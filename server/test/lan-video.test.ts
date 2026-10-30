import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE } from './final-helpers.js';
import { PNG_BYTES, setupProject, userClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan, type LanPlanFixture } from './helpers-lan-plan.js';
import { clip, movOf } from './helpers-video.js';
import { LAN_RATE } from '../src/lan/routes.js';

const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c: LanClient;
let fx: LanPlanFixture;
const db = () => L.env.ctx.db;
const url = (sceneIdx = 0, tail = 'video') => `/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[sceneIdx]!.id}/${tail}`;
const videoDir = () => path.join(L.env.root, 'output', fx.slug, 'video');
const leftovers = () => (fs.existsSync(videoDir()) ? fs.readdirSync(videoDir()).filter((f) => f.startsWith('.lan-upload-')) : []);
const sceneRow = (i = 0) => db().prepare('SELECT * FROM scenes WHERE id = ?').get(fx.scenes[i]!.id) as any;
const videoAssets = (i = 0) => db().prepare("SELECT * FROM assets WHERE scene_id = ? AND kind = 'video' ORDER BY id").all(fx.scenes[i]!.id) as any[];

beforeEach(async () => {
  L = await makeLanEnv();
  c = L.client();
  await c.login();
  fx = await makeLanPlan(L, c, 3);
});
afterEach(async () => {
  await L.close();
});

run('Bước 3: tải video cảnh lên (stream xuống đĩa)', () => {
  it('mp4 hợp lệ: lưu asset video đúng quy ước, kèm metadata ffprobe, trở thành video được chọn; KHÔNG đổi trạng thái cảnh, KHÔNG tạo job', async () => {
    const statusBefore = sceneRow().status;
    const jobsBefore = (db().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
    const r = await c.uploadVideo(url(), { name: 'canh 1 (final).mp4', data: clip(3) });
    expect(r.status, r.raw).toBe(201);
    const a = videoAssets()[0];
    expect(a).toMatchObject({ kind: 'video', job_id: null, attempt: 1, file_path: `output/${fx.slug}/video/C1_v1.mp4` });
    const meta = JSON.parse(a.meta);
    expect(meta).toMatchObject({ source: 'lan_upload', original_name: 'canh 1 (final).mp4', width: 160, height: 284, has_audio: true });
    expect(meta.duration_s).toBeGreaterThan(2.9);
    expect(meta.duration_s).toBeLessThan(3.2);
    expect(meta.bytes).toBe(clip(3).length);
    expect(meta.ffprobe).toMatchObject({ video_codec: 'h264', audio_codec: 'aac' });
    expect(meta.ffprobe.format_name).toContain('mp4');
    expect(fs.readFileSync(path.join(L.env.root, a.file_path)).equals(clip(3))).toBe(true);
    expect(sceneRow().selected_video_id).toBe(a.id);
    expect(sceneRow().status).toBe(statusBefore); // không qua transition()
    expect((db().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(jobsBefore);
    expect(leftovers()).toEqual([]);
    expect(r.body.video).toMatchObject({ id: a.id, attempt: 1, selected: true, url: `/lan/files/output/${fx.slug}/video/C1_v1.mp4`, file_name: 'canh 1 (final).mp4', has_audio: true });
    expect(r.body.videos).toMatchObject({ selected_id: a.id, count: 1, max: 5, block: null });
    expect(Object.keys(r.body.video).sort()).toEqual(['attempt', 'bytes', 'duration_s', 'file_name', 'has_audio', 'height', 'id', 'selected', 'uploaded_at', 'url', 'width']);
  });

  it('lần tải sau: attempt tăng dần, video mới được chọn; chọn lại video cũ; chi tiết kế hoạch liệt kê đủ', async () => {
    const r1 = await c.uploadVideo(url(), { name: 'a.mp4', data: clip(3) });
    const r2 = await c.uploadVideo(url(), { name: 'b.mov', data: movOf(clip(2)) });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(videoAssets().map((a) => [a.attempt, a.file_path.split('/').pop()])).toEqual([[1, 'C1_v1.mp4'], [2, 'C1_v2.mp4']]);
    expect(sceneRow().selected_video_id).toBe(r2.body.video.id);
    const d = (await c.get(`/lan/api/plans/${fx.plan.id}`)).body;
    expect(d.scenes[0].videos).toMatchObject({ count: 2, selected_id: r2.body.video.id });
    expect(d.scenes[0].videos.items.map((v: any) => [v.attempt, v.selected, v.file_name])).toEqual([[1, false, 'a.mp4'], [2, true, 'b.mov']]);
    expect(d.scenes[1].videos).toMatchObject({ count: 0, selected_id: null, items: [] });

    const sel = await c.post(url(0, 'video/select'), { asset_id: r1.body.video.id });
    expect(sel.status, sel.raw).toBe(200);
    expect(sel.body.video).toMatchObject({ id: r1.body.video.id, selected: true });
    expect(sel.body.videos.selected_id).toBe(r1.body.video.id);
    expect(sceneRow().selected_video_id).toBe(r1.body.video.id);
    // asset không thuộc cảnh / không phải video tải lên / không có → 404
    const other = await c.uploadVideo(url(1), { name: 'c.mp4', data: clip(2) });
    expect((await c.post(url(0, 'video/select'), { asset_id: other.body.video.id })).status).toBe(404);
    expect((await c.post(url(0, 'video/select'), { asset_id: 99999 })).status).toBe(404);
    expect((await c.post(url(0, 'video/select'), { asset_id: 'x' })).status).toBe(400);
    expect((await c.post(url(0, 'video/select'), {})).status).toBe(400);
  });

  it('tối đa 5 video mỗi cảnh (409 TOO_MANY_UPLOADS); cảnh khác vẫn tải được', async () => {
    for (let i = 0; i < 5; i++) expect((await c.uploadVideo(url(), { name: `v${i}.mp4`, data: clip(2) })).status).toBe(201);
    const r = await c.uploadVideo(url(), { name: 'v6.mp4', data: clip(2) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TOO_MANY_UPLOADS');
    expect(videoAssets()).toHaveLength(5);
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.scenes[0].videos.block).toContain('tối đa 5');
    expect((await c.uploadVideo(url(1), { name: 'ok.mp4', data: clip(2) })).status).toBe(201);
  });

  it('từ chối sớm, không để lại file: không phải mp4/mov (png, văn bản, rỗng), thiếu ftyp, ftyp nhưng không đọc được, quá ngắn, quá dài', async () => {
    const cases: [string, Buffer, number, string][] = [
      ['anh.mp4', PNG_BYTES, 415, 'UNSUPPORTED_FILE_TYPE'],
      ['a.mp4', Buffer.from('xin chào, đây là văn bản không phải video'), 415, 'UNSUPPORTED_FILE_TYPE'],
      ['empty.mp4', Buffer.alloc(0), 415, 'UNSUPPORTED_FILE_TYPE'],
      ['webm.mp4', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200)]), 415, 'UNSUPPORTED_FILE_TYPE'],
      ['fake.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(500, 7)]), 422, 'INVALID_VIDEO'],
      ['ngan.mp4', clip(0.5), 422, 'VIDEO_DURATION'],
      ['dai.mp4', clip(65), 422, 'VIDEO_DURATION'],
    ];
    for (const [name, data, status, code] of cases) {
      const r = await c.uploadVideo(url(), { name, data });
      expect([name, r.status, r.body.error?.code]).toEqual([name, status, code]);
    }
    expect(videoAssets()).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(sceneRow().selected_video_id).toBeNull();
    // 1 giây và 60 giây đúng giới hạn thì nhận
    expect((await c.uploadVideo(url(), { name: 'một.mp4', data: clip(1, { audio: false }) })).status).toBe(201);
    expect((await c.uploadVideo(url(1), { name: 'sáu mươi.mp4', data: clip(60, { audio: false }) })).status).toBe(201);
    const msg = (await c.uploadVideo(url(2), { name: 'dai.mp4', data: clip(65) })).body.error.message;
    expect(msg).toContain('1 đến 60 giây');
  });

  it('quá dung lượng: từ chối theo Content-Length (không đọc file) và theo số byte thực nhận (client nói dối); không để lại file tạm', async () => {
    L.env.ctx.config.lanVideoMaxBytes = 64 * 1024;
    const big = Buffer.concat([clip(3).subarray(0, 64), Buffer.alloc(200 * 1024, 1)]);
    const r = await c.uploadVideo(url(), { name: 'to.mp4', data: big });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
    expect(r.body.error.message).toContain('MB');
    // luồng không có Content-Length: bị chặn khi đếm byte
    const { Readable } = await import('node:stream');
    const lie = await c.uploadVideo(url(), { name: 'to.mp4', data: Readable.from([clip(3).subarray(0, 4096), Buffer.alloc(100 * 1024, 2)]) });
    expect([lie.status, lie.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    expect(leftovers()).toEqual([]);
    expect(videoAssets()).toEqual([]);
  });

  it('tên file lạ bị từ chối; kế hoạch/cảnh sai → 404; dự án app không tải được; thiếu file → 400', async () => {
    expect((await c.uploadVideo(url(), { name: '../x.mp4', data: clip(2) })).status).toBe(400);
    expect((await c.uploadVideo(`/lan/api/plans/${fx.plan.id}/scenes/99999/video`, { name: 'a.mp4', data: clip(2) })).status).toBe(404);
    const other = await makeLanPlan(L, c, 1, 'Kế hoạch khác'); // worker giả cần job analyze mới: dùng tên khác
    expect((await c.uploadVideo(`/lan/api/plans/${fx.plan.id}/scenes/${other.scenes[0]!.id}/video`, { name: 'a.mp4', data: clip(2) })).status).toBe(404); // cảnh của kế hoạch khác
    const app = await setupProject(L.env, { scenes: 1 });
    const r = await c.uploadVideo(`/lan/api/plans/${app.project.id}/scenes/${app.scenes[0].id}/video`, { name: 'a.mp4', data: clip(2) });
    expect(r.status).toBe(404);
    expect(videoAssets()).toEqual([]);
    expect((await c.postRaw(url(), JSON.stringify({ a: 1 }), { 'content-type': 'application/json' })).status).toBe(400); // không phải multipart
  });

  it('chủ máy đang có job ở cảnh đó → 409 SCENE_BUSY (báo trước khi nhận file)', async () => {
    db().prepare("UPDATE scenes SET status = 'video_running' WHERE id = ?").run(fx.scenes[0]!.id);
    const r = await c.uploadVideo(url(), { name: 'a.mp4', data: clip(2) });
    expect([r.status, r.body.error.code]).toEqual([409, 'SCENE_BUSY']);
    expect(r.body.error.message).toContain('video');
    expect(leftovers()).toEqual([]);
  });

  it('video LAN không tính vào lượt/credit của chủ máy (attemptsUsed)', async () => {
    await c.uploadVideo(url(0), { name: 'a.mp4', data: clip(2) });
    const s = (await userClient(L.env.app).get(`/api/projects/${fx.plan.id}/scenes`)).body;
    expect(s[0]).toMatchObject({ attempts_used: 0, video_count: 1 });
    expect(s[0].selected_video_id).toBe(videoAssets()[0].id);
  });

  it(`giới hạn ${LAN_RATE.uploadVideo.max} video mỗi giờ theo IP; hết giờ thì tải lại được; IP khác không bị ảnh hưởng`, async () => {
    const big = await makeLanPlan(L, c, 7, 'Nhiều cảnh');
    const u = (i: number) => `/lan/api/plans/${big.plan.id}/scenes/${big.scenes[i]!.id}/video`;
    const tiny = clip(1, { audio: false });
    for (let i = 0; i < LAN_RATE.uploadVideo.max; i++) {
      const r = await c.uploadVideo(u(i % 7), { name: `v${i}.mp4`, data: tiny });
      expect(r.status, `lượt ${i + 1}: ${r.raw}`).toBe(201);
    }
    const r = await c.uploadVideo(u(6), { name: 'thua.mp4', data: tiny });
    expect([r.status, r.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(leftovers()).toEqual([]);
    const other = L.client({ ip: '192.168.1.99', cookie: c.cookie });
    expect((await other.uploadVideo(u(6), { name: 'ip-khac.mp4', data: tiny })).status).toBe(201);
    L.env.clock.advance(61 * 60_000);
    expect((await c.uploadVideo(u(5), { name: 'sau-gio.mp4', data: tiny })).status).toBe(201);
    expect((await c.get('/lan/api/status')).body.remaining.upload_video).toBeLessThan(LAN_RATE.uploadVideo.max);
  });
});
