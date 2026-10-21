import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, client, type Env, PNG_BYTES, setupProject } from './helpers.js';
import { createAccount } from '../src/services/ai/accounts.js';
import { normalizeFailure } from '../src/services/ai/router.js';
import { sweepStaleJobs } from '../src/services/jobs.js';

let env: Env;
const servers: http.Server[] = [];
beforeEach(async () => { env = await makeEnv({ config: { workerMode: 'managed' } }); });
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())); await env.close(); });
const worker = (name = 'A', lease?: string, jobId?: number) => client(env.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': name, ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}) });
async function job() {
  const p = (await client(env.app).post('/api/projects', { name: 'Managed', brief: 'Một cảnh sản phẩm' })).body;
  await client(env.app).post(`/api/projects/${p.id}/brief`, {});
  return (await worker().get('/api/worker/next?mode=managed')).body;
}
async function gateway(status: number, body: unknown, onRequest?: () => void) {
  const s = http.createServer((req, res) => {
    onRequest?.();
    expect(req.headers.authorization).toMatch(/^Bearer /);
    res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '120' } : {}) }); res.end(JSON.stringify(body));
  });
  servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as any).port}/v1`;
}
function add(alias: string, base_url: string, extra = {}) {
  return createAccount(env.ctx, { alias, provider: 'codex', model: 'test-model', base_url, priority: alias === 'A' ? 1 : 2, capabilities: ['text', 'vision', 'tools'], ...extra });
}
const request = { messages: [{ role: 'user', content: 'Một cảnh' }], tools: [], capabilities: ['text'] };

describe('managed worker: account failover and durable ownership', () => {
  it('forwards a reference-image context larger than 8MB and checkpoints it for resume', async () => {
    let received = 0;
    const s = http.createServer((req, res) => {
      req.on('data', (chunk) => { received += chunk.length; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    add('A', `http://127.0.0.1:${(s.address() as any).port}/v1`);
    const j = await job(), w = worker('A', j.lease_id);
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024) } }] }];
    expect((await w.post(`/api/worker/jobs/${j.id}/infer`, { messages, capabilities: ['vision'] })).status).toBe(200);
    expect(received).toBeGreaterThan(8 * 1024 * 1024);
    expect((await w.post(`/api/worker/jobs/${j.id}/checkpoint`, { step: 'inference', messages })).status).toBe(200);
    expect(JSON.stringify((await client(env.app).get(`/api/jobs/${j.id}`)).body)).not.toContain('data:image');
    env.clock.advance(6 * 60000); sweepStaleJobs(env.ctx);
    const resumed = (await worker('B').get('/api/worker/next?mode=managed')).body;
    expect(resumed.checkpoint.messages).toEqual(messages);
  });
  it('keeps inference/checkpoint context bounded and ordinary writes at the existing limit', async () => {
    const j = await job(), w = worker('A', j.lease_id);
    for (const endpoint of ['infer', 'checkpoint']) {
      const r = await w.post(`/api/worker/jobs/${j.id}/${endpoint}`, {}, { 'content-length': String(32 * 1024 * 1024 + 1) });
      expect(r.status).toBe(413);
      expect(r.body.error.code).toBe('BODY_TOO_LARGE');
    }
    expect((await client(env.app).post('/api/projects', { name: 'Large ordinary request', brief: 'A'.repeat(3 * 1024 * 1024) })).status).toBe(413);
  });
  it('A hết quota → B tiếp tục request, cooldown A và ghi attribution, không lộ credential', async () => {
    let callsA = 0, callsB = 0;
    const a = add('A', await gateway(429, { error: { code: 'quota_exhausted' } }, () => callsA++));
    const b = add('B', await gateway(200, { choices: [{ message: { content: '{"ok":true}' } }] }, () => callsB++));
    const j = await job();
    const r = await worker('A', j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request);
    expect(r.status).toBe(200); expect(r.body.account.id).toBe(b.id);
    expect(callsA).toBe(1); expect(callsB).toBe(1);
    const ar = env.ctx.db.prepare('SELECT state,retry_after,last_error FROM ai_accounts WHERE id=?').get(a.id) as any;
    expect(ar).toMatchObject({ state: 'cooldown', last_error: 'quota_exhausted' });
    expect(Date.parse(ar.retry_after) - env.clock.now()).toBe(120000);
    const key = fs.readFileSync(path.join(env.ctx.config.aiHome, String(a.id), 'access-key'), 'utf8');
    expect(JSON.stringify((await client(env.app).get('/api/ai/accounts')).body)).not.toContain(key);
    expect(env.ctx.db.prepare('SELECT outcome FROM ai_attempts ORDER BY id').all()).toEqual([{ outcome: 'quota_exhausted' }, { outcome: 'ok' }]);
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM credit_ledger').get()).toEqual({ n: 0 });
  });
  it('quota chung ngăn chuyển tới account khác trong cùng scope', async () => {
    let calls = 0;
    add('A', await gateway(429, { error: 'quota' }), { quota_scope_key: 'workspace' });
    add('B', await gateway(200, {}, () => calls++), { quota_scope_key: 'workspace' });
    const j = await job();
    expect((await worker('A', j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).status).toBe(503);
    expect(calls).toBe(0);
  });
  it('hết account → wait giữ checkpoint, chỉ claim lại khi tới hạn', async () => {
    const j = await job(), w = worker('A', j.lease_id);
    expect((await w.post(`/api/worker/jobs/${j.id}/infer`, request)).body.error.code).toBe('AI_UNAVAILABLE');
    await w.post(`/api/worker/jobs/${j.id}/checkpoint`, { step: 'written', result: { scenes: [] } });
    const retryAt = new Date(env.clock.now() + 60000).toISOString();
    expect((await w.post(`/api/worker/jobs/${j.id}/wait`, { reason: 'ai_quota', retry_at: retryAt })).status).toBe(200);
    expect((await worker('B').get('/api/worker/next?mode=managed')).status).toBe(204);
    env.clock.advance(60001);
    const resumed = (await worker('B').get('/api/worker/next?mode=managed')).body;
    expect(resumed.id).toBe(j.id); expect(resumed.lease_epoch).toBe(2);
    expect(resumed.checkpoint.step).toBe('written'); expect(resumed.payload).toEqual(j.payload);
    expect((await w.post(`/api/worker/jobs/${j.id}/heartbeat`, {})).status).toBe(409);
  });
  it('worker cũ không thể complete/fail/ghi cảnh sau khi job được claim lại', async () => {
    const j = await job(), w = worker('A', j.lease_id);
    env.clock.advance(6 * 60000); sweepStaleJobs(env.ctx);
    const next = (await worker('B').get('/api/worker/next?mode=managed')).body;
    expect(next.id).toBe(j.id); expect(next.lease_id).not.toBe(j.lease_id);
    for (const endpoint of ['complete', 'fail', 'checkpoint']) expect((await w.post(`/api/worker/jobs/${j.id}/${endpoint}`, endpoint === 'fail' ? { error: 'old' } : {})).status).toBe(409);
    expect((await worker('A', j.lease_id, j.id).post('/api/worker/scenes', { project_id: j.project_id, scenes: [{ code: 'C1', prompt: 'old' }] })).status).toBe(409);
  });
  it('intent chưa rõ sau crash → cần đối soát, không tự claim lại để submit', async () => {
    const j = await job();
    await worker('A', j.lease_id).post(`/api/worker/jobs/${j.id}/actions`, { id: 'a', profile: 'media', kind: 'video', state: 'intent', evidence: {} });
    env.clock.advance(6 * 60000); sweepStaleJobs(env.ctx);
    expect((await worker('B').get('/api/worker/next?mode=managed')).status).toBe(204);
    expect((await client(env.app).get(`/api/jobs/${j.id}`)).body.wait_reason).toBe('needs_reconciliation');
  });
  it('complete lặp cùng key trả kết quả cũ; key/body khác bị từ chối', async () => {
    const j = await job(), w = worker('A', j.lease_id, j.id);
    expect((await w.post('/api/worker/scenes', { project_id: j.project_id, scenes: [{ code: 'C1', prompt: 'product' }] })).status).toBe(200);
    const body = { result: { summary: 'one scene' } }, headers = { 'idempotency-key': 'finish' };
    expect((await w.post(`/api/worker/jobs/${j.id}/complete`, body, headers)).status).toBe(200);
    expect((await w.post(`/api/worker/jobs/${j.id}/complete`, body, headers)).status).toBe(200);
    expect((await w.post(`/api/worker/jobs/${j.id}/complete`, { result: {} }, headers)).status).toBe(409);
    expect(env.ctx.db.prepare('SELECT created_by FROM scene_prompt_versions').get()).toEqual({ created_by: 'agent' });
  });
  it('chặn worker legacy khi server chạy managed, filter loại job', async () => {
    expect((await worker().get('/api/worker/next')).status).toBe(409);
    await job();
    expect((await worker('B').get('/api/worker/next?mode=managed&types=video')).status).toBe(204);
  });
  it('không cho fallback provider/model nếu chưa bật policy', async () => {
    add('A', await gateway(429, { error: 'quota' }));
    let calls = 0;
    add('B', await gateway(200, { choices: [{ message: { content: '{}' } }] }, () => calls++), { provider: 'antigravity' });
    const j = await job();
    expect((await worker('A', j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).status).toBe(503);
    expect(calls).toBe(0);
    env.ctx.db.prepare('INSERT INTO ai_project_policy VALUES(?,?)').run(j.project_id, JSON.stringify({ allow_provider_fallback: true }));
    expect((await worker('A', j.lease_id).post(`/api/worker/jobs/${j.id}/infer`, request)).status).toBe(200);
    expect(calls).toBe(1);
  });
  it('browser profile chỉ thuộc một lease tại một thời điểm', async () => {
    const a = await job(), b = await job();
    expect((await worker('A', a.lease_id).post(`/api/worker/jobs/${a.id}/browser-lease`, { profile: 'media' })).status).toBe(200);
    expect((await worker('A', b.lease_id).post(`/api/worker/jobs/${b.id}/browser-lease`, { profile: 'media' })).status).toBe(409);
  });
  it('checkpoint public không lộ ngữ cảnh; claim tiếp theo phục hồi đầy đủ', async () => {
    const j = await job();
    await worker('A', j.lease_id).post(`/api/worker/jobs/${j.id}/checkpoint`, { step: 'inference', messages: [{ content: 'private-context' }] });
    expect(JSON.stringify((await client(env.app).get(`/api/jobs/${j.id}`)).body)).not.toContain('private-context');
    env.clock.advance(6 * 60000); sweepStaleJobs(env.ctx);
    const next = (await worker('B').get('/api/worker/next?mode=managed')).body;
    expect(next.checkpoint.messages[0].content).toBe('private-context');
  });
  it('probe phát hiện cùng login, không đếm thành hai account độc lập', async () => {
    const a = add('A', await gateway(200, { data: [{ id: 'test-model' }] }));
    const b = add('B', await gateway(200, { data: [{ id: 'test-model' }] }));
    for (const r of [a, b]) fs.writeFileSync(path.join(env.ctx.config.aiHome, String(r.id), 'identity'), 'a'.repeat(64));
    const { probeAccount } = await import('../src/services/ai/router.js');
    expect((await probeAccount(env.ctx, a.id)).ok).toBe(true);
    expect(await probeAccount(env.ctx, b.id)).toMatchObject({ ok: false, reason: 'duplicate_identity' });
    expect(env.ctx.db.prepare('SELECT enabled FROM ai_accounts WHERE id=?').get(b.id)).toEqual({ enabled: 0 });
  });
});

describe('account admin and normalized failures', () => {
  it('restore DB không được ghi đè store credential còn tồn tại', () => {
    const dir = path.join(env.ctx.config.aiHome, '1');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'access-key'), 'existing-secret');
    expect(() => add('A', 'http://127.0.0.1:19999/v1')).toThrow(/Store này đã tồn tại/);
    expect(fs.readFileSync(path.join(dir, 'access-key'), 'utf8')).toBe('existing-secret');
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM ai_accounts').get()).toEqual({ n: 0 });
  });
  it('đòi cookie + CSRF, chặn cross-site session, không tạo bằng request user thông thường', async () => {
    const user = client(env.app);
    const input = { alias: 'X', provider: 'codex', model: 'x' };
    expect((await user.post('/api/ai/accounts', input)).status).toBe(403);
    expect((await user.get('/api/ai/session', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const session = await user.get('/api/ai/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    expect((await user.post('/api/ai/accounts', input, { cookie, 'x-ai-csrf': session.body.csrf })).status).toBe(201);
  });
  it('phân biệt rate limit/quota/đăng nhập, không ghi upstream error body', () => {
    const now = env.clock.now();
    expect(normalizeFailure(429, 'slow down', '2', now)).toMatchObject({ code: 'rate_limited', retryAt: new Date(now + 2000).toISOString() });
    expect(normalizeFailure(429, 'quota exhausted', null, now).code).toBe('quota_exhausted');
    expect(normalizeFailure(401, 'secret-token', null, now)).toMatchObject({ code: 'login_required', retryAt: null });
  });
  it('video complete hai lần chỉ ghi một asset/ledger', async () => {
    env.ctx.config.workerMode = 'legacy';
    const sc = await setupProject(env);
    const id = sc.scenes[0].id;
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    let j = (await worker().get('/api/worker/next')).body;
    const rel = j.payload.output.storyboard_path; fs.writeFileSync(path.join(env.root, rel), PNG_BYTES);
    await worker().post(`/api/worker/jobs/${j.id}/complete`, { assets: [{ kind: 'storyboard', file_path: rel }] });
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    env.ctx.config.workerMode = 'managed';
    j = (await worker().get('/api/worker/next?mode=managed')).body;
    const v = j.payload.output.video_path; fs.writeFileSync(path.join(env.root, v), 'test-video');
    const w = worker('A', j.lease_id), data = { assets: [{ kind: 'video', file_path: v }], credits_cost: 15 };
    expect((await w.post(`/api/worker/jobs/${j.id}/complete`, data, { 'idempotency-key': 'video' })).status).toBe(200);
    expect((await w.post(`/api/worker/jobs/${j.id}/complete`, data, { 'idempotency-key': 'video' })).status).toBe(200);
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM assets WHERE job_id=?').get(j.id)).toEqual({ n: 1 });
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE job_id=?').get(j.id)).toEqual({ n: 1 });
  });
});
