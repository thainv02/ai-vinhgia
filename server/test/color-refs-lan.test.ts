import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAN_RATE } from '../src/lan/routes.js';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { colorPng, cubeText, frameMean } from './helpers-color.js';
import { PNG_BYTES, multipart, userClient, workerClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan, type LanPlanFixture } from './helpers-lan-plan.js';
import { clip } from './helpers-video.js';

const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c: LanClient;
let fake: FakeRenderer;
let fx: LanPlanFixture;
const db = () => L.env.ctx.db;
const idle = () => L.env.ctx.finalRender!.idle();
const abs = (rel: string) => path.join(L.env.root, rel);
const refsUrl = (tail = '', plan = fx.plan.id) => `/lan/api/plans/${plan}/color-refs${tail}`;
const cutsUrl = (tail = '') => `/lan/api/plans/${fx.plan.id}/final-cuts${tail}`;
const sceneUrl = (i: number) => `/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[i]!.id}/video`;
const dir = () => `output/${fx.slug}/final/color-refs`;
const edlFrom = (cut: any) => ({
  scenes: cut.selection.map((s: any) => ({ scene_id: s.scene_id, asset_id: s.asset_id, segments: [{ in_s: 0.3, out_s: 2.5 }], removed: [{ from_s: 0, to_s: 0.3, reason: 'đầu' }], note: s.code })),
});

async function upload(client: LanClient, name: string, data: Buffer, url = refsUrl(), fields: Record<string, string> = {}) {
  const m = multipart([...Object.entries(fields).map(([k, v]) => ({ name: k, value: v })), { name: 'file', filename: name, data }]);
  return client.postRaw(url, m.payload, m.headers);
}

async function mk() {
  fake = new FakeRenderer();
  fake.realVideo = { seconds: 2, audio: true };
  L = await makeLanEnv({ app: { finalRenderer: fake, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 } }, config: { watermarkRemover: 'off' } });
  c = L.client();
  await c.login();
  fx = await makeLanPlan(L, c, 2);
}
async function readyV1() {
  for (let i = 0; i < 2; i++) expect((await c.uploadVideo(sceneUrl(i), { name: `c${i + 1}.mp4`, data: clip(3) })).status).toBe(201);
  const r = await c.post(cutsUrl(), {});
  expect(r.status, r.raw).toBe(201);
  const job = await workerClient(L.env.app).get('/api/worker/next?worker=w1');
  const done = await workerClient(L.env.app).post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl: edlFrom(r.body.final_cut), summary: 'Cắt đầu cuối.' } });
  expect(done.status, done.raw).toBe(200);
  await idle();
  const v1 = (await c.get(cutsUrl(`/${r.body.final_cut.id}`))).body;
  expect(v1.status).toBe('ready');
  return v1;
}

afterEach(async () => {
  fake?.release();
  await L?.close();
});

run('LAN: ảnh mẫu / LUT cho "Màu theo ảnh mẫu"', () => {
  beforeEach(() => mk());

  it('tải ảnh lên: 201, JSON dùng URL /lan/files (không đường dẫn thô); thumb và ảnh gốc phục vụ được; file LUT .cube KHÔNG BAO GIỜ phục vụ; chỉ kiểu hợp lệ', async () => {
    const r = await upload(c, 'mau.png', colorPng('warm'), refsUrl(), { created_by_name: 'Lan' });
    expect(r.status, r.raw).toBe(201);
    const ref = r.body.color_ref;
    expect(ref).toMatchObject({ kind: 'image', original_name: 'mau.png', width: 160, height: 240, created_by_name: 'Lan', used_by: [] });
    expect(ref.thumb_url).toMatch(new RegExp(`^/lan/files/${dir()}/[0-9a-f]{16}_thumb\\.jpg$`));
    expect(ref.image_url).toMatch(new RegExp(`^/lan/files/${dir()}/[0-9a-f]{16}\\.png$`));
    expect(JSON.stringify(r.body)).not.toContain(L.env.root);
    expect((await c.get(ref.thumb_url)).status).toBe(200);
    expect((await c.get(ref.image_url)).status).toBe(200);
    expect(r.body.rate.color_ref_remaining).toBe(LAN_RATE.colorRef.max - 1);
    // LUT: lưu được nhưng không có URL, không phục vụ qua LAN (kể cả đoán đường dẫn)
    const lut = await upload(c, 'brand.cube', Buffer.from(cubeText(5)));
    expect(lut.status, lut.raw).toBe(201);
    expect(lut.body.color_ref).toMatchObject({ kind: 'lut', lut_size: 5, thumb_url: null, image_url: null });
    const lutRel = (db().prepare("SELECT file_path FROM color_refs WHERE kind = 'lut'").get() as { file_path: string }).file_path;
    expect(fs.existsSync(abs(lutRel))).toBe(true);
    expect((await c.get('/lan/files/' + lutRel)).status).toBe(404);
    expect(JSON.stringify(lut.body)).not.toContain(path.basename(lutRel));
    // sai kiểu
    for (const [name, data, status] of [['gia.png', Buffer.from('text'), 415], ['x.gif', Buffer.from('GIF89a'), 415], ['../x.png', PNG_BYTES, 400]] as const) {
      const bad = await upload(c, name, data);
      expect([name, bad.status]).toEqual([name, status]);
    }
    const bigPng = await upload(c, 'lon.png', Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(15 * 1024 * 1024 + 10, 1)]));
    expect([bigPng.status, bigPng.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    const list = (await c.get(refsUrl())).body;
    expect(list.items.map((i: any) => i.kind).sort()).toEqual(['image', 'lut']);
    expect(JSON.stringify(list)).not.toContain(L.env.root);
  });

  it('hạn mức 20 lần/giờ/IP: lần thứ 21 → 429 RATE_LIMITED + Retry-After; tải TRÙNG nội dung không tính; IP khác không ảnh hưởng; sau 1 giờ dùng lại được; /lan/api/status có remaining.color_ref', async () => {
    expect(LAN_RATE.colorRef.max).toBe(20);
    const first = await upload(c, 'a.png', colorPng('warm', 0));
    expect(first.status).toBe(201);
    const dup = await upload(c, 'a-lan-nua.png', colorPng('warm', 0));
    expect([dup.status, dup.body.existing, dup.body.rate.color_ref_remaining]).toEqual([200, true, LAN_RATE.colorRef.max - 1]);
    for (let i = 1; i < LAN_RATE.colorRef.max; i++) {
      const r = await upload(c, `a${i}.png`, colorPng('warm', i));
      expect([i, r.status]).toEqual([i, 201]);
    }
    expect((await c.get('/lan/api/status')).body.remaining.color_ref).toBe(0);
    const over = await upload(c, 'qua.png', colorPng('warm', 99));
    expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    const overAsset = await c.post(refsUrl('/from-asset'), { ref_id: 1 });
    expect([overAsset.status, overAsset.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(db().prepare('SELECT COUNT(*) AS n FROM color_refs WHERE project_id = ?').get(fx.plan.id)).toEqual({ n: 20 });
    const other = L.client({ ip: '192.168.1.99' });
    await other.login();
    expect((await upload(other, 'b.png', colorPng('warm', 100))).status).toBe(201);
    L.env.clock.advanceMinutes(61);
    expect((await upload(c, 'sau-gio.png', colorPng('warm', 101))).status).toBe(201);
    expect((await c.get('/lan/api/status')).body.rate.colorRef).toEqual({ max: 20, windowMs: 3_600_000 });
  }, 60_000);

  it('chép ảnh có sẵn của kế hoạch: ảnh tham chiếu (refs) và storyboard do CHÍNH người dùng LAN tải lên; storyboard do chủ máy/worker tạo → 404; id của kế hoạch khác → 404', async () => {
    const ref = await c.upload(`/lan/api/plans/${fx.plan.id}/refs`, [{ name: 'hop.png', data: colorPng('cool') }]);
    expect(ref.status, ref.raw).toBe(201);
    const refId = ref.body[0].id;
    const sb = await c.upload(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/storyboard`, [{ name: 'sb.png', data: colorPng('warm', 7) }]);
    expect(sb.status, sb.raw).toBe(201);
    const sbAsset = db().prepare("SELECT id FROM assets WHERE kind = 'storyboard' AND scene_id = ?").get(fx.scenes[0]!.id) as { id: number };
    // storyboard KHÔNG do LAN tải lên (worker tạo) cho cảnh 2
    db().prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, created_at) VALUES (?, 'storyboard', ?, 1, ?)").run(fx.scenes[1]!.id, `output/${fx.slug}/storyboard/C2.png`, L.env.ctx.now());
    fs.mkdirSync(abs(`output/${fx.slug}/storyboard`), { recursive: true });
    fs.writeFileSync(abs(`output/${fx.slug}/storyboard/C2.png`), colorPng('warm', 8));
    const workerAsset = db().prepare("SELECT id FROM assets WHERE kind = 'storyboard' AND scene_id = ?").get(fx.scenes[1]!.id) as { id: number };
    const list = (await c.get(refsUrl())).body;
    expect(list.sources.refs.map((r: any) => r.id)).toEqual([refId]);
    expect(list.sources.refs[0].url).toMatch(/^\/lan\/files\/refs\//);
    expect(list.sources.assets.map((a: any) => [a.id, a.scene_code])).toEqual([[sbAsset.id, 'C1']]); // chỉ storyboard do LAN tải lên
    expect((await c.post(refsUrl('/from-asset'), { ref_id: refId })).status).toBe(201);
    expect((await c.post(refsUrl('/from-asset'), { asset_id: sbAsset.id })).status).toBe(201);
    expect((await c.post(refsUrl('/from-asset'), { asset_id: workerAsset.id })).status).toBe(404);
    expect((await c.post(refsUrl('/from-asset'), {})).status).toBe(400);
    // kế hoạch LAN khác
    const second = await makeLanPlan(L, c, 1, 'Kế hoạch hai');
    expect((await c.post(refsUrl('/from-asset', second.plan.id), { ref_id: refId })).status).toBe(404);
    expect((await c.post(refsUrl('/from-asset', second.plan.id), { asset_id: sbAsset.id })).status).toBe(404);
  });

  it('dự án app → 404 trên mọi route color-refs LAN; xoá ảnh dùng được; ảnh/thumb của kế hoạch khác không phục vụ nhầm', async () => {
    const app = (await userClient(L.env.app).post('/api/projects', { name: 'Dự án app', brief: 'x' })).body;
    expect((await c.get(refsUrl('', app.id))).status).toBe(404);
    expect((await upload(c, 'a.png', PNG_BYTES, refsUrl('', app.id))).status).toBe(404);
    expect((await c.del(refsUrl('/1', app.id))).status).toBe(404);
    // ảnh mẫu của dự án APP (main) không phục vụ qua LAN
    const m = multipart([{ name: 'file', filename: 'app.png', data: colorPng('cool', 5) }]);
    const appUp = await L.env.app.inject({ method: 'POST', url: `/api/projects/${app.id}/color-refs`, payload: m.payload, headers: { host: 'localhost:8787', ...m.headers } });
    const appRef = JSON.parse(appUp.body).color_ref;
    expect(appUp.statusCode).toBe(201);
    expect((await c.get(appRef.thumb_url.replace('/files/', '/lan/files/'))).status).toBe(404);
    expect((await c.get(appRef.image_url.replace('/files/', '/lan/files/'))).status).toBe(404);
    // xoá ảnh của kế hoạch mình
    const mine = (await upload(c, 'mine.png', colorPng('warm', 11))).body.color_ref;
    expect((await c.del(refsUrl(`/${mine.id}`))).body).toEqual({ ok: true });
    expect((await c.get(mine.thumb_url)).status).toBe(404);
    expect((await c.del(refsUrl(`/${mine.id}`))).status).toBe(404);
    // id của dự án app qua đường kế hoạch LAN → 404
    expect((await c.del(refsUrl(`/${appRef.id}`))).status).toBe(404);
  });

  it('grade + xem trước qua LAN dùng match: ref_id phải thuộc kế hoạch (400), phiên bản dùng ảnh mẫu có color_ref với URL /lan/files, xoá khi đang dùng → 409', async () => {
    const v1 = await readyV1();
    const ref = (await upload(c, 'am.png', colorPng('warm', 0))).body.color_ref;
    const second = await makeLanPlan(L, c, 1, 'Kế hoạch hai');
    const foreign = (await upload(c, 'khac.png', colorPng('cool', 2), refsUrl('', second.plan.id))).body.color_ref;
    for (const tail of ['grade', 'grade-preview']) {
      const r = await c.post(cutsUrl(`/${v1.id}/${tail}`), { grade: { match: { kind: 'image', ref_id: foreign.id } } });
      expect([tail, r.status, r.body.error.code]).toEqual([tail, 400, 'INVALID_GRADE']);
    }
    const pv = await c.post(cutsUrl(`/${v1.id}/grade-preview`), { grade: { match: { kind: 'image', ref_id: ref.id, strength: 1 } } });
    expect(pv.status, pv.raw).toBe(200);
    expect(pv.body.items[0].after_url).toMatch(new RegExp(`^/lan/files/output/${fx.slug}/final/preview/`));
    expect((await c.get(pv.body.items[0].after_url)).status).toBe(200);
    const g = await c.post(cutsUrl(`/${v1.id}/grade`), { grade: { match: { kind: 'image', ref_id: ref.id, strength: 1 } } });
    expect(g.status, g.raw).toBe(201);
    await idle();
    const v2 = (await c.get(cutsUrl(`/${g.body.final_cut.id}`))).body;
    expect(v2).toMatchObject({ status: 'ready', grade_chips: ['Màu theo ảnh mẫu 100%'], color_ref: { id: ref.id, kind: 'image', original_name: 'am.png', thumb_url: ref.thumb_url } });
    expect(JSON.stringify(v2)).not.toContain(L.env.root);
    const a = frameMean(abs(`output/${fx.slug}/final/${fx.slug}_final_v1.mp4`), 0.8);
    const b = frameMean(abs(`output/${fx.slug}/final/${fx.slug}_final_v2.mp4`), 0.8);
    expect(b.r / b.b).toBeGreaterThan((a.r / a.b) * 1.3);
    const del = await c.del(refsUrl(`/${ref.id}`));
    expect([del.status, del.body.error.code]).toEqual([409, 'COLOR_REF_IN_USE']);
    expect((await c.get(refsUrl())).body.items.find((i: any) => i.id === ref.id).used_by).toEqual([2]);
    // bản v1 không có color_ref
    expect((await c.get(cutsUrl(`/${v1.id}`))).body.color_ref).toBeNull();
  });

  it('kế hoạch bị xoá (thùng rác) → 404 cho list/tải/chép/xoá và file ảnh mẫu không phục vụ nữa', async () => {
    const ref = (await upload(c, 'am.png', colorPng('warm', 0))).body.color_ref;
    expect((await c.get(ref.thumb_url)).status).toBe(200);
    const { deleteProject } = await import('../src/services/trash.js');
    deleteProject(L.env.ctx, fx.plan.id, { by: 'app' });
    expect((await c.get(refsUrl())).status).toBe(404);
    expect((await upload(c, 'b.png', colorPng('warm', 1))).status).toBe(404);
    expect((await c.post(refsUrl('/from-asset'), { ref_id: 1 })).status).toBe(404);
    expect((await c.del(refsUrl(`/${ref.id}`))).status).toBe(404);
    expect((await c.get(ref.thumb_url)).status).toBe(404);
    expect((await c.get(ref.image_url)).status).toBe(404);
  });
});
