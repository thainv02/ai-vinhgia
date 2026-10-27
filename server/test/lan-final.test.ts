import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scrubForLan } from '../src/services/lan-common.js';
import { LAN_RATE } from '../src/lan/routes.js';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { setupAllDone, userClient, workerClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan, type LanPlanFixture } from './helpers-lan-plan.js';
import { clip } from './helpers-video.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-gwr.mjs', import.meta.url));
const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c: LanClient;
let fake: FakeRenderer;
let fx: LanPlanFixture;
let tmp: string;
const db = () => L.env.ctx.db;
const idle = () => L.env.ctx.finalRender!.idle();
const worker = () => workerClient(L.env.app);

async function mk(o: { gwr?: boolean; renderer?: FakeRenderer; scenes?: number } = {}) {
  fake = o.renderer ?? new FakeRenderer();
  fake.realVideo = { seconds: 2, audio: true };
  L = await makeLanEnv({
    app: { finalRenderer: fake, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 } },
    config: o.gwr ? { gwrCli: FAKE_CLI, watermarkRemover: 'auto', gwrTimeoutMs: 60_000 } : { watermarkRemover: 'off' },
  });
  c = L.client();
  await c.login();
  fx = await makeLanPlan(L, c, o.scenes ?? 2);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'autovideo-lanfinal-'));
  process.env.FAKE_GWR_LOG = path.join(tmp, 'gwr.log');
  process.env.FAKE_GWR_MODE = 'ok';
  process.env.FAKE_GWR_HELP = 'ok';
  process.env.FAKE_GWR_FFMPEG = FFMPEG ?? 'ffmpeg';
});
afterEach(async () => {
  fake?.release();
  for (const k of ['FAKE_GWR_LOG', 'FAKE_GWR_MODE', 'FAKE_GWR_HELP', 'FAKE_GWR_FFMPEG']) delete process.env[k];
  await L?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sceneUrl = (i: number, tail = 'video') => `/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[i]!.id}/${tail}`;
const uploadAll = async () => {
  for (let i = 0; i < fx.scenes.length; i++) expect((await c.uploadVideo(sceneUrl(i), { name: `c${i + 1}.mp4`, data: clip(3) })).status).toBe(201);
};
const cutsUrl = (tail = '') => `/lan/api/plans/${fx.plan.id}/final-cuts${tail}`;
const edlFrom = (cut: any, seg: [number, number] = [0.3, 2.5]) => ({
  scenes: cut.selection.map((s: any) => ({ scene_id: s.scene_id, asset_id: s.asset_id, segments: [{ in_s: seg[0], out_s: seg[1] }], removed: [{ from_s: 0, to_s: seg[0], reason: 'Đầu chưa có hành động' }], note: `ghi chú ${s.code}` })),
});
/** Build → worker giả nhận edit_plan → gửi EDL → đợi render (và xoá logo) xong. */
async function buildAndPlan(seg?: [number, number]) {
  const r = await c.post(cutsUrl(), {});
  expect(r.status, r.raw).toBe(201);
  const job = await worker().get('/api/worker/next?worker=w1');
  expect(job.status, job.raw).toBe(200);
  expect(job.body.type).toBe('edit_plan');
  const done = await worker().post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl: edlFrom(r.body.final_cut, seg), summary: 'Cắt đầu cuối mỗi cảnh.' } });
  expect(done.status, done.raw).toBe(200);
  await idle();
  return { job: job.body, id: r.body.final_cut.id as number, get: async () => (await c.get(cutsUrl(`/${r.body.final_cut.id}`))).body };
}

run('điều kiện dựng của kế hoạch LAN', () => {
  beforeEach(() => mk());

  it('nút dựng khóa kèm lý do "Còn C2 chưa có video"; mọi cảnh có video được chọn là đủ — cảnh vẫn awaiting_approval, KHÔNG tự dựng khi upload', async () => {
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final).toMatchObject({ block: { code: 'SCENES_NOT_READY', message: 'Còn C1, C2 chưa có video' }, active: false, latest: null });
    let r = await c.post(cutsUrl(), {});
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([409, 'SCENES_NOT_READY', 'Còn C1, C2 chưa có video']);
    await c.uploadVideo(sceneUrl(0), { name: 'a.mp4', data: clip(3) });
    r = await c.post(cutsUrl(), {});
    expect(r.body.error.message).toBe('Còn C2 chưa có video');
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final.block.message).toBe('Còn C2 chưa có video');

    await c.uploadVideo(sceneUrl(1), { name: 'b.mp4', data: clip(3) });
    // upload KHÔNG kích hoạt: không có bản dựng, không job edit_plan, cảnh giữ nguyên trạng thái của máy trạng thái app
    expect((db().prepare('SELECT COUNT(*) AS n FROM final_cuts').get() as { n: number }).n).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'edit_plan'").get() as { n: number }).n).toBe(0);
    expect((db().prepare('SELECT DISTINCT status FROM scenes WHERE project_id = ?').all(fx.plan.id) as { status: string }[]).map((s) => s.status)).toEqual(['awaiting_approval']);
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final.block).toBeNull();
  });

  it('bấm dựng: final_cut planning + job edit_plan (không duyệt, không tốn credit), payload có video LAN; dựng tiếp khi đang chạy → 409', async () => {
    await uploadAll();
    const r = await c.post(cutsUrl(), {});
    expect(r.status, r.raw).toBe(201);
    expect(r.body.final_cut).toMatchObject({ version: 1, status: 'planning', created_by: 'claude', edl: null, video_url: null, project_file_path: null, render_ref: null, watermark_meta: null, outdated: false });
    expect(r.body.final_cut.selection.map((s: any) => [s.code, s.attempt, s.video_url])).toEqual([
      ['C1', 1, `/lan/files/output/${fx.slug}/video/C1_v1.mp4`],
      ['C2', 1, `/lan/files/output/${fx.slug}/video/C2_v1.mp4`],
    ]);
    const jobs = db().prepare("SELECT * FROM jobs WHERE type = 'edit_plan'").all() as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ project_id: fx.plan.id, scene_id: null, requires_approval: 0, credits_cost: 0, status: 'queued' });
    const claim = await worker().get('/api/worker/next?worker=w1');
    expect(claim.body.type).toBe('edit_plan');
    expect(claim.body.payload.scenes.map((s: any) => [s.code, s.video_path, s.duration_s > 2.9])).toEqual([
      ['C1', `output/${fx.slug}/video/C1_v1.mp4`, true],
      ['C2', `output/${fx.slug}/video/C2_v1.mp4`, true],
    ]);
    const again = await c.post(cutsUrl(), {});
    expect([again.status, again.body.error.code]).toEqual([409, 'FINAL_CUT_ACTIVE']);
    expect(again.body.error.message).toContain('v1');
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final).toMatchObject({ active: true, block: { code: 'FINAL_CUT_ACTIVE' }, latest: { version: 1, status: 'planning' } });
    // không tốn credit, không job storyboard/video
    expect((db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('storyboard','video')").get() as { n: number }).n).toBe(0);
    expect((db().prepare('SELECT COUNT(*) AS n FROM credit_ledger').get() as { n: number }).n).toBe(0);
  });

  it('chọn video khác của cảnh sau khi dựng → bản cũ outdated; file video nguồn bị xoá → khóa nút với lý do rõ', async () => {
    await uploadAll();
    const built = await buildAndPlan();
    expect((await built.get()).outdated).toBe(false);
    await c.uploadVideo(sceneUrl(0), { name: 'moi.mp4', data: clip(2) });
    expect((await built.get()).outdated).toBe(true);
    const a = db().prepare("SELECT file_path FROM assets WHERE scene_id = ? ORDER BY id DESC LIMIT 1").get(fx.scenes[0]!.id) as { file_path: string };
    fs.rmSync(path.join(L.env.root, a.file_path));
    const r = await c.post(cutsUrl(), {});
    expect([r.status, r.body.error.code]).toEqual([409, 'FILE_MISSING']);
    expect(r.body.error.message).toContain('C1');
  });

  it('kế hoạch chưa có cảnh → 409; dự án app và bản dựng của dự án khác → 404 (không đụng được qua LAN)', async () => {
    const empty = await c.post('/lan/api/plans', { name: 'Trống', created_by_name: 'T', brief: 'b' });
    const r = await c.post(`/lan/api/plans/${empty.body.plan.id}/final-cuts`, {});
    expect([r.status, r.body.error.message]).toEqual([409, 'Kế hoạch chưa có cảnh nào']);
    const app = await setupAllDone(L.env, { scenes: 2 }); // dự án app đã có bản dựng planning
    const appCut = (await userClient(L.env.app).get(`/api/projects/${app.project.id}/final-cuts`)).body[0];
    expect((await c.get(`/lan/api/plans/${app.project.id}/final-cuts`)).status).toBe(404);
    expect((await c.post(`/lan/api/plans/${app.project.id}/final-cuts`, {})).status).toBe(404);
    // id bản dựng của dự án app dùng với kế hoạch LAN → 404 như không tồn tại
    for (const [m, tail] of [['get', `/${appCut.id}`], ['post', `/${appCut.id}/cancel`], ['post', `/${appCut.id}/clean`], ['post', `/${appCut.id}/rerender`]] as const) {
      const res = m === 'get' ? await c.get(cutsUrl(tail)) : await c.post(cutsUrl(tail), { edl: {} });
      expect([m, tail, res.status]).toEqual([m, tail, 404]);
    }
    expect((await userClient(L.env.app).get(`/api/final-cuts/${appCut.id}`)).body.status).toBe('planning'); // không bị hủy
  });
});

run('dựng → render → xoá logo → sẵn sàng (ffmpeg giả + CLI xoá logo giả)', () => {
  beforeEach(() => mk({ gwr: true }));

  it('pipeline đầy đủ qua LAN: AI chọn điểm cắt → render → xoá logo → ready; JSON an toàn; file qua /lan/files; chạy một việc một lúc', async () => {
    await uploadAll();
    const seen: string[] = [];
    const orig = L.env.ctx.sse.publish.bind(L.env.ctx.sse);
    L.env.ctx.sse.publish = (e: string, d: any, p: number | null) => {
      if (e === 'final_cut.updated') seen.push(`${d.final_cut.status}/${d.final_cut.stage}`);
      orig(e, d, p);
    };
    L.env.ctx.sse.add({ writeHead() {}, write() {}, on() {}, end() {} } as any, fx.plan.id);
    const built = await buildAndPlan();
    const cut = await built.get();
    expect(cut).toMatchObject({ status: 'ready', stage: null, failed_stage: null, watermark_removed: true, renderer: 'ffmpeg', progress: 100, error: null, outdated: false, created_by: 'claude', summary: 'Cắt đầu cuối mỗi cảnh.' });
    expect(seen).toContain('planning/null');
    expect(seen).toContain('rendering/render');
    expect(seen).toContain('rendering/clean');
    expect(seen.at(-1)).toBe('ready/null');
    expect(cut.video_url).toBe(`/lan/files/output/${fx.slug}/final/${fx.slug}_final_v1.mp4`);
    expect(cut.raw_video_url).toBe(`/lan/files/output/${fx.slug}/final/${fx.slug}_final_v1_raw.mp4`);
    expect(cut.contact_sheet_url).toBe(`/lan/files/output/${fx.slug}/final/${fx.slug}_final_v1_contact.png`);
    // không lộ đường dẫn thô / file dự án / meta tool / mã render
    expect([cut.video_path, cut.raw_video_path, cut.contact_sheet_path, cut.project_file_path, cut.render_ref, cut.watermark_meta]).toEqual([null, null, null, null, null, null]);
    expect(JSON.stringify(cut)).not.toContain(L.env.root);
    expect(cut.edl.scenes).toHaveLength(2);
    expect(cut.selection.every((s: any) => s.duration_s > 2.9 && s.video_url?.startsWith('/lan/files/'))).toBe(true);
    // file phục vụ qua LAN: video sạch, raw còn logo, contact sheet
    for (const u of [cut.video_url, cut.raw_video_url, cut.contact_sheet_url]) {
      const f = await c.get(u);
      expect([u, f.status]).toEqual([u, 200]);
    }
    const range = await c.get(cut.video_url, { range: 'bytes=0-99' });
    expect(range.status).toBe(206);
    // danh sách + chi tiết + tóm tắt
    const list = (await c.get(cutsUrl())).body;
    expect(list.map((x: any) => [x.version, x.status])).toEqual([[1, 'ready']]);
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final).toMatchObject({ active: false, block: null, latest: { version: 1, status: 'ready' }, watermark: { active: true } });
    expect(JSON.stringify((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final.watermark)).not.toContain('/');
    // mỗi lúc một việc: tool chạy đúng một lần cho bản dựng, và main app thấy bản dựng này như dự án thường
    expect(fs.readFileSync(process.env.FAKE_GWR_LOG!, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).argv[0] === 'remove')).toHaveLength(1);
    const appView = (await userClient(L.env.app).get(`/api/projects/${fx.plan.id}/final-cuts`)).body;
    expect(appView[0]).toMatchObject({ status: 'ready', watermark_removed: true, video_url: expect.stringContaining('/files/output/') });
    expect(fake.maxConcurrent).toBe(1);
  });

  it('lỗi ở bước xoá logo: giữ bản raw, failed_stage=clean, lỗi không lộ đường dẫn; /clean chạy lại RIÊNG bước xoá logo (không render lại)', async () => {
    await uploadAll();
    process.env.FAKE_GWR_MODE = 'fail';
    const built = await buildAndPlan();
    let cut = await built.get();
    expect(cut).toMatchObject({ status: 'failed', failed_stage: 'clean', watermark_removed: false, video_url: null });
    expect(cut.raw_video_url).toContain('_raw.mp4');
    expect(cut.error).toContain('Xoá logo Veo thất bại');
    expect(fake.calls).toHaveLength(1);
    expect((await c.get(cut.raw_video_url)).status).toBe(200); // "Tải bản gốc còn logo"

    process.env.FAKE_GWR_MODE = 'ok';
    const r = await c.post(cutsUrl(`/${built.id}/clean`), {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.final_cut).toMatchObject({ status: 'rendering', stage: 'clean', progress: 0, video_url: null });
    expect(typeof r.body.rate.remove_logo_remaining).toBe('number');
    await idle();
    cut = await built.get();
    expect(cut).toMatchObject({ status: 'ready', watermark_removed: true, failed_stage: null });
    expect(fake.calls).toHaveLength(1); // không render lại
    // đã xoá rồi thì không xoá lại
    const again = await c.post(cutsUrl(`/${built.id}/clean`), {});
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('tool xoá logo tắt/hỏng → /clean 409 WATERMARK_REMOVER_UNAVAILABLE, lý do không chứa đường dẫn máy chủ', async () => {
    await uploadAll();
    process.env.FAKE_GWR_MODE = 'fail';
    const built = await buildAndPlan();
    L.env.ctx.config.gwrCli = '/duong/dan/khong/co/gwr.mjs';
    const r = await c.post(cutsUrl(`/${built.id}/clean`), {});
    expect([r.status, r.body.error.code]).toEqual([409, 'WATERMARK_REMOVER_UNAVAILABLE']);
    expect(r.body.error.message).not.toContain('/duong/dan');
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).body.final.watermark).toMatchObject({ active: false });
  });
});

run('render lại, hủy, file bản dựng', () => {
  beforeEach(() => mk());

  it('render lại với điểm cắt người dùng sửa → version mới (created_by user, không qua worker); EDL sai → 400 INVALID_EDL kèm cảnh/đoạn, không tạo version', async () => {
    await uploadAll();
    const built = await buildAndPlan();
    const v1 = await built.get();
    expect(v1.status).toBe('ready');
    const jobsBefore = (db().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;

    const bad = edlFrom(v1, [0.3, 2.5]);
    bad.scenes[1]!.segments = [{ in_s: 1, out_s: 2 }, { in_s: 1.5, out_s: 2.5 }];
    const e = await c.post(cutsUrl(`/${built.id}/rerender`), { edl: bad });
    expect([e.status, e.body.error.code]).toEqual([400, 'INVALID_EDL']);
    expect(e.body.error.details).toMatchObject({ scene: 'C2', segment: 2 });
    expect((await c.post(cutsUrl(`/${built.id}/rerender`), {})).body.error.code).toBe('INVALID_EDL');
    expect((await c.get(cutsUrl())).body).toHaveLength(1);

    const ok = await c.post(cutsUrl(`/${built.id}/rerender`), { edl: edlFrom(v1, [0.5, 2]), note: 'bỏ đầu thừa' });
    expect(ok.status, ok.raw).toBe(201);
    expect(ok.body.final_cut).toMatchObject({ version: 2, created_by: 'user', status: 'rendering', note: 'bỏ đầu thừa' });
    await idle();
    const v2 = (await c.get(cutsUrl(`/${ok.body.final_cut.id}`))).body;
    expect(v2).toMatchObject({ version: 2, status: 'ready' });
    expect(v2.edl.scenes[0].segments).toEqual([{ in_s: 0.5, out_s: 2 }]);
    expect((await c.get(cutsUrl(`/${built.id}`))).body.version).toBe(1); // bản cũ giữ nguyên
    expect((db().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(jobsBefore); // không job mới
    expect((await c.get(cutsUrl())).body.map((x: any) => x.version)).toEqual([2, 1]);
  });

  it('hủy: bản đang chờ AI chọn điểm cắt → job edit_plan bị hủy; bản đang render → dừng; đã xong → 409', async () => {
    await uploadAll();
    let r = await c.post(cutsUrl(), {});
    const planId = r.body.final_cut.id;
    const job = db().prepare("SELECT id FROM jobs WHERE type = 'edit_plan'").get() as { id: number };
    const cancelled = await c.post(cutsUrl(`/${planId}/cancel`), {});
    expect(cancelled.status, cancelled.raw).toBe(200);
    expect(cancelled.body.final_cut.status).toBe('cancelled');
    expect((db().prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string }).status).toBe('cancelled');

    // đang render (giữ renderer lại)
    fake.hold();
    r = await c.post(cutsUrl(), {});
    const w = await worker().get('/api/worker/next?worker=w1');
    await worker().post(`/api/worker/jobs/${w.body.id}/complete`, { result: { edl: edlFrom(r.body.final_cut), summary: 'x' } });
    await new Promise((res) => setTimeout(res, 100));
    expect((await c.get(cutsUrl(`/${r.body.final_cut.id}`))).body).toMatchObject({ status: 'rendering', stage: 'render' });
    const c2 = await c.post(cutsUrl(`/${r.body.final_cut.id}/cancel`), {});
    expect(c2.body.final_cut.status).toBe('cancelled');
    await idle();
    expect(fake.aborted).toContain(r.body.final_cut.id);
    expect((await c.post(cutsUrl(`/${r.body.final_cut.id}/cancel`), {})).status).toBe(409);
  });

  it('hàng đợi: bản đang chờ trong hàng đợi render báo "còn N việc trước" (queue_ahead)', async () => {
    await uploadAll();
    fake.hold();
    const r1 = await c.post(cutsUrl(), {});
    const j1 = await worker().get('/api/worker/next?worker=w1');
    await worker().post(`/api/worker/jobs/${j1.body.id}/complete`, { result: { edl: edlFrom(r1.body.final_cut), summary: 'x' } });
    await new Promise((res) => setTimeout(res, 100));
    expect((await c.get(cutsUrl(`/${r1.body.final_cut.id}`))).body.queue_ahead).toBe(0); // đang chạy
    // render lại một bản khác của cùng kế hoạch bị chặn vì đang render (mỗi kế hoạch một bản)
    const again = await c.post(cutsUrl(`/${r1.body.final_cut.id}/rerender`), { edl: edlFrom(r1.body.final_cut) });
    expect(again.body.error.code).toBe('FINAL_CUT_ACTIVE');
    fake.release();
    await idle();
  });

  it('chỉ phục vụ file bản dựng của dự án LAN: mp4, raw (nếu có), contact sheet; KHÔNG file .mlt; không file của dự án app', async () => {
    await mkShotcutLike();
    await uploadAll();
    const built = await buildAndPlan();
    const cut = await built.get();
    expect(cut).toMatchObject({ status: 'ready', renderer: 'shotcut', project_file_path: null });
    const mlt = db().prepare('SELECT project_file_path FROM final_cuts WHERE id = ?').get(built.id) as { project_file_path: string };
    expect(mlt.project_file_path).toMatch(/\.mlt$/);
    expect(fs.existsSync(path.join(L.env.root, mlt.project_file_path))).toBe(true);
    expect((await c.get(cut.video_url)).status).toBe(200);
    expect((await c.get(cut.contact_sheet_url)).status).toBe(200);
    expect((await c.get('/lan/files/' + mlt.project_file_path)).status).toBe(404);
    expect((await c.get(`/lan/files/${path.posix.dirname(mlt.project_file_path)}/`)).status).toBe(404);
    // file của dự án app (video, bản dựng) không phục vụ
    const app = await setupAllDone(L.env, { scenes: 1 });
    const appVideo = (db().prepare("SELECT file_path FROM assets WHERE scene_id = ? AND kind = 'video'").get(app.scenes[0].id) as { file_path: string }).file_path;
    expect((await c.get('/lan/files/' + appVideo)).status).toBe(404);
    expect(fs.existsSync(path.join(L.env.root, appVideo))).toBe(true);
  });
});

async function mkShotcutLike() {
  await L.close();
  await mk({ renderer: new FakeRenderer('shotcut') });
}

run('hạn mức, trần hàng đợi và ưu tiên', () => {
  beforeEach(() => mk());

  it(`dựng + render lại: tối đa ${LAN_RATE.createFinal.max} lần mỗi giờ theo IP (lỗi nghiệp vụ không tính); hết giờ dựng lại được`, async () => {
    await uploadAll();
    expect((await c.post(`/lan/api/plans/${fx.plan.id}/final-cuts/99999/rerender`, { edl: {} })).status).toBe(404); // lỗi nghiệp vụ không tính
    for (let i = 0; i < LAN_RATE.createFinal.max; i++) {
      const r = await c.post(cutsUrl(), {});
      expect(r.status, `lượt ${i + 1}: ${r.raw}`).toBe(201);
      expect((await c.post(cutsUrl(`/${r.body.final_cut.id}/cancel`), {})).status).toBe(200);
    }
    const over = await c.post(cutsUrl(), {});
    expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await c.get('/lan/api/status')).body.remaining.create_final).toBe(0);
    L.env.clock.advance(61 * 60_000);
    expect((await c.post(cutsUrl(), {})).status).toBe(201);
  });

  it('việc LAN chạm trần toàn cục 6 → 429 "Hàng đợi đang đầy, thử lại sau"; việc của app chính không bị chặn', async () => {
    const app = await setupAllDone(L.env, { scenes: 1 }); // dự án app trước (claim job theo thứ tự id): có bản dựng planning của chủ máy
    const now = L.env.ctx.now();
    // 6 việc công cụ đang chờ (giả lập trực tiếp trong DB): đúng trần
    for (let i = 0; i < 6; i++) {
      db().prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'queued', 'x.mp4', 'h', '{}', ?)").run(now);
    }
    await uploadAll();
    const r = await c.post(cutsUrl(), {});
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([429, 'QUEUE_FULL', 'Hàng đợi đang đầy, thử lại sau']);
    expect((db().prepare('SELECT COUNT(*) AS n FROM final_cuts WHERE project_id = ?').get(fx.plan.id) as { n: number }).n).toBe(0);
    expect((await c.get('/lan/api/status')).body.queue).toEqual({ cuts: 0, tools: 6, clips: 0, total: 6, cap: 6 });
    // bớt một việc → dựng được
    db().prepare("UPDATE lan_tool_jobs SET status = 'ready' WHERE id = 1").run();
    expect((await c.post(cutsUrl(), {})).status).toBe(201);
    expect((await c.get('/lan/api/status')).body.queue).toMatchObject({ cuts: 1, tools: 5, total: 6 });
    // việc của app chính không tính vào trần và vẫn tạo được bản dựng mới
    const appCuts = (await userClient(L.env.app).get(`/api/projects/${app.project.id}/final-cuts`)).body;
    expect(appCuts).toHaveLength(1);
    const appCancel = await userClient(L.env.app).post(`/api/final-cuts/${appCuts[0].id}/cancel`, {});
    expect(appCancel.status).toBe(200);
    expect((await userClient(L.env.app).post(`/api/projects/${app.project.id}/final-cuts`, {})).status).toBe(201);
    expect((await userClient(L.env.app).get('/api/lan')).body.queue).toMatchObject({ cuts: 1, tools: 5, total: 6, cap: 6 });
  });
});

describe('hàm thuần', () => {
  it('scrubForLan che đường dẫn tuyệt đối trong lỗi, giữ thông báo thường', () => {
    expect(scrubForLan('Server khởi động lại trong lúc render; bấm Render lại', 'chung')).toBe('Server khởi động lại trong lúc render; bấm Render lại');
    expect(scrubForLan('tool thoát với mã 1: Error: cannot open /Users/thainv/code/autovideo/output/x/y.mp4', 'chung')).toBe('chung');
    expect(scrubForLan('lỗi tại C:\\Users\\a\\b', 'chung')).toBe('chung');
    expect(scrubForLan('đoạn 1/2 hỏng', 'chung')).toBe('đoạn 1/2 hỏng');
    expect(scrubForLan(null, 'chung')).toBeNull();
    expect(scrubForLan('x'.repeat(400), 'chung')!.length).toBe(298);
  });
});
