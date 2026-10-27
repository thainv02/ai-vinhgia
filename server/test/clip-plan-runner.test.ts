import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildTranscript, snapBounds } from '../src/services/clips/transcript.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../worker/src/api-failure.js';
import { handleJob, type RunnerDeps } from '../../worker/src/runner.js';
import { createAccount } from '../src/services/ai/accounts.js';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { makeEnv, userClient, type Env } from './helpers.js';
import { seedClipProject, type Seeded } from './helpers-clips.js';

/**
 * Job `clip_plan` chạy THẬT end-to-end: server thật (inject) + managed worker thật (handleJob) + gateway AI giả có kịch bản.
 * Không gọi AI thật. Gateway nhận diện từng loại lời gọi (phân loại / đề xuất / kiểm định / khôi phục) từ system prompt.
 */
let env: Env;
let gateway: http.Server;
let gatewayUrl = '';
let seeded: Seeded;
const seen: { kind: string; vision: boolean }[] = [];
let failVerifyOnce = false;
let forcedMoments: object[] | null = null;

const sentences = Array.from({ length: 40 }, (_, i) => Array.from({ length: 10 }, (_, k) => `c${i}t${k}`).join(' '));

function reply(kind: string, text: string): string {
  const lines = [...text.matchAll(/\[S(\d+) \| [\d:]+\] ([^\n]*)/g)].map((m) => ({ id: Number(m[1]), text: m[2]! }));
  const quote = (id: number) => lines.find((l) => l.id === id)!.text.split(' ').slice(0, 5).join(' ');
  if (kind === 'type') return '{"content_type":"podcast","information_density":"vừa"}';
  if (kind === 'moments') {
    if (forcedMoments) return JSON.stringify({ moments: forcedMoments });
    return JSON.stringify({ moments: [
      { start_id: 2, end_id: 9, start_quote: quote(2), title: 'bí quyết đầu tiên', hook: 'Bí quyết không ai nói với bạn', score: 92, reason: 'mở đầu mạnh' },
      { start_id: 20, end_id: 27, start_quote: quote(20), title: 'khoảnh khắc cười lớn', hook: 'Cả phòng cười nghiêng ngả', score: 75, reason: 'cảm xúc' },
    ] });
  }
  if (kind === 'verify') {
    const keys = [...text.matchAll(/Ứng viên (c\d+):/g)].map((m) => m[1]!);
    return JSON.stringify({ results: keys.map((id) => ({ id, keep: true, standalone_score: 0.88, diagnosis: 'none', fix: null })) });
  }
  const m = /<loi_thoai>\n([\s\S]*?)\n<\/loi_thoai>/.exec(text)!;
  return JSON.stringify({ text: m[1]!.split(' ').map((w, k) => (k === 0 ? w[0]!.toUpperCase() + w.slice(1) : k % 10 === 9 ? `${w}.` : w)).join(' ') });
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  seen.length = 0;
  failVerifyOnce = false;
  forcedMoments = null;
  env = await makeEnv({ config: { clipMinFreeGb: 0, workerMode: 'managed', managedJobTypes: ['clip_plan'] } });
  seeded = seedClipProject(env, { sentences, wordS: 0.5, video: { seconds: 300, size: '320x180' } });
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const sys = String(body.messages[0].content);
      const kind = sys.includes('phân loại nội dung') ? 'type' : sys.includes('biên tập viên chọn đoạn') ? 'moments' : sys.includes('kiểm định') ? 'verify' : 'restore';
      const userMsg = body.messages.find((m: any) => m.role === 'user').content;
      const parts: any[] = Array.isArray(userMsg) ? userMsg : [{ type: 'text', text: userMsg }];
      seen.push({ kind, vision: parts.some((p) => p.type === 'image_url') });
      if (kind === 'verify' && failVerifyOnce) {
        failVerifyOnce = false;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return void res.end('{"error":"quota exhausted"}');
      }
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply(kind, text) } }] }));
    });
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}/v1`;
  createAccount(env.ctx, { alias: 'A', provider: 'codex', model: 'm', base_url: gatewayUrl, priority: 1, capabilities: ['text', 'vision', 'tools'] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => gateway.close(() => r()));
  await thumbsIdle(env.ctx);
  await env.close();
});

/** `api` của worker nối thẳng vào server thật (inject), cùng giao thức như client.ts. */
const makeApi = (): RunnerDeps['api'] => async (method, url, body, lease, jobId, extra = {}) => {
  const res = await env.app.inject({
    method: method as 'GET',
    url,
    payload: body === undefined ? undefined : (body as object),
    headers: { host: 'localhost', authorization: 'Bearer test-worker-token', 'x-worker-id': 'W1', ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}), ...extra },
  });
  if (res.statusCode === 204) return null as never;
  const b = JSON.parse(res.body);
  if (res.statusCode >= 400) throw new ApiFailure(b.error?.code ?? 'HTTP_ERROR', b.error?.message ?? 'lỗi', b.error?.details);
  return b;
};
const deps = (api: RunnerDeps['api']): RunnerDeps => ({ api, root: env.root, sleep: async () => undefined, stopping: () => false, makeBrowser: () => ({ guard: async () => undefined, run: async () => ({}) as never, close: async () => undefined, uploads: [] }) as never });

describe('worker managed chạy clip_plan end-to-end', () => {
  it('claim → nhiều lời gọi /infer (kèm lưới 4 khung thật từ video nguồn) → complete: clip proposed do agent tạo, điểm cắt do server tính, chữ phụ đề khôi phục', async () => {
    const c = userClient(env.app);
    expect((await c.post(`/api/projects/${seeded.projectId}/clip-plan`, { count: 2, duration_preset: '30_60', focus: 'phần bí quyết' })).status).toBe(201);
    const api = makeApi();
    const job = await api<any>('GET', '/api/worker/next?mode=managed&types=clip_plan');
    expect(job).toMatchObject({ type: 'clip_plan', lease_id: expect.any(String) });
    await handleJob(job, deps(api));

    const kinds = seen.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'type')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'moments')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'verify')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'restore')).toHaveLength(2);
    expect(seen.find((s) => s.kind === 'verify')!.vision).toBe(true); // ảnh lưới khung hình thật đã được gửi

    const d = (await c.get(`/api/clip-projects/${seeded.projectId}`)).body;
    expect(d.plan_job).toMatchObject({ status: 'done', created_clips: 2 });
    expect(d.clips.map((x: any) => [x.code, x.status, x.created_by, x.start_sentence, x.end_sentence, x.title])).toEqual([
      ['K1', 'proposed', 'agent', 2, 9, 'bí quyết đầu tiên'],
      ['K2', 'proposed', 'agent', 20, 27, 'khoảnh khắc cười lớn'],
    ]);
    expect(d.clips[0]).toMatchObject({ score: 92, content_type: 'podcast', hook: 'Bí quyết không ai nói với bạn', verify: { status: 'kept', standalone_score: 0.88, diagnosis: 'none' }, caption_edited: false });
    expect(d.clips[0].caption_words[0]).toEqual({ i: seeded.transcript.sentences[2]!.start_word, w: 'C2t0' });
    expect(d.clips[0].caption_words[9].w).toBe('c2t9.');
    // giây do SERVER tính từ chỉ số từ (AI không trả giây)
    const s2 = seeded.transcript.sentences[2]!;
    expect(d.clips[0].start_s).toBeGreaterThan(s2.start - 0.2);
    expect(d.clips[0].start_s).toBeLessThanOrEqual(s2.start);
    // job đã được commit đúng và checkpoint lưu trạng thái clip_plan
    const row = env.ctx.db.prepare('SELECT status, checkpoint, completion_key FROM jobs WHERE id = ?').get(job.id) as any;
    expect(row.status).toBe('done');
    expect(row.completion_key).toBe(`complete-${job.id}`);
    expect(JSON.parse(row.checkpoint).complete.result.clips).toHaveLength(2);
  }, 60_000);

  it('transcript thật 318 từ: timeout rồi thử lại → gateway giả → kiểm định ảnh → dấu câu → complete giữ điểm giữa câu', async () => {
    const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/clips-e2e/${name}.json`, import.meta.url), 'utf8'));
    const t = buildTranscript(read('stt-verbose'), { pauses: read('pauses') });
    fs.writeFileSync(path.join(env.root, `output/${seeded.slug}/clips/transcript.json`), JSON.stringify(t));
    const start_word = t.words.findIndex((w) => w.w === 'riêng');
    const end_word = t.words.findIndex((w, i) => i > start_word && w.w === 'ạ');
    const start_id = t.sentences.find((s) => s.start_word <= start_word && s.end_word >= start_word)!.id;
    const end_id = t.sentences.find((s) => s.start_word <= end_word && s.end_word >= end_word)!.id;
    forcedMoments = [{ start_id, end_id, start_quote: t.words.slice(start_word, start_word + 6).map((w) => w.w).join(' '), end_quote: t.words.slice(end_word - 5, end_word + 1).map((w) => w.w).join(' '), title: 'Ưu đãi hôm nay', hook: 'Quà tặng dành riêng phiên live', score: 90, reason: 'chốt ưu đãi' }];
    const c = userClient(env.app);
    await c.post(`/api/projects/${seeded.projectId}/clip-plan`, { count: 1, duration_preset: '15_30' });
    const baseApi = makeApi(); let failures = 0;
    const api: RunnerDeps['api'] = async (...args) => {
      if (args[1].endsWith('/infer') && failures++ === 0) throw new DOMException('timed out', 'TimeoutError');
      return baseApi(...args);
    };
    const job = await api<any>('GET', '/api/worker/next?mode=managed&types=clip_plan');
    await handleJob(job, deps(api));
    const d = (await c.get(`/api/clip-projects/${seeded.projectId}`)).body;
    expect(d.plan_job).toMatchObject({ status: 'done', created_clips: 1 });
    expect(d.clips[0]).toMatchObject({ start_word, end_word, ...snapBounds(t, start_word, end_word), verify: { status: 'kept', boundary: 'word_quote' } });
    expect(d.clips[0].caption_words).toHaveLength(end_word - start_word + 1);
    expect(d.clips[0].caption_words[0]).toMatchObject({ i: start_word, w: 'Riêng' });
    expect(seen.map((x) => x.kind)).toEqual(['type', 'moments', 'verify', 'restore']);
    expect(seen.find((x) => x.kind === 'verify')?.vision).toBe(true);
    const completed = JSON.parse((env.ctx.db.prepare('SELECT result FROM jobs WHERE id = ?').get(job.id) as any).result);
    expect(completed.diagnostics).toEqual({ proposed: 1, rejected: [] });
  }, 60_000);

  it('hết hạn mức AI giữa chừng → job chờ (wait ai_quota) giữ checkpoint; chạy lại thì TIẾP TỤC, không gọi lại bước đã xong', async () => {
    const c = userClient(env.app);
    await c.post(`/api/projects/${seeded.projectId}/clip-plan`, { count: 2, duration_preset: '30_60' });
    const api = makeApi();
    failVerifyOnce = true;
    const job1 = await api<any>('GET', '/api/worker/next?mode=managed&types=clip_plan');
    await handleJob(job1, deps(api));
    expect(seen.map((s) => s.kind)).toEqual(['type', 'moments', 'verify']); // verify bị 429 → dừng
    const waiting = env.ctx.db.prepare('SELECT status, wait_reason, checkpoint FROM jobs WHERE id = ?').get(job1.id) as any;
    expect(waiting).toMatchObject({ status: 'queued', wait_reason: 'ai_quota' });
    const cp = JSON.parse(waiting.checkpoint);
    expect(cp.clip_plan.content_type).toBe('podcast');
    expect(cp.clip_plan.candidates).toHaveLength(2);
    expect((await c.get(`/api/clip-projects/${seeded.projectId}`)).body.plan_job).toMatchObject({ status: 'queued', wait_reason: 'ai_quota' });
    // tới hạn thử lại
    env.clock.advance(5 * 60_000);
    seen.length = 0;
    const job2 = await api<any>('GET', '/api/worker/next?mode=managed&types=clip_plan');
    expect(job2.id).toBe(job1.id);
    expect(job2.checkpoint.clip_plan.candidates).toHaveLength(2);
    await handleJob(job2, deps(api));
    expect(seen.map((s) => s.kind)).toEqual(['verify', 'restore', 'restore']); // KHÔNG gọi lại phân loại và đề xuất
    expect((await c.get(`/api/clip-projects/${seeded.projectId}`)).body.clips).toHaveLength(2);
  }, 60_000);

  it('đề xuất sai độ dài bị worker tự loại → không còn ứng viên → kết quả rỗng hợp lệ (job done, có not_found_reason), không tạo clip', async () => {
    const c = userClient(env.app);
    await c.post(`/api/projects/${seeded.projectId}/clip-plan`, { count: 2, duration_preset: '15_30' }); // khoảng 15–30 s nhưng gateway đề xuất 47 s
    const api = makeApi();
    const job = await api<any>('GET', '/api/worker/next?mode=managed&types=clip_plan');
    await handleJob(job, deps(api));
    // worker tự loại các đề xuất sai độ dài → không còn ứng viên → kết quả rỗng hợp lệ (không phải lỗi)
    const d = (await c.get(`/api/clip-projects/${seeded.projectId}`)).body;
    expect(d.clips).toEqual([]);
    expect(d.plan_job).toMatchObject({ status: 'done', created_clips: 0 });
    expect(d.plan_job.not_found_reason).toBeTruthy();
  }, 60_000);
});
