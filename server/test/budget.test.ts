import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim, finish, makeEnv, scene, setupProject, toStoryboardReview, toVideoReview, type Env, type Scenario } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const budget = async (sc: Scenario) => (await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body;

describe('approve video: điều kiện bắt buộc (kể cả gọi API trực tiếp)', () => {
  it('từ chối khi chưa có storyboard', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const r = await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
    expect(r.body.error.message).toContain('chưa có storyboard');
    // không có job video nào được tạo
    expect((await sc.user.get('/api/jobs?type=video')).body).toHaveLength(0);
    expect((await budget(sc)).reserved).toBe(0);
  });

  it('KHÔNG còn hạn mức credit: duyệt được dù đã tiêu/đặt trước nhiều; credit_budget gửi lên bị bỏ qua', async () => {
    // credit_budget=30 (đã bỏ) không chặn việc duyệt 3 video = 45 credit
    const sc = await setupProject(env, { scenes: 3, project: { credit_budget: 30 } });
    const ids = sc.scenes.map((s: any) => s.id);
    for (const id of ids) await toStoryboardReview(sc, id);
    for (const id of ids) expect((await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' })).status).toBe(200);
    expect(await budget(sc)).toEqual({
      used: 0,
      reserved: 45,
      credit_per_video: 15,
      max_attempts: 2,
      scenes: ids.map((id: number, i: number) => ({ scene_id: id, code: `C${i + 1}`, attempts_used: 1, max_attempts: 2 })),
    });
    // không có lỗi BUDGET_EXCEEDED ở video_block
    for (const s of (await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body) expect(s.video_block?.code).not.toBe('BUDGET_EXCEEDED');
    // credit đặt trước được giải phóng khi hủy job queued
    const jobs = (await sc.user.get('/api/jobs?type=video&status=queued')).body;
    await sc.user.post(`/api/jobs/${jobs[0].id}/cancel`, {});
    expect((await budget(sc)).reserved).toBe(30);
  });

  it('chỉ bị chặn bởi số lượt: duyệt được video thứ N dù đã tiêu rất nhiều credit', async () => {
    const sc = await setupProject(env, { scenes: 1, project: { max_attempts_per_scene: 5, credit_per_video: 40 } });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    for (let i = 1; i <= 5; i++) {
      const r = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
      expect(r.status, `lượt ${i}`).toBe(200);
      await finish(sc, await claim(sc));
    }
    expect((await budget(sc)).used).toBe(200); // 5 × 40, vượt xa mọi hạn mức cũ (120)
    const over = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    expect(over.status).toBe(409);
    expect(over.body.error).toEqual({ code: 'ATTEMPTS_EXCEEDED', message: 'Cảnh C1 đã dùng 5/5 lượt' });
    // comment regenerate_same cũng chỉ bị chặn bởi số lượt
    const c = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'lại', action: 'regenerate_same' });
    expect(c.body.error.code).toBe('ATTEMPTS_EXCEEDED');
    await sc.user.patch(`/api/projects/${sc.project.id}`, { max_attempts_per_scene: 6 });
    expect((await sc.user.post(`/api/scenes/${id}/comments`, { body: 'lại', action: 'regenerate_same' })).status).toBe(201);
  });

  it('video hoàn thành ghi sổ cái −15; còn lại giảm; credits_cost tùy biến được dùng', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    const [a, b] = sc.scenes.map((s: any) => s.id);
    await toStoryboardReview(sc, a);
    await toStoryboardReview(sc, b);
    await toVideoReview(sc, a);
    await toVideoReview(sc, b, { credits_cost: 20 });
    const ledger = (await sc.user.get(`/api/projects/${sc.project.id}/ledger`)).body;
    expect(ledger.entries.map((e: any) => [e.scene_code, e.delta, e.cumulative_used])).toEqual([
      ['C1', -15, 15],
      ['C2', -20, 35],
    ]);
    expect(ledger.entries[0]).not.toHaveProperty('balance');
    expect(ledger.totals).toEqual({ used: 35, reserved: 0 });
    const proj = (await sc.user.get(`/api/projects/${sc.project.id}`)).body;
    expect(proj).toMatchObject({ credits_used: 35, credits_reserved: 0 });
    expect(proj).not.toHaveProperty('credits_remaining');
    expect(proj).not.toHaveProperty('credit_budget');
  });

  it('từ chối khi đã đủ số lượt (2/2), kể cả khi còn credit', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await toVideoReview(sc, id);
    await toVideoReview(sc, id);
    const r = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'ATTEMPTS_EXCEEDED', message: 'Cảnh C1 đã dùng 2/2 lượt' });
    const s = await scene(sc, id);
    expect(s).toMatchObject({ attempts_used: 2, max_attempts: 2, status: 'video_review' });
    expect(s.video_block.code).toBe('ATTEMPTS_EXCEEDED');
    expect((await budget(sc)).used).toBe(30);
    // tăng max_attempts_per_scene thì duyệt được
    await sc.user.patch(`/api/projects/${sc.project.id}`, { max_attempts_per_scene: 3 });
    expect((await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' })).status).toBe(200);
  });

  it('job video lỗi nhưng có tốn credit vẫn tính một lượt và ghi sổ cái', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j = await claim(sc);
    const f = await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'Flow lỗi sau khi trừ credit', code: 'OTHER', credits_cost: 15 });
    expect(f.status).toBe(200);
    expect(await budget(sc)).toMatchObject({ used: 15, reserved: 0 });
    expect((await budget(sc)).scenes[0].attempts_used).toBe(1);
    const s = await scene(sc, id);
    expect(s.status).toBe('failed');
    // lượt tiếp theo mang số 2 (v2) dù chưa có video nào
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j2 = await claim(sc);
    expect(j2.payload.attempt).toBe(2);
    await sc.worker.post(`/api/worker/jobs/${j2.id}/fail`, { error: 'lại lỗi', credits_cost: 15 });
    const r = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    expect(r.body.error.code).toBe('ATTEMPTS_EXCEEDED');
  });

  it('job video lỗi không tốn credit không chiếm lượt', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    for (let i = 0; i < 3; i++) {
      expect((await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' })).status).toBe(200);
      const j = await claim(sc);
      await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'UI lạ', code: 'OTHER' });
    }
    expect((await budget(sc)).scenes[0].attempts_used).toBe(0);
    expect((await budget(sc)).used).toBe(0);
  });

  it('FLOW_OUT_OF_CREDIT: cảnh → blocked_budget, tạm dừng hàng đợi; sau khi nạp credit Flow thì tiếp tục hàng đợi và duyệt lại', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j = await claim(sc);
    await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'Flow hết credit', code: 'FLOW_OUT_OF_CREDIT' });
    expect((await scene(sc, id)).status).toBe('blocked_budget');
    expect((await sc.user.get('/api/worker/status')).body).toMatchObject({ queue_paused: true, pause_code: 'FLOW_OUT_OF_CREDIT' });
    await sc.user.post('/api/queue/resume', {});
    const again = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    expect(again.status).toBe(200);
    expect(again.body.scene.status).toBe('video_queued');
  });
});

describe('duyệt hàng loạt (approve-all)', () => {
  async function ready(n: number, project: Record<string, unknown> = {}) {
    const sc = await setupProject(env, { scenes: n, project });
    for (const s of sc.scenes) await toStoryboardReview(sc, s.id);
    return sc;
  }

  it('preview trả danh sách cảnh + tổng credit; approve-all tạo job cho tất cả', async () => {
    const sc = await ready(3);
    const p = (await sc.user.get(`/api/projects/${sc.project.id}/approve-all/preview?stage=video`)).body;
    expect(Object.keys(p).sort()).toEqual(['count', 'credit_per_video', 'scenes', 'skipped', 'stage', 'total_credits']);
    expect(p).toMatchObject({ stage: 'video', count: 3, total_credits: 45, credit_per_video: 15 });
    expect(p.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2', 'C3']);
    const r = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video', expectedCredits: 45 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stage: 'video', count: 3, total_credits: 45 });
    expect(r.body.jobs).toHaveLength(3);
    const scenes = (await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body;
    expect(scenes.map((s: any) => s.status)).toEqual(['video_queued', 'video_queued', 'video_queued']);
    expect(await budget(sc)).toMatchObject({ used: 0, reserved: 45 });
  });

  it('CREDITS_CHANGED khi expectedCredits khác tổng thực tế; không tạo job nào', async () => {
    const sc = await ready(3);
    const r = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video', expectedCredits: 30 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CREDITS_CHANGED');
    expect(r.body.error.details).toEqual({ expected: 30, actual: 45 });
    expect((await sc.user.get('/api/jobs?type=video')).body).toHaveLength(0);
    expect((await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video' })).status).toBe(400); // thiếu expectedCredits
  });

  it('không còn BUDGET_EXCEEDED: duyệt hàng loạt vượt mọi hạn mức cũ vẫn được, chỉ cần expectedCredits khớp', async () => {
    const sc = await ready(3, { credit_budget: 40, credit_per_video: 50 });
    const p = (await sc.user.get(`/api/projects/${sc.project.id}/approve-all/preview?stage=video`)).body;
    expect(p).toMatchObject({ count: 3, total_credits: 150, credit_per_video: 50 });
    expect(p).not.toHaveProperty('affordable');
    expect(p).not.toHaveProperty('remaining');
    const r = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video', expectedCredits: 150 });
    expect(r.status).toBe(200);
    expect(r.body.total_credits).toBe(150);
    expect((await budget(sc)).reserved).toBe(150);
  });

  it('cảnh đã đủ lượt bị bỏ qua (skipped), cảnh còn lại vẫn được duyệt', async () => {
    const sc = await ready(2);
    const [a] = sc.scenes.map((s: any) => s.id);
    await toVideoReview(sc, a);
    await toVideoReview(sc, a); // C1 đã 2/2
    // đưa C1 về storyboard_review bằng regenerate_storyboard
    await sc.user.post(`/api/scenes/${a}/comments`, { body: 'storyboard lại', action: 'regenerate_storyboard' });
    await finish(sc, await claim(sc));
    const p = (await sc.user.get(`/api/projects/${sc.project.id}/approve-all/preview?stage=video`)).body;
    expect(p.scenes.map((s: any) => s.code)).toEqual(['C2']);
    expect(p.skipped).toEqual([expect.objectContaining({ code: 'C1', reason_code: 'ATTEMPTS_EXCEEDED', message: 'Cảnh C1 đã dùng 2/2 lượt' })]);
    const r = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video', expectedCredits: 15 });
    expect(r.status).toBe(200);
    expect(r.body.jobs.map((j: any) => j.code)).toEqual(['C2']);
  });

  it('stage=storyboard duyệt các cảnh awaiting_approval (0 credit); không còn gì để duyệt → NOTHING_TO_APPROVE', async () => {
    const sc = await setupProject(env, { scenes: 3 });
    const p = (await sc.user.get(`/api/projects/${sc.project.id}/approve-all/preview?stage=storyboard`)).body;
    expect(p).toMatchObject({ count: 3, total_credits: 0 });
    const r = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'storyboard', expectedCredits: 0 });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    const again = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'storyboard' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOTHING_TO_APPROVE');
    expect((await sc.user.get(`/api/projects/${sc.project.id}/approve-all/preview?stage=nope`)).status).toBe(400);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('sửa tên, style_lock, số lượt, credit/video; credit_budget bị bỏ qua; xác thực đầu vào', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const r = await sc.user.patch(`/api/projects/${sc.project.id}`, {
      name: 'Tên mới',
      style_lock: 'Ánh sáng lạnh',
      credit_budget: 200, // đã bỏ: bị bỏ qua
      max_attempts_per_scene: 3,
      credit_per_video: 10,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Tên mới', style_lock: 'Ánh sáng lạnh', max_attempts_per_scene: 3, credit_per_video: 10 });
    expect(r.body).not.toHaveProperty('credit_budget');
    // chỉ gửi credit_budget → không đổi gì, không lỗi
    expect((await sc.user.patch(`/api/projects/${sc.project.id}`, { credit_budget: 5 })).status).toBe(200);
    expect(env.ctx.db.prepare('SELECT credit_budget FROM projects WHERE id = ?').get(sc.project.id)).toEqual({ credit_budget: 0 });
    expect(r.body.slug).toBe('cacao-actiso-plus'); // slug giữ nguyên để đường dẫn file không đổi
    expect((await sc.user.patch(`/api/projects/${sc.project.id}`, { credit_per_video: -5 })).status).toBe(400);
    expect((await sc.user.patch('/api/projects/9999', { name: 'x' })).status).toBe(404);
  });
});
