import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../../../server/src/config.js';
import { loadDotEnv } from '../../../server/src/lib/env.js';
import { JobGone, MediaFail, runMediaJob, type MediaDeps, type MediaJob } from './media.js';

/**
 * Worker nền tạo storyboard/video qua Muse2API / Flow2API (chế độ legacy, cùng giao thức với Codex trong WORKER-MUSE.md).
 * Chạy: `npm run media -w worker` (hoặc `npm run worker:media`). Một máy chỉ một tiến trình (file khóa).
 * Cấu hình trong .env: MUSE2API_URL, MUSE2API_KEY hoặc MUSE2API_KEY_FILE, FLOW2API_URL, FLOW2API_KEY, MEDIA_WORKER_ID.
 */
loadDotEnv(path.join(REPO_ROOT, '.env'));
const env = process.env;
const apiUrl = env.AUTOVIDEO_API ?? 'http://127.0.0.1:8787';
const workerId = env.MEDIA_WORKER_ID ?? 'media-api-1';
const once = process.argv.includes('--once');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });

const lockDir = path.join(os.homedir(), '.local/share/autovideo');
fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
const lock = path.join(lockDir, 'media-worker.lock');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  let live = false;
  try { process.kill(pid, 0); live = true; } catch { /* khóa cũ */ }
  if (live) throw new Error(`Đã có worker nền ảnh/video (pid ${pid}); dừng nó trước khi khởi động`);
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
process.on('exit', () => { try { fs.unlinkSync(lock); } catch { /* đã xoá */ } });

class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details: any = null) { super(message); }
}

async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${apiUrl}${url}${sep}worker=${encodeURIComponent(workerId)}`, {
    method,
    headers: { Authorization: `Bearer ${env.WORKER_TOKEN ?? ''}`, 'X-Worker-Id': workerId, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status === 204) return null as T;
  const b = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new ApiError(b.error?.code ?? `HTTP_${res.status}`, b.error?.message ?? `HTTP ${res.status}`, res.status, b.error?.details ?? null);
  return b as T;
}

function museKey(): string {
  if (env.MUSE2API_KEY) return env.MUSE2API_KEY;
  const file = env.MUSE2API_KEY_FILE;
  try { return file ? fs.readFileSync(file, 'utf8').trim() : ''; } catch { return ''; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('vi-VN', { hour12: false })} ${msg}`);
const stateDir = path.join(REPO_ROOT, 'data', 'media-worker');

const deps: MediaDeps = {
  root: REPO_ROOT,
  stateDir,
  api,
  fetch,
  muse: { url: (env.MUSE2API_URL ?? 'http://127.0.0.1:18610').replace(/\/+$/, ''), key: museKey() },
  flow: { url: (env.FLOW2API_URL ?? 'http://127.0.0.1:8020').replace(/\/+$/, ''), key: env.FLOW2API_KEY ?? '' },
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
  sleep,
  log,
};

/**
 * Tự bật lại hàng đợi khi nó dừng vì tài khoản Flow2API (LOGIN_REQUIRED do chính worker này báo): extension của chủ máy tự đồng bộ cookie
 * mỗi vài phút, nên đợi rồi kiểm tra `GET /health` của Flow2API; có tài khoản hoạt động thì gọi `POST /api/worker/queue/auto-resume`
 * (server bật lại và tạo lại các job lỗi trước khi gửi). Lần đầu đợi 5 phút; mỗi lần bật lại mà lại dừng thì đợi gấp đôi, tối đa 60 phút.
 * Dừng vì lý do khác (tay, CAPTCHA, hết credit, Muse) thì vẫn chờ chủ máy.
 */
let pausedSince = 0;
let autoResumes = 0;
async function maybeAutoResume(details: any): Promise<void> {
  const reason = String(details?.pause_reason ?? '');
  if (details?.pause_code !== 'LOGIN_REQUIRED' || !/Flow2API/.test(reason)) return;
  if (!pausedSince) pausedSince = Date.now();
  const waitMs = Math.min(5 * 2 ** autoResumes, 60) * 60_000;
  if (Date.now() - pausedSince < waitMs) return;
  const health = await fetch(`${deps.flow.url}/health`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json() as Promise<{ active_tokens?: number; has_active_tokens?: boolean }>)
    .catch(() => null);
  if (!health?.has_active_tokens) {
    log(`Flow2API chưa có tài khoản hoạt động; kiểm tra lại sau`);
    pausedSince = Date.now() - waitMs + 60_000; // thử lại sau 1 phút
    return;
  }
  const r = await api<{ resumed: boolean; requeued: number[] }>('POST', '/api/worker/queue/auto-resume').catch((e) => {
    log(`Không tự bật lại được hàng đợi: ${(e as Error).message}`);
    return null;
  });
  if (!r) return;
  autoResumes++;
  pausedSince = 0;
  log(r.resumed ? `Tự bật lại hàng đợi (Flow2API có ${health.active_tokens ?? '?'} tài khoản hoạt động)${r.requeued.length ? `, tạo lại job ${r.requeued.join(', ')}` : ''}` : 'Hàng đợi đã được bật lại từ trước');
}

log(`Worker nền ảnh/video ${workerId}: storyboard,video qua Muse2API (${deps.muse.url}${deps.muse.key ? '' : ', THIẾU KEY'}) / Flow2API (${deps.flow.url}${deps.flow.key ? '' : ', THIẾU KEY'})`);
let lastWait = '';
while (!stopping) {
  let job: MediaJob | null = null;
  try {
    job = await api<MediaJob | null>('GET', '/api/worker/next?types=storyboard,video');
  } catch (e) {
    const code = (e as ApiError).code;
    // Hàng đợi tạm dừng (vd LOGIN_REQUIRED): chờ người dùng bật lại trên web, chỉ ghi log khi lý do đổi.
    const msg = code === 'QUEUE_PAUSED' ? `Chờ: ${(e as Error).message}` : `Không lấy được job: ${(e as Error).message}`;
    if (msg !== lastWait) log(msg);
    lastWait = msg;
    if (code === 'UNAUTHORIZED') { process.exitCode = 1; break; }
    if (code === 'QUEUE_PAUSED') await maybeAutoResume((e as ApiError).details);
    await sleep(code === 'QUEUE_PAUSED' ? 15_000 : 10_000);
    continue;
  }
  lastWait = '';
  pausedSince = 0;
  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }
  let pauseMs = 1000;
  try {
    await runMediaJob(job, deps);
    autoResumes = 0;
  } catch (e) {
    if (e instanceof JobGone) {
      log(e.message);
    } else {
      const f = e instanceof MediaFail ? e : new MediaFail('OTHER', `Lỗi worker: ${(e as Error).message}`);
      log(`Job ${job.id} lỗi [${f.code}]: ${f.message}`);
      try {
        await api('POST', `/api/worker/jobs/${job.id}/fail`, { error: f.message, code: f.code, ...(f.retryable ? { retryable: true } : {}) });
      } catch (err) {
        log(`Không báo được lỗi job ${job.id}: ${(err as Error).message}`);
      }
      fs.rmSync(path.join(stateDir, `job-${job.id}.json`), { force: true });
      // Lỗi phía dịch vụ (key sai, Muse2API không đính được ảnh, hết hạn mức ảnh…): nghỉ 15 phút để không làm hỏng hàng loạt job.
      if (f.stopLoop) {
        log('Nghỉ 15 phút trước khi nhận job tiếp (lỗi phía dịch vụ, cần người kiểm tra)');
        pauseMs = 15 * 60_000;
      }
    }
  }
  if (once) break;
  for (let t = 0; t < pauseMs && !stopping; t += 1000) await sleep(1000);
}
