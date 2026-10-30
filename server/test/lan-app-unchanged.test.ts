import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attemptsUsed } from '../src/services/budget.js';
import { finalCutBlock, maybeAutoFinalCut } from '../src/services/final-cuts.js';
import { ALLOWED_TRANSITIONS } from '../src/services/transition.js';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { claimEditPlan, edlFor, makeEnv, setupAllDone, setupProject, toStoryboardReview, toVideoReview, userClient, workerClient, type Env, type Scenario } from './helpers.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';
import { makeLanPlan } from './helpers-lan-plan.js';
import { clip } from './helpers-video.js';

/**
 * CHỨNG MINH hành vi của dự án `source='app'` không đổi sau khi thêm bước 3 / bản dựng / công cụ cho LAN:
 * bảng chuyển trạng thái, đếm lượt, tự kích hoạt bản dựng, điều kiện dựng thủ công, thứ tự hàng đợi render, và file phục vụ.
 */
const run = FFMPEG && FFPROBE ? describe : describe.skip;

describe('bảng chuyển trạng thái của cảnh (transition) không đổi', () => {
  it('ALLOWED_TRANSITIONS giữ nguyên từng dòng: LAN không được thêm đường đi nào (vd awaiting_approval → done)', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      draft: ['prompt_ready'],
      prompt_ready: ['awaiting_approval', 'storyboard_queued'],
      awaiting_approval: ['storyboard_queued', 'video_queued', 'needs_revision'],
      storyboard_queued: ['storyboard_running', 'storyboard_review', 'awaiting_approval', 'failed'],
      storyboard_running: ['storyboard_queued', 'storyboard_review', 'awaiting_approval', 'failed'],
      storyboard_review: ['storyboard_queued', 'video_queued', 'needs_revision'],
      video_queued: ['video_running', 'video_review', 'storyboard_review', 'failed', 'blocked_budget'],
      video_running: ['video_queued', 'video_review', 'storyboard_review', 'failed', 'blocked_budget'],
      video_review: ['done', 'video_queued', 'storyboard_queued', 'needs_revision'],
      done: ['video_queued', 'storyboard_queued', 'video_review', 'needs_revision'],
      needs_revision: ['awaiting_approval', 'failed'],
      failed: ['storyboard_queued', 'video_queued', 'awaiting_approval', 'needs_revision'],
      blocked_budget: ['storyboard_queued', 'video_queued', 'awaiting_approval'],
      cancelled: [],
    });
  });
});

describe('dự án app: điều kiện dựng, tự kích hoạt và đếm lượt', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv({ finalRenderer: new FakeRenderer(), finalRender: { progressThrottleMs: 0 } });
  });
  afterEach(async () => {
    await env.close();
  });

  it('tự kích hoạt như cũ: chỉ khi MỌI cảnh `done` có video được chọn; thiếu một cảnh thì không; thông báo thủ công giữ nguyên "Còn C2 chưa chọn video"', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    const [a, b] = sc.scenes.map((s: any) => s.id);
    await toStoryboardReview(sc, a);
    await toVideoReview(sc, a);
    await sc.user.post(`/api/scenes/${a}/select-video`, {});
    expect((await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body).toEqual([]);
    const blocked = await sc.user.post(`/api/projects/${sc.project.id}/final-cuts`, {});
    expect([blocked.status, blocked.body.error.code, blocked.body.error.message]).toEqual([409, 'SCENES_NOT_READY', 'Còn C2 chưa chọn video']);
    expect((await sc.user.get(`/api/projects/${sc.project.id}`)).body.final_cut_block).toEqual({ code: 'SCENES_NOT_READY', message: 'Còn C2 chưa chọn video' });
    await toStoryboardReview(sc, b);
    await toVideoReview(sc, b);
    await sc.user.post(`/api/scenes/${b}/select-video`, {});
    const cuts = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body;
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ version: 1, status: 'planning', created_by: 'claude' });
    // và trạng thái cảnh vẫn do máy trạng thái app điều khiển (done qua transition)
    expect((env.ctx.db.prepare('SELECT DISTINCT status FROM scenes').all() as { status: string }[]).map((r) => r.status)).toEqual(['done']);
  });

  it('cảnh app chưa `done` dù đã gán selected_video_id vẫn KHÔNG tự kích hoạt (allDone vẫn đòi trạng thái done); dự án LAN thì không bao giờ tự dựng', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await toVideoReview(sc, sc.scenes[0].id);
    const asset = env.ctx.db.prepare("SELECT id FROM assets WHERE kind = 'video'").get() as { id: number };
    env.ctx.db.prepare('UPDATE scenes SET selected_video_id = ? WHERE id = ?').run(asset.id, sc.scenes[0].id); // video_review, đã chọn
    expect(maybeAutoFinalCut(env.ctx, sc.project.id)).toBeNull();
    env.ctx.db.prepare("UPDATE scenes SET status = 'done' WHERE id = ?").run(sc.scenes[0].id);
    expect(maybeAutoFinalCut(env.ctx, sc.project.id)).not.toBeNull(); // app: done + đã chọn → tạo

    // cùng dữ liệu nhưng dự án LAN: không tự dựng dù cảnh `done` và có video được chọn
    env.ctx.db.prepare("UPDATE projects SET source = 'lan' WHERE id = ?").run(sc.project.id);
    env.ctx.db.prepare("UPDATE final_cuts SET status = 'cancelled'").run();
    expect(maybeAutoFinalCut(env.ctx, sc.project.id)).toBeNull();
    const r = await sc.user.post(`/api/scenes/${sc.scenes[0].id}/select-video`, {}); // đường chọn video của app trên dự án LAN
    expect(r.status).toBe(200);
    expect((env.ctx.db.prepare('SELECT COUNT(*) AS n FROM final_cuts').get() as { n: number }).n).toBe(1); // vẫn chỉ bản đã hủy cũ
  });

  it('finalCutBlock của dự án app chỉ dựa trên video được chọn (như cũ), không phụ thuộc cách LAN kiểm tra', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    expect(finalCutBlock(env.ctx, sc.project.id)).toEqual({ code: 'SCENES_NOT_READY', message: 'Còn C1, C2 chưa chọn video' });
  });

  it('attemptsUsed: mọi asset video của cảnh app vẫn tính vào lượt (chỉ video tải lên từ LAN được loại)', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await toVideoReview(sc, sc.scenes[0].id);
    expect(attemptsUsed(env.ctx, sc.scenes[0].id)).toBe(1);
    const row = env.ctx.db.prepare('SELECT meta FROM assets WHERE kind = ?').get('video') as { meta: string };
    expect(row.meta).not.toContain('lan_upload');
    // asset video không có `source` hoặc meta rỗng/hỏng vẫn được đếm (không làm câu SQL lỗi)
    env.ctx.db.prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'video', 'output/x/video/a.mp4', 9, '{}', ?)").run(sc.scenes[0].id, env.ctx.now());
    env.ctx.db.prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'video', 'output/x/video/b.mp4', 10, 'khong-phai-json', ?)").run(sc.scenes[0].id, env.ctx.now());
    expect(attemptsUsed(env.ctx, sc.scenes[0].id)).toBe(3);
  });

  it('GET /api/lan: thêm tool_jobs_24h và queue, các trường cũ giữ nguyên', async () => {
    const r = await userClient(env.app).get('/api/lan');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['access_code', 'clip_project_count', 'enabled', 'error', 'host', 'listening', 'plan_count', 'port', 'queue', 'render', 'require_code', 'tool_jobs_24h', 'urls']);
    expect(r.body).toMatchObject({ enabled: false, listening: false, access_code: null, require_code: false, urls: [], plan_count: 0, tool_jobs_24h: 0, queue: { cuts: 0, tools: 0, clips: 0, total: 0, cap: 6 } });
    const now = env.ctx.now();
    env.ctx.db.prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'ready', 'a.mp4', 'h', '{}', ?)").run(now);
    env.ctx.db.prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'queued', 'b.mp4', 'h', '{}', ?)").run(now);
    env.ctx.db.prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'ready', 'c.mp4', 'h', '{}', '2020-01-01T00:00:00.000Z')").run();
    expect((await userClient(env.app).get('/api/lan')).body).toMatchObject({ tool_jobs_24h: 2, queue: { tools: 1, total: 1 } });
  });
});

run('hàng đợi render: việc của app chạy trước việc LAN; thứ tự giữa các việc app giữ FIFO', () => {
  let L: LanEnv;
  let fake: FakeRenderer;
  afterEach(async () => {
    fake?.release();
    await L?.close();
  });

  /** Tạo dự án app `n` cảnh và đưa bản dựng của nó tới `rendering` (đã gửi EDL). */
  async function appCutRendering(sc: Scenario) {
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 'x' } });
    expect(r.status, r.raw).toBe(200);
    return cut.id as number;
  }

  it('FIFO giữa các bản dựng app (X đang chạy → Y → Z); bản LAN đến giữa chừng bị đẩy xuống SAU mọi việc app đang chờ nhưng không ngắt việc đang chạy', async () => {
    fake = new FakeRenderer();
    L = await makeLanEnv({ app: { finalRenderer: fake, finalRender: { progressThrottleMs: 0 } }, config: { watermarkRemover: 'off', renderConcurrency: 1 } });
    const c = L.client();
    await c.login();
    fake.hold();
    const x = await appCutRendering(await setupAllDone(L.env, { scenes: 1, project: { name: 'App X' } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.map((k) => k.cutId)).toEqual([x]); // X đang chạy (giữ)
    const y = await appCutRendering(await setupAllDone(L.env, { scenes: 1, project: { name: 'App Y' } }));

    // kế hoạch LAN có bản dựng đã gửi EDL (rendering) — đến SAU Y
    const fx = await makeLanPlan(L, c, 1, 'Ke hoach LAN');
    expect((await c.uploadVideo(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, { name: 'a.mp4', data: clip(3) })).status).toBe(201);
    const built = await c.post(`/lan/api/plans/${fx.plan.id}/final-cuts`, {});
    const job = await workerClient(L.env.app).get('/api/worker/next?worker=w1');
    const edl = { scenes: built.body.final_cut.selection.map((s: any) => ({ scene_id: s.scene_id, asset_id: s.asset_id, segments: [{ in_s: 0.3, out_s: 2.5 }], removed: [], note: '' })) };
    expect((await workerClient(L.env.app).post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl, summary: 'lan' } })).status).toBe(200);
    const lanCut = built.body.final_cut.id as number;

    // thêm bản dựng app Z SAU bản LAN: phải chạy trước nó
    const z = await appCutRendering(await setupAllDone(L.env, { scenes: 1, project: { name: 'App Z' } }));
    const rf = L.env.ctx.finalRender!;
    expect([rf.position('cut', x), rf.position('cut', y), rf.position('cut', z), rf.position('cut', lanCut)]).toEqual([0, 2, 3, 4]);
    fake.release();
    await rf.idle();
    expect(fake.calls.map((k) => k.cutId)).toEqual([x, y, z, lanCut]);
    expect(fake.maxConcurrent).toBe(1);
    expect((await c.get(`/lan/api/plans/${fx.plan.id}/final-cuts/${lanCut}`)).body.status).toBe('ready');
  });
});

describe('phân tích lại kế hoạch LAN không xoá cảnh đã có video; dự án app không bị prune (như cũ)', () => {
  it('cảnh LAN có video người dùng tải lên được giữ khi phân tích lại; cảnh chỉ là kế hoạch bị bỏ như trước', async () => {
    const L = await makeLanEnv();
    try {
      const c = L.client();
      await c.login();
      const fx = await makeLanPlan(L, c, 3);
      const withVideo = `/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[2]!.id}/video`;
      if (FFMPEG && FFPROBE) expect((await c.uploadVideo(withVideo, { name: 'a.mp4', data: clip(2) })).status).toBe(201);
      else L.env.ctx.db.prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'video', 'output/x/video/C3_v1.mp4', 1, '{}', ?)").run(fx.scenes[2]!.id, L.env.ctx.now());
      const re = await c.post(`/lan/api/plans/${fx.plan.id}/analyze`, { brief: 'đổi yêu cầu' });
      expect(re.status, re.raw).toBe(201);
      const w = workerClient(L.env.app);
      const job = await w.get('/api/worker/next?worker=w1');
      const r = await w.post('/api/worker/scenes', { project_id: fx.plan.id, scenes: [{ code: 'C1', title: 'Mới', prompt: 'p1', first_frame_desc: '', upload_refs: [], use_prev_storyboard: false }] });
      expect(r.status, r.raw).toBe(200);
      expect(r.body.pruned).toEqual(['C2']); // C2 chỉ là kế hoạch → bỏ; C3 đã có video → giữ
      await w.post(`/api/worker/jobs/${job.body.id}/complete`, { result: {} });
      const d = (await c.get(`/lan/api/plans/${fx.plan.id}`)).body;
      expect(d.scenes.map((s: any) => s.code)).toEqual(['C1', 'C3']);
    } finally {
      await L.close();
    }
  });
});
