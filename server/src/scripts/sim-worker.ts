/**
 * Worker giả lập (không cần Claude/Chrome): vòng lặp GET /api/worker/next → xử lý → complete/fail.
 *
 *   npm run sim:worker -- [--once] [--delay 3000] [--fail-rate 0.2] [--api http://127.0.0.1:8787]
 *                         [--poll 2000] [--worker sim-1] [--root <ROOT_DIR>] [--fail-code CAPTCHA] [--mixed-verdicts]
 *
 * --once  : xử lý tối đa MỘT job rồi thoát (không có job / hàng đợi tạm dừng thì thoát ngay).
 * Worker này KHÔNG BAO GIỜ tự tạo job video; chỉ xử lý job người dùng đã duyệt.
 * Cần WORKER_TOKEN (đọc từ .env hoặc biến môi trường) và cùng ROOT_DIR với server để ghi file mẫu.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT, loadConfig } from '../config.js';
import { loadDotEnv } from '../lib/env.js';

loadDotEnv(path.join(REPO_ROOT, '.env'));

// ------------------------------------------------------------------ tham số
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const API = String(args.api ?? `http://${cfg.host}:${cfg.port}`).replace(/\/$/, '');
const TOKEN = String(args.token ?? process.env.WORKER_TOKEN ?? '');
const ROOT = path.resolve(String(args.root ?? cfg.rootDir));
const ONCE = args.once === true;
const DELAY = Number(args.delay ?? 3000);
const POLL = Number(args.poll ?? 2000);
const FAIL_RATE = Number(args['fail-rate'] ?? 0);
const FAIL_CODE = String(args['fail-code'] ?? 'OTHER');
const WORKER_ID = String(args.worker ?? 'sim-worker');
const MIXED = args['mixed-verdicts'] === true;

if (!TOKEN) {
  console.error('Thiếu WORKER_TOKEN (đặt trong .env hoặc biến môi trường, hoặc dùng --token).');
  process.exit(2);
}

const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString('vi-VN')}] [${WORKER_ID}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP
interface ApiResult {
  status: number;
  json: any;
}
async function api(method: string, url: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

// ------------------------------------------------------------------ sinh file mẫu
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** PNG hợp lệ w×h, nền gradient theo màu suy ra từ `seed`. */
function makePng(w: number, h: number, seed: string): Buffer {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const base = [(hash & 0xff) | 0x40, ((hash >> 8) & 0xff) | 0x40, ((hash >> 16) & 0xff) | 0x40];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    const shade = 0.5 + 0.5 * (y / h);
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = Math.round(base[0]! * shade);
      raw[o + 1] = Math.round(base[1]! * shade);
      raw[o + 2] = Math.round(base[2]! * shade);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// JPEG 1x1 hợp lệ, dùng khi không có ffmpeg
const TINY_JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

function findFfmpeg(): string | null {
  for (const bin of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    if (r.status === 0) return bin;
  }
  return null;
}
const FFMPEG = findFfmpeg();
if (!FFMPEG) log('Không tìm thấy ffmpeg: video/grid sẽ là file giả (không phát được).');

const abs = (rel: string) => {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
};

function makeVideo(videoRel: string, gridRel: string): { video: Record<string, unknown> } {
  const v = abs(videoRel);
  const g = abs(gridRel);
  if (FFMPEG) {
    const r = spawnSync(
      FFMPEG,
      ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=24', '-t', '3', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', v],
      { stdio: 'inherit' },
    );
    if (r.status === 0) {
      const gr = spawnSync(
        FFMPEG,
        ['-y', '-loglevel', 'error', '-i', v, '-vf', 'fps=1,scale=120:-1,tile=3x1', '-frames:v', '1', '-q:v', '3', g],
        { stdio: 'inherit' },
      );
      if (gr.status !== 0) fs.writeFileSync(g, TINY_JPG);
      return { video: { width: 360, height: 640, duration_s: 3, simulated: true } };
    }
  }
  fs.writeFileSync(v, Buffer.from('mô phỏng: không có ffmpeg, đây không phải mp4 thật'));
  fs.writeFileSync(g, TINY_JPG);
  return { video: { width: 360, height: 640, duration_s: 3, simulated: true, fake: true } };
}

// ------------------------------------------------------------------ xử lý job
interface Job {
  id: number;
  type: 'analyze_brief' | 'storyboard' | 'video' | 'revise_prompt' | 'edit_plan';
  payload: any;
}

/** Giả lập thời gian làm việc, gửi heartbeat; trả false nếu job bị hủy (409). */
async function work(job: Job): Promise<boolean> {
  const step = Math.max(200, Math.min(2000, Math.floor(DELAY / 3)));
  const end = Date.now() + DELAY;
  let alive = true;
  while (Date.now() < end) {
    await sleep(Math.min(step, Math.max(0, end - Date.now())));
    const r = await api('POST', `/api/worker/jobs/${job.id}/heartbeat?worker=${WORKER_ID}`, {});
    if (r.status === 409) {
      log(`Job #${job.id} bị hủy hoặc không còn thuộc worker này (${r.json?.error?.code}); dừng.`);
      alive = false;
      break;
    }
  }
  return alive;
}

async function handle(job: Job): Promise<void> {
  const p = job.payload;
  log(`Nhận job #${job.id} (${job.type}${p.scene ? ' ' + p.scene.code : ''})${p.requeued ? ' [được trả về hàng đợi trước đó]' : ''}`);

  if (!(await work(job))) return;

  if (job.type !== 'analyze_brief' && Math.random() < FAIL_RATE) {
    const r = await api('POST', `/api/worker/jobs/${job.id}/fail?worker=${WORKER_ID}`, {
      error: `Mô phỏng lỗi (${FAIL_CODE})`,
      code: FAIL_CODE,
    });
    log(`Job #${job.id} báo lỗi giả [${FAIL_CODE}] -> HTTP ${r.status}`);
    return;
  }

  if (job.type === 'analyze_brief') {
    const proj = p.project;
    const refIds: number[] = (p.refs ?? []).map((r: any) => r.id);
    const titles = ['Mở đầu', 'Chế biến', 'Hoàn thiện', 'Thưởng thức'];
    const count = 3 + (job.id % 2); // 3–4 cảnh
    const scenes = Array.from({ length: count }, (_, i) => ({
      code: `C${i + 1}`,
      order_index: i,
      title: titles[i] ?? `Cảnh ${i + 1}`,
      prompt: `[Mô phỏng] ${titles[i] ?? 'Cảnh ' + (i + 1)}: ${String(proj.brief).slice(0, 120)}\nPhong cách: ${String(proj.style_lock).slice(0, 80) || 'tự nhiên'}`,
      first_frame_desc: `Khung đầu cảnh ${i + 1} (mô phỏng)`,
      upload_refs: i === 0 ? refIds : [],
      use_prev_storyboard: i > 0,
    }));
    const r = await api('POST', '/api/worker/scenes', { project_id: proj.id, scenes });
    if (r.status !== 200) {
      log(`POST /api/worker/scenes lỗi ${r.status}: ${JSON.stringify(r.json)}`);
      await api('POST', `/api/worker/jobs/${job.id}/fail?worker=${WORKER_ID}`, { error: 'Không tạo được cảnh: ' + JSON.stringify(r.json), code: 'OTHER' });
      return;
    }
    const c = await api('POST', `/api/worker/jobs/${job.id}/complete?worker=${WORKER_ID}`, { result: { scenes: count } });
    log(`analyze_brief xong: ${count} cảnh -> HTTP ${c.status}`);
    return;
  }

  if (job.type === 'storyboard') {
    const rel: string = p.output.storyboard_path;
    fs.writeFileSync(abs(rel), makePng(180, 320, p.scene.code + p.attempt));
    const c = await api('POST', `/api/worker/jobs/${job.id}/complete?worker=${WORKER_ID}`, {
      result: { note: 'Mô phỏng: không thấy lỗi' },
      assets: [{ kind: 'storyboard', file_path: rel, meta: { width: 180, height: 320, simulated: true } }],
    });
    log(`storyboard ${p.scene.code} xong -> HTTP ${c.status} ${c.status !== 200 ? JSON.stringify(c.json) : ''}`);
    return;
  }

  if (job.type === 'video') {
    const { video } = makeVideo(p.output.video_path, p.output.grid_path);
    const verdicts = ['pass', 'pass', 'pass', 'fix_in_edit', 'redo'];
    const verdict = MIXED ? verdicts[Math.floor(Math.random() * verdicts.length)] : 'pass';
    const c = await api('POST', `/api/worker/jobs/${job.id}/complete?worker=${WORKER_ID}`, {
      result: { verdict, verdict_note: 'Mô phỏng: không thấy lỗi' },
      assets: [
        { kind: 'video', file_path: p.output.video_path, meta: video },
        { kind: 'grid', file_path: p.output.grid_path, meta: {} },
      ],
      credits_cost: p.credits_expected,
    });
    log(`video ${p.scene.code} lượt ${p.attempt} xong (${verdict}) -> HTTP ${c.status} ${c.status !== 200 ? JSON.stringify(c.json) : ''}`);
    return;
  }

  if (job.type === 'edit_plan') {
    // Mô phỏng: bỏ 0,3 giây đầu và 0,2 giây cuối mỗi cảnh (nếu đủ dài). Server tự render sau khi complete.
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const edl = {
      scenes: (p.scenes as any[]).map((s) => {
        const dur: number | null = typeof s.duration_s === 'number' ? s.duration_s : null;
        const trim = dur !== null && dur >= 1.5;
        const inS = trim ? 0.3 : 0;
        const outS = trim ? r3(dur! - 0.2) : dur !== null ? r3(dur) : 3;
        return {
          scene_id: s.scene_id,
          asset_id: s.asset_id,
          segments: [{ in_s: inS, out_s: outS }],
          removed: trim
            ? [
                { from_s: 0, to_s: inS, reason: 'Mô phỏng: 0–0,3s đầu chưa có hành động' },
                { from_s: outS, to_s: r3(dur!), reason: `Mô phỏng: ${outS}–${r3(dur!)}s cuối khung đứng yên` },
              ]
            : [],
          note: 'Mô phỏng',
        };
      }),
    };
    const c = await api('POST', `/api/worker/jobs/${job.id}/complete?worker=${WORKER_ID}`, {
      result: { edl, summary: 'Mô phỏng: cắt 0,3 giây đầu và 0,2 giây cuối mỗi cảnh, giữ nguyên thứ tự.' },
    });
    log(`edit_plan v${p.version} xong (${edl.scenes.length} cảnh) -> HTTP ${c.status} ${c.status !== 200 ? JSON.stringify(c.json) : ''}`);
    return;
  }

  // revise_prompt: thêm một dòng vào cuối prompt kèm lý do (KHÔNG tạo job video)
  const comments: { id: number; body: string }[] = p.comments ?? [];
  const reason = comments.length ? `Theo nhận xét: ${comments.map((c) => c.body).join(' | ').slice(0, 200)}` : 'Chỉnh theo yêu cầu';
  const c = await api('POST', `/api/worker/jobs/${job.id}/complete?worker=${WORKER_ID}`, {
    result: {
      prompt: `${p.scene.prompt}\n[Mô phỏng chỉnh sửa] ${reason}`,
      reason,
      resolved_comment_ids: comments.map((x) => x.id),
    },
  });
  log(`revise_prompt ${p.scene.code} xong -> HTTP ${c.status} ${c.status !== 200 ? JSON.stringify(c.json) : ''}`);
}

// ------------------------------------------------------------------ vòng lặp chính
async function main(): Promise<void> {
  log(`Bắt đầu. API=${API} ROOT=${ROOT} delay=${DELAY}ms fail-rate=${FAIL_RATE}${ONCE ? ' (--once)' : ''}`);
  for (;;) {
    let r: ApiResult;
    try {
      r = await api('GET', `/api/worker/next?worker=${WORKER_ID}`);
    } catch (err) {
      log(`Không kết nối được API: ${(err as Error).message}`);
      if (ONCE) process.exit(1);
      await sleep(POLL);
      continue;
    }
    if (r.status === 401) {
      log('WORKER_TOKEN sai hoặc thiếu (401).');
      process.exit(2);
    }
    if (r.status === 503) {
      log(`Hàng đợi đang tạm dừng: ${r.json?.error?.message ?? ''}`);
      if (ONCE) return;
      await sleep(POLL);
      continue;
    }
    if (r.status === 204) {
      if (ONCE) {
        log('Không có job nào đang chờ.');
        return;
      }
      await sleep(POLL);
      continue;
    }
    if (r.status !== 200) {
      log(`next trả ${r.status}: ${JSON.stringify(r.json)}`);
      if (ONCE) process.exit(1);
      await sleep(POLL);
      continue;
    }
    await handle(r.json as Job);
    if (ONCE) return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
