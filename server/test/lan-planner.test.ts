import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JPG_BYTES, PNG_BYTES, WORKER_TOKEN, setupProject, userClient, workerClient, writeFile } from './helpers.js';
import { LAN_CODE, makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { LAN_RATE } from '../src/lan/routes.js';

let L: LanEnv;
let c: LanClient;

beforeEach(async () => {
  L = await makeLanEnv();
  c = L.client();
  await c.login();
});
afterEach(async () => {
  await L.close();
});

const png = (tag: string) => Buffer.concat([PNG_BYTES, Buffer.from(tag)]);
const db = () => L.env.ctx.db;
const jobTypes = () => (db().prepare('SELECT type FROM jobs ORDER BY id').all() as { type: string }[]).map((j) => j.type);

async function newPlan(client: LanClient = c, over: Record<string, unknown> = {}) {
  const r = await client.post('/lan/api/plans', { name: 'Cacao Actiso', created_by_name: 'Lan', brief: 'Quảng cáo 3 cảnh cho sinh tố cacao', style_lock: 'Ánh sáng ấm', ...over });
  expect(r.status, r.raw).toBe(201);
  return r.body.plan as { id: number };
}

/** Worker giả: nhận job analyze_brief rồi ghi cảnh bằng API worker (như worker thật, không gọi AI). */
async function fakeWorkerAnalyze(planId: number, scenes: Record<string, unknown>[], opts: { complete?: boolean } = {}) {
  const w = workerClient(L.env.app);
  const job = await w.get('/api/worker/next?worker=w1');
  expect(job.status, job.raw).toBe(200);
  expect(job.body.type).toBe('analyze_brief');
  expect(job.body.project_id).toBe(planId);
  const r = await w.post('/api/worker/scenes', { project_id: planId, scenes });
  expect(r.status, r.raw).toBe(200);
  if (opts.complete !== false) expect((await w.post(`/api/worker/jobs/${job.body.id}/complete`, { result: {} })).status).toBe(200);
  return { job: job.body, scenes: r };
}

const sceneInput = (n: number, extra: Record<string, unknown> = {}) => ({
  code: `C${n}`,
  order_index: n - 1,
  title: `Cảnh ${n}`,
  prompt: `Style: soft morning light, vertical 9:16\n\nA hand holds the box from image 1, scene ${n}\n\nAction: opens it\nShot 1: 0-10 s, close-up: opens.\nNo dialogue.`,
  first_frame_desc: `Khung đầu cảnh ${n}`,
  upload_refs: [] as number[],
  use_prev_storyboard: n > 1,
  ...extra,
});

describe('tạo kế hoạch', () => {
  it('lưu dự án source=lan với tên người tạo; kiểm tra dữ liệu vào', async () => {
    const plan = await newPlan();
    const row = db().prepare('SELECT source, created_by_name, name, brief, style_lock, status FROM projects WHERE id = ?').get(plan.id);
    expect(row).toEqual({ source: 'lan', created_by_name: 'Lan', name: 'Cacao Actiso', brief: 'Quảng cáo 3 cảnh cho sinh tố cacao', style_lock: 'Ánh sáng ấm', status: 'draft' });
    const bad = [{ name: '' }, { created_by_name: '   ' }, { name: 'x'.repeat(201) }, { created_by_name: 'x'.repeat(61) }, { name: 'a\nb' }, { brief: 'x'.repeat(50_001) }];
    for (const b of bad) expect((await c.post('/lan/api/plans', { name: 'N', created_by_name: 'T', ...b })).status, JSON.stringify(b).slice(0, 40)).toBe(400);
  });

  it('danh sách chỉ có kế hoạch LAN (không có dự án của app chính), mới nhất trước, kèm trạng thái', async () => {
    await setupProject(L.env, { scenes: 2 }); // dự án app
    const a = await newPlan(c, { name: 'Một' });
    const b = await newPlan(c, { name: 'Hai', created_by_name: 'Minh' });
    const list = (await c.get('/lan/api/plans')).body;
    expect(list.map((p: any) => p.name)).toEqual(['Hai', 'Một']);
    expect(list[0]).toMatchObject({ id: b.id, created_by_name: 'Minh', status: 'draft', scene_count: 0, ref_count: 0, analysis: { state: 'idle' } });
    expect(Object.keys(list[0]).sort()).toEqual(['analysis', 'can_delete', 'created_at', 'created_by_name', 'delete_block', 'id', 'name', 'ref_count', 'scene_count', 'status', 'updated_at']);
    expect(list.map((p: any) => p.id)).not.toContain(1);
    expect(a.id).toBeGreaterThan(1);
  });

  it('dự án của app chính không đọc/sửa được qua route LAN (404 như không tồn tại)', async () => {
    const sc = await setupProject(L.env, { scenes: 1 });
    const id = sc.project.id;
    for (const [method, url] of [['get', `/lan/api/plans/${id}`], ['get', `/lan/api/plans/${id}/plan.md`], ['get', `/lan/api/plans/${id}/refs.zip`]] as const) {
      expect((await c[method](url)).status, url).toBe(404);
    }
    expect((await c.post(`/lan/api/plans/${id}/analyze`, { brief: 'x' })).status).toBe(404);
    expect((await c.upload(`/lan/api/plans/${id}/refs`, [{ name: 'a.png', data: PNG_BYTES }])).status).toBe(404);
    expect((await c.upload(`/lan/api/plans/${id}/scenes/${sc.scenes[0].id}/storyboard`, [{ name: 'a.png', data: PNG_BYTES }])).status).toBe(404);
    expect((await c.get('/lan/api/plans/9999')).status).toBe(404);
    expect(jobTypes()).toEqual([]);
  });

  it('giới hạn tạo kế hoạch: 20 mỗi giờ theo IP', async () => {
    for (let i = 0; i < LAN_RATE.createPlan.max; i++) await newPlan(c, { name: `K${i}` });
    const r = await c.post('/lan/api/plans', { name: 'Thừa', created_by_name: 'T', brief: 'b' });
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await L.client({ ip: '192.168.1.99', cookie: c.cookie }).post('/lan/api/plans', { name: 'IP khác', created_by_name: 'T', brief: 'b' })).status).toBe(201);
  });
});

describe('ảnh tham chiếu', () => {
  it('tải lên png/jpg/webp (magic bytes), giữ thứ tự và nhãn; URL là /lan/files', async () => {
    const plan = await newPlan();
    const r = await c.upload(`/lan/api/plans/${plan.id}/refs`, [
      { name: 'hop.png', data: png('1'), label: 'Hộp 3/4' },
      { name: 'stick.jpg', data: JPG_BYTES, label: 'Stick' },
    ]);
    expect(r.status, r.raw).toBe(201);
    expect(r.body.map((x: any) => [x.label, x.order_index, x.file_name])).toEqual([['Hộp 3/4', 0, 'hop.png'], ['Stick', 1, 'stick.jpg']]);
    expect(r.body[0].url).toBe(`/lan/files/refs/${plan.id}/hop.png`);
    expect(Object.keys(r.body[0]).sort()).toEqual(['file_name', 'id', 'label', 'order_index', 'url']); // không lộ đường dẫn thô/hash
    expect(fs.existsSync(path.join(L.env.root, 'refs', String(plan.id), 'hop.png'))).toBe(true);
    const detail = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(detail.refs.map((x: any) => x.label)).toEqual(['Hộp 3/4', 'Stick']);
  });

  it('từ chối file không phải ảnh (kể cả đuôi .png giả), tên file có .., file quá 10 MB', async () => {
    const plan = await newPlan();
    const url = `/lan/api/plans/${plan.id}/refs`;
    const fake = await c.upload(url, [{ name: 'dep.png', data: Buffer.from('#!/bin/sh\necho hi') }]);
    expect(fake.status).toBe(415);
    expect(fake.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await c.upload(url, [{ name: '../evil.png', data: PNG_BYTES }])).status).toBe(400);
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024)]);
    const tooBig = await c.upload(url, [{ name: 'to.png', data: big }]);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    expect((await c.post(url, { x: 1 })).status).toBe(400); // không phải multipart
    expect(db().prepare('SELECT COUNT(*) AS n FROM project_refs').get()).toEqual({ n: 0 });
  });

  it('tối đa 12 ảnh mỗi kế hoạch', async () => {
    const plan = await newPlan();
    const url = `/lan/api/plans/${plan.id}/refs`;
    expect((await c.upload(url, Array.from({ length: 12 }, (_, i) => ({ name: `a${i}.png`, data: png(String(i)) })))).status).toBe(201);
    const over = await c.upload(url, [{ name: 'thua.png', data: png('x') }]);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('TOO_MANY_REFS');
    expect(db().prepare('SELECT COUNT(*) AS n FROM project_refs WHERE project_id = ?').get(plan.id)).toEqual({ n: 12 });
    // 13 file trong một request vượt giới hạn multipart
    const plan2 = await newPlan();
    const many = await c.upload(`/lan/api/plans/${plan2.id}/refs`, Array.from({ length: 13 }, (_, i) => ({ name: `b${i}.png`, data: png('b' + i) })));
    expect(many.status).toBe(413);
  });

  it('giới hạn tải lên: 60 ảnh mỗi giờ theo IP', async () => {
    const plans = [await newPlan(), await newPlan(), await newPlan(), await newPlan(), await newPlan(), await newPlan()];
    let n = 0;
    for (const p of plans) {
      for (let k = 0; k < 2; k++) {
        const r = await c.upload(`/lan/api/plans/${p.id}/refs`, Array.from({ length: 5 }, () => ({ name: `i${n}.png`, data: png(String(n++)) })));
        expect(r.status, r.raw).toBe(201);
      }
    }
    expect(n).toBe(60);
    const plan = await newPlan();
    const r = await c.upload(`/lan/api/plans/${plan.id}/refs`, [{ name: 'them.png', data: png('them') }]);
    expect(r.status).toBe(429);
    L.env.clock.advance(61 * 60_000);
    expect((await c.upload(`/lan/api/plans/${plan.id}/refs`, [{ name: 'them.png', data: png('them') }])).status).toBe(201);
  });

  it('thư viện chỉ có ảnh của kế hoạch LAN; không lộ ảnh của dự án app và không chép được ảnh đó', async () => {
    // ảnh của dự án app chính
    const sc = await setupProject(L.env, { scenes: 1 });
    const app = userClient(L.env.app);
    const { multipart } = await import('./helpers.js');
    const m = multipart([{ name: 'file', filename: 'bi-mat.png', data: png('ban-quyen-cua-chu-may'), type: 'image/png' }]);
    const appRef = await L.env.app.inject({ method: 'POST', url: `/api/projects/${sc.project.id}/refs`, payload: m.payload, headers: { ...m.headers, host: 'localhost:8787' } });
    expect(appRef.statusCode).toBe(201);
    const appRefId = JSON.parse(appRef.body)[0].id;
    expect((await app.get('/api/ref-library')).body).toHaveLength(1);

    const a = await newPlan(c, { name: 'A' });
    await c.upload(`/lan/api/plans/${a.id}/refs`, [{ name: 'hop.png', data: png('hop'), label: 'Hộp' }]);
    const lib = (await c.get('/lan/api/ref-library')).body;
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ label: 'Hộp', original_name: 'hop.png', in_project: false, projects: [{ id: a.id, name: 'A' }] });
    expect(lib[0].url).toBe(`/lan/files/refs/${a.id}/hop.png`);
    expect(Object.keys(lib[0]).sort()).toEqual(['content_hash', 'created_at', 'in_project', 'label', 'original_name', 'projects', 'ref_id', 'url']);
    expect(JSON.stringify(lib)).not.toContain('bi-mat');

    const b = await newPlan(c, { name: 'B' });
    // chép ảnh dự án app → 404, không có gì được tạo
    const steal = await c.post(`/lan/api/plans/${b.id}/refs/from-library`, { ref_ids: [appRefId] });
    expect(steal.status).toBe(404);
    expect(db().prepare('SELECT COUNT(*) AS n FROM project_refs WHERE project_id = ?').get(b.id)).toEqual({ n: 0 });
    expect((await c.post(`/lan/api/plans/${b.id}/refs/from-library`, { ref_ids: [999999] })).status).toBe(404);
    // thư viện theo kế hoạch: in_project; chép ảnh từ kế hoạch LAN khác thành công, có nhãn mới
    const libB = (await c.get(`/lan/api/ref-library?planId=${a.id}`)).body;
    expect(libB[0].in_project).toBe(true);
    const ok = await c.post(`/lan/api/plans/${b.id}/refs/from-library`, { ref_ids: [lib[0].ref_id], labels: { [lib[0].ref_id]: 'Hộp (B)' } });
    expect(ok.status, ok.raw).toBe(201);
    expect(ok.body.map((x: any) => x.label)).toEqual(['Hộp (B)']);
    expect(ok.body[0].url).toContain(`/lan/files/refs/${b.id}/`);
    expect((await c.get('/lan/api/ref-library?planId=' + sc.project.id)).status).toBe(404); // planId của dự án app
  });

  it('thêm ảnh từ thư viện cũng bị chặn ở 12 ảnh', async () => {
    const a = await newPlan(c, { name: 'A' });
    await c.upload(`/lan/api/plans/${a.id}/refs`, Array.from({ length: 12 }, (_, i) => ({ name: `a${i}.png`, data: png('A' + i) })));
    const b = await newPlan(c, { name: 'B' });
    await c.upload(`/lan/api/plans/${b.id}/refs`, [{ name: 'b.png', data: png('B') }]);
    const lib = (await c.get(`/lan/api/ref-library?planId=${b.id}`)).body as any[];
    const fromA = lib.filter((x) => x.projects.some((p: any) => p.id === a.id)).map((x) => x.ref_id);
    expect(fromA).toHaveLength(12);
    const r = await c.post(`/lan/api/plans/${b.id}/refs/from-library`, { ref_ids: fromA });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TOO_MANY_REFS');
    expect(db().prepare('SELECT COUNT(*) AS n FROM project_refs WHERE project_id = ?').get(b.id)).toEqual({ n: 1 });
  });
});

describe('phân tích', () => {
  it('chỉ tạo đúng MỘT job analyze_brief; trạng thái "xếp hàng" khi chưa có worker; không tạo storyboard/video', async () => {
    const plan = await newPlan();
    const r = await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    expect(r.status, r.raw).toBe(201);
    expect(r.body.plan.status).toBe('analyzing');
    expect(r.body.rate.analyze_remaining).toBe(5);
    expect(jobTypes()).toEqual(['analyze_brief']);
    const d = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d.plan.status).toBe('analyzing');
    expect(d.plan.analysis).toMatchObject({ state: 'queued', waiting: 'Máy chủ AI chưa sẵn sàng, yêu cầu đang xếp hàng.' });
    expect(d.worker).toEqual({ online: false, queue_paused: false });
    expect(Object.keys(d.plan.analysis).sort()).toEqual(['created_at', 'error', 'finished_at', 'job_id', 'queue', 'state', 'waiting']);
    // worker xuất hiện → đổi thông báo; claim → running
    await workerClient(L.env.app).get('/api/worker/ping');
    const d2 = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d2.worker.online).toBe(true);
    expect(d2.plan.analysis.waiting).toBe('Yêu cầu đang xếp hàng, chờ máy chủ AI nhận việc.');
    await workerClient(L.env.app).get('/api/worker/next?worker=w1');
    expect((await c.get(`/lan/api/plans/${plan.id}`)).body.plan.analysis).toMatchObject({ state: 'running', waiting: null });
    expect(jobTypes()).toEqual(['analyze_brief']);
  });

  it('hàng đợi tạm dừng / hết hạn mức AI được nói rõ', async () => {
    const plan = await newPlan();
    await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    await userClient(L.env.app).post('/api/queue/pause', { reason: 'bí mật nội bộ' });
    const d = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d.plan.analysis.waiting).toContain('tạm dừng');
    expect(d.worker.queue_paused).toBe(true);
    expect(JSON.stringify(d)).not.toContain('bí mật nội bộ'); // không lộ lý do tạm dừng của chủ máy
    await userClient(L.env.app).post('/api/queue/resume');
    db().prepare("UPDATE jobs SET wait_reason = 'ai_quota' WHERE type = 'analyze_brief'").run();
    expect((await c.get(`/lan/api/plans/${plan.id}`)).body.plan.analysis.waiting).toContain('hết hạn mức');
  });

  it('cần có yêu cầu kịch bản; đang phân tích thì không gửi lại hay thêm ảnh; analyze cập nhật brief + khóa nhất quán', async () => {
    const plan = await newPlan(c, { brief: '' });
    const none = await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    expect(none.status).toBe(400);
    expect(jobTypes()).toEqual([]);
    expect((await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: '  Brief mới  ', style_lock: ' Khóa mới ' })).status).toBe(201);
    expect(db().prepare('SELECT brief, style_lock FROM projects WHERE id = ?').get(plan.id)).toEqual({ brief: 'Brief mới', style_lock: 'Khóa mới' });
    const again = await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: 'khác' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('JOB_ACTIVE');
    expect(db().prepare('SELECT brief FROM projects WHERE id = ?').get(plan.id)).toEqual({ brief: 'Brief mới' });
    expect((await c.upload(`/lan/api/plans/${plan.id}/refs`, [{ name: 'a.png', data: PNG_BYTES }])).status).toBe(409);
    expect(jobTypes()).toEqual(['analyze_brief']);
  });

  it('giới hạn 6 lượt phân tích mỗi giờ theo IP (phân tích lại cũng tính); IP khác có hạn mức riêng; hết giờ thì dùng lại được', async () => {
    const plan = await newPlan();
    for (let i = 0; i < LAN_RATE.analyze.max; i++) {
      const r = await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: `Brief ${i}` });
      expect(r.status, `lượt ${i}: ${r.raw}`).toBe(201);
      db().prepare("UPDATE jobs SET status = 'failed', error = 'x', finished_at = ? WHERE project_id = ? AND status = 'queued'").run(L.env.ctx.now(), plan.id);
    }
    const blocked = await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: 'lượt 7' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(3000);
    expect(db().prepare("SELECT brief FROM projects WHERE id = ?").get(plan.id)).toEqual({ brief: 'Brief 5' }); // lượt bị chặn không ghi gì
    const other = L.client({ ip: '192.168.1.200', cookie: c.cookie });
    expect((await other.post(`/lan/api/plans/${plan.id}/analyze`, { brief: 'IP khác' })).status).toBe(201);
    db().prepare("UPDATE jobs SET status = 'failed', error = 'x', finished_at = ? WHERE status = 'queued'").run(L.env.ctx.now());
    L.env.clock.advance(61 * 60_000);
    expect((await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: 'sau 1 giờ' })).status).toBe(201);
    // lỗi nghiệp vụ (đang phân tích) không bị tính vào hạn mức
    expect((await c.post(`/lan/api/plans/${plan.id}/analyze`, {})).status).toBe(409);
  });

  it('kết quả worker: cảnh C1.. xuất hiện, trạng thái ready; job lỗi → failed với thông báo chung (không lộ chi tiết)', async () => {
    const plan = await newPlan();
    await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    const w = workerClient(L.env.app);
    const job = (await w.get('/api/worker/next?worker=w1')).body;
    await w.post(`/api/worker/jobs/${job.id}/fail`, { error: 'AI_UNAVAILABLE: tài khoản codex-a hết quota, key sk-123456', code: 'OTHER' });
    const failed = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(failed.plan.status).toBe('failed');
    expect(failed.plan.analysis.state).toBe('failed');
    expect(failed.plan.analysis.error).toContain('Phân tích lại');
    expect(JSON.stringify(failed)).not.toContain('codex-a');
    expect(JSON.stringify(failed)).not.toContain('sk-123456');
    expect((await c.get('/lan/api/plans')).body[0].status).toBe('failed');

    expect((await c.post(`/lan/api/plans/${plan.id}/analyze`, {})).status).toBe(201);
    await fakeWorkerAnalyze(plan.id, [sceneInput(1), sceneInput(2)]);
    const ready = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(ready.plan.status).toBe('ready');
    expect(ready.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2']);
    expect(ready.plan.scene_count).toBe(2);
    expect(jobTypes()).toEqual(['analyze_brief', 'analyze_brief']);
  });

  it('job bị chủ máy hủy → failed; phân tích lại được', async () => {
    const plan = await newPlan();
    await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    const jobId = (db().prepare('SELECT id FROM jobs').get() as { id: number }).id;
    await userClient(L.env.app).post(`/api/jobs/${jobId}/cancel`);
    expect((await c.get(`/lan/api/plans/${plan.id}`)).body.plan.analysis.error).toContain('hủy');
    expect((await c.post(`/lan/api/plans/${plan.id}/analyze`, {})).status).toBe(201);
  });
});

describe('kế hoạch từng cảnh', () => {
  async function planWithScenes(opts: { requirePromptApproval?: boolean } = {}) {
    if (opts.requirePromptApproval === false) L.env.ctx.config.requirePromptApproval = false;
    const plan = await newPlan();
    const up = await c.upload(`/lan/api/plans/${plan.id}/refs`, [
      { name: 'hop.png', data: png('hop'), label: 'Hộp 3/4' },
      { name: 'stick.png', data: png('stick'), label: 'Stick' },
    ]);
    const [hop, stick] = up.body;
    await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    await fakeWorkerAnalyze(plan.id, [sceneInput(1, { upload_refs: [stick.id, hop.id] }), sceneInput(2, { upload_refs: [hop.id] }), sceneInput(3, { upload_refs: [], use_prev_storyboard: false })]);
    return { plan, hop, stick };
  }

  it('mỗi cảnh có tin nhắn ChatGPT, ảnh đính kèm theo thứ tự (Bước 1) và prompt Flow nguyên văn + cài đặt (Bước 2)', async () => {
    const { plan, hop, stick } = await planWithScenes();
    const d = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d.scenes).toHaveLength(3);
    const [c1, c2, c3] = d.scenes;
    expect(c1.step1.attachments.map((a: any) => [a.order, a.label, a.prompt_label])).toEqual([[1, 'Stick', 'ảnh 1'], [2, 'Hộp 3/4', 'ảnh 2']]);
    expect(c1.step1.attachments[0].url).toBe(stick.url);
    expect(c1.step1.message).toContain('Đây là khung hình MỞ ĐẦU (giây 0) của clip C1.');
    expect(c1.step1.message).toContain('ảnh 1 = Stick, ảnh 2 = Hộp 3/4');
    expect(c1.step1.message).toContain('Nội dung khung hình: Khung đầu cảnh 1 — chi tiết theo mô tả sau: Style: soft morning light, vertical 9:16 A hand holds the box from image 1, scene 1');
    expect(c1.step1.message).not.toContain('Giữ cùng');
    const prompt1 = (db().prepare("SELECT prompt FROM scenes WHERE code = 'C1'").get() as { prompt: string }).prompt;
    expect(c1.step2.prompt).toBe(prompt1);
    expect(c1.step2.attachments.map((a: any) => [a.order, a.kind, a.prompt_label])).toEqual([[1, 'ref', 'image 1'], [2, 'ref', 'image 2'], [3, 'storyboard_self', null]]);
    expect(c1.step2.settings).toEqual({ aspect: '9:16', duration_s: 10, count: 1, resolution: '720p', estimated_credits: 15 });
    expect(c1.step2.notes.join(' ')).toContain('Bắt đầu tạo');
    // C2 dùng storyboard cảnh đầu
    expect(c2.use_prev_storyboard).toBe(true);
    expect(c2.step1.attachments.map((a: any) => [a.kind, a.label])).toEqual([['ref', 'Hộp 3/4'], ['storyboard_prev', 'Storyboard của C1']]);
    expect(c2.step1.message).toContain('Giữ cùng mặt bếp');
    expect(c2.step1.attachments[1]).toMatchObject({ available: false, url: null });
    expect(c3.step1.attachments).toEqual([]);
    expect(c3.step1.message).toContain('Không có ảnh tham chiếu đính kèm.');
    // thông tin gói
    expect(d.plan).toMatchObject({ name: 'Cacao Actiso', created_by_name: 'Lan', style_lock: 'Ánh sáng ấm', credit_per_video: 15 });
    expect(d.markdown).toContain('## C1 — Cảnh 1');
    expect(d.limits).toMatchObject({ max_refs: 12, max_upload_bytes: 10 * 1024 * 1024 });
    void hop;
  });

  it('KHÔNG tạo job storyboard/video khi phân tích xong, kể cả REQUIRE_PROMPT_APPROVAL=false; dự án app thì vẫn như cũ', async () => {
    const { plan } = await planWithScenes({ requirePromptApproval: false });
    expect(jobTypes()).toEqual(['analyze_brief']);
    expect((db().prepare('SELECT status FROM scenes WHERE project_id = ? ORDER BY id').all(plan.id) as any[]).map((s) => s.status)).toEqual(['awaiting_approval', 'awaiting_approval', 'awaiting_approval']);
    // đối chứng: dự án app với cùng cấu hình tự tạo storyboard
    const sc = await setupProject(L.env, { scenes: 1 });
    expect(sc.scenes[0].status).toBe('storyboard_queued');
    expect(jobTypes()).toContain('storyboard');
    expect(jobTypes().filter((t) => t === 'storyboard')).toHaveLength(1);
  });

  it('tải storyboard lên: lưu asset storyboard bình thường, KHÔNG đổi trạng thái cảnh, không tạo job; cảnh sau và bước 2 dùng nó', async () => {
    const { plan } = await planWithScenes();
    const before = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    const c1 = before.scenes[0];
    const r = await c.upload(`/lan/api/plans/${plan.id}/scenes/${c1.id}/storyboard`, [{ name: 'Ảnh của tôi.png', data: png('storyboard-c1') }]);
    expect(r.status, r.raw).toBe(201);
    expect(r.body.storyboard.url).toBe('/lan/files/output/cacao-actiso/storyboard/C1_storyboard_lan_v1.png');
    expect(r.body.storyboard.attempt).toBe(1);

    const asset = db().prepare("SELECT * FROM assets WHERE scene_id = ?").get(c1.id) as any;
    expect(asset).toMatchObject({ kind: 'storyboard', job_id: null, attempt: 1, file_path: 'output/cacao-actiso/storyboard/C1_storyboard_lan_v1.png' });
    expect(JSON.parse(asset.meta)).toMatchObject({ source: 'lan_upload', original_name: 'Ảnh của tôi.png', bytes: png('storyboard-c1').length, prompt_version: 1 });
    expect(fs.readFileSync(path.join(L.env.root, asset.file_path)).equals(png('storyboard-c1'))).toBe(true);
    expect(db().prepare('SELECT status FROM scenes WHERE id = ?').get(c1.id)).toEqual({ status: 'awaiting_approval' }); // không đổi
    expect(jobTypes()).toEqual(['analyze_brief']);
    expect(db().prepare("SELECT message FROM events WHERE type = 'scene.storyboard_uploaded'").all()).toHaveLength(1);

    const d = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d.scenes[0].storyboard).toMatchObject({ url: r.body.storyboard.url, file_name: 'C1_storyboard_lan_v1.png', stale: false });
    expect(d.scenes[0].step2.attachments.at(-1)).toMatchObject({ kind: 'storyboard_self', available: true, url: r.body.storyboard.url });
    expect(d.scenes[1].step1.attachments.at(-1)).toMatchObject({ kind: 'storyboard_prev', available: true, url: r.body.storyboard.url, note: null });
    expect(d.scenes[2].step1.attachments).toEqual([]);
    // file phục vụ được qua listener LAN với đúng nội dung
    const f = await c.get(r.body.storyboard.url);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toContain('image/png');
    // chủ máy thấy asset trên app chính như storyboard bình thường
    const app = (await userClient(L.env.app).get(`/api/scenes/${c1.id}`)).body;
    expect(app.assets.map((a: any) => [a.kind, a.attempt])).toEqual([['storyboard', 1]]);
    expect(app.storyboard_count).toBe(1);
  });

  it('tải lại → lượt mới, dùng bản mới nhất; không ghi đè file cũ; giới hạn số lần mỗi cảnh', async () => {
    const { plan } = await planWithScenes();
    const sceneId = (db().prepare("SELECT id FROM scenes WHERE code = 'C1'").get() as { id: number }).id;
    const url = `/lan/api/plans/${plan.id}/scenes/${sceneId}/storyboard`;
    expect((await c.upload(url, [{ name: 'a.png', data: png('v1') }])).status).toBe(201);
    const r2 = await c.upload(url, [{ name: 'b.png', data: JPG_BYTES }]);
    expect(r2.body.storyboard).toMatchObject({ url: '/lan/files/output/cacao-actiso/storyboard/C1_storyboard_lan_v2.jpg', attempt: 2 });
    const d = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d.scenes[0].storyboard.file_name).toBe('C1_storyboard_lan_v2.jpg');
    expect(d.scenes[0].storyboard_uploads).toBe(2);
    expect(fs.existsSync(path.join(L.env.root, 'output/cacao-actiso/storyboard/C1_storyboard_lan_v1.png'))).toBe(true);
    for (let i = 3; i <= 8; i++) expect((await c.upload(url, [{ name: `n${i}.png`, data: png('n' + i) }])).status).toBe(201);
    const over = await c.upload(url, [{ name: 'thua.png', data: png('thua') }]);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('TOO_MANY_UPLOADS');
    expect(fs.readdirSync(path.join(L.env.root, 'output/cacao-actiso/storyboard'))).toHaveLength(8);
  });

  it('kiểm tra file tải lên: không phải ảnh, nhiều file, quá lớn, cảnh của kế hoạch khác', async () => {
    const { plan } = await planWithScenes();
    const other = await newPlan(c, { name: 'Khác' });
    const sceneId = (db().prepare("SELECT id FROM scenes WHERE code = 'C1'").get() as { id: number }).id;
    const url = `/lan/api/plans/${plan.id}/scenes/${sceneId}/storyboard`;
    expect((await c.upload(url, [{ name: 'x.png', data: Buffer.from('không phải ảnh') }])).status).toBe(415);
    expect((await c.upload(url, [{ name: 'a.png', data: PNG_BYTES }, { name: 'b.png', data: PNG_BYTES }])).status).toBe(400);
    expect((await c.upload(url, [{ name: 'to.png', data: Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024)]) }])).status).toBe(413);
    expect((await c.upload(`/lan/api/plans/${other.id}/scenes/${sceneId}/storyboard`, [{ name: 'a.png', data: PNG_BYTES }])).status).toBe(404);
    expect((await c.upload(`/lan/api/plans/${plan.id}/scenes/99999/storyboard`, [{ name: 'a.png', data: PNG_BYTES }])).status).toBe(404);
    expect((await c.upload(`/lan/api/plans/${plan.id}/scenes/abc/storyboard`, [{ name: 'a.png', data: PNG_BYTES }])).status).toBe(400);
    expect(db().prepare('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
    const sbDir = path.join(L.env.root, 'output/cacao-actiso/storyboard');
    expect(!fs.existsSync(sbDir) || fs.readdirSync(sbDir).length === 0).toBe(true);
  });

  it('cảnh đang được chủ máy sản xuất (có job) thì không chen vào: 409 SCENE_BUSY, không ghi gì', async () => {
    const { plan } = await planWithScenes();
    const sceneId = (db().prepare("SELECT id FROM scenes WHERE code = 'C1'").get() as { id: number }).id;
    // chủ máy duyệt storyboard trên app chính (dự án LAN vẫn sản xuất được như dự án thường)
    expect((await userClient(L.env.app).post(`/api/scenes/${sceneId}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const r = await c.upload(`/lan/api/plans/${plan.id}/scenes/${sceneId}/storyboard`, [{ name: 'a.png', data: PNG_BYTES }]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SCENE_BUSY');
    expect((await c.get(`/lan/api/plans/${plan.id}`)).body.scenes[0].upload_block).toContain('Chủ máy đang sản xuất');
    expect(db().prepare('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  });

  it('phân tích lại: mã cảnh chuẩn hóa, cảnh cũ không còn thì bỏ, storyboard cũ của cảnh còn lại bị đánh dấu stale khi prompt đổi', async () => {
    const { plan } = await planWithScenes();
    const c1 = (db().prepare("SELECT id FROM scenes WHERE code = 'C1'").get() as { id: number }).id;
    await c.upload(`/lan/api/plans/${plan.id}/scenes/${c1}/storyboard`, [{ name: 'a.png', data: png('c1') }]);
    expect((await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: 'Brief đã sửa, chỉ 2 cảnh' })).status).toBe(201);
    // worker (như managed worker cũ) trả scene_01/scene_02: server chuẩn hóa về C1/C2
    const out = await fakeWorkerAnalyze(plan.id, [
      { ...sceneInput(1, { code: 'scene_01' }), prompt: 'Style: new look\n\nA hand holds image 1\n\nAction: x' },
      sceneInput(2, { code: 'scene_02' }),
    ]);
    expect(out.scenes.body.renamed).toEqual([{ from: 'scene_01', to: 'C1' }, { from: 'scene_02', to: 'C2' }]);
    expect(out.scenes.body.pruned).toEqual(['C3']);
    const d = (await c.get(`/lan/api/plans/${plan.id}`)).body;
    expect(d.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2']);
    expect(d.plan.scene_count).toBe(2);
    expect(d.scenes[0].storyboard.stale).toBe(true); // prompt C1 đổi sau khi tải storyboard
    expect(d.scenes[0].step2.attachments.at(-1).note).toContain('Prompt cảnh đã đổi');
    expect(d.scenes[1].storyboard).toBeNull();
    expect(d.plan.brief).toBe('Brief đã sửa, chỉ 2 cảnh');
  });

  it('phân tích lại KHÔNG bỏ cảnh mà chủ máy đã duyệt/đang sản xuất', async () => {
    const { plan } = await planWithScenes();
    const c3 = (db().prepare("SELECT id FROM scenes WHERE code = 'C3'").get() as { id: number }).id;
    await userClient(L.env.app).post(`/api/scenes/${c3}/approve`, { stage: 'storyboard' });
    await c.post(`/lan/api/plans/${plan.id}/analyze`, { brief: 'sửa' });
    // job analyze mới xếp sau job storyboard của chủ máy: worker giả nhận đúng job analyze
    const w = workerClient(L.env.app);
    const job = (await w.get('/api/worker/next?worker=w1&types=analyze_brief')).body;
    const r = await w.post('/api/worker/scenes', { project_id: plan.id, scenes: [sceneInput(1)] });
    expect(r.body.pruned).toEqual(['C2']); // C2 chỉ là kế hoạch; C3 đã có job storyboard nên giữ
    await w.post(`/api/worker/jobs/${job.id}/complete`, { result: {} });
    expect((db().prepare('SELECT code FROM scenes WHERE project_id = ? ORDER BY order_index').all(plan.id) as any[]).map((s) => s.code)).toEqual(['C1', 'C3']);
  });
});

describe('tải kế hoạch và gói ảnh', () => {
  it('plan.md là tệp tải về có đủ cảnh, ảnh và prompt nguyên văn', async () => {
    const plan = await newPlan();
    const up = await c.upload(`/lan/api/plans/${plan.id}/refs`, [{ name: 'hop.png', data: png('hop'), label: 'Hộp 3/4' }]);
    await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    await fakeWorkerAnalyze(plan.id, [sceneInput(1, { upload_refs: [up.body[0].id] }), sceneInput(2, { upload_refs: [up.body[0].id] })]);
    const r = await c.get(`/lan/api/plans/${plan.id}/plan.md`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="ke-hoach-cacao-actiso.md"');
    expect(r.raw).toContain('# Kế hoạch prompt: Cacao Actiso');
    expect(r.raw).toContain('## C1 — Cảnh 1');
    expect(r.raw).toContain('## C2 — Cảnh 2');
    expect(r.raw).toContain('1. [image 1] Hộp 3/4 — hop.png');
    expect(r.raw).toContain('Style: soft morning light, vertical 9:16');
    expect(r.raw).toBe((await c.get(`/lan/api/plans/${plan.id}`)).body.markdown);
  });

  it('refs.zip: gói ZIP hợp lệ theo thứ tự ảnh; không có ảnh → 404', async () => {
    const plan = await newPlan();
    expect((await c.get(`/lan/api/plans/${plan.id}/refs.zip`)).status).toBe(404);
    await c.upload(`/lan/api/plans/${plan.id}/refs`, [
      { name: 'a.png', data: png('mot'), label: 'Hộp 3/4 (đỏ)' },
      { name: 'b.jpg', data: JPG_BYTES, label: 'Stick' },
    ]);
    const res = await L.lan.inject({ method: 'GET', url: `/lan/api/plans/${plan.id}/refs.zip`, headers: { host: '192.168.1.50:8790', cookie: c.cookie! } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="anh-tham-chieu-cacao-actiso.zip"');
    const zip = res.rawPayload;
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    let off = zip.readUInt32LE(eocd + 16);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const n = zip.readUInt16LE(off + 28);
      names.push(zip.subarray(off + 46, off + 46 + n).toString());
      off += 46 + n;
    }
    expect(names).toEqual(['01-Hop-3-4-do.png', '02-Stick.jpg']);
    expect(zip.includes(png('mot'))).toBe(true);
    expect(zip.includes(JPG_BYTES)).toBe(true);
  });
});

describe('phục vụ file: chỉ ảnh của kế hoạch LAN và storyboard người dùng LAN tải lên', () => {
  it('ảnh tham chiếu của kế hoạch LAN phục vụ được (có phiên); không có phiên thì 401', async () => {
    const plan = await newPlan();
    const up = await c.upload(`/lan/api/plans/${plan.id}/refs`, [{ name: 'hop.png', data: png('hop') }]);
    const r = await c.get(up.body[0].url);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('private, no-cache');
    expect((await L.client().get(up.body[0].url)).status).toBe(401);
  });

  it('file của dự án app, video/output khác, storyboard do worker tạo, file mồ côi, traversal và symlink đều 404', async () => {
    const sc = await setupProject(L.env, { scenes: 1 });
    const plan = await newPlan();
    const up = await c.upload(`/lan/api/plans/${plan.id}/refs`, [{ name: 'hop.png', data: png('hop') }]);
    void up;
    // dự án app: ảnh tham chiếu, storyboard, video
    writeFile(L.env.root, `refs/${sc.project.id}/bi-mat.png`, PNG_BYTES);
    db().prepare("INSERT INTO project_refs (project_id, label, file_path, order_index, created_at) VALUES (?, 'Bí mật', ?, 0, ?)").run(sc.project.id, `refs/${sc.project.id}/bi-mat.png`, L.env.ctx.now());
    writeFile(L.env.root, 'output/cacao-actiso-plus/storyboard/C1_storyboard.png', PNG_BYTES);
    writeFile(L.env.root, 'output/cacao-actiso-plus/video/C1_v1.mp4', 'video');
    db().prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, created_at) VALUES (?, 'storyboard', 'output/cacao-actiso-plus/storyboard/C1_storyboard.png', 1, ?)").run(sc.scenes[0].id, L.env.ctx.now());
    // storyboard do WORKER tạo cho dự án LAN (không phải người dùng LAN tải lên)
    await c.post(`/lan/api/plans/${plan.id}/analyze`, {});
    await fakeWorkerAnalyze(plan.id, [sceneInput(1)]);
    const lanScene = (db().prepare('SELECT id FROM scenes WHERE project_id = ?').get(plan.id) as { id: number }).id;
    writeFile(L.env.root, 'output/cacao-actiso/storyboard/C1_storyboard.png', PNG_BYTES);
    db().prepare("INSERT INTO assets (scene_id, kind, file_path, attempt, meta, created_at) VALUES (?, 'storyboard', 'output/cacao-actiso/storyboard/C1_storyboard.png', 1, '{\"source\":\"worker\"}', ?)").run(lanScene, L.env.ctx.now());
    // file mồ côi trong thư mục refs của dự án LAN (không có bản ghi)
    writeFile(L.env.root, `refs/${plan.id}/mo-coi.png`, PNG_BYTES);
    // symlink trong refs trỏ ra ngoài
    const outside = path.join(L.env.root, 'ngoai.txt');
    fs.writeFileSync(outside, 'ngoài');
    fs.symlinkSync(outside, path.join(L.env.root, 'refs', String(plan.id), 'link.png'));
    db().prepare("INSERT INTO project_refs (project_id, label, file_path, order_index, created_at) VALUES (?, 'link', ?, 5, ?)").run(plan.id, `refs/${plan.id}/link.png`, L.env.ctx.now());

    const notFound = [
      `/lan/files/refs/${sc.project.id}/bi-mat.png`,
      '/lan/files/output/cacao-actiso-plus/storyboard/C1_storyboard.png',
      '/lan/files/output/cacao-actiso-plus/video/C1_v1.mp4',
      '/lan/files/output/cacao-actiso/storyboard/C1_storyboard.png',
      `/lan/files/refs/${plan.id}/mo-coi.png`,
      `/lan/files/refs/${plan.id}/link.png`,
      `/lan/files/refs/${plan.id}/../${sc.project.id}/bi-mat.png`,
      `/lan/files/refs/${plan.id}/%2e%2e/${sc.project.id}/bi-mat.png`,
      `/lan/files/refs/${plan.id}%2f..%2f${sc.project.id}%2fbi-mat.png`,
      `/lan/files/refs/${plan.id}\\..\\${sc.project.id}\\bi-mat.png`,
      '/lan/files/data/test.db',
      '/lan/files/.env',
      '/lan/files/refs',
      '/lan/files/',
      '/lan/files//etc/passwd',
      `/lan/files/refs/${plan.id}/hop.png/../../${sc.project.id}/bi-mat.png`,
    ];
    for (const url of notFound) {
      const r = await c.get(url);
      expect(r.status, url).toBe(404);
      expect(r.raw, url).not.toContain('ngoài');
    }
    expect((await c.get(`/lan/files/refs/${plan.id}/hop.png`)).status).toBe(200); // đối chứng: file hợp lệ vẫn phục vụ được
  });
});

describe('dự án LAN hiển thị trên app chính', () => {
  it('projectSummary có source và created_by_name; dự án thường là app/null', async () => {
    const plan = await newPlan(c, { created_by_name: 'Thảo' });
    const sc = await setupProject(L.env, { scenes: 1 });
    const list = (await userClient(L.env.app).get('/api/projects')).body;
    const lan = list.find((p: any) => p.id === plan.id);
    expect(lan).toMatchObject({ source: 'lan', created_by_name: 'Thảo' });
    expect(list.find((p: any) => p.id === sc.project.id)).toMatchObject({ source: 'app', created_by_name: null });
    // chủ máy xem được kế hoạch LAN như dự án thường
    expect((await userClient(L.env.app).get(`/api/projects/${plan.id}`)).body).toMatchObject({ source: 'lan', created_by_name: 'Thảo' });
  });

  it('GET /api/lan (app chính): URL, mã truy cập, trạng thái; tắt thì không lộ mã', async () => {
    const u = userClient(L.env.app);
    L.env.ctx.config.lanHost = '10.1.2.3';
    L.env.ctx.config.lanPort = 8790;
    L.env.ctx.lan = { listening: true, host: '10.1.2.3', port: 8790, error: null };
    const on = (await u.get('/api/lan')).body;
    expect(on).toMatchObject({ enabled: true, listening: true, port: 8790, urls: ['http://10.1.2.3:8790'], access_code: LAN_CODE, error: null });
    L.env.ctx.config.lanEnabled = false;
    L.env.ctx.config.lanHost = '0.0.0.0';
    const off = (await u.get('/api/lan')).body;
    expect(off).toMatchObject({ enabled: false, listening: false, urls: [], access_code: null });
    // route này KHÔNG có trên listener LAN (đã được kiểm chứng ở bài kiểm tra cô lập); worker token không mở được gì ở LAN
    expect((await c.get('/api/lan', { authorization: `Bearer ${WORKER_TOKEN}` })).status).toBe(404);
    void LAN_CODE;
  });
});

describe('payload job storyboard dùng chung template với trang LAN', () => {
  it('payload.chatgpt_message = buildStoryboardMessage (cùng nhãn ảnh, cùng thứ tự; có storyboard cảnh đầu khi use_prev_storyboard)', async () => {
    const { buildStoryboardMessage } = await import('../src/services/plan.js');
    const { multipart } = await import('./helpers.js');
    const sc = await setupProject(L.env, { scenes: 2, usePrev: true });
    // hai ảnh tham chiếu cho dự án app, gán cho cảnh 2
    const refs: any[] = [];
    for (const [name, label] of [['hop.png', 'Hộp 3/4'], ['stick.png', 'Stick']] as const) {
      const m = multipart([{ name: 'label', value: label }, { name: 'file', filename: name, data: png(name), type: 'image/png' }]);
      const r = await L.env.app.inject({ method: 'POST', url: `/api/projects/${sc.project.id}/refs`, payload: m.payload, headers: { ...m.headers, host: 'localhost:8787' } });
      refs.push(...JSON.parse(r.body));
    }
    await workerClient(L.env.app).post('/api/worker/scenes', {
      project_id: sc.project.id,
      scenes: sc.scenes.map((s: any, i: number) => ({ code: s.code, order_index: i, title: s.title, prompt: s.prompt, first_frame_desc: s.first_frame_desc, upload_refs: [refs[1].id, refs[0].id], use_prev_storyboard: i > 0 })),
    });
    // C1: storyboard xong
    const u = userClient(L.env.app);
    const w = workerClient(L.env.app);
    await u.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const j1 = (await w.get('/api/worker/next?worker=w1')).body;
    expect(j1.payload.chatgpt_message).toBe(
      buildStoryboardMessage({ sceneCode: 'C1', firstFrameDesc: sc.scenes[0].first_frame_desc, prompt: sc.scenes[0].prompt, refLabels: ['Stick', 'Hộp 3/4'], prevStoryboardCode: null }),
    );
    expect(j1.payload.chatgpt_message).toContain('ảnh 1 = Stick, ảnh 2 = Hộp 3/4');
    writeFile(L.env.root, j1.payload.output.storyboard_path, PNG_BYTES);
    await w.post(`/api/worker/jobs/${j1.id}/complete`, { result: {}, assets: [{ kind: 'storyboard', file_path: j1.payload.output.storyboard_path }] });
    // C2: có storyboard cảnh đầu ở cuối upload_files và trong tin nhắn
    await u.post(`/api/scenes/${sc.scenes[1].id}/approve`, { stage: 'storyboard' });
    const j2 = (await w.get('/api/worker/next?worker=w1')).body;
    expect(j2.payload.upload_files).toHaveLength(3);
    expect(j2.payload.upload_files[2]).toBe(j1.payload.output.storyboard_path);
    expect(j2.payload.chatgpt_message).toBe(
      buildStoryboardMessage({ sceneCode: 'C2', firstFrameDesc: sc.scenes[1].first_frame_desc, prompt: sc.scenes[1].prompt, refLabels: ['Stick', 'Hộp 3/4'], prevStoryboardCode: 'C1' }),
    );
    expect(j2.payload.chatgpt_message).toContain('ảnh 3 = storyboard cảnh C1');
  });
});
