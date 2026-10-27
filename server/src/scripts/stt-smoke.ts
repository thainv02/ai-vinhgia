/**
 * Thử THỦ CÔNG dịch vụ nhận dạng lời nói thật (KHÔNG chạy trong `npm test`; test tự động dùng server STT giả).
 *
 *   npx tsx server/src/scripts/stt-smoke.ts <file audio/video> ["Tên riêng, thuật ngữ"]
 *
 * Biến môi trường: STT_URL (mặc định http://10.0.3.214:18085/v1/audio/transcriptions), STT_TENANT_ID (mặc định s-omnix-studio).
 * Việc làm: tách audio mono 16 kHz mp3 48k (như server) → POST → in job id, thời gian, văn bản, số từ, các câu dựng được → hỏi lại kết quả theo
 * `GET /v1/stt/jobs/{id}` và in HÌNH DẠNG phản hồi thực tế (khoá cấp cao, trạng thái) để đối chiếu với `extractResult` của stt-client.
 * Chỉ dùng với audio tổng hợp ngắn (vd `say -v Linh`), vài lần là đủ.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STT_DEFAULT_TENANT, STT_RETRY_DELAYS_MS } from '../config.js';
import { ffmpegOf } from '../services/media.js';
import { extractResult, sttJobUrl, sttOrigin, transcribeAudio } from '../services/clips/stt-client.js';
import { buildTranscript } from '../services/clips/transcript.js';

const url = process.env.STT_URL || 'http://10.0.3.214:18085/v1/audio/transcriptions';
const tenantId = process.env.STT_TENANT_ID || STT_DEFAULT_TENANT;
const input = process.argv[2];
const terms = process.argv[3] ?? null;
if (!input) {
  console.error('Cách dùng: tsx server/src/scripts/stt-smoke.ts <file> ["Tên riêng, thuật ngữ"]');
  process.exit(2);
}

const ffmpeg = ffmpegOf({ ffmpegPath: process.env.FFMPEG_PATH || null });
if (!ffmpeg) throw new Error('Không tìm thấy ffmpeg');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stt-smoke-')), 'audio.mp3');
const ex = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.resolve(input), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', tmp], { encoding: 'utf8' });
if (ex.status !== 0) throw new Error(`ffmpeg tách audio lỗi: ${ex.stderr}`);
console.log(`audio tạm: ${(fs.statSync(tmp).size / 1024).toFixed(0)} KB`);

try {
  const h = await fetch(`${sttOrigin(url)}/health`, { signal: AbortSignal.timeout(10_000) });
  console.log(`GET /health -> ${h.status} ${(await h.text()).slice(0, 200)}`);
} catch (e) {
  console.log(`GET /health lỗi: ${e instanceof Error ? e.message : e}`);
}

const ctl = new AbortController();
const t0 = Date.now();
const out = await transcribeAudio(tmp, terms, {
  url,
  tenantId,
  signal: ctl.signal,
  timeoutMs: 10 * 60_000,
  maxRetries: 2,
  retryDelaysMs: STT_RETRY_DELAYS_MS,
  pollMs: 3000,
  onJobId: (id) => console.log(`X-Job-Id: ${id}`),
  onRetry: (r) => console.log(`thử lại lần ${r.attempt} sau ${r.delayMs} ms: ${r.reason}`),
});
console.log(`xong sau ${Date.now() - t0} ms (dịch vụ báo ${out.result.elapsed_ms ?? '?'} ms), model=${out.result.model}, language=${out.result.language}, duration=${out.result.duration}`);
console.log(`text: ${out.result.text}`);
console.log(`segments=${out.result.segments.length} words=${out.result.words.length}`);
const t = buildTranscript(out.result, { terms, durationHintS: out.result.duration ?? null });
console.log(`sentences=${t.sentences.length} speech_ratio=${t.speech_ratio}`);
for (const s of t.sentences.slice(0, 5)) console.log(`  S${s.id} [${s.start.toFixed(2)}–${s.end.toFixed(2)}] ${s.text}`);

if (out.jobId) {
  const r = await fetch(sttJobUrl(url, out.jobId), { headers: { 'X-Tenant-ID': tenantId }, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  console.log(`GET /v1/stt/jobs/${out.jobId} -> ${r.status}, ${text.length} byte`);
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    console.log(`khoá cấp cao: ${Object.keys(body).join(', ')}`);
    for (const k of ['status', 'state', 'job_id', 'task', 'model']) if (k in body) console.log(`  ${k} = ${JSON.stringify(body[k])}`);
    console.log(`extractResult nhận ra kết quả: ${extractResult(body) ? 'CÓ' : 'KHÔNG'}`);
  } catch {
    console.log(`(không phải JSON) ${text.slice(0, 300)}`);
  }
}
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
