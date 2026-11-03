import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, client, type Env } from './helpers.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';
import { AI_MODEL_DEFAULT, DESKTOP_AI_API_URL, TEXT_JOB_TYPES, loadConfig } from '../src/config.js';
import { startEmbeddedWorker } from '../src/services/embedded-worker.js';
import { assembleStream } from '../src/services/ai/router.js';

let env: Env | null = null;
let L: LanEnv | null = null;
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await env?.close();
  await L?.close();
  env = null;
  L = null;
});

const worker = (lease?: string) => client(env!.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': 'desktop', ...(lease ? { 'x-job-lease': lease } : {}) });

/** API AI giả (chuẩn OpenAI): ghi lại request, trả `status`/`body` (chuỗi = gửi nguyên văn, vd SSE). */
async function fakeAi(status: number, body: unknown, headers: Record<string, string> = {}, limitedModel?: string) {
  const seen: { url: string; auth: string | undefined; body: any }[] = [];
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (status === 200 && req.url === '/v1/models' && !(body && typeof body === 'object' && 'data' in body)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }, ...(limitedModel ? [{ id: 'gemini-2.5-flash' }] : [])] }));
        return;
      }
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (limitedModel && raw && JSON.parse(raw).model === limitedModel) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
        res.end(JSON.stringify({ error: 'rate_limit_exceeded' }));
        return;
      }
      res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/event-stream' : 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as any).port}/v1`, seen };
}

async function claimAnalyze() {
  const p = (await client(env!.app).post('/api/projects', { name: 'Desktop', brief: 'Một cảnh sản phẩm' })).body;
  await client(env!.app).post(`/api/projects/${p.id}/brief`, {});
  return (await worker().get('/api/worker/next?mode=managed')).body;
}
const request = { messages: [{ role: 'user', content: 'Một cảnh' }], tools: [], capabilities: ['text', 'vision'] };

describe('cấu hình bản desktop', () => {
  it('giao diện chỉ nghe 127.0.0.1, job AI managed; giới hạn video nguồn như dự án thường; AI mặc định là máy chủ nội bộ', () => {
    const cfg = loadConfig({ LAN_HOST: '0.0.0.0' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ lanHost: '127.0.0.1', workerMode: 'managed', aiApiUrl: DESKTOP_AI_API_URL, trashRetentionDays: 0, sttProvider: 'local' });
    expect(cfg.managedJobTypes).toEqual(TEXT_JOB_TYPES);
    expect(cfg.lanClipSourceMaxBytes).toBe(cfg.clipSourceMaxBytes);
  });

  it('AI_API_URL/AI_MODEL đọc từ môi trường, bỏ dấu / cuối', () => {
    const cfg = loadConfig({ AI_API_URL: 'https://ai.example/v1/', AI_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ aiApiUrl: 'https://ai.example/v1', aiApiKey: 'k', aiModel: AI_MODEL_DEFAULT });
    expect(loadConfig({ AI_MODEL: 'gemini-3-flash' } as NodeJS.ProcessEnv).aiModel).toBe('gemini-3-flash');
  });


  it('GET /api/meta không lộ AI_API_KEY', async () => {
    env = await makeEnv({ config: { aiApiUrl: 'https://ai.example/v1', aiApiKey: 'sk-bi-mat' } });
    expect(JSON.stringify((await client(env.app).get('/api/meta')).body)).not.toContain('sk-bi-mat');
  });
});

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('gọi thẳng API AI (AI_API_URL)', () => {
  it('429 chuyển model trong cùng job và ghi đúng model thực tế của từng lần gọi', async () => {
    const ai = await fakeAi(200, { choices: [{ message: { content: 'ok' } }] }, {}, 'claude-sonnet-4-6');
    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: ai.url, aiApiKey: 'sk-test' } });
    const j = await claimAnalyze();
    const r = await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request);
    expect(r.status).toBe(200);
    expect(r.body.account.model).toBe('gemini-2.5-flash');
    expect(ai.seen.map(x => x.body.model)).toEqual(['claude-sonnet-4-6', 'gemini-2.5-flash']);
    expect(env.ctx.db.prepare('SELECT model, outcome FROM ai_attempts WHERE job_id = ? ORDER BY id').all(j.id)).toEqual([
      { model: 'claude-sonnet-4-6', outcome: 'rate_limited' }, { model: 'gemini-2.5-flash', outcome: 'ok' },
    ]);
  });
  it('ghép stream: nối content, gộp tool_calls theo index, lấy usage; bỏ reasoning_content và dòng rác', () => {
    const text = sse([
      { choices: [{ delta: { role: 'assistant', content: '', reasoning_content: 'nghĩ...' } }] },
      { choices: [{ delta: { content: '{"sce' } }] },
      { choices: [{ delta: { content: 'nes":[]}' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 9 } },
    ]);
    expect(assembleStream(': keep-alive\n' + text)).toEqual({ message: { content: '{"scenes":[]}' }, usage: { total_tokens: 9 } });
    const tools = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":2,' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] } }] },
    ]);
    expect(assembleStream(tools)!.message).toEqual({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] });
    expect(assembleStream('data: [DONE]\n')).toBeNull();
  });

  it('gửi /chat/completions dạng stream kèm Bearer key và model; trả message, ghi provenance "internal" không cần ai_accounts', async () => {
    const ai = await fakeAi(200, sse([{ choices: [{ delta: { content: '{"ok":' } }] }, { choices: [{ delta: { content: 'true}' } }], usage: { total_tokens: 3 } }]));
    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: ai.url, aiApiKey: 'sk-test', aiModel: 'claude-sonnet-4-6' } });
    const j = await claimAnalyze();
    const r = await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ message: { content: '{"ok":true}' }, account: { provider: 'internal', model: 'claude-sonnet-4-6' } });
    expect(ai.seen).toHaveLength(1);
    expect(ai.seen[0]).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer sk-test', body: { model: 'claude-sonnet-4-6', stream: true } });
    expect(ai.seen[0]!.body.tools).toBeUndefined();
    const attempt = env.ctx.db.prepare('SELECT account_id, model, outcome FROM ai_attempts WHERE job_id = ?').get(j.id);
    expect(attempt).toEqual({ account_id: null, model: 'claude-sonnet-4-6', outcome: 'ok' });
  });

  it('gateway bỏ qua stream và trả JSON thường: vẫn đọc được', async () => {
    const ai = await fakeAi(200, { choices: [{ message: { content: 'xin chào' } }] });
    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: ai.url, aiApiKey: 'sk-test' } });
    const j = await claimAnalyze();
    expect((await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).body.message).toEqual({ content: 'xin chào' });
  });

  it('429 → 503 AI_UNAVAILABLE kèm retry_at theo Retry-After (worker xếp job chờ)', async () => {
    const ai = await fakeAi(429, { error: 'quota' }, { 'Retry-After': '120' });
    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: ai.url, aiApiKey: 'sk-test' } });
    const j = await claimAnalyze();
    const r = await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request);
    expect([r.status, r.body.error.code]).toEqual([503, 'AI_UNAVAILABLE']);
    expect(Date.parse(r.body.error.details.retry_at) - env.clock.now()).toBe(120_000);
  });

  it('401, không kết nối được, thiếu key (không gọi mạng) → AI_UNAVAILABLE kèm retry_at: job chờ tới khi nhập key đúng', async () => {
    const bad = await fakeAi(401, { error: 'Invalid API key' });
    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: bad.url, aiApiKey: 'sk-sai' } });
    let j = await claimAnalyze();
    expect((await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'key_invalid' } });
    await env.close();

    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: 'http://127.0.0.1:9/v1', aiApiKey: 'sk-test' } });
    j = await claimAnalyze();
    expect((await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).body.error.code).toBe('AI_UNAVAILABLE');
    await env.close();

    const ai = await fakeAi(200, { choices: [{ message: { content: 'x' } }] });
    env = await makeEnv({ config: { workerMode: 'managed', aiApiUrl: ai.url, aiApiKey: '' } });
    j = await claimAnalyze();
    expect((await worker(j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'key_missing' } });
    expect(ai.seen).toHaveLength(0);
  });
});

describe('worker văn bản nhúng', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-embedded-'));
  const cfg = (dir: string) => ({ port: 1, workerToken: 't', rootDir: dir, dbPath: path.join(dir, 'data', 'app.db'), ffmpegPath: null, ffprobePath: null });

  it('truyền API/token/thư mục qua biến môi trường; chết thì chạy lại; stop() đóng stdin và đợi worker thoát', async () => {
    const dir = tmp();
    const marker = path.join(dir, 'runs.txt');
    // worker giả: ghi env rồi (lần 1) thoát ngay để bị chạy lại, (lần 2) chờ tới khi stdin đóng
    const script = path.join(dir, 'fake-worker.mjs');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
       fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ api: process.env.AUTOVIDEO_API, token: process.env.WORKER_TOKEN, root: process.env.AUTOVIDEO_ROOT, embedded: process.env.AUTOVIDEO_EMBEDDED }) + '\\n');
       if (fs.readFileSync(${JSON.stringify(marker)}, 'utf8').trim().split('\\n').length === 1) process.exit(3);
       process.stdin.on('end', () => process.exit(0)).resume();`,
    );
    const logs: string[] = [];
    const w = await startEmbeddedWorker({ config: cfg(dir), log: (_l, m) => logs.push(m), command: { bin: process.execPath, args: [script] }, restartDelayMs: 50 });
    const deadline = Date.now() + 5000;
    while ((fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0) < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const runs = fs.readFileSync(marker, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ api: 'http://127.0.0.1:1', token: 't', root: dir, embedded: '1' });
    expect(logs.some((l) => /Worker văn bản dừng \(mã 3\)/.test(l))).toBe(true);
    expect(w.running).toBe(true);
    await w.stop();
    expect(w.running).toBe(false);
  });

  it('không tìm thấy worker: ghi lỗi, không ném', async () => {
    const dir = tmp();
    const logs: string[] = [];
    const w = await startEmbeddedWorker({ config: cfg(dir), log: (_l, m) => logs.push(m), command: null });
    expect(w.running).toBe(false);
    expect(logs.join('\n')).toMatch(/Không tìm thấy worker văn bản/);
    await w.stop();
  });
});

describe('cài đặt API AI trên trang planner (bản desktop)', () => {
  const desk = async (aiUrl: string, extra: Record<string, unknown> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-desk-env-'));
    const envFile = path.join(dir, 'config.env');
    fs.writeFileSync(envFile, 'WORKER_TOKEN=abc\n');
    L = await makeLanEnv({ config: { aiApiUrl: aiUrl, aiApiKey: '', envFile, ...extra } });
    return { envFile, c: L.client() };
  };

  it('kiểm tra key → danh sách model; lưu → ghi config.env, áp dụng ngay; status/GET chỉ có 4 ký tự cuối, không lộ key', async () => {
    const ai = await fakeAi(200, { data: [{ id: 'claude-sonnet-4-6' }, { id: 'gemini-3-flash' }] });
    const { envFile, c } = await desk(ai.url);
    expect((await c.get('/lan/api/status')).body).toMatchObject({ desktop: true, ai: { url: ai.url, key_set: false, key_hint: null } });
    const check = await c.post('/lan/api/settings/ai/check', { api_key: 'sk-moi-12345678' });
    expect(check.body).toEqual({ ok: true, models: ['claude-sonnet-4-6', 'gemini-3-flash'] });
    expect(ai.seen[0]).toMatchObject({ url: '/v1/models', auth: 'Bearer sk-moi-12345678' });
    const saved = await c.put('/lan/api/settings/ai', { api_key: 'sk-moi-12345678' });
    expect(saved.body).toEqual({ url: ai.url, model: AI_MODEL_DEFAULT, key_set: true, key_hint: '…5678' });
    expect(L!.env.ctx.config).toMatchObject({ aiApiKey: 'sk-moi-12345678', aiModel: AI_MODEL_DEFAULT });
    expect(fs.readFileSync(envFile, 'utf8')).toBe('WORKER_TOKEN=abc\nAI_API_KEY=sk-moi-12345678\n');
    expect((await c.put('/lan/api/settings/ai', { model: 'gemini-3-flash' })).status).toBe(400);
    for (const url of ['/lan/api/status', '/lan/api/settings/ai']) expect(JSON.stringify((await c.get(url)).body)).not.toContain('sk-moi-12345678');
  });

  it('key sai → 400 AI_KEY_INVALID; key có khoảng trắng/xuống dòng bị chặn (không chèn được dòng vào config.env)', async () => {
    const ai = await fakeAi(401, { error: 'Invalid API key' });
    const { envFile, c } = await desk(ai.url);
    expect((await c.post('/lan/api/settings/ai/check', { api_key: 'sk-sai-12345678' })).body.error.code).toBe('AI_KEY_INVALID');
    const r = await c.put('/lan/api/settings/ai', { api_key: 'sk-12345678\nLAN_ENABLED=true' });
    expect(r.status).toBe(400);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('WORKER_TOKEN=abc\n');
  });

});
