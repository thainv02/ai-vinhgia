import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim, finish, makeEnv, setupProject, toStoryboardReview, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

describe('chọn dịch vụ tạo video', () => {
  it('liệt kê các dịch vụ, mặc định Muse', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const r = await sc.user.get('/api/video-generators');
    expect(r.status).toBe(200);
    const ids = r.body.generators.map((g: { id: string }) => g.id);
    expect(ids[0]).toBe('muse');
    expect(ids).toContain('flow-veo-fast');
  });

  it('job video không chọn dịch vụ dùng Muse, 10 giây', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    expect((await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' })).status).toBe(200);
    const job = await claim(sc);
    expect(job.payload.generator).toMatchObject({ id: 'muse', provider: 'muse', model: 'muse-video', max_images: 4 });
    expect(job.payload.settings).toMatchObject({ aspect: '9:16', duration_s: 10 });
  });

  it('chọn Google Flow: payload mang model Flow và độ dài 8 giây; tạo lại đúng prompt giữ dịch vụ cũ', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    const a = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video', generator: 'flow-veo-fast' });
    expect(a.status).toBe(200);
    const job = await claim(sc);
    expect(job.payload.generator).toMatchObject({ id: 'flow-veo-fast', provider: 'flow', model: 'veo-3.1-fast-r2v-8s-portrait', max_images: 3 });
    expect(job.payload.settings.duration_s).toBe(8);
    expect((await finish(sc, job)).status).toBe(200);

    const c = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'tạo lại', action: 'regenerate_same' });
    expect(c.status).toBe(201);
    const again = await claim(sc);
    expect(again.payload.generator.id).toBe('flow-veo-fast');
    const scene = await sc.user.get(`/api/scenes/${id}`);
    const video = scene.body.assets.find((a: { kind: string }) => a.kind === 'video');
    expect(video.meta.generator).toBe('Google Flow · Veo 3.1 Fast');
  });

  it('từ chối dịch vụ không tồn tại', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    const r = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video', generator: 'sora' });
    expect(r.status).toBe(400);
  });

  it('duyệt hàng loạt: bỏ qua cảnh có nhiều ảnh hơn giới hạn của Flow, Muse vẫn nhận', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    // 3 ảnh sản phẩm + storyboard = 4 ảnh: vượt 3 ảnh của Flow, vừa 4 ảnh của Muse.
    env.ctx.db.prepare('UPDATE scenes SET upload_refs = ? WHERE id = ?').run(JSON.stringify([1, 2, 3]), id);
    const flow = await sc.user.get(`/api/projects/${sc.project.id}/approve-all/preview?stage=video&generator=flow-veo-lite`);
    expect(flow.status).toBe(200);
    expect(flow.body.count).toBe(0);
    expect(flow.body.skipped[0].reason_code).toBe('TOO_MANY_IMAGES');
    const single = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video', generator: 'flow-veo-lite' });
    expect(single.status).toBe(409);
    const muse = await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video', generator: 'muse' });
    expect(muse.status).toBe(200);
    expect(muse.body.count).toBe(1);
  });
});
