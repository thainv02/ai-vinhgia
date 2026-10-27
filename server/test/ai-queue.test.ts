import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitPlanningQueueChanges } from '../src/services/final-cuts.js';
import { insertJob } from '../src/services/job-create.js';
import { aiQueueInfoById } from '../src/services/job-queue.js';
import { client, claimEditPlan, makeEnv, setupAllDone, type Env } from './helpers.js';
import { managedClient } from './helpers-media.js';

/**
 * Vị trí trong hàng đợi của worker AI (một worker, tuần tự): số job đủ điều kiện, cùng làn worker, đứng trước job này; job nào đang chạy.
 * Dùng cho bước `edit_plan` của bản dựng hoàn chỉnh (`ai_queue` trong FinalCut) và bước phân tích của kế hoạch LAN.
 */
let env: Env;
afterEach(async () => {
  await env?.close();
});
const info = (id: number) => aiQueueInfoById(env.ctx, id);
const user = () => client(env.app);
const db = () => env.ctx.db;
const worker = () => client(env.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': 'w1' });

async function briefJob(name: string): Promise<{ projectId: number; jobId: number }> {
  const p = (await user().post('/api/projects', { name, brief: 'Một cảnh' })).body;
  const r = await user().post(`/api/projects/${p.id}/brief`, {});
  expect(r.status, r.raw).toBeLessThan(300);
  const job = db().prepare("SELECT id FROM jobs WHERE project_id = ? AND type = 'analyze_brief' ORDER BY id DESC").get(p.id) as { id: number };
  return { projectId: p.id as number, jobId: job.id };
}

describe('làn legacy (một worker Claude, tuần tự)', () => {
  it('edit_plan chờ sau các job cũ hơn; vị trí giảm khi worker nhận job; job đang chạy hiện đúng loại và `own`', async () => {
    env = await makeEnv();
    const sc = await setupAllDone(env, { scenes: 1 });
    const cutId = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body[0].id as number;
    const editJob = (await sc.user.get(`/api/final-cuts/${cutId}`)).body.job_id as number;
    const a = await briefJob('Phân tích A'); // id lớn hơn edit_plan
    const b = await briefJob('Phân tích B');
    env.clock.advance((env.ctx.config.workerOnlineSeconds + 1) * 1000); // worker (đã dùng để chuẩn bị dự án) im lặng quá lâu → offline

    // worker offline; edit_plan đứng đầu hàng
    expect(info(editJob)).toEqual({ state: 'waiting', position: 1, ahead: 0, running: null, worker: { online: false, paused: false }, wait_reason: null });
    expect(info(a.jobId)).toMatchObject({ state: 'waiting', position: 2, ahead: 1 });
    expect(info(b.jobId)).toMatchObject({ state: 'waiting', position: 3, ahead: 2 });
    // API: bản dựng đang `planning` mang ai_queue; các bản khác thì null
    expect((await sc.user.get(`/api/final-cuts/${cutId}`)).body).toMatchObject({ status: 'planning', ai_queue: { state: 'waiting', position: 1, ahead: 0, worker: { online: false } }, queue_state: null, queue_position: null });

    // worker online và nhận edit_plan
    const j = await claimEditPlan(sc);
    expect(j.id).toBe(editJob);
    expect(info(editJob)).toMatchObject({ state: 'running', position: null, ahead: 0, running: { type: 'edit_plan', own: true }, worker: { online: true } });
    expect(info(a.jobId)).toMatchObject({ state: 'waiting', position: 1, ahead: 0, running: { type: 'edit_plan', own: false } });
    expect(info(b.jobId)).toMatchObject({ position: 2, ahead: 1 });
    expect((await sc.user.get(`/api/final-cuts/${cutId}`)).body.ai_queue).toMatchObject({ state: 'running', position: null });

    // hết việc: không còn thông tin
    await worker().post(`/api/worker/jobs/${j.id}/fail`, { error: 'x', code: 'OTHER' });
    expect(info(editJob)).toBeNull();
    expect((await sc.user.get(`/api/final-cuts/${cutId}`)).body).toMatchObject({ status: 'failed', ai_queue: null });
  });

  it('chỉ đếm job ĐỦ ĐIỀU KIỆN: bỏ job chờ duyệt, job hoãn (wait_reason tương lai), job lỗi thời và job đã hủy; `wait_reason` của chính job được báo', async () => {
    env = await makeEnv();
    const sc = await setupAllDone(env, { scenes: 1 });
    const cutId = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body[0].id as number;
    const editJob = (await sc.user.get(`/api/final-cuts/${cutId}`)).body.job_id as number;
    const a = await briefJob('A');
    const b = await briefJob('B');
    const c = await briefJob('C');
    expect(info(c.jobId)).toMatchObject({ position: 4, ahead: 3 });

    // A chờ hạn mức AI tới tương lai → không chặn hàng; B bị hủy
    const future = new Date(env.clock.now() + 60_000).toISOString();
    db().prepare("UPDATE jobs SET wait_reason = 'ai_quota', next_attempt_at = ? WHERE id = ?").run(future, a.jobId);
    db().prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(b.jobId);
    expect(info(c.jobId)).toMatchObject({ position: 2, ahead: 1 }); // chỉ còn edit_plan phía trước
    expect(info(a.jobId)).toMatchObject({ state: 'waiting', wait_reason: 'ai_quota', position: 2 });
    expect(info(b.jobId)).toBeNull();
    // tới hạn thử lại → A lại đủ điều kiện
    env.clock.advance(61_000);
    expect(info(c.jobId)).toMatchObject({ position: 3, ahead: 2 });
    expect(info(a.jobId)).toMatchObject({ wait_reason: null });

    // job chưa được duyệt không bao giờ được claim → không đếm
    const unapproved = insertJob(env.ctx, { project_id: a.projectId, scene_id: null, type: 'analyze_brief', requires_approval: true, approved: false });
    const d = await briefJob('D');
    expect(unapproved).toBeLessThan(d.jobId);
    expect(info(d.jobId)).toMatchObject({ ahead: 3 }); // edit_plan, A, C (không có job chưa duyệt)

    // bản dựng của edit_plan không còn `planning` → job lỗi thời bị hủy lúc claim, không đếm
    db().prepare("UPDATE final_cuts SET status = 'cancelled' WHERE id = ?").run(cutId);
    expect(info(d.jobId)).toMatchObject({ ahead: 2 });
    expect(info(editJob)).toMatchObject({ state: 'waiting' }); // bản thân job vẫn còn hàng (sẽ bị hủy khi worker lấy)
  });

  it('báo trạng thái worker: offline → online (có request), tạm dừng hàng đợi', async () => {
    env = await makeEnv();
    const a = await briefJob('A');
    expect(info(a.jobId)?.worker).toEqual({ online: false, paused: false });
    await worker().get('/api/worker/ping');
    expect(info(a.jobId)?.worker).toEqual({ online: true, paused: false });
    db().prepare('UPDATE worker_state SET queue_paused = 1 WHERE id = 1').run();
    expect(info(a.jobId)?.worker).toEqual({ online: true, paused: true });
    env.clock.advance((env.ctx.config.workerOnlineSeconds + 1) * 1000);
    expect(info(a.jobId)?.worker).toEqual({ online: false, paused: true });
  });
});

describe('chế độ kết hợp: mỗi làn một worker', () => {
  it('job managed chỉ xếp cùng các job managed; storyboard (làn legacy) không chen vào vị trí và không phải "job đang chạy" của làn managed', async () => {
    env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: ['analyze_brief', 'revise_prompt', 'edit_plan'] } });
    // dự án 1: phân tích bằng managed rồi tạo storyboard (làn legacy)
    const p1 = (await user().post('/api/projects', { name: 'Mixed 1', brief: 'Một cảnh' })).body;
    await user().post(`/api/projects/${p1.id}/brief`, {});
    const a1 = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    const w = managedClient(env, 'W1', a1.lease_id, a1.id);
    expect((await w.post('/api/worker/scenes', { project_id: p1.id, scenes: [{ code: 'C1', title: 'x', prompt: 'p' }] })).status).toBe(200);
    expect((await w.post(`/api/worker/jobs/${a1.id}/complete`, { result: { summary: 'ok' } }, { 'idempotency-key': 'k1' })).status).toBe(200);
    const scene = (await user().get(`/api/projects/${p1.id}/scenes`)).body[0];
    expect((await user().post(`/api/scenes/${scene.id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const sb = db().prepare("SELECT id FROM jobs WHERE type = 'storyboard' ORDER BY id DESC").get() as { id: number };

    const a2 = await briefJob('Mixed 2'); // làn managed, id lớn hơn storyboard
    expect(a2.jobId).toBeGreaterThan(sb.id);
    expect(info(a2.jobId)).toMatchObject({ state: 'waiting', position: 1, ahead: 0, running: null }); // storyboard không đứng trước
    expect(info(sb.id)).toMatchObject({ state: 'waiting', position: 1, ahead: 0, running: null }); // analyze (managed) không đứng trước storyboard

    // managed worker nhận a2 → bận; storyboard (làn legacy) vẫn thấy worker legacy rảnh
    const got = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    expect(got.id).toBe(a2.jobId);
    expect(info(a2.jobId)).toMatchObject({ state: 'running', running: { type: 'analyze_brief', own: true } });
    expect(info(sb.id)).toMatchObject({ state: 'waiting', position: 1, running: null });
    const a3 = await briefJob('Mixed 3');
    expect(info(a3.jobId)).toMatchObject({ state: 'waiting', position: 1, ahead: 0, running: { type: 'analyze_brief', own: false } });
  });
});

describe('SSE: vị trí hàng đợi AI đổi', () => {
  it('emitPlanningQueueChanges phát final_cut.updated (kèm ai_queue) khi tình trạng đổi, không phát lại khi không đổi; lần đầu thấy không phát', async () => {
    env = await makeEnv();
    const events: any[] = [];
    const res: any = new EventEmitter();
    res.writeHead = vi.fn();
    res.write = (txt: string) => {
      const ev = /^event: (.+)$/m.exec(txt);
      const data = /^data: (.+)$/m.exec(txt);
      if (ev?.[1] === 'final_cut.updated' && data) events.push(JSON.parse(data[1]!).final_cut);
    };
    res.end = vi.fn();
    env.ctx.sse.add(res, null);
    const sc = await setupAllDone(env, { scenes: 1 });
    events.length = 0; // bỏ các sự kiện lúc tạo
    expect(emitPlanningQueueChanges(env.ctx)).toBe(0); // lần đầu thấy: ghi nhớ, không phát
    expect(emitPlanningQueueChanges(env.ctx)).toBe(0);
    env.clock.advance((env.ctx.config.workerOnlineSeconds + 1) * 1000); // worker offline
    expect(emitPlanningQueueChanges(env.ctx)).toBe(1);
    expect(events.at(-1)).toMatchObject({ status: 'planning', ai_queue: { state: 'waiting', position: 1, worker: { online: false } } });
    expect(emitPlanningQueueChanges(env.ctx)).toBe(0);
    await worker().get('/api/worker/ping'); // online lại
    expect(emitPlanningQueueChanges(env.ctx)).toBe(1);
    expect(events.at(-1).ai_queue.worker.online).toBe(true);
    await claimEditPlan(sc); // worker nhận edit_plan
    expect(emitPlanningQueueChanges(env.ctx)).toBe(1);
    expect(events.at(-1).ai_queue).toMatchObject({ state: 'running', running: { type: 'edit_plan', own: true } });
    expect(emitPlanningQueueChanges(env.ctx)).toBe(0);
  });
});
