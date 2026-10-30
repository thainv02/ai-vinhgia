import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { PNG_BYTES, setupAllDone, userClient, workerClient, writeFile } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan, type LanPlanFixture } from './helpers-lan-plan.js';
import { clip } from './helpers-video.js';

const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c: LanClient;
let fx: LanPlanFixture;

beforeEach(async () => {
  L = await makeLanEnv({ app: { finalRenderer: new FakeRenderer(), finalRender: { progressThrottleMs: 0 } }, config: { watermarkRemover: 'off' } });
  c = L.client();
  await c.login();
  fx = await makeLanPlan(L, c, 2);
});
afterEach(async () => {
  await L.close();
});

const sceneUrl = (i: number, tail = 'video') => `/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[i]!.id}/${tail}`;

describe('mọi endpoint mới cần phiên + Host/Origin + không từ trang khác; không tồn tại trên app chính', () => {
  const urls = (): [string, string][] => [
    ['POST', `/lan/api/plans/1/scenes/1/video`],
    ['POST', `/lan/api/plans/1/scenes/1/video/select`],
    ['GET', `/lan/api/plans/1/final-cuts`],
    ['GET', `/lan/api/plans/1/final-cuts/1`],
    ['POST', `/lan/api/plans/1/final-cuts`],
    ['POST', `/lan/api/plans/1/final-cuts/1/rerender`],
    ['POST', `/lan/api/plans/1/final-cuts/1/cancel`],
    ['POST', `/lan/api/plans/1/final-cuts/1/clean`],
    ['GET', '/lan/api/tools/status'],
    ['GET', '/lan/api/tools/jobs'],
    ['GET', '/lan/api/tools/jobs/1'],
    ['POST', '/lan/api/tools/jobs'],
    ['POST', '/lan/api/tools/jobs/1/cancel'],
    ['POST', '/lan/api/tools/jobs/1/retry'],
  ];

  it('không phiên → 401 UNAUTHENTICATED; sai Host → 403; request ghi thiếu/sai Origin → 403; Sec-Fetch-Site cross-site → 403', async () => {
    const anon = L.client();
    for (const [m, u] of urls()) {
      const r = m === 'GET' ? await anon.get(u) : await anon.post(u, {});
      expect([m, u, r.status, r.body.error.code]).toEqual([m, u, 401, 'UNAUTHENTICATED']);
    }
    for (const [m, u] of urls()) {
      const bad = L.client({ cookie: c.cookie, host: 'evil.example.com', origin: 'http://evil.example.com' });
      const r = m === 'GET' ? await bad.get(u) : await bad.post(u, {});
      expect([m, u, r.status, r.body.error.code]).toEqual([m, u, 403, 'FORBIDDEN_HOST']);
    }
    for (const [, u] of urls().filter(([m]) => m === 'POST')) {
      expect([u, (await L.client({ cookie: c.cookie, origin: null }).post(u, {})).status]).toEqual([u, 403]);
      expect([u, (await L.client({ cookie: c.cookie, origin: 'http://evil.example' }).post(u, {})).status]).toEqual([u, 403]);
      expect([u, (await c.post(u, {}, { 'sec-fetch-site': 'cross-site' })).status]).toEqual([u, 403]);
    }
    for (const [, u] of urls().filter(([m]) => m === 'GET')) expect([u, (await c.get(u, { 'sec-fetch-site': 'cross-site' })).status]).toEqual([u, 403]);
  });

  it('app chính (localhost) không có các route này, và listener LAN vẫn không có API chính', async () => {
    for (const [m, u] of urls()) {
      expect(L.env.app.hasRoute({ method: m as 'GET', url: u.replace(/\/\d+/g, '/:id') }), `${m} ${u}`).toBe(false);
      const r = await L.env.app.inject({ method: m as 'GET', url: u, headers: { host: 'localhost:8787', origin: 'http://localhost:8787' }, payload: m === 'POST' ? {} : undefined });
      expect([m, u, r.statusCode]).toEqual([m, u, 404]);
    }
    for (const p of ['/api/final-cuts/1', '/api/projects/1/final-cuts', '/api/scenes/1/select-video', '/api/lan', '/api/meta']) expect([p, (await c.get(p)).status]).toEqual([p, 404]);
    expect((await c.post('/api/final-cuts/1/clean', {})).status).toBe(404);
    expect((await c.post('/api/final-cuts/1/open-in-shotcut', {})).status).toBe(404); // KHÔNG có "Mở trong Shotcut" cho LAN
    expect((await c.post(`/lan/api/plans/${fx.plan.id}/final-cuts/1/open-in-shotcut`, {})).status).toBe(404);
  });
});

run('/lan/files: danh sách cho phép mở rộng CHỈ như spec', () => {
  it('phục vụ: video lan_upload của cảnh LAN; KHÔNG phục vụ: video do worker/chủ máy tạo cho cảnh LAN, video và file bản dựng của dự án app, file mồ côi, symlink ra ngoài, traversal', async () => {
    const up = await c.uploadVideo(sceneUrl(0), { name: 'a.mp4', data: clip(2) });
    expect(up.status, up.raw).toBe(201);
    expect((await c.get(up.body.video.url)).status).toBe(200);

    // video của cảnh LAN do chủ máy/worker tạo (không phải lan_upload): không phục vụ qua LAN
    const ownerRel = `output/${fx.slug}/video/C2_v1.mp4`;
    writeFile(L.env.root, ownerRel, clip(2));
    L.env.ctx.db.prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'video', ?, 1, '{\"duration_s\":2}', ?)").run(fx.scenes[1]!.id, ownerRel, L.env.ctx.now());
    expect((await c.get('/lan/files/' + ownerRel)).status).toBe(404);
    // storyboard do worker tạo cho cảnh LAN (không phải lan_upload)
    const sbRel = `output/${fx.slug}/storyboard/C1_storyboard.png`;
    writeFile(L.env.root, sbRel, PNG_BYTES);
    L.env.ctx.db.prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'storyboard', ?, 1, '{}', ?)").run(fx.scenes[0]!.id, sbRel, L.env.ctx.now());
    expect((await c.get('/lan/files/' + sbRel)).status).toBe(404);
    // file mồ côi trong thư mục của kế hoạch (không có dòng DB)
    writeFile(L.env.root, `output/${fx.slug}/video/orphan.mp4`, clip(2));
    expect((await c.get(`/lan/files/output/${fx.slug}/video/orphan.mp4`)).status).toBe(404);
    // video của dự án app + bản dựng của dự án app + ảnh của dự án app
    const app = await setupAllDone(L.env, { scenes: 1, project: { name: 'Du an app' } });
    const appVideo = (L.env.ctx.db.prepare("SELECT file_path FROM assets WHERE scene_id = ? AND kind = 'video'").get(app.scenes[0].id) as { file_path: string }).file_path;
    expect((await c.get('/lan/files/' + appVideo)).status).toBe(404);
    // bản dựng của dự án app (sau khi render xong): không phục vụ
    const job = await workerClient(L.env.app).get('/api/worker/next?worker=w1');
    const cut = (await userClient(L.env.app).get(`/api/final-cuts/${job.body.payload.final_cut_id}`)).body;
    const edl = { scenes: cut.selection.map((s: any) => ({ scene_id: s.scene_id, asset_id: s.asset_id, segments: [{ in_s: 0.5, out_s: 9 }], removed: [], note: '' })) };
    expect((await workerClient(L.env.app).post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl, summary: 'x' } })).status).toBe(200);
    await L.env.ctx.finalRender!.idle();
    const appCut = (await userClient(L.env.app).get(`/api/final-cuts/${cut.id}`)).body;
    expect(appCut.status).toBe('ready');
    expect((await c.get('/lan/files/' + appCut.video_path)).status).toBe(404);
    expect((await c.get('/lan/files/' + appCut.contact_sheet_path)).status).toBe(404);
    // symlink: dòng DB hợp lệ (lan_upload) nhưng file là symlink trỏ ra ngoài thư mục output → 404
    const secret = path.join(L.env.root, 'secret.txt');
    fs.writeFileSync(secret, 'bí mật');
    const linkRel = `output/${fx.slug}/video/C1_v9.mp4`;
    fs.symlinkSync(secret, path.join(L.env.root, linkRel));
    L.env.ctx.db.prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'video', ?, 9, '{\"source\":\"lan_upload\"}', ?)").run(fx.scenes[0]!.id, linkRel, L.env.ctx.now());
    const link = await c.get('/lan/files/' + linkRel);
    expect(link.status).toBe(404);
    expect(link.raw).not.toContain('bí mật');
    // traversal và đường dẫn lạ
    for (const p of [`/lan/files/output/${fx.slug}/video/../../../secret.txt`, '/lan/files/output/%2e%2e/secret.txt', '/lan/files/%2e%2e/%2e%2e/etc/passwd', `/lan/files/output/${fx.slug}%2fvideo%2f..%2f..%2f..%2fsecret.txt`, '/lan/files/data/test.db', '/lan/files/.env', '/lan/files/']) {
      const r = await c.get(p);
      expect([p, [400, 404].includes(r.status)]).toEqual([p, true]);
      expect(r.raw).not.toContain('bí mật');
    }
  });

  it('việc công cụ của người khác không tải được; input không bao giờ; đường dẫn tương tự bản sạch nhưng không có trong DB → 404', async () => {
    const c2 = L.client({ ip: '192.168.1.12' });
    await c2.login();
    // việc ready giả lập trong DB cho client A (băm của cookie client của c)
    expect((await c.get('/lan/api/tools/jobs')).body).toEqual([]);
    const hash = crypto.createHash('sha256').update(c.cookie!.split('; ').find((x) => x.startsWith('autovideo_lan_client='))!.split('=')[1]!).digest('hex');
    writeFile(L.env.root, 'output/lan-tools/7/clean.mp4', clip(2));
    writeFile(L.env.root, 'output/lan-tools/7/input.mp4', clip(2));
    L.env.ctx.db.prepare("INSERT INTO lan_tool_jobs (id, kind, status, progress, input_path, output_path, original_name, client_id_hash, meta, created_at) VALUES (7, 'remove_logo', 'ready', 100, 'output/lan-tools/7/input.mp4', 'output/lan-tools/7/clean.mp4', 'a.mp4', ?, '{}', ?)").run(hash, L.env.ctx.now());
    expect((await c.get('/lan/files/output/lan-tools/7/clean.mp4')).status).toBe(200);
    expect((await c2.get('/lan/files/output/lan-tools/7/clean.mp4')).status).toBe(404);
    expect((await c.get('/lan/files/output/lan-tools/7/input.mp4')).status).toBe(404);
    writeFile(L.env.root, 'output/lan-tools/8/clean.mp4', clip(2)); // không có dòng DB
    expect((await c.get('/lan/files/output/lan-tools/8/clean.mp4')).status).toBe(404);
    // việc chưa ready (processing/failed) thì file output chưa/không được phục vụ
    L.env.ctx.db.prepare("UPDATE lan_tool_jobs SET status = 'failed' WHERE id = 7").run();
    expect((await c.get('/lan/files/output/lan-tools/7/clean.mp4')).status).toBe(404);
  });
});
