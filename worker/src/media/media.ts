import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Worker nền tạo storyboard/video qua API (Muse2API hoặc Flow2API theo `payload.generator.provider`).
 * Làm đúng các luật của WORKER-MUSE.md / WORKER-FLOW.md, bỏ phần xem ảnh/video bằng mắt: worker không kết luận
 * (không gửi `verdict`), người dùng tự đánh giá trên web.
 *
 * An toàn khi gửi:
 * - Video Muse có idempotency (`autovideo-video-<job>`): lỗi mạng thì gửi lại cùng body, không tạo trùng.
 * - Ảnh Muse và mọi yêu cầu Flow KHÔNG có idempotency: ghi nhật ký TRƯỚC khi gửi; không rõ kết quả thì báo lỗi, không gửi lại.
 * - Nhật ký mỗi job ở `stateDir/job-<id>.json` để job bị trả về hàng đợi (worker chết giữa chừng) làm tiếp đúng chỗ.
 * - Ngoại lệ duy nhất được gửi lại Flow: lỗi tài khoản xảy ra TRƯỚC khi Flow nhận lệnh tạo (Flow2API chưa chọn được tài khoản, cookie 401
 *   ở bước tải ảnh `maseQ`, chưa có tiến độ): chưa tạo gì nên gửi lại an toàn; đợi extension đồng bộ cookie / Flow2API chuyển tài khoản khác.
 */

export type FailCode = 'CAPTCHA' | 'LOGIN_REQUIRED' | 'FLOW_OUT_OF_CREDIT' | 'UI_CHANGED' | 'OTHER';

export class MediaFail extends Error {
  /** `retryable`: lỗi trước khi dịch vụ nhận lệnh tạo (chưa tốn gì); server được tạo lại job khi tự bật lại hàng đợi. */
  constructor(public readonly code: FailCode, message: string, public readonly stopLoop = false, public readonly retryable = false) {
    super(message);
    this.name = 'MediaFail';
  }
}

/** Job bị hủy/trả về trong lúc chạy (heartbeat 409): dừng, không báo fail. */
export class JobGone extends Error {}

export interface MediaJob {
  id: number;
  type: string;
  scene_id: number | null;
  payload: any;
}

export interface MediaDeps {
  root: string;
  stateDir: string;
  /** Gọi API autovideo (đã kèm token + worker id). */
  api<T = any>(method: string, url: string, body?: unknown): Promise<T>;
  fetch: typeof fetch;
  muse: { url: string; key: string };
  flow: { url: string; key: string };
  ffmpeg: string;
  ffprobe: string;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
  /** Khoảng poll và heartbeat (test đặt nhỏ). */
  pollMs?: number;
  heartbeatMs?: number;
  /** Thời gian chờ tối đa một task (mặc định 25 phút). */
  maxWaitMs?: number;
  /** Khoảng chờ giữa các lần gửi lại Flow khi lỗi tài khoản trước khi Flow nhận lệnh (mặc định 1, 2, 4, 6, 8 phút ≈ 21 phút). */
  flowRetryDelaysMs?: number[];
}

const FLOW_RETRY_DELAYS_MS = [1, 2, 4, 6, 8].map((m) => m * 60_000);

/**
 * Lỗi Flow2API xảy ra trước khi Google Flow nhận lệnh tạo: không chọn được tài khoản (không phải hết quota) hoặc cookie 401 ở bước tải ảnh
 * tham chiếu (`rpc=maseQ`). `progressed`: stream đã có % tiến độ (đã tạo) → không bao giờ coi là trước khi gửi.
 */
export function isFlowPreSubmitError(message: string, progressed: boolean): boolean {
  if (progressed) return false;
  if (/没有可用的Token/.test(message)) return true; // chưa chọn được tài khoản nên chưa gửi gì
  return /(登录认证失败|code=401)/.test(message) && /rpc=maseQ/.test(message);
}

interface Journal {
  /** Ảnh Muse: 'posting' ghi trước POST; có task id thì chuyển 'submitted'. */
  muse_image?: { phase: 'posting' | 'submitted'; task?: string };
  muse_video_task?: string;
  /** Flow: ghi trước POST; `url` có khi stream trả kết quả. */
  flow?: { sent_at: string; url?: string; done?: boolean };
}

// ------------------------------------------------------------------ tiện ích

const run = (bin: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${path.basename(bin)}: ${String(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`)) : resolve(String(stdout)),
    ),
  );

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * Ảnh đầu vào → data URL. Ảnh > 5 MB thu nhỏ về JPEG (tổng request phải dưới 30 MiB); định dạng ngoài `accept` chuyển PNG.
 * ffmpeg cho ra cùng byte với cùng file nên body video Muse dựng lại vẫn giống hệt (idempotency).
 */
export async function imageDataUrl(deps: MediaDeps, rel: string, tag: string, accept: string[]): Promise<string> {
  let abs = path.join(deps.root, rel);
  if (!fs.existsSync(abs)) throw new MediaFail('OTHER', `Thiếu file ảnh: ${rel}`);
  let mime = MIME[path.extname(abs).toLowerCase()] ?? '';
  const big = fs.statSync(abs).size > 5 * 1024 * 1024;
  if (big || !accept.includes(mime)) {
    const out = path.join(deps.stateDir, `${tag}.${big ? 'jpg' : 'png'}`);
    const args = ['-y', '-loglevel', 'error', '-i', abs, '-frames:v', '1', '-update', '1', '-map_metadata', '-1'];
    if (big) args.push('-vf', "scale='min(2048,iw)':-2", '-q:v', '3');
    await run(deps.ffmpeg, [...args, out]);
    abs = out;
    mime = big ? 'image/jpeg' : 'image/png';
  }
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

async function probe(deps: MediaDeps, abs: string): Promise<{ width: number; height: number; duration_s?: number }> {
  const j = JSON.parse(await run(deps.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', abs]));
  const d = Number(j.format?.duration);
  return { width: j.streams?.[0]?.width, height: j.streams?.[0]?.height, ...(Number.isFinite(d) && d > 0 ? { duration_s: Math.round(d * 100) / 100 } : {}) };
}

function readJournal(deps: MediaDeps, id: number): Journal {
  try {
    return JSON.parse(fs.readFileSync(path.join(deps.stateDir, `job-${id}.json`), 'utf8')) as Journal;
  } catch {
    return {};
  }
}

function writeJournal(deps: MediaDeps, id: number, j: Journal): void {
  const file = path.join(deps.stateDir, `job-${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(j));
  fs.renameSync(`${file}.tmp`, file);
}

async function comment(deps: MediaDeps, job: MediaJob, body: string): Promise<void> {
  if (!job.scene_id) return;
  try {
    await deps.api('POST', '/api/worker/comments', { scene_id: job.scene_id, body });
  } catch (e) {
    deps.log(`không ghi được comment: ${(e as Error).message}`);
  }
}

/** Ghi file nguyên tử: tải vào `.part` rồi đổi tên. */
async function download(deps: MediaDeps, url: string, abs: string, headers: Record<string, string>): Promise<void> {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (url.startsWith('data:')) {
    fs.writeFileSync(abs, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    return;
  }
  // Tải là GET, thử lại an toàn: lỗi mạng hoặc 5xx thử tối đa 4 lần (cách 3, 6, 12 giây). 4xx (link hết hạn…) dừng ngay.
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await deps.fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
      if (res.status >= 400 && res.status < 500) throw new MediaFail('OTHER', `Tải kết quả lỗi HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(`${abs}.part`, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(`${abs}.part`, abs);
      return;
    } catch (e) {
      if (e instanceof MediaFail) throw e;
      lastErr = (e as Error).message;
      deps.log(`  tải lần ${attempt} lỗi (${lastErr})${attempt < 4 ? ', thử lại' : ''}`);
      if (attempt < 4) await deps.sleep(3000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${lastErr} (đã thử 4 lần)`);
}

/** Ảnh tải về (webp/jpg/png) → PNG đúng đường dẫn storyboard. */
async function saveAsPng(deps: MediaDeps, rawAbs: string, rel: string) {
  const abs = path.join(deps.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await run(deps.ffmpeg, ['-y', '-loglevel', 'error', '-i', rawAbs, '-frames:v', '1', '-update', '1', abs]);
  return probe(deps, abs);
}

async function makeGrid(deps: MediaDeps, videoRel: string, gridRel: string) {
  const g = path.join(deps.root, gridRel);
  fs.mkdirSync(path.dirname(g), { recursive: true });
  await run(deps.ffmpeg, ['-y', '-loglevel', 'error', '-i', path.join(deps.root, videoRel), '-vf', 'fps=2,scale=270:-2,tile=5x4', '-frames:v', '1', '-update', '1', g]);
  return probe(deps, g);
}

// ------------------------------------------------------------------ lỗi API → mã fail

/** Lỗi Muse (task.error hoặc body HTTP) → MediaFail theo bảng WORKER-MUSE.md mục 6. */
export function museFail(kind: 'storyboard' | 'video', err: { code?: string; message?: string } | null | undefined, status?: number, task?: string): MediaFail {
  const code = err?.code ?? '';
  const msg = err?.message ?? (status ? `HTTP ${status}` : 'lỗi không rõ');
  const t = task ? ` (task ${task})` : '';
  if (status === 401 || code === 'invalid_api_key') return new MediaFail('OTHER', `Muse2API từ chối API key${t}`, true);
  if (status === 503 || code === 'no_account_available' || code === 'upstream_auth_failed') return new MediaFail('LOGIN_REQUIRED', `Tài khoản Muse chưa sẵn sàng hoặc hết phiên: ${msg}${t}`);
  if (code === 'upstream_access_denied') return new MediaFail('CAPTCHA', `Muse cần xác minh thủ công: ${msg}${t}`);
  if (code === 'upstream_quota_exhausted') {
    return kind === 'video' ? new MediaFail('FLOW_OUT_OF_CREDIT', `Hết hạn mức Muse${t}`) : new MediaFail('OTHER', `Hết hạn mức Muse${t}`, true);
  }
  if (/attach all reference images|upload was not confirmed/i.test(msg)) return new MediaFail('OTHER', `Muse2API không đính được ảnh tham chiếu (chưa gửi prompt): ${msg}${t}`, true);
  if (code === 'submission_unknown') return new MediaFail('OTHER', `Muse chưa rõ kết quả${t}; kiểm tra dashboard Muse2API trước khi tạo lại`);
  return new MediaFail('OTHER', `Muse: ${msg}${t}`);
}

/** Lỗi Flow2API → MediaFail theo bảng WORKER-FLOW.md mục 7. */
export function flowFail(kind: 'storyboard' | 'video', message: string, status?: number): MediaFail {
  if (/MODEL_ACCESS_DENIED/.test(message)) return new MediaFail('OTHER', `Tài khoản Flow không được dùng model này: ${message}`);
  if (/登录认证失败|code=401/.test(message)) return new MediaFail('LOGIN_REQUIRED', `Phiên Google của Flow2API hết hạn: ${message}`);
  if (/captcha/i.test(message)) return new MediaFail('CAPTCHA', `Flow cần xác minh: ${message}`);
  if (/没有可用的Token/.test(message) || status === 503) {
    if (/quota|credit|额度/i.test(message)) return kind === 'video' ? new MediaFail('FLOW_OUT_OF_CREDIT', `Hết hạn mức Google Flow: ${message}`) : new MediaFail('OTHER', `Hết hạn mức Google Flow: ${message}`, true);
    return new MediaFail('LOGIN_REQUIRED', `Tài khoản Flow2API không khả dụng: ${message}`);
  }
  return new MediaFail('OTHER', `Google Flow: ${message}`);
}

// ------------------------------------------------------------------ Muse

async function museJson(deps: MediaDeps, method: string, url: string, body?: string, extra: Record<string, string> = {}) {
  const res = await deps.fetch(deps.muse.url + url, {
    method,
    headers: { Authorization: `Bearer ${deps.muse.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* body không phải JSON */
  }
  return { status: res.status, json };
}

/** Poll task Muse tới khi xong. Trả task đã `succeeded`; lỗi → MediaFail. */
async function museWait(deps: MediaDeps, kind: 'storyboard' | 'video', endpoint: string, task: string, alive: () => void) {
  const deadline = Date.now() + (deps.maxWaitMs ?? 25 * 60_000);
  let last = '';
  for (;;) {
    alive();
    const r = await museJson(deps, 'GET', `${endpoint}/${task}`).catch(() => null);
    if (r?.status === 429) await deps.sleep(15_000);
    else if (r && r.status !== 200) throw museFail(kind, r.json?.error, r.status, task);
    const t = r?.json;
    if (t?.status && `${t.status}/${t.stage ?? ''}` !== last) {
      last = `${t.status}/${t.stage ?? ''}`;
      deps.log(`  task ${task}: ${last}`);
    }
    if (t?.status === 'succeeded') return t;
    if (t?.status === 'failed' || t?.status === 'cancelled') throw museFail(kind, t.error, undefined, task);
    if (t?.status === 'unknown') throw new MediaFail('OTHER', `Muse chưa rõ kết quả task ${task}; kiểm tra dashboard Muse2API trước khi tạo lại`);
    if (Date.now() > deadline) throw new MediaFail('OTHER', `Muse task ${task} chưa xong sau ${Math.round((deps.maxWaitMs ?? 25 * 60_000) / 60_000)} phút; có thể vẫn đang chạy`);
    await deps.sleep(deps.pollMs ?? 5000);
  }
}

const mediaName = (url: string): string => {
  const m = /\/v1\/media\/([^?#]+)/.exec(url);
  if (!m) throw new MediaFail('OTHER', 'Muse trả URL kết quả không hợp lệ');
  return m[1]!;
};

async function museStoryboard(deps: MediaDeps, job: MediaJob, alive: () => void) {
  const p = job.payload;
  const files: string[] = p.upload_files ?? [];
  if (files.length < 1 || files.length > 4) throw new MediaFail('OTHER', `Muse nhận 1–4 ảnh tham chiếu, cảnh này có ${files.length}`);
  const j = readJournal(deps, job.id);
  let task = j.muse_image?.task;
  if (j.muse_image?.phase === 'posting' && !task) {
    throw new MediaFail('OTHER', 'Lần gửi ảnh trước lên Muse không rõ kết quả (worker dừng giữa chừng); kiểm tra dashboard Muse2API trước khi tạo lại');
  }
  if (!task) {
    const images = [];
    for (const [k, f] of files.entries()) images.push(await imageDataUrl(deps, f, `ref-${job.id}-${k + 1}`, ['image/png', 'image/jpeg', 'image/webp']));
    const body = JSON.stringify({ model: p.generator?.model ?? 'muse-image', prompt: p.chatgpt_message, n: 1, size: '9:16', response_format: 'url', async: true, image: images });
    writeJournal(deps, job.id, { ...j, muse_image: { phase: 'posting' } });
    let r;
    try {
      r = await museJson(deps, 'POST', '/v1/images/generations', body);
    } catch (e) {
      throw new MediaFail('OTHER', `Gửi ảnh lên Muse bị lỗi mạng, không rõ đã tạo task chưa (${(e as Error).message}); kiểm tra dashboard Muse2API trước khi tạo lại`);
    }
    if (r.status !== 200 || !r.json?.id) {
      writeJournal(deps, job.id, { ...j, muse_image: undefined }); // server từ chối: chưa tạo task
      throw museFail('storyboard', r.json?.error, r.status);
    }
    task = String(r.json.id);
    writeJournal(deps, job.id, { ...j, muse_image: { phase: 'submitted', task } });
    await comment(deps, job, `[muse] storyboard lượt ${p.attempt}, lần 1: ${task}`);
  }
  const t = await museWait(deps, 'storyboard', '/v1/images/generations', task, alive);
  const url: string | undefined = t.result?.data?.[0]?.url;
  if (!url) throw new MediaFail('OTHER', `Muse task ${task} xong nhưng không có ảnh`);
  const raw = path.join(deps.stateDir, `sb-${job.id}-raw`);
  await download(deps, `${deps.muse.url}/v1/media/${mediaName(url)}`, raw, { Authorization: `Bearer ${deps.muse.key}` });
  const wh = await saveAsPng(deps, raw, p.output.storyboard_path);
  return { result: { provider: 'muse2api', muse_task_ids: [task] }, assets: [{ kind: 'storyboard', file_path: p.output.storyboard_path, meta: { width: wh.width, height: wh.height } }] };
}

async function museVideo(deps: MediaDeps, job: MediaJob, alive: () => void) {
  const p = job.payload;
  const files: string[] = p.upload_files ?? [];
  const images = [];
  for (const [k, f] of files.entries()) images.push(await imageDataUrl(deps, f, `vref-${job.id}-${k + 1}`, ['image/png', 'image/jpeg', 'image/webp']));
  // Cùng key + cùng body (sort key) → Muse trả task cũ: gửi lại an toàn sau lỗi mạng hoặc khi job bị trả về hàng đợi.
  const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const body = JSON.stringify(sorted({ model: p.generator?.model ?? 'muse-video', prompt: p.scene.prompt, image: images, size: p.settings.aspect, duration: p.settings.duration_s }));
  const key = `autovideo-video-${job.id}`;
  let r: Awaited<ReturnType<typeof museJson>> | null = null;
  for (let i = 0; i < 3 && !r; i++) {
    r = await museJson(deps, 'POST', '/v1/videos', body, { 'Idempotency-Key': key }).catch(async (e) => {
      deps.log(`  POST video lỗi mạng (${(e as Error).message}), gửi lại cùng key`);
      await deps.sleep(5000);
      return null;
    });
  }
  if (!r) throw new MediaFail('OTHER', 'Không gửi được video lên Muse2API (lỗi mạng); Muse2API có chạy không?');
  if (r.status === 409) throw new MediaFail('OTHER', `Muse báo trùng idempotency key ${key} với nội dung khác; kiểm tra task cũ trên dashboard Muse2API`);
  if (r.status !== 200 || !r.json?.id) throw museFail('video', r.json?.error, r.status);
  const task = String(r.json.id);
  const j = readJournal(deps, job.id);
  if (j.muse_video_task !== task) {
    writeJournal(deps, job.id, { ...j, muse_video_task: task });
    await comment(deps, job, `[muse] video job ${job.id}: ${task} (key ${key})`);
  }
  const t = await museWait(deps, 'video', '/v1/videos', task, alive);
  if (t.result?.synthetic !== false) throw new MediaFail('OTHER', 'Muse2API đang chạy driver mock (kết quả giả): không dùng', true);
  await download(deps, `${deps.muse.url}/v1/media/${t.result.media_name}`, path.join(deps.root, p.output.video_path), { Authorization: `Bearer ${deps.muse.key}` });
  const notes = [];
  const got = t.requested?.reference_image_count;
  if (typeof got === 'number' && got !== files.length) notes.push(`Muse nhận ${got}/${files.length} ảnh.`);
  return { result: { provider: 'muse2api', muse_task_id: task }, notes };
}

// ------------------------------------------------------------------ Flow2API

/** Gửi một yêu cầu Flow (stream SSE), đọc tới hết. Trả URL kết quả (video src hoặc ảnh markdown). */
async function flowRun(deps: MediaDeps, job: MediaJob, kind: 'storyboard' | 'video', content: unknown[], alive: () => void): Promise<string> {
  const p = job.payload;
  const j = readJournal(deps, job.id);
  if (j.flow?.url) return j.flow.url;
  if (j.flow) throw new MediaFail('OTHER', `Đã gửi lên Google Flow lúc ${j.flow.sent_at} nhưng không rõ kết quả (worker dừng giữa chừng); kiểm tra Google Flow trước khi tạo lại`);
  const body = JSON.stringify({ model: p.generator.model, messages: [{ role: 'user', content }], stream: true });
  const sent_at = new Date().toISOString();
  writeJournal(deps, job.id, { ...j, flow: { sent_at } });
  await comment(deps, job, `[flow] ${kind} job ${job.id}: gửi lúc ${sent_at}, model ${p.generator.model}`);
  let res: Response;
  try {
    res = await deps.fetch(`${deps.flow.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.flow.key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(1_600_000),
    });
  } catch (e) {
    const refused = /ECONNREFUSED/.test(String((e as { cause?: unknown }).cause ?? e));
    if (refused) {
      writeJournal(deps, job.id, { ...j, flow: undefined }); // chưa tới được Flow2API: chưa tạo gì
      throw new MediaFail('OTHER', 'Flow2API không chạy (từ chối kết nối)');
    }
    throw new MediaFail('OTHER', `Mất kết nối với Flow2API (${(e as Error).message}); Google Flow có thể vẫn đang tạo, kiểm tra trước khi tạo lại`);
  }
  if (res.status === 401) {
    writeJournal(deps, job.id, { ...j, flow: undefined });
    throw new MediaFail('OTHER', 'Flow2API từ chối API key (FLOW2API_KEY)', true);
  }
  let text = '';
  let error: { message?: string; status_code?: number } | null = null;
  let done = false;
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastPct = '';
  try {
    while (reader) {
      const { value, done: end } = await reader.read();
      if (end) break;
      alive();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{') && line.includes('"error"')) {
          try {
            error = JSON.parse(line).error;
          } catch {
            /* bỏ qua */
          }
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.error) error = ev.error;
        for (const c of ev.choices ?? []) {
          const piece = c.delta?.content ?? c.message?.content ?? '';
          text += piece;
          const pct = /(\d{1,3})%/.exec(piece)?.[1];
          if (pct && pct !== lastPct) {
            lastPct = pct;
            deps.log(`  Flow ${pct}%`);
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof JobGone) throw e;
    throw new MediaFail('OTHER', `Stream Flow bị ngắt (${(e as Error).message}); Google Flow có thể vẫn đang tạo, kiểm tra trước khi tạo lại`);
  }
  const m = /<video\b[^>]*\bsrc=['"]([^'"]+)['"]/.exec(text) ?? /!\[[^\]]*\]\((\S+?)\)/.exec(text);
  if (m) {
    const url = m[1]!.replace(/&amp;/g, '&');
    writeJournal(deps, job.id, { ...readJournal(deps, job.id), flow: { sent_at, url, done } });
    return url;
  }
  if (error) {
    const msg = String(error.message ?? 'lỗi không rõ');
    const f = flowFail(kind, msg, error.status_code ?? (res.status !== 200 ? res.status : undefined));
    if (f.code === 'LOGIN_REQUIRED' && isFlowPreSubmitError(msg, lastPct !== '')) {
      writeJournal(deps, job.id, { ...readJournal(deps, job.id), flow: undefined }); // Flow chưa nhận lệnh: được gửi lại
      throw new MediaFail(f.code, f.message, f.stopLoop, true);
    }
    writeJournal(deps, job.id, { ...readJournal(deps, job.id), flow: { sent_at, done: true } });
    throw f;
  }
  if (res.status !== 200) throw flowFail(kind, `HTTP ${res.status}`, res.status);
  const tail = text.replace(/(https?:\/\/|data:)[^\s)'"]+/g, '<url>').slice(-200);
  throw new MediaFail('OTHER', done ? `Flow trả kết quả không có ${kind === 'video' ? 'video' : 'ảnh'}: ${tail}` : `Stream Flow kết thúc giữa chừng; Google Flow có thể vẫn đang tạo, kiểm tra trước khi tạo lại`);
}

/** `flowRun`, gửi lại khi lỗi tài khoản trước khi Flow nhận lệnh; hết số lần thì ném lỗi cuối (kèm `retryable`). */
async function flowRunRetry(deps: MediaDeps, job: MediaJob, kind: 'storyboard' | 'video', content: unknown[], alive: () => void): Promise<string> {
  const delays = deps.flowRetryDelaysMs ?? FLOW_RETRY_DELAYS_MS;
  for (let i = 0; ; i++) {
    try {
      return await flowRun(deps, job, kind, content, alive);
    } catch (e) {
      if (!(e instanceof MediaFail) || !e.retryable || i >= delays.length) throw e;
      const wait = delays[i]!;
      deps.log(`  Flow2API lỗi tài khoản trước khi tạo (${e.message.slice(0, 120)}); thử lại sau ${Math.round(wait / 60_000) || 1} phút (lần ${i + 1}/${delays.length})`);
      for (let t = 0; t < wait; t += 5_000) {
        alive();
        await deps.sleep(Math.min(5_000, wait - t));
      }
      alive();
    }
  }
}

const flowHeaders = (deps: MediaDeps, url: string): Record<string, string> => (url.startsWith(deps.flow.url + '/') ? { Authorization: `Bearer ${deps.flow.key}` } : {}); // chỉ gửi key cho chính Flow2API

async function flowContent(deps: MediaDeps, job: MediaJob, text: string, files: string[]) {
  const parts: unknown[] = [{ type: 'text', text }];
  for (const [k, f] of files.entries()) parts.push({ type: 'image_url', image_url: { url: await imageDataUrl(deps, f, `fref-${job.id}-${k + 1}`, ['image/png', 'image/jpeg']) } });
  return parts;
}

async function flowStoryboard(deps: MediaDeps, job: MediaJob, alive: () => void) {
  const p = job.payload;
  const files: string[] = p.upload_files ?? [];
  const max = p.generator?.max_images ?? 4;
  if (files.length < 1 || files.length > max) throw new MediaFail('OTHER', `Storyboard Flow nhận 1–${max} ảnh tham chiếu, cảnh này có ${files.length}`);
  const url = await flowRunRetry(deps, job, 'storyboard', await flowContent(deps, job, p.chatgpt_message, files), alive);
  const raw = path.join(deps.stateDir, `sb-${job.id}-raw`);
  await download(deps, url, raw, flowHeaders(deps, url)).catch((e) => {
    throw e instanceof MediaFail ? e : new MediaFail('OTHER', `Đã tạo ảnh trên Google Flow nhưng không tải được: ${(e as Error).message}`);
  });
  const wh = await saveAsPng(deps, raw, p.output.storyboard_path);
  // Logo Gemini: server xoá khi nhận complete (services/storyboard-logo.ts).
  return { result: { provider: 'flow2api', model: p.generator.model }, assets: [{ kind: 'storyboard', file_path: p.output.storyboard_path, meta: { width: wh.width, height: wh.height } }] };
}

async function flowVideo(deps: MediaDeps, job: MediaJob, alive: () => void) {
  const p = job.payload;
  const files: string[] = p.upload_files ?? [];
  const max = p.generator?.max_images ?? 3;
  if (files.length < 1 || files.length > max) throw new MediaFail('OTHER', `Google Flow nhận 1–${max} ảnh, cảnh này có ${files.length}`);
  const url = await flowRunRetry(deps, job, 'video', await flowContent(deps, job, p.scene.prompt, files), alive);
  await download(deps, url, path.join(deps.root, p.output.video_path), flowHeaders(deps, url)).catch((e) => {
    throw e instanceof MediaFail ? e : new MediaFail('OTHER', `Đã tạo video trên Google Flow nhưng không tải được (link có thể hết hạn): ${(e as Error).message}`);
  });
  return { result: { provider: 'flow2api', model: p.generator.model }, notes: [] as string[] };
}

// ------------------------------------------------------------------ một job

/** Chạy một job storyboard/video đã claim. Ném MediaFail (worker báo fail) hoặc JobGone (dừng im lặng). */
export async function runMediaJob(job: MediaJob, deps: MediaDeps): Promise<void> {
  fs.mkdirSync(deps.stateDir, { recursive: true });
  const p = job.payload;
  const provider: 'muse' | 'flow' = p.generator?.provider === 'flow' ? 'flow' : 'muse';
  const label: string = p.generator?.label ?? 'Muse';
  let gone = false;
  const started = Date.now();
  const beat = async () => {
    try {
      await deps.api('POST', `/api/worker/jobs/${job.id}/heartbeat`);
    } catch (e) {
      // JOB_CANCELLED: job bị hủy, trả về hàng đợi hoặc giao cho worker khác. Lỗi mạng thì thử lại ở nhịp sau.
      if (/JOB_CANCELLED|LEASE_LOST|NOT_FOUND/.test(String((e as { code?: string }).code ?? ''))) gone = true;
    }
  };
  const timer = setInterval(() => void beat(), deps.heartbeatMs ?? 60_000);
  const alive = () => {
    if (gone) throw new JobGone(`Job ${job.id} đã bị hủy hoặc trả về hàng đợi`);
  };
  try {
    await beat();
    alive();
    if (job.type === 'storyboard') {
      deps.log(`Job ${job.id} storyboard ${p.scene?.code ?? ''} qua ${label}`);
      const out = provider === 'flow' ? await flowStoryboard(deps, job, alive) : await museStoryboard(deps, job, alive);
      alive();
      const note = `Worker nền tạo qua ${label}; chưa đánh giá nội dung, xem và kết luận trên web.`;
      await deps.api('POST', `/api/worker/jobs/${job.id}/complete`, { ...out, result: { ...out.result, note } });
    } else if (job.type === 'video') {
      const s = p.settings ?? {};
      const wantDur = p.generator?.duration_s ?? (provider === 'flow' ? undefined : 10);
      if (s.aspect !== '9:16' || s.count !== 1 || (wantDur !== undefined && s.duration_s !== wantDur)) {
        throw new MediaFail('UI_CHANGED', `Cấu hình video không hỗ trợ: ${JSON.stringify(s)}`);
      }
      if (!p.storyboard_path || !fs.existsSync(path.join(deps.root, p.storyboard_path))) throw new MediaFail('OTHER', 'Thiếu ảnh storyboard của cảnh');
      deps.log(`Job ${job.id} video ${p.scene?.code ?? ''} qua ${label}`);
      const out = provider === 'flow' ? await flowVideo(deps, job, alive) : await museVideo(deps, job, alive);
      alive();
      const meta = await probe(deps, path.join(deps.root, p.output.video_path));
      const gwh = await makeGrid(deps, p.output.video_path, p.output.grid_path);
      const notes = [...out.notes];
      if (meta.height <= meta.width) notes.push(`Video ngang ${meta.width}×${meta.height}.`);
      if (meta.duration_s && Math.abs(meta.duration_s - s.duration_s) > 1.5) notes.push(`Dài ${meta.duration_s} giây (yêu cầu ${s.duration_s}).`);
      await deps.api('POST', `/api/worker/jobs/${job.id}/complete`, {
        result: { ...out.result, verdict_note: [`Worker nền tạo qua ${label}, ${meta.width}×${meta.height}, ${meta.duration_s ?? '?'} giây. Chưa đánh giá nội dung: xem video/lưới và kết luận trên web.`, ...notes].join(' ') },
        assets: [
          { kind: 'video', file_path: p.output.video_path, meta },
          { kind: 'grid', file_path: p.output.grid_path, meta: gwh },
        ],
      });
    } else {
      throw new MediaFail('OTHER', `Worker nền không làm loại job ${job.type}`);
    }
    fs.rmSync(path.join(deps.stateDir, `job-${job.id}.json`), { force: true });
    deps.log(`Job ${job.id} xong sau ${Math.round((Date.now() - started) / 1000)} giây`);
  } finally {
    clearInterval(timer);
  }
}
