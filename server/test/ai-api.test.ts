import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, client, type Env } from './helpers.js';
import { createAccount } from '../src/services/ai/accounts.js';
import { parseAiApi, AI_API_DEFAULT_MODEL } from '../src/config.js';

let env: Env | undefined;
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await env?.close(); env = undefined;
});

interface Seen { auth?: string; body: any }
/** API giả lập trên loopback; trả lần lượt các phản hồi trong `replies` (phản hồi cuối lặp lại). */
async function fakeApi(replies: { status: number; body: unknown; headers?: Record<string, string> }[], seen: Seen[] = []) {
  let i = 0;
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const r = replies[Math.min(i++, replies.length - 1)];
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers }); res.end(JSON.stringify(r.body));
    });
  });
  servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as any).port}`;
}
async function setup(url: string) {
  env = await makeEnv({ config: { workerMode: 'managed', aiApi: parseAiApi({ AI_API_URL: url, AI_API_KEY: 'sk-test-secret', AI_API_MODEL: 'remote-model' }) } });
  const worker = (lease?: string) => client(env!.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': 'A', ...(lease ? { 'x-job-lease': lease } : {}) });
  const p = (await client(env.app).post('/api/projects', { name: 'API', brief: 'Một cảnh sản phẩm' })).body;
  await client(env.app).post(`/api/projects/${p.id}/brief`, {});
  const job = (await worker().get('/api/worker/next?mode=managed')).body;
  return { job, w: worker(job.lease_id) };
}
const request = { messages: [{ role: 'user', content: 'Một cảnh' }], tools: [], capabilities: ['text', 'vision'] };

describe('AI API dùng chung (AI_API_URL)', () => {
  it('parseAiApi: rỗng → null; bắt buộc key, HTTPS (HTTP chỉ loopback), tự thêm /v1, model mặc định', () => {
    expect(parseAiApi({})).toBeNull();
    expect(parseAiApi({ AI_API_URL: 'https://ai.example.com', AI_API_KEY: 'k' })).toEqual({ baseUrl: 'https://ai.example.com/v1', key: 'k', model: AI_API_DEFAULT_MODEL, timeoutMs: 120_000 });
    expect(parseAiApi({ AI_API_URL: 'https://ai.example.com/v1/', AI_API_KEY: 'k', AI_API_MODEL: 'm' })).toMatchObject({ baseUrl: 'https://ai.example.com/v1', model: 'm' });
    expect(parseAiApi({ AI_API_URL: 'http://127.0.0.1:9/v1', AI_API_KEY: 'k' })?.baseUrl).toBe('http://127.0.0.1:9/v1');
    expect(() => parseAiApi({ AI_API_URL: 'https://ai.example.com' })).toThrow(/AI_API_KEY/);
    expect(() => parseAiApi({ AI_API_URL: 'http://ai.example.com', AI_API_KEY: 'k' })).toThrow(/HTTPS/);
    expect(() => parseAiApi({ AI_API_URL: 'https://u:p@ai.example.com', AI_API_KEY: 'k' })).toThrow(/HTTPS/);
    expect(parseAiApi({ AI_API_URL: 'https://ai.example.com', AI_API_KEY: 'k', AI_API_TIMEOUT_MS: '999999' })?.timeoutMs).toBe(125_000);
  });

  it('gọi thẳng API với model cố định, bỏ qua account pool, ghi provenance "api" và không lộ key', async () => {
    const seen: Seen[] = [];
    const url = await fakeApi([{ status: 200, body: { choices: [{ message: { content: '{"ok":true}' } }] } }], seen);
    const { job, w } = await setup(url);
    let poolCalls = 0;
    const pool = http.createServer((_q, res) => { poolCalls++; res.end('{}'); });
    servers.push(pool); await new Promise<void>((r) => pool.listen(0, '127.0.0.1', r));
    createAccount(env!.ctx, { alias: 'Pool', provider: 'codex', model: 'pool-model', base_url: `http://127.0.0.1:${(pool.address() as any).port}/v1`, priority: 1, capabilities: ['text', 'vision', 'tools'] });

    const r = await w.post(`/api/worker/jobs/${job.id}/infer`, request);
    expect(r.status).toBe(200);
    expect(r.body.account).toEqual({ id: null, alias: 'AI API', provider: 'api', model: 'remote-model' });
    expect(r.body.message.content).toBe('{"ok":true}');
    expect(poolCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe('Bearer sk-test-secret');
    expect(seen[0].body).toMatchObject({ model: 'remote-model', stream: false, messages: request.messages });
    expect(seen[0].body).not.toHaveProperty('tools');
    expect(env!.ctx.db.prepare('SELECT account_id,model,outcome FROM ai_attempts').all()).toEqual([{ account_id: null, model: 'remote-model', outcome: 'ok' }]);
    const jobs = (await client(env!.app).get('/api/jobs')).body;
    expect(JSON.stringify(jobs)).toContain('"provider":"api"');
    const status = (await client(env!.app).get('/api/ai/status')).body;
    expect(status.ai_api).toEqual({ base_url: `${url}/v1`, model: 'remote-model' });
    expect(JSON.stringify(status)).not.toContain('sk-test-secret');
  });

  it('gửi tools kèm parallel_tool_calls:false', async () => {
    const seen: Seen[] = [];
    const { job, w } = await setup(await fakeApi([{ status: 200, body: { choices: [{ message: { content: null, tool_calls: [] } }] } }], seen));
    const tool = { type: 'function', function: { name: 'browser_snapshot', description: 'x', parameters: { type: 'object', properties: {} } } };
    expect((await w.post(`/api/worker/jobs/${job.id}/infer`, { ...request, tools: [tool], capabilities: ['text', 'tools'] })).status).toBe(200);
    expect(seen[0].body).toMatchObject({ tools: [tool], parallel_tool_calls: false });
  });

  it('429 → AI_UNAVAILABLE theo Retry-After, chỉ gọi một lần (không xoay sang model/tài khoản khác)', async () => {
    const seen: Seen[] = [];
    const { job, w } = await setup(await fakeApi([{ status: 429, body: { error: 'quota' }, headers: { 'Retry-After': '90' } }], seen));
    const r = await w.post(`/api/worker/jobs/${job.id}/infer`, request);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('AI_UNAVAILABLE');
    expect(Date.parse(r.body.error.details.retry_at) - env!.clock.now()).toBe(90_000);
    expect(seen).toHaveLength(1);
    expect(env!.ctx.db.prepare('SELECT outcome FROM ai_attempts').all()).toEqual([{ outcome: 'quota_exhausted' }]);
  });

  it('401 → job chờ 5 phút (không fail); 404 model → AI_INVALID_REQUEST', async () => {
    const { job, w } = await setup(await fakeApi([{ status: 401, body: { error: 'Invalid API key' } }, { status: 404, body: { error: 'model not found' } }]));
    const a = await w.post(`/api/worker/jobs/${job.id}/infer`, request);
    expect(a.body.error.code).toBe('AI_UNAVAILABLE');
    expect(Date.parse(a.body.error.details.retry_at) - env!.clock.now()).toBe(300_000);
    const b = await w.post(`/api/worker/jobs/${job.id}/infer`, request);
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe('AI_INVALID_REQUEST');
  });

  it('API không kết nối được hoặc trả phản hồi hỏng → AI_UNAVAILABLE', async () => {
    const { job, w } = await setup(await fakeApi([{ status: 200, body: { nope: true } }]));
    const r = await w.post(`/api/worker/jobs/${job.id}/infer`, request);
    expect(r.body.error.code).toBe('AI_UNAVAILABLE');
    env!.ctx.config.aiApi = parseAiApi({ AI_API_URL: 'http://127.0.0.1:1', AI_API_KEY: 'k' });
    expect((await w.post(`/api/worker/jobs/${job.id}/infer`, request)).body.error.code).toBe('AI_UNAVAILABLE');
    expect(env!.ctx.db.prepare('SELECT outcome FROM ai_attempts ORDER BY id').all()).toEqual([{ outcome: 'invalid_response' }, { outcome: 'network_error' }]);
  });
});
