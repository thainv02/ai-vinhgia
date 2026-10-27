import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { resolveBinary } from '../src/services/media.js';
import { hasSubtitlesFilter } from '../src/services/clips/render.js';
import { buildTranscript, type Transcript } from '../src/services/clips/transcript.js';
import type { Env } from './helpers.js';
import { makeTestVideo } from './final-helpers.js';

// ---------------------------------------------------------------- ffmpeg có libass (cháy phụ đề)

/** ffmpeg có bộ lọc `subtitles`: biến môi trường AUTOVIDEO_TEST_LIBASS_FFMPEG, rồi ffmpeg mặc định / ffmpeg-full. Null → test cháy phụ đề được bỏ qua. */
export function libassFfmpeg(): string | null {
  const cands = [process.env.AUTOVIDEO_TEST_LIBASS_FFMPEG, resolveBinary('ffmpeg', null), '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'];
  for (const c of cands) {
    if (!c || (c.includes('/') && !fs.existsSync(c))) continue;
    if (hasSubtitlesFilter(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------- server STT giả

export interface FakeWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

/** Kịch bản một lần gọi POST: `ok` trả kết quả, `busy` 503 retryable, `bad` 400 không retry, `timeout504` 504 kèm job_id rồi poll, `drop` đóng socket ngay, `dropAfterHeaders` gửi header (có X-Job-Id) rồi đứt. */
export type Step = 'ok' | 'busy' | 'bad' | 'timeout504' | 'drop' | 'dropAfterHeaders' | 'empty';

export interface FakeStt {
  url: string;
  origin: string;
  /** Hàng kịch bản (lấy lần lượt); hết thì dùng `fallback` (mặc định `ok`). */
  steps: Step[];
  fallback: Step;
  words: FakeWord[];
  /** `GET /v1/stt/jobs/:id` trả kèm `words` không (thật: không). */
  jobHasWords: boolean;
  /** Số lần poll trả `running` trước khi trả kết quả. */
  pollRunning: number;
  calls: { prompt: string | null; tenant: string | undefined; bytes: number }[];
  polls: { id: string; tenant: string | undefined }[];
  /** Đăng ký một job id đã biết (mô phỏng job do tiến trình server cũ gửi trước khi chết). */
  registerJob(id: string): void;
  /** Giữ mọi POST cho tới khi gọi `release()`. */
  hold(): void;
  release(): void;
  close(): Promise<void>;
}

/** Từ giả: đọc `script` (mảng câu, mỗi câu cách nhau khoảng lặng `gap`) thành từ có mốc thời gian 0.4 giây/từ. */
export function speechWords(sentences: string[], opts: { gap?: number; wordS?: number; start?: number } = {}): FakeWord[] {
  const gap = opts.gap ?? 1.0;
  const wordS = opts.wordS ?? 0.4;
  let t = opts.start ?? 0.5;
  const out: FakeWord[] = [];
  for (const s of sentences) {
    for (const w of s.split(/\s+/).filter(Boolean)) {
      out.push({ word: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + wordS) * 1000) / 1000, probability: 0.9 });
      t += wordS;
    }
    t += gap;
  }
  return out;
}

export function verboseOf(words: FakeWord[], segmentsOf: string[] | null = null) {
  // một segment cho mỗi câu (theo khoảng lặng ≥ 0.7 s) nếu không cho trước
  const segs: { id: number; start: number; end: number; text: string }[] = [];
  let cur: FakeWord[] = [];
  const flush = () => {
    if (cur.length) segs.push({ id: segs.length, start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.word).join(' ') });
    cur = [];
  };
  words.forEach((w, k) => {
    if (cur.length && w.start - cur[cur.length - 1]!.end >= 0.7) flush();
    cur.push(w);
    if (k === words.length - 1) flush();
  });
  void segmentsOf;
  const end = words.length ? words[words.length - 1]!.end : 0;
  return { task: 'transcribe', language: 'vi', duration: Math.ceil(end + 0.5), text: words.map((w) => w.word).join(' '), segments: segs, words, elapsed_ms: 1234, model: 'gipformer1.5-68M-rnnt' };
}

export async function startFakeStt(opts: { words?: FakeWord[] } = {}): Promise<FakeStt> {
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const jobs = new Map<string, { polls: number }>();
  let seq = 0;
  const fake: FakeStt = {
    url: '',
    origin: '',
    steps: [],
    fallback: 'ok',
    words: opts.words ?? speechWords(['xin chào cả nhà hôm nay có ưu đãi', 'giảm giá sốc mua ngay nhé']),
    jobHasWords: true,
    pollRunning: 0,
    calls: [],
    polls: [],
    registerJob(id: string) {
      jobs.set(id, { polls: 0 });
    },
    hold() {
      gate = new Promise((r) => (open = r));
    },
    release() {
      open?.();
      gate = null;
    },
    close: async () => {
      fake.release();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    await new Promise<void>((r) => req.on('end', () => r()));
    const body = Buffer.concat(chunks);
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url?.startsWith('/v1/stt/jobs/')) {
      const id = decodeURIComponent(req.url.split('/').pop()!);
      fake.polls.push({ id, tenant: req.headers['x-tenant-id'] as string | undefined });
      const job = jobs.get(id);
      if (!job) return json(404, { error: { message: 'job not found', code: 'not_found', retryable: false } });
      job.polls++;
      if (job.polls <= fake.pollRunning) return json(200, { job_id: id, state: 'running' });
      const v = verboseOf(fake.words);
      return json(200, { job_id: id, tenant_id: 's-omnix-studio', state: 'succeeded', text: v.text, segments: v.segments, duration_seconds: v.duration, model: v.model, error: null, ...(fake.jobHasWords ? { words: v.words } : {}) });
    }
    if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const text = body.toString('latin1');
      const m = /name="prompt"\r\n\r\n([^\r]*)\r\n/.exec(text);
      fake.calls.push({ prompt: m ? Buffer.from(m[1]!, 'latin1').toString('utf8') : null, tenant: req.headers['x-tenant-id'] as string | undefined, bytes: body.length });
      if (gate) await gate;
      const step = fake.steps.shift() ?? fake.fallback;
      const jobId = `job-${++seq}`;
      jobs.set(jobId, { polls: 0 });
      if (step === 'drop') return void req.socket.destroy();
      if (step === 'busy') return json(503, { error: { message: 'no capacity', type: 'service_unavailable', code: 'no_capacity', retryable: true, details: {} } });
      if (step === 'bad') return json(400, { error: { message: 'unsupported audio', type: 'invalid_request', code: 'invalid_audio', retryable: false } });
      if (step === 'timeout504') return json(504, { error: { message: 'timeout', type: 'timeout', code: 'transcription_timeout', retryable: false, details: { job_id: jobId } } });
      if (step === 'dropAfterHeaders') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-job-id': jobId, 'content-length': '100000' });
        res.write('{"task":"trans');
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      const data = step === 'empty' ? { ...verboseOf([]), text: '' } : verboseOf(fake.words);
      return json(200, data, { 'x-job-id': jobId });
    }
    json(404, { error: { message: 'not found' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  fake.origin = `http://127.0.0.1:${port}`;
  fake.url = `${fake.origin}/v1/audio/transcriptions`;
  return fake;
}

// ---------------------------------------------------------------- dữ liệu cắt clip trong DB

export const STT_FAST = { sttRetryDelaysMs: [5, 5, 5], sttPollMs: 5 };

/** Cấu hình app để dùng server STT giả (backoff/poll rất ngắn). `clipMinFreeGb: 0` để test không phụ thuộc ổ đĩa. */
export function sttConfig(fake: FakeStt, extra: Record<string, unknown> = {}) {
  return { sttProvider: 'omnix' as const, sttUrl: fake.url, sttTenantId: 's-omnix-studio', clipMinFreeGb: 0, ...STT_FAST, ...extra };
}

export async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean = Boolean as never, timeoutMs = 15_000, label = 'điều kiện'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`hết thời gian chờ ${label}; giá trị cuối: ${JSON.stringify(v)?.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface SeedOpts {
  name?: string;
  lan?: boolean;
  clientHash?: string;
  /** Video nguồn thật (ffmpeg testsrc + sine); false = file giả (không dựng được). */
  video?: { seconds: number; size?: string; fps?: number } | false;
  /** Các câu của transcript (mỗi câu cách nhau 1 giây lặng). */
  sentences?: string[];
  wordS?: number;
  status?: 'transcribed' | 'uploaded' | 'transcribing' | 'failed';
  terms?: string | null;
}

export interface Seeded {
  projectId: number;
  slug: string;
  sourceId: number;
  transcript: Transcript;
  sourceRel: string;
}

/** Tạo dự án cắt clip + video nguồn + transcript trực tiếp trong DB/đĩa (không qua STT). */
export function seedClipProject(env: Env, o: SeedOpts = {}): Seeded {
  const { ctx, root } = env;
  const now = ctx.now();
  const name = o.name ?? 'Phiên live cacao';
  const slug = `seed-${Math.random().toString(16).slice(2, 8)}`;
  const info = ctx.db
    .prepare("INSERT INTO projects (slug, name, brief, status, source, created_by_name, lan_client_hash, kind, stt_terms, created_at, updated_at) VALUES (?, ?, '', 'active', ?, ?, ?, 'clips', ?, ?, ?)")
    .run(slug, name, o.lan ? 'lan' : 'app', o.lan ? 'Khách' : null, o.clientHash ?? null, o.terms ?? null, now, now);
  const projectId = Number(info.lastInsertRowid);
  const sentences = o.sentences ?? Array.from({ length: 12 }, (_, i) => `đây là câu số ${i + 1} của buổi livestream bán hàng hôm nay nhé cả nhà ơi`);
  const words = speechWords(sentences, { wordS: o.wordS ?? 0.4, gap: 1.0 });
  const verbose = verboseOf(words);
  const transcript = buildTranscript(verbose, { contentHash: 'h'.repeat(64) });
  const clipsDir = `output/${slug}/clips`;
  const sourceRel = `${clipsDir}/source/${'a'.repeat(16)}.mp4`;
  let width: number | null = null;
  let height: number | null = null;
  let duration = transcript.duration_s;
  if (o.video !== false) {
    const v = o.video ?? { seconds: Math.ceil(transcript.duration_s) + 1 };
    makeTestVideo(path.join(root, sourceRel), v.seconds, { size: v.size ?? '640x360', fps: v.fps ?? 24 });
    const [w, h] = (v.size ?? '640x360').split('x').map(Number);
    width = w!;
    height = h!;
    duration = v.seconds;
  } else {
    fs.mkdirSync(path.join(root, clipsDir, 'source'), { recursive: true });
    fs.writeFileSync(path.join(root, sourceRel), 'fake');
  }
  const status = o.status ?? 'transcribed';
  const transcriptRel = `${clipsDir}/transcript.json`;
  if (status === 'transcribed') {
    fs.mkdirSync(path.join(root, clipsDir), { recursive: true });
    fs.writeFileSync(path.join(root, transcriptRel), JSON.stringify(transcript));
  }
  const src = ctx.db
    .prepare(
      `INSERT INTO source_videos (project_id, path, original_name, bytes, duration_s, width, height, fps, has_audio, status, progress, transcript_path, stt_meta, content_hash, created_at, transcribed_at)
       VALUES (?, ?, 'live.mp4', 1000, ?, ?, ?, 24, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      sourceRel,
      duration,
      width,
      height,
      status,
      status === 'transcribed' ? 100 : null,
      status === 'transcribed' ? transcriptRel : null,
      status === 'transcribed' ? JSON.stringify({ model: 'x', word_count: transcript.words.length, speech_ratio: transcript.speech_ratio, terms: o.terms ?? null }) : null,
      Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
      now,
      status === 'transcribed' ? now : null,
    );
  return { projectId, slug, sourceId: Number(src.lastInsertRowid), transcript, sourceRel };
}
