import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAN_RATE } from '../src/lan/routes.js';
import { LAN_QUEUE_CAP } from '../src/services/lan-queue.js';
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
const cutsUrl = (tail = '') => `/lan/api/plans/${fx.plan.id}/final-cuts${tail}`;
const sceneUrl = (i: number) => `/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[i]!.id}/video`;
const edlFrom = (cut: any) => ({
  scenes: cut.selection.map((s: any) => ({ scene_id: s.scene_id, asset_id: s.asset_id, segments: [{ in_s: 0.3, out_s: 2.5 }], removed: [{ from_s: 0, to_s: 0.3, reason: 'đầu' }], note: s.code })),
});

async function mk(o: { gwr?: boolean } = {}) {
  fake = new FakeRenderer();
  fake.realVideo = { seconds: 2, audio: true };
  L = await makeLanEnv({
    app: { finalRenderer: fake, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 } },
    config: o.gwr === false ? { watermarkRemover: 'off' } : { gwrCli: FAKE_CLI, watermarkRemover: 'auto', gwrTimeoutMs: 60_000 },
  });
  c = L.client();
  await c.login();
  fx = await makeLanPlan(L, c, 2);
  for (let i = 0; i < 2; i++) expect((await c.uploadVideo(sceneUrl(i), { name: `c${i + 1}.mp4`, data: clip(3) })).status).toBe(201);
}
async function readyV1() {
  const r = await c.post(cutsUrl(), {});
  expect(r.status, r.raw).toBe(201);
  const job = await worker().get('/api/worker/next?worker=w1');
  const done = await worker().post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl: edlFrom(r.body.final_cut), summary: 'Cắt đầu cuối.' } });
  expect(done.status, done.raw).toBe(200);
  await idle();
  const v1 = (await c.get(cutsUrl(`/${r.body.final_cut.id}`))).body;
  expect(v1.status).toBe('ready');
  return v1;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'autovideo-lanfb-'));
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

run('LAN: góp ý cho AI + chỉnh màu', () => {
  beforeEach(() => mk());

  it('góp ý → phiên bản mới + job edit_plan (payload.revision); JSON an toàn (không đường dẫn thô); AI trả màu → v2 ready qua /lan/files; hạn mức hiển thị', async () => {
    const v1 = await readyV1();
    const r = await c.post(cutsUrl(`/${v1.id}/feedback`), { feedback: 'Màu ấm hơn, tương phản cao hơn' });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.final_cut).toMatchObject({ version: 2, status: 'planning', parent_id: v1.id, parent_version: 1, feedback: 'Màu ấm hơn, tương phản cao hơn', base_path: null, video_path: null });
    expect(r.body.rate.feedback_remaining).toBe(LAN_RATE.feedback.max - 1);
    expect(JSON.stringify(r.body)).not.toContain(L.env.root);
    const job = await worker().get('/api/worker/next?worker=w1');
    expect(job.body.payload.revision).toMatchObject({ parent_cut_id: v1.id, feedback: 'Màu ấm hơn, tương phản cao hơn' });
    const done = await worker().post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl: null, grade: { temperature_k: 7200, contrast: 1.15 }, summary: 'Ấm 7200K; tương phản 1.15', not_done: ['Thêm nhạc'] } });
    expect(done.status, done.raw).toBe(200);
    await idle();
    const v2 = (await c.get(cutsUrl(`/${r.body.final_cut.id}`))).body;
    expect(v2).toMatchObject({ status: 'ready', grade_chips: ['Ấm 7200K', 'Tương phản 1.15'], base_path: null, video_path: null, revision: { kind: 'ai', edl_changed: false, not_done: ['Thêm nhạc'] } });
    expect(v2.video_url).toBe(`/lan/files/output/${fx.slug}/final/${fx.slug}_final_v2.mp4`);
    expect((await c.get(v2.video_url)).status).toBe(200);
    expect((await c.get(`/lan/files/output/${fx.slug}/final/${fx.slug}_final_v2_base.mp4`)).status).toBe(404); // bản sạch chưa chỉnh màu không phục vụ qua LAN
    expect(JSON.stringify(v2)).not.toContain(L.env.root);
    expect((await c.get('/lan/api/status')).body.remaining).toMatchObject({ feedback: LAN_RATE.feedback.max - 1, grade: LAN_RATE.grade.max, grade_preview: LAN_RATE.gradePreview.max });
    expect(fake.calls).toHaveLength(1);
  });

  it('chỉnh tay + xem trước qua LAN: ảnh phục vụ qua /lan/files (đúng danh sách cho phép), bản mới created_by=user', async () => {
    const v1 = await readyV1();
    const pv = await c.post(cutsUrl(`/${v1.id}/grade-preview`), { grade: { temperature_k: 7600 } });
    expect(pv.status, pv.raw).toBe(200);
    expect(pv.body.items).toHaveLength(3);
    for (const it of pv.body.items) {
      expect(it.before_url).toMatch(new RegExp(`^/lan/files/output/${fx.slug}/final/preview/`));
      expect([(await c.get(it.before_url)).status, (await c.get(it.after_url)).status]).toEqual([200, 200]);
    }
    expect(pv.body.rate.grade_preview_remaining).toBe(LAN_RATE.gradePreview.max - 1);
    // không phục vụ ảnh preview của slug khác / tên lạ
    expect((await c.get(`/lan/files/output/khong-co/final/preview/x.jpg`)).status).toBe(404);
    expect((await c.get(`/lan/files/output/${fx.slug}/final/preview/..%2F..%2Fx.jpg`)).status).toBe(404);
    const g = await c.post(cutsUrl(`/${v1.id}/grade`), { grade: { temperature_k: 7600 }, note: 'tay' });
    expect(g.status, g.raw).toBe(201);
    expect(g.body.final_cut).toMatchObject({ created_by: 'user', status: 'rendering', stage: 'grade', base_path: null });
    expect(g.body.rate.grade_remaining).toBe(LAN_RATE.grade.max - 1);
    await idle();
    expect((await c.get(cutsUrl(`/${g.body.final_cut.id}`))).body).toMatchObject({ status: 'ready', grade: { temperature_k: 7600 } });
  });

  it('lỗi chỉnh màu (ffmpeg hỏng) → failed_stage=grade, thông báo không lộ đường dẫn; /regrade chạy lại', async () => {
    const v1 = await readyV1();
    const good = L.env.ctx.config.ffmpegPath;
    const broken = path.join(tmp, 'ffmpeg-broken.sh');
    fs.writeFileSync(broken, `#!/bin/sh\ncase "$1" in -version) exec "${FFMPEG}" "$@";; esac\necho "boom /Users/secret/path/file.mp4" >&2\nexit 3\n`, { mode: 0o755 });
    L.env.ctx.config.ffmpegPath = broken;
    const g = await c.post(cutsUrl(`/${v1.id}/grade`), { grade: { contrast: 1.2 } });
    await idle();
    const failed = (await c.get(cutsUrl(`/${g.body.final_cut.id}`))).body;
    expect(failed).toMatchObject({ status: 'failed', failed_stage: 'grade' });
    expect(failed.error).toContain('Chỉnh màu không thành công');
    expect(JSON.stringify(failed)).not.toContain('/Users/secret');
    L.env.ctx.config.ffmpegPath = good;
    const re = await c.post(cutsUrl(`/${g.body.final_cut.id}/regrade`), {});
    expect(re.status, re.raw).toBe(200);
    expect(re.body.rate.grade_remaining).toBe(LAN_RATE.grade.max - 2);
    await idle();
    expect((await c.get(cutsUrl(`/${g.body.final_cut.id}`))).body.status).toBe('ready');
  });

  it('hạn mức theo IP: góp ý 20/giờ, chỉnh tay 30/giờ, xem trước 60/giờ; hết giờ thì dùng lại được; IP khác không bị ảnh hưởng', async () => {
    expect(LAN_RATE.feedback.max).toBe(20);
    expect(LAN_RATE.grade.max).toBe(30);
    expect(LAN_RATE.gradePreview.max).toBe(60);
    const v1 = await readyV1();
    // chỉnh tay 30 lần (trung tính: chỉ hard link, nhanh)
    for (let i = 0; i < LAN_RATE.grade.max; i++) {
      const r = await c.post(cutsUrl(`/${v1.id}/grade`), { grade: {} });
      expect([i, r.status]).toEqual([i, 201]);
      await idle();
    }
    const over = await c.post(cutsUrl(`/${v1.id}/grade`), { grade: {} });
    expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    const other = L.client({ ip: '192.168.1.99' });
    await other.login();
    // IP khác không bị ảnh hưởng (hàng đợi LAN vẫn còn chỗ vì việc đã xong)
    expect((await other.post(cutsUrl(`/${v1.id}/grade`), { grade: {} })).status).toBe(201);
    await idle();
    // góp ý: mỗi lần tạo bản planning rồi hủy để lần sau gửi được
    const other2 = L.client({ ip: '192.168.1.98' });
    await other2.login();
    for (let i = 0; i < LAN_RATE.feedback.max; i++) {
      const r = await other2.post(cutsUrl(`/${v1.id}/feedback`), { feedback: `góp ý ${i}` });
      expect([i, r.status, r.raw.slice(0, 120)]).toEqual([i, 201, r.raw.slice(0, 120)]);
      expect((await other2.post(cutsUrl(`/${r.body.final_cut.id}/cancel`), {})).status).toBe(200);
    }
    const f21 = await other2.post(cutsUrl(`/${v1.id}/feedback`), { feedback: 'quá' });
    expect([f21.status, f21.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    // xem trước: 60 lần (cùng grade nên dùng cache), lần 61 bị chặn
    const o3 = L.client({ ip: '192.168.1.97' });
    await o3.login();
    for (let i = 0; i < LAN_RATE.gradePreview.max; i++) expect([i, (await o3.post(cutsUrl(`/${v1.id}/grade-preview`), { grade: { contrast: 1.2 } })).status]).toEqual([i, 200]);
    expect((await o3.post(cutsUrl(`/${v1.id}/grade-preview`), { grade: { contrast: 1.2 } })).body.error.code).toBe('RATE_LIMITED');
    // sau 1 giờ dùng lại được
    L.env.clock.advanceMinutes(61);
    expect((await o3.post(cutsUrl(`/${v1.id}/grade-preview`), { grade: { contrast: 1.2 } })).status).toBe(200);
  }, 120_000);

  it('tính vào trần hàng đợi LAN (6): đầy → 429 QUEUE_FULL cho góp ý/chỉnh tay/thử lại; xem trước không vào hàng đợi', async () => {
    const v1 = await readyV1();
    const ins = db().prepare("INSERT INTO lan_tool_jobs (kind, status, client_id_hash, created_at) VALUES ('remove_logo', 'queued', 'h', ?)");
    for (let i = 0; i < LAN_QUEUE_CAP; i++) ins.run(L.env.ctx.now());
    for (const [tail, body] of [['feedback', { feedback: 'ấm hơn' }], ['grade', { grade: { contrast: 1.1 } }]] as const) {
      const r = await c.post(cutsUrl(`/${v1.id}/${tail}`), body);
      expect([tail, r.status, r.body.error.code]).toEqual([tail, 429, 'QUEUE_FULL']);
    }
    expect((await c.post(cutsUrl(`/${v1.id}/grade-preview`), { grade: { contrast: 1.1 } })).status).toBe(200);
    // chưa tạo gì
    expect((db().prepare('SELECT COUNT(*) AS n FROM final_cuts WHERE project_id = ?').get(fx.plan.id) as { n: number }).n).toBe(1);
  });

  it('bản của dự án khác / dự án app → 404 cho cả 4 thao tác; kế hoạch bị xoá (thùng rác) → 404; kiểm tra đầu vào', async () => {
    const v1 = await readyV1();
    const app = await setupAllDone(L.env, { scenes: 2 });
    const appCut = (await userClient(L.env.app).get(`/api/projects/${app.project.id}/final-cuts`)).body[0];
    for (const tail of ['feedback', 'grade', 'grade-preview', 'regrade']) {
      const r = await c.post(cutsUrl(`/${appCut.id}/${tail}`), { feedback: 'x', grade: {} });
      expect([tail, r.status]).toEqual([tail, 404]);
    }
    expect((await c.post(cutsUrl(`/${v1.id}/feedback`), { feedback: '' })).status).toBe(400);
    expect((await c.post(cutsUrl(`/${v1.id}/feedback`), { feedback: 'x'.repeat(1001) })).status).toBe(400);
    expect((await c.post(cutsUrl(`/${v1.id}/grade`), { grade: { gamma: 'x' } })).body.error.code).toBe('INVALID_GRADE');
    // xoá kế hoạch: trình duyệt tạo kế hoạch (cookie client) xoá được
    const created = await c.post('/lan/api/plans', { name: 'Tạm', created_by_name: 'Lan', brief: 'b' });
    expect(created.status).toBe(201);
    const del = await c.del(`/lan/api/plans/${fx.plan.id}`);
    // kế hoạch của fixture tạo bằng cookie khác tuỳ môi trường: xoá trực tiếp bằng dịch vụ nếu bị từ chối
    if (del.status !== 200) {
      const { deleteProject } = await import('../src/services/trash.js');
      deleteProject(L.env.ctx, fx.plan.id, { by: 'app' });
    }
    for (const tail of ['feedback', 'grade', 'grade-preview', 'regrade']) {
      const r = await c.post(cutsUrl(`/${v1.id}/${tail}`), { feedback: 'x', grade: {} });
      expect([tail, r.status]).toEqual([tail, 404]);
    }
  });
});
