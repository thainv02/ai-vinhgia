import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEXT_JOB_TYPES } from '../src/config.js';
import { setCompositionValidator } from '../src/services/html/compose-lifecycle.js';
import { createComposingVersion } from '../src/services/html/versions.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { PNG_BYTES } from './helpers.js';
import { managedClient } from './helpers-media.js';

let L: LanEnv;
let c: LanClient;
beforeEach(async () => {
  L = await makeLanEnv({ config: { workerMode: 'managed', managedJobTypes: TEXT_JOB_TYPES } });
  c = L.client();
});
afterEach(async () => {
  setCompositionValidator(null);
  await L.close();
});

const P = '/lan/api/html-projects';
const db = () => L.env.ctx.db;
let seq = 0;
const key = () => `key-${Date.now()}-${++seq}-abcdef`;

const INDEX = '<!doctype html><html><head><meta charset="utf-8"><title>Demo</title></head><body><h1 data-hf-var="title">Giảm giá lớn</h1><p data-hf-var="sub">Chỉ hôm nay</p></body></html>';
const VARS = [
  { id: 'title', type: 'text', label: 'Tiêu đề', value: 'Giảm giá lớn' },
  { id: 'sub', type: 'text', label: 'Phụ đề', value: 'Chỉ hôm nay' },
  { id: 'brand', type: 'color', label: 'Màu thương hiệu', value: '#ff8800' },
];
const result = (extra: Record<string, unknown> = {}) => ({
  files: [{ path: 'index.html', content: INDEX }, { path: 'compositions/cảnh-1.html', content: '<div>Cảnh 1</div>' }, { path: 'assets/css/style.css', content: 'h1{color:var(--hf-brand)}' }],
  summary: 'Video giảm giá',
  variables: VARS,
  ...extra,
});

async function mk(over: Record<string, unknown> = {}) {
  const r = await c.post(P, { name: 'Khuyến mãi tháng 11', brief: 'Giảm giá sốc', aspect: '9:16', duration_s: 15, quality: '720p', template: null, model: {}, ...over });
  expect(r.status).toBe(201);
  return r.body;
}
const compose = (pid: number, prompt = 'Video giảm giá 50%', k = key()) => c.post(`${P}/${pid}/compose`, { prompt, idempotency_key: k });
const claim = async () => {
  const r = await managedClient(L.env).get('/api/worker/next?mode=managed');
  expect(r.status).toBe(200);
  return r.body;
};
const complete = (job: any, res: unknown, k = `done-${job.id}`) => managedClient(L.env, 'W1', job.lease_id, job.id).post(`/api/worker/jobs/${job.id}/complete`, { result: res }, { 'idempotency-key': k });
/** Tạo project + compose + claim + complete: trả { p, v (view đã ready), job }. */
async function ready(over: Record<string, unknown> = {}, res: unknown = result()) {
  const p = await mk(over);
  const v1 = (await compose(p.id)).body.version;
  const job = await claim();
  const done = await complete(job, res);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const v = (await c.get(`${P}/${p.id}/versions/${v1.version}`)).body;
  return { p, v, job };
}
const pdir = (slug: string) => path.join(L.env.root, 'output', slug, 'html');

describe('dự án Video HTML', () => {
  it('tạo/xem/liệt kê/đổi tên: kích thước chính xác theo tỉ lệ và chất lượng; mặc định model tự chọn', async () => {
    const a = await mk();
    expect(a).toMatchObject({ kind: 'html', name: 'Khuyến mãi tháng 11', aspect: '9:16', width: 720, height: 1280, fps: 30, duration_s: 15, quality: '720p', template_id: null, model: { compose: 'auto', vision: 'auto' }, version_count: 0, latest_version: null, asset_count: 0, delete_block: null });
    expect(a.slug).toBe('khuyen-mai-thang-11');
    const sq = await mk({ name: 'Vuông', aspect: '1:1', quality: '1080p', template: 'san-pham', model: { compose: 'claude-sonnet-4-6' } });
    expect(sq).toMatchObject({ width: 1080, height: 1080, template_id: 'san-pham', model: { compose: 'claude-sonnet-4-6', vision: 'auto' } });
    expect((await mk({ name: 'Ngang', aspect: '16:9' }))).toMatchObject({ width: 1280, height: 720 });
    expect((await c.get(P)).body.map((x: any) => x.name)).toEqual(['Ngang', 'Vuông', 'Khuyến mãi tháng 11']);
    const pr = await c.patch(`${P}/${a.id}`, { name: 'Tên mới', brief: 'Brief mới' });
    expect(pr.body).toMatchObject({ name: 'Tên mới', brief: 'Brief mới', slug: 'khuyen-mai-thang-11' });
  });

  it('kiểm tra đầu vào: tỉ lệ/thời lượng/chất lượng/tên', async () => {
    for (const bad of [{ aspect: '4:3' }, { duration_s: 0 }, { duration_s: 601 }, { duration_s: 1.5 }, { quality: '4k' }, { name: '  ' }, { template: 'A B' }, { model: { compose: 'a b' } }]) {
      const r = await c.post(P, { name: 'X', ...bad });
      expect([r.status, r.body.error.code], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR']);
    }
  });


  it('dự án kế hoạch/cắt clip không dùng được qua route Video HTML và ngược lại: kế hoạch không đụng được dự án HTML', async () => {
    const p = await mk();
    const plan = (await c.post('/lan/api/plans', { name: 'Kế hoạch', created_by_name: 'Minh' })).body.plan;
    const clip = (await c.post('/lan/api/clip-projects', { name: 'Clip', created_by_name: 'Minh' })).body.project;
    for (const id of [plan.id, clip.id]) {
      expect((await c.get(`${P}/${id}`)).status).toBe(404);
      expect((await c.post(`${P}/${id}/compose`, { prompt: 'x', idempotency_key: key() })).status).toBe(404);
      expect((await c.del(`${P}/${id}`)).status).toBe(404);
      expect((await c.get(`${P}/${id}/versions`)).status).toBe(404);
    }
    // route kế hoạch/clip không thấy và không xoá được dự án HTML (gotcha lanProjectAny)
    expect((await c.get(`/lan/api/plans/${p.id}`)).status).toBe(404);
    expect((await c.del(`/lan/api/plans/${p.id}`)).status).toBe(404);
    expect((await c.del(`/lan/api/clip-projects/${p.id}`)).status).toBe(404);
    expect(((await c.get('/lan/api/plans')).body as any[]).map((x) => x.id)).toEqual([plan.id]);
    expect(((await c.get('/lan/api/clip-projects')).body as any[]).map((x) => x.id)).toEqual([clip.id]);
    expect((await c.get('/lan/api/status')).status).toBeLessThan(500);
    expect(db().prepare('SELECT deleted_at FROM projects WHERE id = ?').get(p.id)).toEqual({ deleted_at: null });
    // app chính: danh sách dự án không lẫn dự án HTML
    expect(((await L.env.app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'localhost' } })).json() as any[]).map((x) => x.kind)).not.toContain('html');
  });
});

describe('compose → job → version ready', () => {
  it('tạo version composing + job html_compose (payload snapshot) trong một thao tác; claim giữ nguyên payload đã lưu', async () => {
    const p = await mk({ model: { compose: 'claude-sonnet-4-6' } });
    const r = await compose(p.id, 'Giới thiệu sản phẩm mới');
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    const v = r.body.version;
    expect(v).toMatchObject({ version: 1, parent_version: null, status: 'composing', created_by: 'ai', prompt: 'Giới thiệu sản phẩm mới', policy: { compose: 'claude-sonnet-4-6', vision: 'claude-sonnet-4-6' }, files: [], content_hash: null });
    expect(v.job).toMatchObject({ status: 'queued' });
    const row = db().prepare("SELECT * FROM jobs WHERE id = ?").get(v.job.id) as any;
    expect(row).toMatchObject({ type: 'html_compose', project_id: p.id, scene_id: null, requires_approval: 0 });
    expect(row.approved_at).not.toBeNull();
    const payload = JSON.parse(row.payload);
    expect(payload).toMatchObject({
      project: { id: p.id, name: 'Khuyến mãi tháng 11', brief: 'Giảm giá sốc' },
      version: { number: 1, parent_version: null },
      prompt: 'Giới thiệu sản phẩm mới',
      spec: { aspect: '9:16', width: 720, height: 1280, fps: 30, duration_s: 15, quality: '720p' },
      policy: { compose: 'claude-sonnet-4-6', vision: 'claude-sonnet-4-6' },
      assets: [],
      parent: null,
      limits: { max_files: 40, max_file_bytes: 262144 },
    });
    // snapshot: đổi brief sau đó không ảnh hưởng payload khi claim (không tính lại)
    await c.patch(`${P}/${p.id}`, { brief: 'Brief đã đổi' });
    const job = await claim();
    expect(job).toMatchObject({ id: v.job.id, type: 'html_compose', status: 'claimed' });
    expect(job.lease_id).toBeTruthy();
    expect(job.payload.project.brief).toBe('Giảm giá sốc');
    expect(job.payload.version.id).toBe(v.id);
    expect((await managedClient(L.env).get('/api/worker/next?mode=managed')).status).toBe(204);
  });

  it('worker legacy (không managed) không nhận html_compose: loại này chỉ thuộc làn managed', async () => {
    const p = await mk();
    await compose(p.id);
    const legacy = await L.env.app.inject({ method: 'GET', url: '/api/worker/next', headers: { authorization: 'Bearer test-worker-token', 'x-worker-id': 'legacy' } });
    expect(legacy.statusCode).toBe(204);
  });

  it('hoàn thành (fake result, không AI thật) → version ready, file nằm trên đĩa trong versions/v1, manifest + hash, job done và result gọn', async () => {
    const { p, v, job } = await ready();
    expect(v).toMatchObject({ status: 'ready', summary: 'Video giảm giá', error: null, job: { status: 'done' } });
    expect(v.files.map((f: any) => f.path)).toEqual(['index.html', 'compositions/cảnh-1.html', 'assets/css/style.css']);
    expect(v.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.variables.map((x: any) => x.id)).toEqual(['title', 'sub', 'brand']);
    expect(v.lint_report).toMatchObject({ ok: true, checks: ['manifest', 'paths'] });
    const dir = path.join(pdir(p.slug), 'versions', 'v1');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(INDEX);
    expect(fs.readFileSync(path.join(dir, 'compositions', 'cảnh-1.html'), 'utf8')).toBe('<div>Cảnh 1</div>');
    expect(fs.existsSync(path.join(pdir(p.slug), 'staging', `${v.id}-1`))).toBe(false); // staging đã được rename
    const row = db().prepare('SELECT status, result FROM jobs WHERE id = ?').get(job.id) as any;
    expect(row.status).toBe('done');
    expect(JSON.parse(row.result)).toMatchObject({ version: 1, files: ['index.html', 'compositions/cảnh-1.html', 'assets/css/style.css'], content_hash: v.content_hash });
    expect(row.result).not.toContain('Cảnh 1'); // nội dung file không nằm trong job.result
    const pv = (await c.get(`${P}/${p.id}`)).body;
    expect(pv).toMatchObject({ version_count: 1, active_versions: 0, latest_version: { version: 1, status: 'ready' } });
    // hoàn thành lặp lại cùng key: idempotent; khác key: từ chối
    expect((await complete(job, result())).status).toBe(200);
    expect((await complete(job, result(), 'khac')).body.error.code).toBe('ALREADY_COMPLETED');
  });

  it('kết quả sai: manifest/đường dẫn/biến bị từ chối 400 và job GIỮ NGUYÊN để worker sửa rồi gọi lại', async () => {
    const p = await mk();
    const v = (await compose(p.id)).body.version;
    const job = await claim();
    const bad = async (res: unknown, code: string) => {
      const r = await complete(job, res, key());
      expect([r.status, r.body.error.code], JSON.stringify(res).slice(0, 80)).toEqual([400, code]);
      expect((db().prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as any).status).toBe('claimed');
      expect((await c.get(`${P}/${p.id}/versions/1`)).body.status).toBe('composing');
    };
    await bad({}, 'VALIDATION_ERROR');
    await bad({ files: [{ path: 'index.html', content: 'x' }], variables: 'sai' }, 'VALIDATION_ERROR');
    await bad(result({ files: [{ path: 'compositions/a.html', content: 'x' }] }), 'INVALID_MANIFEST'); // thiếu index.html
    for (const evil of ['compositions/../x.html', 'compositions\\x.html', '../index.html', 'C:foo.html', 'compositions/aux.html', 'compositions/a.html:stream', '/abs.html', 'package.json', 'node_modules/x.js'])
      await bad(result({ files: [{ path: 'index.html', content: INDEX }, { path: evil, content: 'x' }] }), 'INVALID_MANIFEST');
    await bad(result({ files: [{ path: 'index.html', content: INDEX }, { path: 'index.HTML', content: INDEX }] }), 'INVALID_MANIFEST');
    await bad(result({ variables: [{ id: 'title', type: 'text', label: 'T', value: 'Khác nội dung' }, ...VARS.slice(1)] }), 'VARIABLE_MISMATCH');
    await bad(result({ variables: [{ id: 'khong-co', type: 'text', label: 'T', value: 'x' }] }), 'VARIABLE_TARGET_NOT_FOUND');
    await bad(result({ variables: [{ id: 'brand', type: 'color', label: 'M', value: 'đỏ' }] }), 'VARIABLE_INVALID');
    expect(fs.existsSync(path.join(pdir(p.slug), 'versions'))).toBe(false);
    // sau các lần sai, kết quả đúng vẫn nhận được
    expect((await complete(job, result())).status).toBe(200);
    expect((await c.get(`${P}/${p.id}/versions/1`)).body).toMatchObject({ id: v.id, status: 'ready' });
  });

  it('hook validateComposition không đạt → 400 HTML_VALIDATION_FAILED, version quay về composing kèm báo cáo, không công bố; đạt ở lần sau', async () => {
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    setCompositionValidator(async () => ({ ok: false, errors: [{ code: 'LINT', message: 'thiếu data-composition-id' }], warnings: [], checks: ['lint'] }));
    const r = await complete(job, result(), key());
    expect([r.status, r.body.error.code]).toEqual([400, 'HTML_VALIDATION_FAILED']);
    const v = (await c.get(`${P}/${p.id}/versions/1`)).body;
    expect(v.status).toBe('composing');
    expect(v.lint_report.errors[0].message).toContain('data-composition-id');
    expect(fs.existsSync(path.join(pdir(p.slug), 'versions'))).toBe(false);
    expect(fs.readdirSync(path.join(pdir(p.slug), 'staging'))).toEqual([]); // staging đã dọn
    setCompositionValidator(null);
    expect((await complete(job, result(), key())).status).toBe(200);
  });

  it('job lỗi → version failed (mã lỗi/thông báo); job hủy → version cancelled; kết quả về muộn sau hủy bị từ chối và không công bố', async () => {
    const p = await mk();
    await compose(p.id);
    const j1 = await claim();
    const f = await managedClient(L.env, 'W1', j1.lease_id, j1.id).post(`/api/worker/jobs/${j1.id}/fail`, { error: 'AI trả JSON hỏng', code: 'OTHER' });
    expect(f.status).toBe(200);
    expect((await c.get(`${P}/${p.id}/versions/1`)).body).toMatchObject({ status: 'failed', error: 'AI trả JSON hỏng', error_code: 'OTHER' });
    expect((await complete(j1, result())).status).toBe(409);

    await compose(p.id);
    const j2 = await claim();
    const cancel = await c.post(`${P}/${p.id}/versions/2/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.version).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED', job: { status: 'cancelled' } });
    const late = await complete(j2, result());
    expect([late.status, late.body.error.code]).toEqual([409, 'JOB_CANCELLED']);
    expect(fs.existsSync(path.join(pdir(p.slug), 'versions', 'v2'))).toBe(false);
    expect((await c.post(`${P}/${p.id}/versions/2/cancel`)).status).toBe(409); // đã cancelled
    // heartbeat của worker cũng báo hủy
    expect((await managedClient(L.env, 'W1', j2.lease_id, j2.id).post(`/api/worker/jobs/${j2.id}/heartbeat`, {})).body.error.code).toBe('JOB_CANCELLED');
  });

  it('job cũ (version không còn composing) bị hủy lúc claim; job queued bị hủy khi người dùng hủy version', async () => {
    const p = await mk();
    await compose(p.id);
    db().prepare("UPDATE html_versions SET status = 'failed' WHERE project_id = ?").run(p.id); // lệch trạng thái
    expect((await managedClient(L.env).get('/api/worker/next?mode=managed')).status).toBe(204);
    expect(db().prepare("SELECT status, error FROM jobs WHERE type = 'html_compose'").get()).toMatchObject({ status: 'cancelled' });
    // hủy khi còn queued
    await compose(p.id);
    expect((await c.post(`${P}/${p.id}/versions/2/cancel`)).body.version).toMatchObject({ status: 'cancelled', job: { status: 'cancelled' } });
    expect((await managedClient(L.env).get('/api/worker/next?mode=managed')).status).toBe(204);
  });

  it('hoàn thành trực tiếp mà chưa qua bước staging (gọi thẳng completeJob) bị từ chối', async () => {
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    const { completeJob } = await import('../src/services/jobs.js');
    expect(() => completeJob(L.env.ctx, job.id, { result: result() })).toThrow(/staging|kiểm tra/);
    expect((await c.get(`${P}/${p.id}/versions/1`)).body.status).toBe('composing');
  });
});

describe('idempotency và số phiên bản', () => {
  it('cùng key hai lần → một version, một job; khác nội dung với cùng key → 409', async () => {
    const p = await mk();
    const k = key();
    const a = await compose(p.id, 'Prompt A', k);
    const b = await compose(p.id, 'Prompt A', k);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body).toMatchObject({ created: false, version: { id: a.body.version.id, version: 1 } });
    expect(db().prepare('SELECT COUNT(*) AS n FROM html_versions').get()).toEqual({ n: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'html_compose'").get()).toEqual({ n: 1 });
    expect((await compose(p.id, 'Prompt khác', k)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await c.post(`${P}/${p.id}/compose`, { prompt: 'x', idempotency_key: 'ngan' })).status).toBe(400); // key quá ngắn
    expect((await c.post(`${P}/${p.id}/compose`, { prompt: 'x' })).status).toBe(400); // thiếu key
  });

  it('nhiều yêu cầu đồng thời với key khác nhau → số phiên bản khác nhau liên tục, mỗi version đúng một job', async () => {
    const p = await mk();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => compose(p.id, `Prompt ${i}`)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(rs.map((r) => r.body.version.version).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(rs.map((r) => r.body.version.job.id)).size).toBe(8);
    expect(db().prepare("SELECT COUNT(DISTINCT compose_job_id) AS n FROM html_versions").get()).toEqual({ n: 8 });
    // cùng key đồng thời → vẫn một version
    const k = key();
    const same = await Promise.all(Array.from({ length: 5 }, () => compose(p.id, 'Giống', k)));
    expect(new Set(same.map((r) => r.body.version.id)).size).toBe(1);
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('số phiên bản không bao giờ dùng lại, kể cả khi bản trước failed/cancelled', async () => {
    const p = await mk();
    await compose(p.id);
    await c.post(`${P}/${p.id}/versions/1/cancel`);
    const v2 = await compose(p.id);
    expect(v2.body.version.version).toBe(2);
    expect(() => db().prepare("INSERT INTO html_versions (project_id, version, status, created_at) VALUES (?, 2, 'composing', 'x')").run(p.id)).toThrow(/UNIQUE/);
  });
});

describe('sửa bằng góp ý (revise) và phiên bản cha', () => {
  it('chỉ sửa từ phiên bản ready cùng dự án; payload mang file của bản cha; bản cha giữ nguyên', async () => {
    const { p } = await ready();
    const parentHash = (await c.get(`${P}/${p.id}/versions/1`)).body.content_hash;
    const r = await c.post(`${P}/${p.id}/versions/1/revise`, { feedback: 'Chữ to hơn, đổi màu cam', idempotency_key: key() });
    expect(r.status).toBe(201);
    expect(r.body.version).toMatchObject({ version: 2, parent_version: 1, status: 'composing', feedback: 'Chữ to hơn, đổi màu cam', prompt: 'Video giảm giá 50%' });
    const job = await claim();
    expect(job.payload.parent).toMatchObject({ version: 1, summary: 'Video giảm giá' });
    expect(job.payload.parent.files.map((f: any) => f.path)).toEqual(['index.html', 'compositions/cảnh-1.html', 'assets/css/style.css']);
    expect(job.payload.feedback).toBe('Chữ to hơn, đổi màu cam');
    const res2 = result({ files: [{ path: 'index.html', content: INDEX.replace('Giảm giá lớn', 'Giảm giá lớn') + '<!-- v2 -->' }] });
    expect((await complete(job, res2)).status).toBe(200);
    expect((await c.get(`${P}/${p.id}/versions/2`)).body.status).toBe('ready');
    const v1 = (await c.get(`${P}/${p.id}/versions/1`)).body;
    expect(v1.content_hash).toBe(parentHash); // bản cũ nguyên vẹn
    expect(fs.readFileSync(path.join(pdir(p.slug), 'versions', 'v1', 'index.html'), 'utf8')).toBe(INDEX);
    expect((await c.get(`${P}/${p.id}/versions`)).body.map((x: any) => x.version)).toEqual([2, 1]);
  });

  it('cha chưa ready (composing/failed) → 409; cha khác dự án → từ chối; không có cha → 404', async () => {
    const p = await mk();
    await compose(p.id);
    const r = await c.post(`${P}/${p.id}/versions/1/revise`, { feedback: 'x', idempotency_key: key() });
    expect([r.status, r.body.error.code]).toEqual([409, 'PARENT_NOT_READY']);
    expect((await c.post(`${P}/${p.id}/versions/9/revise`, { feedback: 'x', idempotency_key: key() })).status).toBe(404);
    // cha từ dự án khác (gọi thẳng service: route đã tra theo dự án nên cần kiểm tra cả lớp service)
    const { v: ov } = await ready({ name: 'Dự án khác' });
    expect(() => createComposingVersion(L.env.ctx, { projectId: p.id, parentId: ov.id, prompt: 'x' })).toThrow(/không thuộc dự án/);
  });
});

describe('sửa nhanh bằng biến', () => {
  it('tạo version created_by=user với chữ tiếng Việt được escape, màu qua biến CSS; bản cha không đổi; công bố bất biến', async () => {
    const { p } = await ready();
    const attack = '<script>alert(1)</script> & "Khuyến mãi" \'50%\'';
    const k = key();
    const r = await c.post(`${P}/${p.id}/versions/1/variables`, { values: { title: attack, brand: '#00AA11' }, idempotency_key: k });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.version).toMatchObject({ version: 2, parent_version: 1, created_by: 'user', status: 'ready', job: null });
    expect(r.body.version.variables.find((x: any) => x.id === 'title').value).toBe(attack);
    const dir = path.join(pdir(p.slug), 'versions', 'v2');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    expect(html).toContain('<h1 data-hf-var="title">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Khuyến mãi&quot; &#39;50%&#39;</h1>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<p data-hf-var="sub">Chỉ hôm nay</p>');
    expect(html).toContain('<style data-hf-vars>:root{--hf-brand:#00aa11;}</style>');
    expect(fs.readFileSync(path.join(dir, 'compositions', 'cảnh-1.html'), 'utf8')).toBe('<div>Cảnh 1</div>');
    expect(fs.readFileSync(path.join(pdir(p.slug), 'versions', 'v1', 'index.html'), 'utf8')).toBe(INDEX); // cha nguyên vẹn
    // cùng key → cùng version
    const again = await c.post(`${P}/${p.id}/versions/1/variables`, { values: { title: attack, brand: '#00AA11' }, idempotency_key: k });
    expect([again.status, again.body.created, again.body.version.version]).toEqual([200, false, 2]);
    expect(db().prepare('SELECT COUNT(*) AS n FROM html_versions WHERE project_id = ?').get(p.id)).toEqual({ n: 2 });
    // sửa tiếp từ bản user (chuỗi biến)
    const r3 = await c.post(`${P}/${p.id}/versions/2/variables`, { values: { sub: 'Mua ngay' }, idempotency_key: key() });
    expect(r3.body.version).toMatchObject({ version: 3, parent_version: 2, created_by: 'user' });
    expect(fs.readFileSync(path.join(pdir(p.slug), 'versions', 'v3', 'index.html'), 'utf8')).toContain('<p data-hf-var="sub">Mua ngay</p>');
  });

  it('từ chối: biến lạ, màu sai, chữ quá dài, cha chưa ready, thiếu giá trị', async () => {
    const { p } = await ready();
    const post = (values: unknown, v = 1) => c.post(`${P}/${p.id}/versions/${v}/variables`, { values, idempotency_key: key() });
    expect((await post({ khong_co: 'x' })).body.error.code).toBe('UNKNOWN_VARIABLE');
    expect((await post({ brand: 'red' })).body.error.code).toBe('VARIABLE_INVALID');
    expect((await post({ brand: '#12345' })).body.error.code).toBe('VARIABLE_INVALID');
    expect((await post({ title: 'a'.repeat(301) })).body.error.code).toBe('VARIABLE_INVALID');
    expect((await post({ title: 'dòng 1\ndòng 2' })).body.error.code).toBe('VARIABLE_INVALID');
    expect((await post({})).status).toBe(400);
    expect((await post({ 'Sai Id': 'x' })).status).toBe(400);
    await compose(p.id);
    expect((await post({ title: 'x' }, 2)).body.error.code).toBe('PARENT_NOT_READY');
    expect(db().prepare("SELECT COUNT(*) AS n FROM html_versions WHERE created_by = 'user'").get()).toEqual({ n: 0 }); // không version rác
  });

  it('hook kiểm tra không đạt ở phiên bản người dùng → version failed, không công bố', async () => {
    const { p } = await ready();
    setCompositionValidator(async () => ({ ok: false, errors: [{ code: 'X', message: 'bị chặn' }], warnings: [], checks: [] }));
    const r = await c.post(`${P}/${p.id}/versions/1/variables`, { values: { title: 'Mới' }, idempotency_key: key() });
    expect([r.status, r.body.error.code]).toEqual([400, 'HTML_VALIDATION_FAILED']);
    expect((await c.get(`${P}/${p.id}/versions/2`)).body).toMatchObject({ status: 'failed', error_code: 'HTML_VALIDATION_FAILED' });
    expect(fs.existsSync(path.join(pdir(p.slug), 'versions', 'v2'))).toBe(false);
  });
});

describe('asset', () => {
  const up = (pid: number, name: string, data: Buffer) => c.uploadVideo(`${P}/${pid}/assets`, { name, data, type: 'application/octet-stream' });

  it('tải ảnh PNG: nhận diện bằng magic bytes, đọc kích thước, lưu <hash8>-<id>.png; tên gốc chỉ là nhãn; xem lại được', async () => {
    const p = await mk();
    const r = await up(p.id, '../../logo giả.exe.png', PNG_BYTES);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'image', media_type: 'image/png', width: 1, height: 1, bytes: PNG_BYTES.length, path: `assets/u/${r.body.id}.png`, has_audio: null });
    const row = db().prepare('SELECT stored_path, content_hash, original_name FROM html_assets WHERE id = ?').get(r.body.id) as any;
    expect(row.stored_path).toBe(`output/${p.slug}/html/assets/${row.content_hash.slice(0, 8)}-${r.body.id}.png`);
    expect(row.original_name).not.toMatch(/[\\/]/);
    expect(fs.existsSync(path.join(L.env.root, row.stored_path))).toBe(true);
    expect(fs.readdirSync(path.join(pdir(p.slug), '.incoming'))).toEqual([]);
    const file = await c.get(r.body.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect((await c.get(`${P}/${p.id}/assets`)).body.map((a: any) => a.id)).toEqual([r.body.id]);
    expect((await c.get(`${P}`)).body[0]).toMatchObject({ asset_count: 1, asset_bytes: PNG_BYTES.length });
  });

  it('từ chối: không phải media (đổi đuôi .png), rỗng, ảnh hỏng, dự án khác loại; không để file tạm', async () => {
    const p = await mk();
    const plan = (await c.post('/lan/api/plans', { name: 'KH', created_by_name: 'M' })).body.plan;
    const txt = await up(p.id, 'a.png', Buffer.from('đây là văn bản, không phải ảnh'));
    expect([txt.status, txt.body.error.code]).toEqual([415, 'UNSUPPORTED_FILE_TYPE']);
    expect((await up(p.id, 'a.png', Buffer.alloc(0))).status).toBe(415);
    const trunc = await up(p.id, 'a.png', PNG_BYTES.subarray(0, 12));
    expect([trunc.status, trunc.body.error.code]).toEqual([415, 'INVALID_IMAGE']);
    expect((await up(plan.id, 'a.png', PNG_BYTES)).status).toBe(404);
    expect(fs.readdirSync(path.join(pdir(p.slug), '.incoming'))).toEqual([]);
    expect(db().prepare('SELECT COUNT(*) AS n FROM html_assets').get()).toEqual({ n: 0 });
  });

  it('ảnh vượt 20 MB bị từ chối 413 ngay khi nhận (không ghi hết), file tạm được xoá', async () => {
    const p = await mk();
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(21 * 1024 * 1024)]);
    const r = await up(p.id, 'big.png', big);
    expect([r.status, r.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    expect(fs.readdirSync(path.join(pdir(p.slug), '.incoming'))).toEqual([]);
  });

  it('chụp asset vào phiên bản (hard link/copy) và xoá asset gốc không phá bản đã công bố; xoá bị chặn khi version đang tạo dùng nó', async () => {
    const p = await mk();
    const a = (await up(p.id, 'logo.png', PNG_BYTES)).body;
    const v = (await compose(p.id)).body.version;
    expect(v.assets).toEqual([{ asset_id: a.id, path: `assets/u/${a.id}.png`, content_hash: expect.any(String) }]);
    const job = await claim();
    expect(job.payload.assets).toEqual([expect.objectContaining({ id: a.id, path: `assets/u/${a.id}.png`, kind: 'image', width: 1, height: 1, label: 'logo.png' })]);
    const del = await c.del(`${P}/${p.id}/assets/${a.id}`);
    expect([del.status, del.body.error.code]).toEqual([409, 'ASSET_IN_USE']);
    const html = INDEX.replace('</body>', `<img data-hf-var="logo" src="assets/u/${a.id}.png"></body>`);
    expect((await complete(job, result({ files: [{ path: 'index.html', content: html }], variables: [...VARS, { id: 'logo', type: 'asset', label: 'Logo', value: String(a.id) }] }))).status).toBe(200);
    const snap = path.join(pdir(p.slug), 'versions', 'v1', 'assets', 'u', `${a.id}.png`);
    expect(fs.readFileSync(snap)).toEqual(PNG_BYTES);
    expect((db().prepare('SELECT snapshot_path FROM html_version_assets WHERE version_id = ?').get(v.id) as any).snapshot_path).toBe(`output/${p.slug}/html/versions/v1/assets/u/${a.id}.png`);
    // xoá asset gốc: bản đã công bố vẫn dùng được
    expect((await c.del(`${P}/${p.id}/assets/${a.id}`)).status).toBe(200);
    expect(fs.readFileSync(snap)).toEqual(PNG_BYTES);
    expect((await c.get(`${P}/${p.id}/assets`)).body).toEqual([]);
    expect((await c.get(`${P}/${p.id}/assets/${a.id}/file`)).status).toBe(404);
    // sửa biến ảnh trên bản đã chụp (asset gốc đã xoá) vẫn được, dùng bản chụp
    const logo = await c.post(`${P}/${p.id}/versions/1/variables`, { values: { logo: String(a.id), title: 'Tiêu đề mới' }, idempotency_key: key() });
    expect(logo.status, JSON.stringify(logo.body)).toBe(201);
    expect(fs.readFileSync(path.join(pdir(p.slug), 'versions', 'v2', 'assets', 'u', `${a.id}.png`))).toEqual(PNG_BYTES);
    // asset không thuộc dự án bị từ chối
    const other = await mk({ name: 'Khác' });
    const oa = (await up(other.id, 'x.png', PNG_BYTES)).body;
    const bad = await c.post(`${P}/${p.id}/versions/2/variables`, { values: { logo: String(oa.id) }, idempotency_key: key() });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VARIABLE_INVALID']);
    expect((await c.del(`${P}/${p.id}/assets/${oa.id}`)).status).toBe(404); // không xoá chéo dự án
  });

  it('asset của dự án khác không xem được qua dự án này', async () => {
    const a = await mk();
    const b = await mk({ name: 'B' });
    const as = (await up(a.id, 'x.png', PNG_BYTES)).body;
    expect((await c.get(`${P}/${b.id}/assets/${as.id}/file`)).status).toBe(404);
  });
});

describe('xoá dự án', () => {
  it('bị chặn khi version đang composing (PROJECT_BUSY / HTML_ACTIVE) hoặc đang tải asset; hủy rồi xoá được và dọn file', async () => {
    const p = await mk();
    await compose(p.id);
    const busy = await c.del(`${P}/${p.id}`);
    expect([busy.status, busy.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
    expect(busy.body.error.details.reasons[0].code).toBe('HTML_ACTIVE');
    expect((await c.get(`${P}/${p.id}`)).body.delete_block).toMatchObject({ code: 'HTML_ACTIVE' });
    // job đã claim cũng chặn
    const job = await claim();
    expect((await c.del(`${P}/${p.id}`)).body.error.code).toBe('PROJECT_BUSY');
    // đang tải asset
    const release = L.env.ctx.beginProjectUpload(p.id);
    expect((await c.post(`${P}/${p.id}/versions/1/cancel`)).status).toBe(200);
    expect((await c.del(`${P}/${p.id}`)).body.error.details.reasons.map((r: any) => r.code)).toContain('UPLOAD_ACTIVE');
    release();
    void job;
    const ok = await c.del(`${P}/${p.id}`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, purged: true });
    expect((await c.get(`${P}/${p.id}`)).status).toBe(404);
    expect(db().prepare('SELECT COUNT(*) AS n FROM html_versions').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT COUNT(*) AS n FROM html_project_meta').get()).toEqual({ n: 0 });
    expect(fs.existsSync(pdir(p.slug))).toBe(false);
  });

  it('xoá dự án đã có version ready + asset + render: dọn sạch (CASCADE) và file biến mất; render đang chạy chặn xoá', async () => {
    const { p, v } = await ready();
    const a = (await c.uploadVideo(`${P}/${p.id}/assets`, { name: 'a.png', data: PNG_BYTES })).body;
    L.env.ctx.db.prepare("INSERT INTO html_renders (version_id, idempotency_key, quality, status, created_at) VALUES (?, 'r1', '720p', 'rendering', 'x')").run(v.id);
    expect((await c.del(`${P}/${p.id}`)).body.error.details.reasons.map((r: any) => r.code)).toContain('HTML_ACTIVE');
    L.env.ctx.db.prepare("UPDATE html_renders SET status = 'failed'").run();
    expect((await c.del(`${P}/${p.id}`)).status).toBe(200);
    for (const t of ['html_versions', 'html_assets', 'html_renders', 'html_version_assets']) expect(db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    expect(fs.existsSync(pdir(p.slug))).toBe(false);
    void a;
  });
});
