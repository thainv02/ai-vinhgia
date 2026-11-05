import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG_BYTES, finish, setupProject, workerClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { sceneInput } from './helpers-lan-plan.js';

let L: LanEnv;
let c: LanClient;
const db = () => L.env.ctx.db;
const media = () => workerClient(L.env.app);
const sc = () => ({ env: L.env, worker: media() }) as any;
const nextMedia = () => media().get('/api/worker/next?worker=media-api-1&types=storyboard,video');

/** Tạo dự án Autovideo và chạy worker giả cho bước phân tích (n cảnh C1..Cn, chưa có storyboard). */
async function makeAuto(n = 2, body: Record<string, unknown> = {}) {
  const r = await c.post('/lan/api/auto/projects', { name: 'Cacao Auto', created_by_name: 'Lan', brief: 'Quảng cáo sinh tố cacao', style_lock: '', ...body });
  expect(r.status, r.raw).toBe(201);
  const id = r.body.project.id as number;
  expect((await c.post(`/lan/api/plans/${id}/analyze`, {})).status).toBe(201);
  const w = workerClient(L.env.app);
  const job = await w.get('/api/worker/next?worker=w1&types=analyze_brief');
  expect(job.body.type).toBe('analyze_brief');
  expect((await w.post('/api/worker/scenes', { project_id: id, scenes: Array.from({ length: n }, (_, i) => sceneInput(i + 1, { use_prev_storyboard: false })) })).status).toBe(200);
  expect((await w.post(`/api/worker/jobs/${job.body.id}/complete`, { result: {} })).status).toBe(200);
  return id;
}
const detail = async (id: number) => {
  const r = await c.get(`/lan/api/auto/projects/${id}`);
  expect(r.status, r.raw).toBe(200);
  return r.body;
};

beforeEach(async () => {
  L = await makeLanEnv({ config: { lanRequireCode: false } });
  c = L.client();
});
afterEach(async () => {
  await L.close();
});

describe('tab Autovideo của trang LAN', () => {
  it('tạo dự án: lan_mode=auto, dịch vụ storyboard theo lựa chọn; chỉ hiện ở danh sách Autovideo', async () => {
    const id = await makeAuto(2, { storyboard_generator: 'flow-image' });
    expect(db().prepare('SELECT source, lan_mode, storyboard_generator, max_attempts_per_scene FROM projects WHERE id = ?').get(id)).toEqual({ source: 'lan', lan_mode: 'auto', storyboard_generator: 'flow-image', max_attempts_per_scene: 5 });
    expect((await c.get('/lan/api/plans')).body.map((p: any) => p.id)).not.toContain(id);
    const list = (await c.get('/lan/api/auto/projects')).body;
    expect(list.map((p: any) => p.id)).toEqual([id]);
    expect(list[0]).toMatchObject({ status: 'ready', scene_count: 2, storyboard_generator: 'flow-image', progress: { storyboards: 0, videos: 0, active: 0 } });
    const d = await detail(id);
    expect(d.scenes.map((s: any) => [s.code, s.status, s.blocks.storyboard, !!s.blocks.video])).toEqual([['C1', 'awaiting_approval', null, true], ['C2', 'awaiting_approval', null, true]]);
    expect(d.media).toMatchObject({ enabled: true, paused: false, load: 0, cap: 20 });
    expect(d.final.block.code).toBe('SCENES_NOT_READY');
    // kế hoạch prompt thường không mở được bằng route Autovideo
    const plan = await c.post('/lan/api/plans', { name: 'Kế hoạch', created_by_name: 'Lan', brief: 'x', style_lock: '' });
    expect((await c.get(`/lan/api/auto/projects/${plan.body.plan.id}`)).status).toBe(404);
  });

  it('storyboard → video → chọn video: job đi qua worker nền, file phục vụ qua /lan/files, đủ video thì dựng được bản hoàn chỉnh', async () => {
    const id = await makeAuto(2, { storyboard_generator: 'flow-image' });
    const d0 = await detail(id);
    const [s1, s2] = d0.scenes;

    const one = await c.post(`/lan/api/auto/projects/${id}/scenes/${s1.id}/storyboard`);
    expect(one.status, one.raw).toBe(201);
    const q = (await detail(id)).scenes[0];
    expect(q).toMatchObject({ status: 'storyboard_queued', job: { type: 'storyboard', state: 'queued', position: 1, can_cancel: true, generator: 'Google Flow · Gemini 3.1 Flash Image' } });
    // hủy khi còn chờ: cảnh về chờ duyệt
    expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s1.id}/cancel`)).status).toBe(200);
    expect((await detail(id)).scenes[0]).toMatchObject({ status: 'awaiting_approval', job: null });

    const all = await c.post(`/lan/api/auto/projects/${id}/approve-all`, { stage: 'storyboard' });
    expect(all.status, all.raw).toBe(201);
    expect(all.body.count).toBe(2);
    for (let i = 0; i < 2; i++) {
      const job = await nextMedia();
      expect(job.body.type).toBe('storyboard');
      expect(job.body.payload.generator).toMatchObject({ id: 'flow-image' });
      // worker đang chạy: không hủy được
      if (i === 0) expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${job.body.scene_id}/cancel`)).body.error.code).toBe('JOB_RUNNING');
      expect((await finish(sc(), job.body)).status).toBe(200);
    }
    const d1 = await detail(id);
    expect(d1.scenes.map((s: any) => s.status)).toEqual(['storyboard_review', 'storyboard_review']);
    expect(d1.media.online).toBe(true);
    const sb = d1.scenes[0].storyboard;
    expect(sb.url).toMatch(/^\/lan\/files\/output\/.+\/storyboard\/C1_storyboard\.png$/);
    const file = await c.get(sb.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.raw, 'binary').length).toBeGreaterThan(0);

    const v = await c.post(`/lan/api/auto/projects/${id}/scenes/${s1.id}/video`, { generator: 'flow-omni-10s' });
    expect(v.status, v.raw).toBe(201);
    expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s2.id}/video`, { generator: 'nope' })).status).toBe(400);
    // dự án dùng Google Flow: không tạo video bằng Muse (một dịch vụ cho cả storyboard và video)
    expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s2.id}/video`, { generator: 'muse' })).body.error.code).toBe('GENERATOR_MISMATCH');
    expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s2.id}/video`, {})).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      const job = await nextMedia();
      expect(job.body.type).toBe('video');
      expect(job.body.payload.generator.id).toBe(job.body.scene_id === s1.id ? 'flow-omni-10s' : 'flow-veo-fast');
      expect((await finish(sc(), job.body)).status).toBe(200);
    }
    const d2 = await detail(id);
    expect(d2.scenes.map((s: any) => [s.status, s.videos.length, s.attempts_used, s.blocks.select])).toEqual([['video_review', 1, 1, null], ['video_review', 1, 1, null]]);
    const vid = d2.scenes[0].videos[0];
    expect(vid).toMatchObject({ attempt: 1, selected: false, generator: 'Google Flow · Omni 1.1 Flash' });
    expect((await c.get(vid.url)).status).toBe(200);
    expect((await c.get(vid.grid_url)).status).toBe(200);

    for (const s of d2.scenes) expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s.id}/select`, { asset_id: s.videos[0].id })).status).toBe(200);
    const d3 = await detail(id);
    expect(d3.scenes.map((s: any) => s.status)).toEqual(['done', 'done']);
    expect(d3.final.block).toBeNull();
    // chọn xong mọi cảnh không tự dựng (dự án LAN chỉ dựng khi người dùng bấm)
    expect(db().prepare('SELECT COUNT(*) AS n FROM final_cuts WHERE project_id = ?').get(id)).toEqual({ n: 0 });
    expect((await c.get(`/lan/api/auto/projects`)).body[0].progress).toMatchObject({ storyboards: 2, videos: 2 });
    // video của cảnh khác không chọn được
    expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s1.id}/select`, { asset_id: d2.scenes[1].videos[0].id })).status).toBe(400);
  });

  it('việc của chủ máy được worker nhận trước storyboard/video của Autovideo', async () => {
    const id = await makeAuto(1);
    const s1 = (await detail(id)).scenes[0];
    expect((await c.post(`/lan/api/auto/projects/${id}/scenes/${s1.id}/storyboard`)).status).toBe(201);
    const app = await setupProject(L.env, { scenes: 1 });
    expect((await app.user.post(`/api/scenes/${app.scenes[0].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const first = await nextMedia();
    expect(first.body.project_id).toBe(app.project.id);
    expect((await detail(id)).scenes[0].job).toMatchObject({ state: 'queued', position: 1 });
  });

  it('sửa prompt; không nhận file tải lên tay; chủ máy tắt LAN_AUTOVIDEO thì khóa nút', async () => {
    const id = await makeAuto(1);
    const s1 = (await detail(id)).scenes[0];
    expect((await c.put(`/lan/api/auto/projects/${id}/scenes/${s1.id}/prompt`, { prompt: 'Prompt mới' })).status).toBe(200);
    expect((await detail(id)).scenes[0].prompt).toBe('Prompt mới');
    expect((await c.put(`/lan/api/auto/projects/${id}/scenes/${s1.id}/prompt`, { prompt: '  ' })).status).toBe(400);
    const up = await c.upload(`/lan/api/plans/${id}/scenes/${s1.id}/storyboard`, [{ name: 'a.png', data: PNG_BYTES }]);
    expect(up.body.error.code).toBe('AUTO_PROJECT');
    expect((await c.patch(`/lan/api/auto/projects/${id}`, { storyboard_generator: 'flow-image' })).body.project.storyboard_generator).toBe('flow-image');

    L.env.ctx.config.lanAutovideo = false;
    const off = await c.post(`/lan/api/auto/projects/${id}/scenes/${s1.id}/storyboard`);
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('FEATURE_DISABLED');
    expect((await detail(id)).scenes[0].blocks.storyboard).toMatch(/tắt/);
    expect((await c.get('/lan/api/status')).body.autovideo.enabled).toBe(false);
  });

  it('hạn mức theo IP tính theo số cảnh của lần tạo hàng loạt', async () => {
    const id = await makeAuto(3);
    const status = (await c.get('/lan/api/status')).body;
    expect(status.remaining.auto_storyboard).toBe(40);
    expect((await c.post(`/lan/api/auto/projects/${id}/approve-all`, { stage: 'storyboard' })).status).toBe(201);
    expect((await c.get('/lan/api/status')).body.remaining.auto_storyboard).toBe(37);
    expect((await c.get('/lan/api/status')).body.autovideo.load).toBe(3);
  });
});
