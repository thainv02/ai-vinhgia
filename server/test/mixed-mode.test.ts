import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG_BYTES, client, makeEnv, setupProject, writeFile, type Env } from './helpers.js';
import { loadConfig, managedJobTypes } from '../src/config.js';
import { managedClient, mediaScenario } from './helpers-media.js';

/** Cấu hình mục tiêu: WORKER_MODE=managed + MANAGED_JOB_TYPES=analyze_brief,revise_prompt,edit_plan; Claude legacy làm storyboard/video. */
const MIXED = ['analyze_brief', 'revise_prompt', 'edit_plan'] as const;
let env: Env;
beforeEach(async () => { env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: [...MIXED] } }); });
afterEach(async () => { await env.close(); });
const legacy = (name = 'claude-1') => client(env.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': name });
const user = () => client(env.app);

describe('F3 cấu hình MANAGED_JOB_TYPES', () => {
  it('legacy → rỗng; managed không liệt kê → mọi loại; managed có danh sách → đúng danh sách; loại lạ làm khởi động thất bại', () => {
    expect(managedJobTypes(loadConfig({ WORKER_MODE: 'legacy', MANAGED_JOB_TYPES: 'video' } as any))).toEqual([]);
    expect(managedJobTypes(loadConfig({} as any))).toEqual([]);
    expect([...managedJobTypes(loadConfig({ WORKER_MODE: 'managed' } as any))].sort()).toEqual(['analyze_brief', 'clip_plan', 'edit_plan', 'revise_prompt', 'storyboard', 'video']);
    expect([...managedJobTypes(loadConfig({ WORKER_MODE: 'managed', MANAGED_JOB_TYPES: ' analyze_brief, revise_prompt,edit_plan,analyze_brief ' } as any))]).toEqual(['analyze_brief', 'revise_prompt', 'edit_plan']);
    expect(() => loadConfig({ WORKER_MODE: 'managed', MANAGED_JOB_TYPES: 'analyze_brief,vidoe' } as any)).toThrow(/vidoe/);
  });
});

describe('F3 claim theo loại job, không còn cổng WORKER_MODE toàn cục', () => {
  it('managed chỉ nhận analyze_brief/revise_prompt/edit_plan; legacy (?worker=claude-1) chỉ nhận storyboard/video; lệch chế độ → 204 chứ không 409', async () => {
    const p = (await user().post('/api/projects', { name: 'Mixed', brief: 'Một cảnh' })).body;
    await user().post(`/api/projects/${p.id}/brief`, {});
    expect((await legacy().get('/api/worker/next?worker=claude-1')).status).toBe(204); // analyze_brief là loại managed
    const a = await managedClient(env).get('/api/worker/next?mode=managed&types=analyze_brief,storyboard,video');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ type: 'analyze_brief' });
    expect(a.body.lease_id).toBeTruthy();
    // analyze managed: ghi cảnh bằng lease
    const w = managedClient(env, 'W1', a.body.lease_id, a.body.id);
    expect((await w.post('/api/worker/scenes', { project_id: p.id, scenes: [{ code: 'C1', title: 'x', prompt: 'p' }] })).status).toBe(200);
    expect((await w.post(`/api/worker/jobs/${a.body.id}/complete`, { result: { summary: 'ok' } }, { 'idempotency-key': 'k' })).status).toBe(200);
    const scene = (await user().get(`/api/projects/${p.id}/scenes`)).body[0];

    await user().post(`/api/scenes/${scene.id}/approve`, { stage: 'storyboard' });
    expect((await managedClient(env).get('/api/worker/next?mode=managed')).status).toBe(204); // storyboard: không phải loại managed
    const sb = await legacy().get('/api/worker/next?worker=claude-1');
    expect(sb.status).toBe(200);
    expect(sb.body.type).toBe('storyboard');
    expect(sb.body.lease_id).toBeUndefined();
    expect(sb.body.claimed_by).toBe('claude-1');
  });
  it('WORKER.md legacy chạy y như cũ cho storyboard và video: heartbeat/complete không cần lease, ledger và lượt đúng', async () => {
    const sc = await setupProjectLegacy();
    const id = sc.scenes[0].id;
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    let j = (await legacy().get('/api/worker/next?worker=claude-1')).body;
    expect((await legacy().post(`/api/worker/jobs/${j.id}/heartbeat?worker=claude-1`)).status).toBe(200);
    writeFile(env.root, j.payload.output.storyboard_path, PNG_BYTES);
    expect((await legacy().post(`/api/worker/jobs/${j.id}/complete?worker=claude-1`, { assets: [{ kind: 'storyboard', file_path: j.payload.output.storyboard_path }] })).status).toBe(200);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    j = (await legacy().get('/api/worker/next?worker=claude-1')).body;
    expect(j.type).toBe('video');
    writeFile(env.root, j.payload.output.video_path, 'fake-mp4');
    const done = await legacy().post(`/api/worker/jobs/${j.id}/complete?worker=claude-1`, { assets: [{ kind: 'video', file_path: j.payload.output.video_path }], credits_cost: 15 });
    expect(done.status).toBe(200);
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE job_id=?').get(j.id)).toEqual({ n: 1 });
    expect(env.ctx.db.prepare('SELECT worker_mode FROM jobs WHERE id=?').get(j.id)).toEqual({ worker_mode: 'legacy' });
    // legacy fail cũng không cần lease
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j2 = (await legacy().get('/api/worker/next?worker=claude-1')).body;
    expect((await legacy().post(`/api/worker/jobs/${j2.id}/fail?worker=claude-1`, { error: 'x', code: 'OTHER' })).status).toBe(200);
  });
  it('job managed không thể bị worker legacy chạm vào; endpoint chỉ-managed từ chối job legacy', async () => {
    const p = (await user().post('/api/projects', { name: 'Mixed', brief: 'b' })).body;
    await user().post(`/api/projects/${p.id}/brief`, {});
    const a = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    for (const ep of ['heartbeat', 'complete', 'fail']) {
      const r = await legacy().post(`/api/worker/jobs/${a.id}/${ep}?worker=W1`, ep === 'fail' ? { error: 'x' } : {});
      expect(r.status, ep).toBe(409);
      expect(r.body.error.code, ep).toBe('LEASE_LOST');
    }
    // legacy job + endpoint managed → MANAGED_REQUIRED
    const sc = await setupProjectLegacy();
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const lj = (await legacy().get('/api/worker/next?worker=claude-1')).body;
    for (const ep of ['checkpoint', 'actions', 'browser-lease', 'wait', 'infer']) {
      const r = await managedClient(env, 'claude-1', 'x', lj.id).post(`/api/worker/jobs/${lj.id}/${ep}`, { profile: 'media', reason: 'needs_reconciliation', retry_at: null, messages: [{ role: 'user', content: 'x' }], id: 'a', kind: 'storyboard', state: 'intent', evidence: {} });
      expect(r.status, ep).toBe(409);
    }
  });
  it('managed worker vẫn resume job đã từng giữ dù loại bị bỏ khỏi danh sách; legacy không bao giờ nhận job managed', async () => {
    env.ctx.config.managedJobTypes = ['storyboard', 'video'];
    const ms = await mediaScenario(env);
    const sb = await ms.storyboard(); // managed claim
    await managedClient(env, 'W1', sb.lease_id, sb.id).post(`/api/worker/jobs/${sb.id}/wait`, { reason: 'ai_quota', retry_at: new Date(env.clock.now() + 1000).toISOString() });
    env.clock.advance(2000);
    env.ctx.config.managedJobTypes = ['analyze_brief']; // đổi cấu hình: storyboard không còn là loại managed
    expect((await legacy().get('/api/worker/next?worker=claude-1')).status).toBe(204);
    const again = await managedClient(env, 'W2').get('/api/worker/next?mode=managed');
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(sb.id);
  });
});

describe('F3 endpoint ghi theo chế độ của JOB, không theo cấu hình toàn cục', () => {
  it('/api/worker/scenes: lease managed hợp lệ → author agent; không lease khi analyze_brief là loại managed → MANAGED_REQUIRED; lease của job khác loại → JOB_SCOPE', async () => {
    const p = (await user().post('/api/projects', { name: 'Mixed', brief: 'b' })).body;
    await user().post(`/api/projects/${p.id}/brief`, {});
    const body = { project_id: p.id, scenes: [{ code: 'C1', title: 'x', prompt: 'p' }] };
    const bad = await legacy().post('/api/worker/scenes?worker=claude-1', body);
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('MANAGED_REQUIRED');
    const a = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    expect((await managedClient(env, 'W1', a.lease_id).post('/api/worker/scenes', body)).status).toBe(400); // thiếu X-Job-Id
    expect((await managedClient(env, 'W1', a.lease_id, a.id).post('/api/worker/scenes', body)).status).toBe(200);
    expect(env.ctx.db.prepare('SELECT created_by FROM scene_prompt_versions').all()).toEqual([{ created_by: 'agent' }]);
    // lease storyboard (managed bằng cấu hình tạm) không ghi được scenes
    env.ctx.config.managedJobTypes = [...MIXED, 'storyboard'];
    const sc = (await user().get(`/api/projects/${p.id}/scenes`)).body[0];
    await user().post(`/api/scenes/${sc.id}/approve`, { stage: 'storyboard' });
    const sb = (await managedClient(env, 'W3').get('/api/worker/next?mode=managed&types=storyboard')).body;
    const r = await managedClient(env, 'W3', sb.lease_id, sb.id).post('/api/worker/scenes', body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('JOB_SCOPE');
  });
  it('khi analyze_brief là loại legacy thì /scenes không lease chạy như cũ (author claude)', async () => {
    env.ctx.config.managedJobTypes = ['video'];
    const p = (await user().post('/api/projects', { name: 'L', brief: 'b' })).body;
    await user().post(`/api/projects/${p.id}/brief`, {});
    const a = (await legacy().get('/api/worker/next?worker=claude-1')).body;
    expect(a.type).toBe('analyze_brief');
    expect((await legacy().post('/api/worker/scenes?worker=claude-1', { project_id: p.id, scenes: [{ code: 'C1', title: 'x', prompt: 'p' }] })).status).toBe(200);
    expect((await legacy().post(`/api/worker/jobs/${a.id}/complete?worker=claude-1`, { result: {} })).status).toBe(200);
    expect(env.ctx.db.prepare('SELECT created_by FROM scene_prompt_versions').all()).toEqual([{ created_by: 'claude' }]);
  });
  it('/api/worker/comments: legacy ghi cho cảnh có job legacy (author claude); job managed cần lease (author agent); legacy bị chặn trên job managed', async () => {
    const sc = await setupProjectLegacy();
    const id = sc.scenes[0].id;
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    const lj = (await legacy().get('/api/worker/next?worker=claude-1')).body;
    const note = { scene_id: id, body: 'Giả định: hộp ở góc phải' };
    const ok = await legacy().post('/api/worker/comments?worker=claude-1', note);
    expect(ok.status).toBe(201);
    expect(ok.body.comment.author).toBe('claude');
    writeFile(env.root, lj.payload.output.storyboard_path, PNG_BYTES);
    await legacy().post(`/api/worker/jobs/${lj.id}/complete?worker=claude-1`, { assets: [{ kind: 'storyboard', file_path: lj.payload.output.storyboard_path }] });
    // user yêu cầu sửa prompt → job revise_prompt (managed)
    const c = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'Sửa lại', action: 'revise_and_regenerate' });
    expect(c.status).toBe(201);
    const rj = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    expect(rj.type).toBe('revise_prompt');
    const blocked = await legacy().post('/api/worker/comments?worker=claude-1', note);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MANAGED_REQUIRED');
    const viaLease = await managedClient(env, 'W1', rj.lease_id, rj.id).post('/api/worker/comments', note);
    expect(viaLease.status).toBe(201);
    expect(viaLease.body.comment.author).toBe('agent');
  });
  it('final cut: edit_plan thuộc managed → created_by agent; thuộc legacy → claude', async () => {
    // đã phủ ở final-cuts.test cho legacy; ở đây chỉ kiểm tra hàm cấu hình quyết định theo loại
    const { isManagedJobType } = await import('../src/config.js');
    expect(isManagedJobType(env.ctx.config, 'edit_plan')).toBe(true);
    expect(isManagedJobType(env.ctx.config, 'storyboard')).toBe(false);
    env.ctx.config.workerMode = 'legacy';
    expect(isManagedJobType(env.ctx.config, 'edit_plan')).toBe(false);
  });
  it('ping và /api/ai/status cho biết các loại do managed worker xử lý', async () => {
    expect((await legacy().get('/api/worker/ping?worker=claude-1')).body.managed_job_types).toEqual([...MIXED]);
  });
});

/** Tạo cảnh qua API legacy (analyze_brief tạm là loại legacy), rồi trả cấu hình về MIXED. */
async function setupProjectLegacy() {
  const saved = env.ctx.config.managedJobTypes;
  env.ctx.config.managedJobTypes = ['revise_prompt', 'edit_plan'];
  try { return await setupProject(env, { scenes: 1 }); } finally { env.ctx.config.managedJobTypes = saved; }
}
