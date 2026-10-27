import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeProject } from '../src/services/trash.js';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { colorPng, cubeText, frameMean } from './helpers-color.js';
import { PNG_BYTES, claimEditPlan, edlFor, makeEnv, multipart, setupAllDone, setupProject, toStoryboardReview, writeFile, type Env, type Scenario } from './helpers.js';

const SLUG = 'cacao-actiso-plus';
const DIR = `output/${SLUG}/final/color-refs`;
const run = FFMPEG && FFPROBE ? describe : describe.skip;

let env: Env;
let sc: Scenario;
const abs = (rel: string) => path.join(env.root, rel);
const db = () => env.ctx.db;
const refsUrl = (tail = '') => `/api/projects/${sc.project.id}/color-refs${tail}`;
const files = () => (fs.existsSync(abs(DIR)) ? fs.readdirSync(abs(DIR)).sort() : []);
const rows = () => db().prepare('SELECT * FROM color_refs WHERE project_id = ? ORDER BY id').all(sc.project.id) as any[];

/** POST multipart (một file; `fields` đứng trước file). */
async function upload(name: string, data: Buffer, opts: { url?: string; fields?: Record<string, string> } = {}) {
  const m = multipart([...Object.entries(opts.fields ?? {}).map(([k, v]) => ({ name: k, value: v })), { name: 'file', filename: name, data }]);
  const res = await env.app.inject({ method: 'POST', url: opts.url ?? refsUrl(), payload: m.payload, headers: { host: 'localhost:8787', ...m.headers } });
  let body: any = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    /* văn bản */
  }
  return { status: res.statusCode, body, raw: res.body };
}

describe('color_refs: tải lên / chép / liệt kê / xoá (app chính)', () => {
  beforeEach(async () => {
    env = await makeEnv();
    sc = await setupProject(env, { scenes: 2 });
  });
  afterEach(async () => {
    await env.close();
  });

  it('tải ảnh: 201 + JSON (thumb, ảnh gốc, kích thước), file đặt theo hash trong output/<slug>/final/color-refs, có thumb; GET liệt kê', async () => {
    if (!FFMPEG) return;
    const png = colorPng('warm');
    const r = await upload('Mẫu ấm.png', png, { fields: { created_by_name: 'An' } });
    expect(r.status, r.raw).toBe(201);
    const ref = r.body.color_ref;
    expect(r.body.existing).toBe(false);
    expect(ref).toMatchObject({ kind: 'image', original_name: 'Mẫu ấm.png', width: 160, height: 240, lut_size: null, created_by_name: 'An', used_by: [] });
    expect(ref.thumb_url).toMatch(new RegExp(`^/files/${DIR}/[0-9a-f]{16}_thumb\\.jpg$`));
    expect(ref.image_url).toMatch(new RegExp(`^/files/${DIR}/[0-9a-f]{16}\\.png$`));
    expect(files()).toHaveLength(2);
    expect(fs.readFileSync(abs(DIR + '/' + files().find((f) => f.endsWith('.png'))!)).equals(png)).toBe(true);
    const row = rows()[0];
    expect(row).toMatchObject({ project_id: sc.project.id, kind: 'image', original_name: 'Mẫu ấm.png', width: 160, height: 240 });
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await sc.user.get(ref.thumb_url)).status).toBe(200);
    const list = (await sc.user.get(refsUrl())).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(ref.id);
    expect(list.sources).toEqual({ refs: [], assets: [] });
  });

  it('chống trùng theo content_hash trong dự án: tải lại cùng nội dung → 200 existing:true, cùng id, không thêm dòng/file; nội dung khác → dòng mới', async () => {
    if (!FFMPEG) return;
    const a = await upload('a.png', colorPng('warm'));
    const again = await upload('khac-ten.png', colorPng('warm'));
    expect([again.status, again.body.existing, again.body.color_ref.id]).toEqual([200, true, a.body.color_ref.id]);
    expect(rows()).toHaveLength(1);
    expect(files()).toHaveLength(2);
    const b = await upload('b.png', colorPng('warm', 1));
    expect([b.status, b.body.color_ref.id]).toEqual([201, a.body.color_ref.id + 1]);
    expect(rows()).toHaveLength(2);
    // dự án khác có thể có cùng nội dung (UNIQUE chỉ theo dự án)
    const other = (await sc.user.post('/api/projects', { name: 'Dự án khác', brief: 'x' })).body;
    const o = await upload('a.png', colorPng('warm'), { url: `/api/projects/${other.id}/color-refs` });
    expect(o.status).toBe(201);
  });

  it('kiểm tra magic bytes: file giả đuôi .png/.jpg → 415; GIF/BMP → 415; PNG hỏng (ffprobe không đọc được) → 400 INVALID_IMAGE và KHÔNG để lại file/dòng', async () => {
    const bad = async (name: string, data: Buffer, status: number, code: string) => {
      const r = await upload(name, data);
      expect([name, r.status, r.body.error?.code]).toEqual([name, status, code]);
    };
    await bad('gia.png', Buffer.from('đây là văn bản, không phải ảnh'), 415, 'UNSUPPORTED_FILE_TYPE');
    await bad('gia.jpg', Buffer.from('<html>x</html>'), 415, 'UNSUPPORTED_FILE_TYPE');
    await bad('anh.gif', Buffer.from('GIF89a\x01\x00\x01\x00'), 415, 'UNSUPPORTED_FILE_TYPE');
    await bad('anh.bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(60)]), 415, 'UNSUPPORTED_FILE_TYPE');
    await bad('khong-co-duoi', Buffer.from('abc'), 415, 'UNSUPPORTED_FILE_TYPE');
    await bad('x.svg', Buffer.from('<svg/>'), 415, 'UNSUPPORTED_FILE_TYPE');
    if (FFMPEG) {
      const truncated = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from('không phải dữ liệu PNG hợp lệ')]);
      await bad('hong.png', truncated, 400, 'INVALID_IMAGE');
    }
    expect(rows()).toHaveLength(0);
    expect(files()).toEqual([]);
  });

  it('dung lượng: ảnh > 15 MB → 413; .cube > 5 MB → 413; tên file có .. hoặc / → 400; không file → 400; hai file → 400', async () => {
    const png = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(15 * 1024 * 1024 + 10, 1)]);
    const big = await upload('lon.png', png);
    expect([big.status, big.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    const bigCube = await upload('lon.cube', Buffer.alloc(5 * 1024 * 1024 + 10, 0x20));
    expect([bigCube.status, bigCube.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    for (const name of ['../x.png', 'a/b.png', 'a\\b.png']) expect([name, (await upload(name, PNG_BYTES)).body.error.code]).toEqual([name, 'INVALID_FILENAME']);
    const none = await env.app.inject({ method: 'POST', url: refsUrl(), headers: { host: 'localhost:8787' }, payload: {} });
    expect(none.statusCode).toBe(400); // không phải multipart
    const m = multipart([{ name: 'label', value: 'x' }]);
    const noFile = await env.app.inject({ method: 'POST', url: refsUrl(), payload: m.payload, headers: { host: 'localhost:8787', ...m.headers } });
    expect([noFile.statusCode, JSON.parse(noFile.body).error.code]).toEqual([400, 'NO_FILE']);
    const m2 = multipart([{ name: 'file', filename: 'a.png', data: PNG_BYTES }, { name: 'file', filename: 'b.png', data: PNG_BYTES }]);
    const two = await env.app.inject({ method: 'POST', url: refsUrl(), payload: m2.payload, headers: { host: 'localhost:8787', ...m2.headers } });
    expect(two.statusCode).toBeGreaterThanOrEqual(400);
    expect(rows()).toHaveLength(0);
  });

  it('file LUT: server đọc chặt và ghi lại bản chuẩn hoá (không lưu file gốc); trùng nội dung chuẩn hoá thì dùng lại; sai → 400 INVALID_LUT không để lại gì', async () => {
    const raw = cubeText(5, { title: 'thương hiệu' });
    const r = await upload('Brand LUT.CUBE', Buffer.from(raw));
    expect(r.status, r.raw).toBe(201);
    expect(r.body.color_ref).toMatchObject({ kind: 'lut', lut_size: 5, original_name: 'Brand LUT.CUBE', thumb_url: null, image_url: null, width: null });
    expect(files()).toHaveLength(1);
    const stored = fs.readFileSync(abs(DIR + '/' + files()[0]!), 'utf8');
    expect(stored).not.toBe(raw);
    expect(stored.split('\n')[0]).toBe('# autovideo color match');
    expect(stored).toContain('LUT_3D_SIZE 5');
    // cùng LUT nhưng khác chú thích/TITLE/dấu cách → cùng bản chuẩn hoá → dùng lại
    const same = await upload('other.cube', Buffer.from(`# khác\n${raw.replace('thương hiệu', 'tên khác').replace(/ /g, '  ')}`));
    expect([same.status, same.body.existing, same.body.color_ref.id]).toEqual([200, true, r.body.color_ref.id]);
    for (const [name, text, re] of [
      ['1d.cube', 'LUT_1D_SIZE 4\n0 0 0\n', /1D/],
      ['thieu.cube', cubeText(3).split('\n').slice(0, -3).join('\n'), /thiếu dòng/],
      ['to.cube', cubeText(70).slice(0, 10), /LUT_3D_SIZE/],
      ['ngoai.cube', cubeText(2).replace('1.000000', '9.0'), /ngoài khoảng 0–1/],
    ] as const) {
      const bad = await upload(name, Buffer.from(text));
      expect([name, bad.status, bad.body.error.code]).toEqual([name, 400, 'INVALID_LUT']);
      expect(bad.body.error.message).toMatch(re);
    }
    expect(files()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    // file .cube đặt tên .png vẫn là văn bản, không phải ảnh → 415 (kiểu file theo magic bytes/đuôi, không nhầm)
    expect((await upload('lut.png', Buffer.from(raw))).status).toBe(415);
  });

  it('chép ảnh có sẵn của dự án (ref_id / asset_id storyboard) sang color_refs; id của dự án khác hoặc sai loại → 404; thiếu/đủ cả hai tham số → 400', async () => {
    if (!FFMPEG) return;
    const refRel = `refs/${sc.project.id}/hop.png`;
    writeFile(env.root, refRel, colorPng('cool'));
    const pr = db().prepare('INSERT INTO project_refs (project_id, label, file_path, original_name, order_index, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(sc.project.id, 'Hộp', refRel, 'hop.png', env.ctx.now());
    const sb = await toStoryboardReview(sc, sc.scenes[0].id);
    const sbAssetId = (db().prepare("SELECT id FROM assets WHERE kind = 'storyboard' AND scene_id = ?").get(sc.scenes[0].id) as { id: number }).id;
    const videoLike = db().prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, created_at) VALUES (?, 'video', ?, 1, ?)").run(sc.scenes[0].id, 'output/x/video/C1_v1.mp4', env.ctx.now());
    void sb;
    const list = (await sc.user.get(refsUrl())).body;
    expect(list.sources.refs).toEqual([{ id: Number(pr.lastInsertRowid), label: 'Hộp', url: `/files/${refRel}` }]);
    expect(list.sources.assets.map((a: any) => [a.id, a.scene_code])).toEqual([[sbAssetId, 'C1']]);
    const a = await sc.user.post(refsUrl('/from-asset'), { ref_id: Number(pr.lastInsertRowid) });
    expect(a.status, a.raw).toBe(201);
    expect(a.body.color_ref).toMatchObject({ kind: 'image', original_name: 'hop.png', width: 160, height: 240 });
    expect(fs.existsSync(abs(refRel))).toBe(true); // chép, không di chuyển
    const again = await sc.user.post(refsUrl('/from-asset'), { ref_id: Number(pr.lastInsertRowid) });
    expect([again.status, again.body.existing]).toEqual([200, true]);
    const b = await sc.user.post(refsUrl('/from-asset'), { asset_id: sbAssetId });
    expect([b.status, b.body.color_ref?.kind]).toEqual([201, 'image']);
    expect((await sc.user.post(refsUrl('/from-asset'), { asset_id: Number(videoLike.lastInsertRowid) })).status).toBe(404); // không phải storyboard
    expect((await sc.user.post(refsUrl('/from-asset'), { ref_id: 99999 })).status).toBe(404);
    expect((await sc.user.post(refsUrl('/from-asset'), {})).status).toBe(400);
    expect((await sc.user.post(refsUrl('/from-asset'), { ref_id: 1, asset_id: 1 })).status).toBe(400);
    // ảnh tham chiếu/asset của DỰ ÁN KHÁC → 404
    const other = (await sc.user.post('/api/projects', { name: 'Dự án khác', brief: 'x' })).body;
    expect((await sc.user.post(`/api/projects/${other.id}/color-refs/from-asset`, { ref_id: Number(pr.lastInsertRowid) })).status).toBe(404);
    expect((await sc.user.post(`/api/projects/${other.id}/color-refs/from-asset`, { asset_id: sbAssetId })).status).toBe(404);
    expect(rows()).toHaveLength(2);
  });

  it('xoá: chưa dùng → ok (dòng + file + thumb mất); id không thuộc dự án → 404; id sai → 400', async () => {
    if (!FFMPEG) return;
    const r = await upload('a.png', colorPng('warm'));
    const id = r.body.color_ref.id;
    const other = (await sc.user.post('/api/projects', { name: 'Dự án khác', brief: 'x' })).body;
    expect((await sc.user.del(`/api/projects/${other.id}/color-refs/${id}`)).status).toBe(404);
    expect((await sc.user.del(refsUrl('/abc'))).status).toBe(400);
    expect((await sc.user.del(refsUrl(`/${id}`))).body).toEqual({ ok: true });
    expect(rows()).toHaveLength(0);
    expect(files()).toEqual([]);
    expect((await sc.user.del(refsUrl(`/${id}`))).status).toBe(404);
  });

  it('dự án không tồn tại → 404', async () => {
    expect((await sc.user.get('/api/projects/99999/color-refs')).status).toBe(404);
    expect((await upload('a.png', PNG_BYTES, { url: '/api/projects/99999/color-refs' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------- dựng thật

let fake: FakeRenderer;
const idle = () => env.ctx.finalRender!.idle();
const get = async (id: number) => (await sc.user.get(`/api/final-cuts/${id}`)).body;

async function mk() {
  fake = new FakeRenderer();
  fake.realVideo = { seconds: 2, audio: true };
  env = await makeEnv({ finalRenderer: fake, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 }, config: { watermarkRemover: 'off' } });
  sc = await setupAllDone(env, { scenes: 2 });
}
async function readyV1() {
  const job = await claimEditPlan(sc);
  const cut = await get(job.payload.final_cut_id);
  const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut, [0.2, 1.8]), summary: 'Cắt đầu cuối.' } });
  expect(r.status, r.raw).toBe(200);
  await idle();
  const v1 = await get(cut.id);
  expect(v1.status).toBe('ready');
  return v1;
}
async function warmRef(variant = 0): Promise<any> {
  const r = await upload(`am-${variant}.png`, colorPng('warm', variant));
  expect(r.status, r.raw).toBe(201);
  return r.body.color_ref;
}

run('màu theo ảnh mẫu: dựng thật qua API (grade, preview, AI, thùng rác)', () => {
  beforeEach(() => mk());
  afterEach(async () => {
    fake?.release();
    await env?.close();
  });

  it('grade với match: kiểm tra ref_id thuộc dự án (400 INVALID_GRADE), tạo phiên bản dùng ảnh mẫu, chip + color_ref trong JSON, LUT ghi vào luts/, video đổi tông; xoá ảnh đang dùng → 409', async () => {
    const v1 = await readyV1();
    const ref = await warmRef();
    // ref_id không tồn tại / của dự án khác / sai loại / sai kiểu
    const other = (await sc.user.post('/api/projects', { name: 'Dự án khác', brief: 'x' })).body;
    const foreign = await upload('x.png', colorPng('cool'), { url: `/api/projects/${other.id}/color-refs` });
    for (const match of [{ kind: 'image', ref_id: 99999 }, { kind: 'image', ref_id: foreign.body.color_ref.id }, { kind: 'lut', ref_id: ref.id }, { kind: 'image', ref_id: 'x' }, { kind: 'image', ref_id: ref.id, mode: 'weird' }]) {
      const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match } });
      expect([JSON.stringify(match), r.status, r.body.error.code]).toEqual([JSON.stringify(match), 400, 'INVALID_GRADE']);
      const p = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { match } });
      expect([JSON.stringify(match), p.status, p.body.error.code]).toEqual([JSON.stringify(match), 400, 'INVALID_GRADE']);
    }
    expect((await get(v1.id)).status).toBe('ready');
    expect((await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body).toHaveLength(1);

    const g = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 1 } }, note: 'theo ảnh mẫu' });
    expect(g.status, g.raw).toBe(201);
    expect(g.body.final_cut).toMatchObject({ created_by: 'user', status: 'rendering', stage: 'grade', grade_chips: ['Màu theo ảnh mẫu 100%'] });
    await idle();
    const v2 = await get(g.body.final_cut.id);
    expect(v2).toMatchObject({
      status: 'ready',
      grade: { match: { kind: 'image', ref_id: ref.id, strength: 1, mode: 'color', per_scene: false } },
      color_ref: { id: ref.id, kind: 'image', original_name: ref.original_name, thumb_url: ref.thumb_url },
      base_path: `output/${SLUG}/final/${SLUG}_final_v2_base.mp4`,
    });
    expect(v2.revision.summary).toContain('Màu theo ảnh mẫu 100%');
    const luts = fs.readdirSync(abs(`output/${SLUG}/final/luts`));
    expect(luts).toHaveLength(1);
    expect(luts[0]).toMatch(/^[0-9a-f]{16}\.cube$/);
    // bản mới ấm hơn bản gốc (ảnh mẫu cam)
    const a = frameMean(abs(v1.video_path), 0.8);
    const b = frameMean(abs(v2.video_path), 0.8);
    expect(b.r / b.b).toBeGreaterThan((a.r / a.b) * 1.3);
    // dùng ảnh mẫu → không xoá được
    expect((await sc.user.get(refsUrl())).body.items[0].used_by).toEqual([2]);
    const del = await sc.user.del(refsUrl(`/${ref.id}`));
    expect([del.status, del.body.error.code]).toEqual([409, 'COLOR_REF_IN_USE']);
    expect(del.body.error.message).toContain('v2');
    expect(rows()).toHaveLength(1);
    // bản v1 (không dùng ảnh mẫu) không có color_ref
    expect((await get(v1.id)).color_ref).toBeNull();
  });

  it('xem trước dùng cùng pipeline có lut3d: 3 ảnh, "sau" khác "trước", cache theo hash; ảnh mẫu bị xoá file → 409 FILE_MISSING ở grade', async () => {
    const v1 = await readyV1();
    const ref = await warmRef();
    const pv = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 1 } } });
    expect(pv.status, pv.raw).toBe(200);
    expect(pv.body.items).toHaveLength(3);
    for (const it of pv.body.items) {
      expect((await sc.user.get(it.before_url)).status).toBe(200);
      expect((await sc.user.get(it.after_url)).status).toBe(200);
      expect(it.before_url).not.toBe(it.after_url);
    }
    const hash = pv.body.hash;
    const pv2 = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 1 } } });
    expect(pv2.body.hash).toBe(hash);
    // hash khác khi đổi cường độ
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 0.5 } } })).body.hash).not.toBe(hash);
    // sau ấm hơn trước
    const [a, b] = [frameMean(abs(pv.body.items[1].before_url.replace('/files/', '')), 0), frameMean(abs(pv.body.items[1].after_url.replace('/files/', '')), 0)];
    expect(b.r / b.b).toBeGreaterThan((a.r / a.b) * 1.3);
    // file ảnh mẫu mất → báo ngay khi tạo phiên bản, không tạo bản hỏng
    fs.rmSync(abs(rows()[0].file_path));
    const g = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'image', ref_id: ref.id } } });
    expect([g.status, g.body.error.code]).toEqual([409, 'FILE_MISSING']);
    const p = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 0.9 } } });
    expect([p.status, p.body.error.code]).toEqual([409, 'COLOR_MATCH_FAILED']);
    expect((await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body).toHaveLength(1);
  });

  it('khớp riêng từng cảnh + chỉnh thường chồng lên (lut3d trước eq): phiên bản ready, LUT mỗi cảnh một file', async () => {
    const v1 = await readyV1();
    const ref = await warmRef();
    const g = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 0.8, per_scene: true, mode: 'full' }, contrast: 1.1 } });
    expect(g.status, g.raw).toBe(201);
    expect(g.body.final_cut.grade_chips).toEqual(['Màu theo ảnh mẫu 80%', 'Giống cả độ sáng', 'Khớp từng cảnh', 'Tương phản 1.10']);
    await idle();
    expect(await get(g.body.final_cut.id)).toMatchObject({ status: 'ready' });
    expect(fs.readdirSync(abs(`output/${SLUG}/final/luts`))).toHaveLength(2);
  });

  it('file LUT: dùng được cho grade (kind lut), xoá file LUT sinh ra trong luts/ không ảnh hưởng (tính lại theo hash)', async () => {
    const v1 = await readyV1();
    const lut = (await upload('swap.cube', Buffer.from(cubeText(9, { swap: true })))).body.color_ref;
    const g = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'lut', ref_id: lut.id, strength: 1, mode: 'full', per_scene: true } } });
    expect(g.status, g.raw).toBe(201);
    expect(g.body.final_cut.grade).toMatchObject({ match: { kind: 'lut', ref_id: lut.id, strength: 1, mode: 'color', per_scene: false } });
    expect(g.body.final_cut.grade_chips).toEqual(['Màu theo file LUT 100%']);
    await idle();
    const v2 = await get(g.body.final_cut.id);
    expect(v2.status).toBe('ready');
    expect(v2.color_ref).toMatchObject({ id: lut.id, kind: 'lut', thumb_url: null });
    const a = frameMean(abs(v1.video_path), 0.8);
    const b = frameMean(abs(v2.video_path), 0.8);
    expect(Math.abs(b.r - a.b) + Math.abs(b.b - a.r)).toBeLessThan(14); // R↔B hoán đổi
    // xoá LUT đã sinh → chạy lại bước chỉnh màu vẫn được (tính lại theo hash)
    fs.rmSync(abs(`output/${SLUG}/final/luts`), { recursive: true, force: true });
    const g2 = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'lut', ref_id: lut.id, strength: 1 } } });
    expect(g2.status, g2.raw).toBe(201);
    await idle();
    expect((await get(g2.body.final_cut.id)).status).toBe('ready');
    expect(fs.readdirSync(abs(`output/${SLUG}/final/luts`))).toHaveLength(1);
  });

  it('AI giữ match: payload gửi parent_grade có match + original_name; AI không nhắc → giữ; match null → bỏ; strength đổi; ref_id AI tự đặt bị bỏ qua; bản cha không có match thì không thêm', async () => {
    const v1 = await readyV1();
    const ref = await warmRef();
    const other = await warmRef(1);
    const g = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'image', ref_id: ref.id, strength: 0.7 } } });
    await idle();
    const v2 = await get(g.body.final_cut.id);
    expect(v2.status).toBe('ready');
    const revise = async (parent: any, text: string, result: Record<string, unknown>) => {
      const f = await sc.user.post(`/api/final-cuts/${parent.id}/feedback`, { feedback: text });
      expect(f.status, f.raw).toBe(201);
      const job = await claimEditPlan(sc);
      const done = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result });
      expect(done.status, done.raw).toBe(200);
      await idle();
      return { job, cut: await get(f.body.final_cut.id) };
    };
    // 1) AI chỉ đổi nhiệt độ, không nhắc match → match giữ nguyên (bản cha → payload có original_name)
    const a = await revise(v2, 'ấm hơn', { edl: null, grade: { temperature_k: 7000 }, summary: 'Ấm 7000K', not_done: [] });
    expect(a.job.payload.revision.parent_grade.match).toEqual({ kind: 'image', ref_id: ref.id, strength: 0.7, mode: 'color', per_scene: false, original_name: ref.original_name });
    expect(a.cut).toMatchObject({ status: 'ready', grade: { temperature_k: 7000, match: { kind: 'image', ref_id: ref.id, strength: 0.7 } }, grade_chips: ['Màu theo ảnh mẫu 70%', 'Ấm 7000K'] });
    // 2) grade thiếu hẳn (null) → vẫn giữ match; không có khoá grade → giữ nguyên bản cha
    const b = await revise(a.cut, 'giữ nguyên', { edl: null, summary: 'Không đổi', not_done: [] });
    expect(b.cut.grade.match).toMatchObject({ ref_id: ref.id });
    const b2 = await revise(b.cut, 'đặt lại màu thường', { edl: null, grade: null, summary: 'Về màu gốc (thông số thường)', not_done: [] });
    expect(b2.cut.grade).toMatchObject({ temperature_k: 6500, match: { ref_id: ref.id } });
    // 3) "giống ảnh mẫu hơn": strength +0.15; AI cố đổi ref_id/kind → bị bỏ qua
    const c = await revise(b2.cut, 'giống ảnh mẫu hơn', { edl: null, grade: { match: { kind: 'lut', ref_id: other.id, strength: 0.85, mode: 'full' } }, summary: 'Cường độ 70% → 85%', not_done: [] });
    expect(c.cut.grade.match).toEqual({ kind: 'image', ref_id: ref.id, strength: 0.85, mode: 'full', per_scene: false });
    // 4) "bỏ ảnh mẫu": match null → không còn match (grade trung tính → không có grade)
    const d = await revise(c.cut, 'bỏ ảnh mẫu', { edl: null, grade: { match: null }, summary: 'Bỏ ảnh mẫu', not_done: [] });
    expect(d.cut.grade).toBeNull();
    expect(d.cut.color_ref).toBeNull();
    // 5) bản cha không có match: AI đặt match của ảnh khác → bị bỏ qua
    const e = await revise(d.cut, 'dùng ảnh khác', { edl: null, grade: { match: { kind: 'image', ref_id: other.id, strength: 1 } }, summary: 'x', not_done: [] });
    expect(e.cut.grade).toBeNull();
    // ảnh đã hết bản dựng dùng? vẫn còn (v2..v6 có match) nên chưa xoá được
    expect((await sc.user.del(refsUrl(`/${ref.id}`))).status).toBe(409);
    expect((await sc.user.del(refsUrl(`/${other.id}`))).status).toBe(200); // chưa bản nào dùng
  });

  it('thùng rác: dự án vào thùng rác → API color-refs 404 và file không phục vụ; khôi phục → dùng lại; xoá vĩnh viễn → dòng color_refs mất (CASCADE) cùng file', async () => {
    const v1 = await readyV1();
    const ref = await warmRef();
    const g = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { match: { kind: 'image', ref_id: ref.id } } });
    await idle();
    expect((await get(g.body.final_cut.id)).status).toBe('ready');
    const thumb = ref.thumb_url as string;
    expect((await sc.user.get(thumb)).status).toBe(200);
    const del = await sc.user.del(`/api/projects/${sc.project.id}`, { confirm_name: 'Cacao Actiso Plus' });
    expect(del.status, del.raw).toBe(200);
    const trashPath = (db().prepare('SELECT trash_path FROM projects WHERE id = ?').get(sc.project.id) as { trash_path: string }).trash_path;
    // file đi theo thư mục dự án vào thùng rác; dòng DB còn nguyên (xoá mềm)
    expect(fs.existsSync(abs(DIR))).toBe(false);
    expect(fs.existsSync(abs(`${trashPath}/output/final/color-refs`))).toBe(true);
    expect(fs.readdirSync(abs(`${trashPath}/output/final/color-refs`))).toHaveLength(2);
    expect(rows()).toHaveLength(1);
    expect((await sc.user.get(refsUrl())).status).toBe(404);
    expect((await upload('b.png', colorPng('warm', 3))).status).toBe(404);
    expect((await sc.user.del(refsUrl(`/${ref.id}`))).status).toBe(404);
    expect((await sc.user.get(thumb)).status).toBe(404);
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { match: { kind: 'image', ref_id: ref.id } } })).status).toBeGreaterThanOrEqual(400);
    // khôi phục → dùng lại bình thường
    expect((await sc.user.post(`/api/trash/${sc.project.id}/restore`)).status).toBe(200);
    expect(fs.readdirSync(abs(DIR))).toHaveLength(2);
    expect((await sc.user.get(thumb)).status).toBe(200);
    expect((await sc.user.get(refsUrl())).body.items).toHaveLength(1);
    // xoá lần nữa rồi xoá vĩnh viễn
    expect((await sc.user.del(`/api/projects/${sc.project.id}`, { confirm_name: 'Cacao Actiso Plus' })).status).toBe(200);
    const trashPath2 = (db().prepare('SELECT trash_path FROM projects WHERE id = ?').get(sc.project.id) as { trash_path: string }).trash_path;
    purgeProject(env.ctx, sc.project.id, { confirmName: 'Cacao Actiso Plus' });
    expect(rows()).toHaveLength(0);
    expect(db().prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(sc.project.id)).toEqual({ n: 0 });
    expect(fs.existsSync(abs(trashPath2))).toBe(false);
    expect(fs.existsSync(abs(DIR))).toBe(false);
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
