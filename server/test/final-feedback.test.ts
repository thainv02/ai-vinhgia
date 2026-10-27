import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverRenderingCuts } from '../src/services/final-cuts.js';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { claim, claimEditPlan, edlFor, makeEnv, setupAllDone, type Env, type Scenario } from './helpers.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-gwr.mjs', import.meta.url));
const SLUG = 'cacao-actiso-plus';
const FINAL = `output/${SLUG}/final`;
const run = FFMPEG && FFPROBE ? describe : describe.skip;

let env: Env;
let fake: FakeRenderer;
let tmp: string;
let sc: Scenario;
const abs = (rel: string) => path.join(env.root, rel);
const sha = (rel: string) => crypto.createHash('sha256').update(fs.readFileSync(abs(rel))).digest('hex');
const ino = (rel: string) => fs.statSync(abs(rel)).ino;
const gwrLog = () => path.join(tmp, 'gwr.log');
const removeCalls = () => (fs.existsSync(gwrLog()) ? fs.readFileSync(gwrLog(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []).filter((c) => c.argv[0] === 'remove');
const idle = () => env.ctx.finalRender!.idle();
const get = async (id: number) => (await sc.user.get(`/api/final-cuts/${id}`)).body;
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function mk(extra: { gwr?: boolean; config?: Record<string, unknown> } = {}) {
  fake = new FakeRenderer();
  fake.realVideo = { seconds: 2, audio: true };
  env = await makeEnv({
    finalRenderer: fake,
    finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 },
    config: extra.gwr === false ? { watermarkRemover: 'off', ...extra.config } : { gwrCli: FAKE_CLI, watermarkRemover: 'auto', gwrTimeoutMs: 60_000, ...extra.config },
  });
  sc = await setupAllDone(env, { scenes: 2 });
}

/** v1: chọn điểm cắt → render → (xoá logo) → ready. */
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
const feedback = (id: number, text: string) => sc.user.post(`/api/final-cuts/${id}/feedback`, { feedback: text });
/** Góp ý → worker giả nhận job → trả kết quả. */
async function reviseVia(id: number, text: string, result: Record<string, unknown>) {
  const f = await feedback(id, text);
  expect(f.status, f.raw).toBe(201);
  const job = await claimEditPlan(sc);
  const done = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result });
  return { f, job, done, id: f.body.final_cut.id as number };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'autovideo-fb-'));
  process.env.FAKE_GWR_LOG = gwrLog();
  process.env.FAKE_GWR_MODE = 'ok';
  process.env.FAKE_GWR_HELP = 'ok';
  process.env.FAKE_GWR_FFMPEG = FFMPEG ?? 'ffmpeg';
});
afterEach(async () => {
  fake?.release();
  for (const k of ['FAKE_GWR_LOG', 'FAKE_GWR_MODE', 'FAKE_GWR_HELP', 'FAKE_GWR_FFMPEG']) delete process.env[k];
  await env?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

run('góp ý cho AI: tạo phiên bản mới + job edit_plan có payload.revision', () => {
  beforeEach(() => mk());

  it('phiên bản mới (parent_id, feedback, planning) + job edit_plan; bản cũ giữ nguyên; payload.revision đủ dữ liệu cho AI', async () => {
    const v1 = await readyV1();
    const before = { sha: sha(v1.video_path), status: v1.status };
    const r = await feedback(v1.id, '  Màu ấm hơn, tương phản cao hơn  ');
    expect(r.status, r.raw).toBe(201);
    expect(r.body.final_cut).toMatchObject({ version: 2, status: 'planning', parent_id: v1.id, parent_version: 1, feedback: 'Màu ấm hơn, tương phản cao hơn', grade: null, revision: null, edl: null, base_path: null });
    expect(['claude', 'agent']).toContain(r.body.final_cut.created_by);
    expect(r.body.job).toMatchObject({ type: 'edit_plan', status: 'queued', credits_cost: 0 });
    // bản cũ không đổi
    expect(await get(v1.id)).toMatchObject({ status: 'ready', version: 1, parent_id: null, feedback: null });
    expect(sha(v1.video_path)).toBe(before.sha);

    const job = await claimEditPlan(sc);
    const rev = job.payload.revision;
    expect(job.payload.final_cut_id).toBe(r.body.final_cut.id);
    expect(rev).toMatchObject({ parent_cut_id: v1.id, parent_version: 1, feedback: 'Màu ấm hơn, tương phản cao hơn', feedback_history: [], parent_grade: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature_k: 6500, vibrance: 0 } });
    expect(rev.parent_edl).toEqual(v1.edl);
    expect(rev.scenes.map((s: any) => [s.code, s.title, s.duration_s])).toEqual([['C1', 'Cảnh 1', 10], ['C2', 'Cảnh 2', 10]]);
    expect(rev.timeline).toEqual([
      { scene_id: sc.scenes[0].id, code: 'C1', out_start_s: 0, out_end_s: 1.6 },
      { scene_id: sc.scenes[1].id, code: 'C2', out_start_s: 1.6, out_end_s: 3.2 },
    ]);
    expect(rev.contact_sheet).toBe(v1.contact_sheet_path);
    expect(rev.grade_ranges.temperature_k).toEqual({ min: 4000, max: 9000, neutral: 6500, digits: 0 });
    expect(job.payload.scenes).toHaveLength(2); // vẫn có đủ dữ liệu video nguồn để AI xem khi cần đổi điểm cắt
  });

  it('chỉ góp ý được khi bản ready và không có bản nào đang chạy; góp ý 1–1000 ký tự', async () => {
    const v1 = await readyV1();
    for (const bad of ['', '   ', 'x'.repeat(1001)]) expect([bad.length, (await feedback(v1.id, bad)).status]).toEqual([bad.length, 400]);
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/feedback`, {})).status).toBe(400);
    expect((await feedback(v1.id, 'x'.repeat(1000))).status).toBe(201);
    const again = await feedback(v1.id, 'lần nữa');
    expect([again.status, again.body.error.code]).toEqual([409, 'FINAL_CUT_ACTIVE']);
    const planning = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body[0];
    const onPlanning = await feedback(planning.id, 'trên bản đang planning');
    expect([onPlanning.status, onPlanning.body.error.code]).toEqual([409, 'INVALID_STATE']);
    expect((await feedback(999999, 'x')).status).toBe(404);
  });

  it('bản còn logo Veo (tool xoá logo đang bật) phải xoá logo trước: 409 LOGO_NOT_REMOVED', async () => {
    const v1 = await readyV1();
    env.ctx.db.prepare('UPDATE final_cuts SET watermark_removed = 0 WHERE id = ?').run(v1.id);
    const r = await feedback(v1.id, 'ấm hơn');
    expect([r.status, r.body.error.code]).toEqual([409, 'LOGO_NOT_REMOVED']);
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { contrast: 1.1 } })).body.error.code).toBe('LOGO_NOT_REMOVED');
  });
});

run('revision chỉ đổi màu: KHÔNG render lại, KHÔNG xoá logo lại; chuỗi base không chỉnh chồng', () => {
  beforeEach(() => mk());

  it('v2 (chỉ màu): ready với grade, bản sạch `_base.mp4` là hard link của video sạch v1, bản cha không đổi, render/gwr không chạy thêm; summary + not_done lưu lại', async () => {
    const v1 = await readyV1();
    expect(fake.calls).toHaveLength(1);
    expect(removeCalls()).toHaveLength(1);
    const v1Sha = sha(v1.video_path);
    const { done, id } = await reviseVia(v1.id, 'màu ấm hơn, tương phản cao hơn, thêm nhạc nền', {
      edl: null,
      grade: { temperature_k: 7200, contrast: 1.15, hack: 'x' },
      summary: 'Nhiệt độ màu 6500K → 7200K; tương phản 1.00 → 1.15',
      not_done: ['Thêm nhạc nền (chưa hỗ trợ)'],
    });
    expect(done.status, done.raw).toBe(200);
    // chạy ngay sang bước chỉnh màu (không qua render/clean)
    await idle();
    const v2 = await get(id);
    expect(v2).toMatchObject({
      status: 'ready',
      stage: null,
      failed_stage: null,
      version: 2,
      parent_id: v1.id,
      progress: 100,
      watermark_removed: true,
      video_path: `${FINAL}/${SLUG}_final_v2.mp4`,
      base_path: `${FINAL}/${SLUG}_final_v2_base.mp4`,
      grade: { brightness: 0, contrast: 1.15, saturation: 1, gamma: 1, temperature_k: 7200, vibrance: 0 },
      grade_chips: ['Ấm 7200K', 'Tương phản 1.15'],
      revision: { kind: 'ai', edl_changed: false, summary: 'Nhiệt độ màu 6500K → 7200K; tương phản 1.00 → 1.15', not_done: ['Thêm nhạc nền (chưa hỗ trợ)'] },
      summary: 'Nhiệt độ màu 6500K → 7200K; tương phản 1.00 → 1.15',
    });
    expect(v2.edl).toEqual(v1.edl); // giữ nguyên điểm cắt
    expect(fake.calls).toHaveLength(1); // KHÔNG render lại
    expect(removeCalls()).toHaveLength(1); // KHÔNG xoá logo lại
    expect(ino(v2.base_path)).toBe(ino(v1.video_path)); // base = bản sạch của bản cha (hard link, không sao chép lại)
    expect(sha(v2.base_path)).toBe(v1Sha);
    expect(sha(v2.video_path)).not.toBe(v1Sha); // bản giao đã chỉnh màu
    expect(sha(v1.video_path)).toBe(v1Sha); // bản cha không bị đụng
    expect(Math.abs(v2.duration_s - v1.duration_s)).toBeLessThan(0.2);
    expect(v2.contact_sheet_url).toMatch(/_final_v2_contact\.png$/);
    expect(fs.existsSync(abs(v2.contact_sheet_path))).toBe(true);
    expect(fs.readdirSync(abs(FINAL)).filter((f) => f.includes('.tmp'))).toEqual([]);
    // bản mới nhất là v2, v1 vẫn còn trong danh sách với video của nó
    const list = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body;
    expect(list.map((c: any) => [c.version, c.status, c.parent_id])).toEqual([[2, 'ready', v1.id], [1, 'ready', null]]);
    // log.md ghi nhận chỉnh màu
    const logmd = fs.readFileSync(abs(`output/${SLUG}/log.md`), 'utf8');
    expect(logmd).toContain('đã chỉnh màu');
  });

  it('chuỗi v1 → v2 → v3: mỗi vòng AI thấy grade/góp ý trước; v3 chỉnh lại từ BẢN SẠCH v1 (không chỉnh chồng lên bản đã chỉnh màu của v2)', async () => {
    const v1 = await readyV1();
    const a = await reviseVia(v1.id, 'ấm hơn', { edl: null, grade: { temperature_k: 7100 }, summary: 'Ấm hơn: 6500K → 7100K', not_done: [] });
    expect(a.done.status).toBe(200);
    await idle();
    const v2 = await get(a.id);
    const b = await feedback(v2.id, 'ấm hơn nữa');
    expect(b.status, b.raw).toBe(201);
    const job = await claimEditPlan(sc);
    expect(job.payload.revision.parent_grade).toMatchObject({ temperature_k: 7100 });
    expect(job.payload.revision.feedback_history).toEqual([{ version: 2, kind: 'ai', feedback: 'ấm hơn', summary: 'Ấm hơn: 6500K → 7100K', not_done: [], grade_chips: ['Ấm 7100K'] }]);
    const done = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: null, grade: { temperature_k: 7700 }, summary: 'Ấm hơn nữa: 7100K → 7700K', not_done: [] } });
    expect(done.status, done.raw).toBe(200);
    await idle();
    const v3 = await get(b.body.final_cut.id);
    expect(v3).toMatchObject({ status: 'ready', parent_id: v2.id, parent_version: 2, base_path: `${FINAL}/${SLUG}_final_v3_base.mp4`, grade: { temperature_k: 7700 } });
    // base của v3 = bản sạch GỐC của v1 (không phải video đã chỉnh màu của v2)
    expect(ino(v3.base_path)).toBe(ino(v1.video_path));
    expect(ino(v3.base_path)).not.toBe(ino(v2.video_path));
    expect(sha(v3.base_path)).toBe(sha(v1.video_path));
    expect(sha(v3.video_path)).not.toBe(sha(v2.video_path));
    expect(fake.calls).toHaveLength(1);
    expect(removeCalls()).toHaveLength(1);
    // không bao giờ ghi đè: mọi file đều là của đúng version
    expect(fs.readdirSync(abs(FINAL)).filter((f) => f.endsWith('.mp4')).sort()).toEqual(
      [`${SLUG}_final_v1.mp4`, `${SLUG}_final_v1_raw.mp4`, `${SLUG}_final_v2.mp4`, `${SLUG}_final_v2_base.mp4`, `${SLUG}_final_v3.mp4`, `${SLUG}_final_v3_base.mp4`].sort(),
    );
  });

  it('EDL giống hệt bản cha = coi như null (không render lại); grade thiếu = giữ grade của bản cha; AI báo "không làm gì" vẫn ra một phiên bản', async () => {
    const v1 = await readyV1();
    const a = await reviseVia(v1.id, 'giữ nguyên điểm cắt', { edl: v1.edl, summary: 'Giữ nguyên điểm cắt và màu', not_done: [] });
    expect(a.done.status, a.done.raw).toBe(200);
    await idle();
    const v2 = await get(a.id);
    expect(v2).toMatchObject({ status: 'ready', revision: { edl_changed: false }, grade: null, base_path: null });
    expect(fake.calls).toHaveLength(1);
    // grade trung tính: bản giao là hard link của bản sạch, không chạy ffmpeg chỉnh màu
    expect(ino(v2.video_path)).toBe(ino(v1.video_path));
  });
});

run('revision đổi EDL: render → xoá logo → chỉnh màu (đúng thứ tự, chỉnh màu SAU xoá logo)', () => {
  beforeEach(() => mk());

  it('v2 đổi điểm cắt + màu: stage render → clean → grade → ready; bản sạch `_base` là kết quả xoá logo; bản giao là bản đã chỉnh màu', async () => {
    const v1 = await readyV1();
    const seen: string[] = [];
    const orig = env.ctx.sse.publish.bind(env.ctx.sse);
    env.ctx.sse.publish = (e: string, d: any, p: number | null) => {
      if (e === 'final_cut.updated' && d.final_cut.version === 2) seen.push(`${d.final_cut.status}/${d.final_cut.stage}`);
      orig(e, d, p);
    };
    env.ctx.sse.add({ writeHead() {}, write() {}, on() {}, end() {} } as any, sc.project.id);
    const f = await feedback(v1.id, 'cắt bớt đầu mỗi cảnh, màu ấm hơn');
    const job = await claimEditPlan(sc);
    const newEdl = edlFor(sc, v1, [0.4, 1.5]);
    const done = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: newEdl, grade: { temperature_k: 7000, saturation: 1.1 }, summary: 'Cắt đầu 0.4s; ấm 7000K', not_done: [] } });
    expect(done.status, done.raw).toBe(200);
    expect(await get(f.body.final_cut.id)).toMatchObject({ status: 'rendering', stage: 'render', revision: { edl_changed: true } });
    await idle();
    const v2 = await get(f.body.final_cut.id);
    expect(v2).toMatchObject({ status: 'ready', watermark_removed: true, raw_video_path: `${FINAL}/${SLUG}_final_v2_raw.mp4`, base_path: `${FINAL}/${SLUG}_final_v2_base.mp4`, video_path: `${FINAL}/${SLUG}_final_v2.mp4`, grade: { temperature_k: 7000, saturation: 1.1 } });
    expect(v2.edl.scenes[0].segments).toEqual([{ in_s: 0.4, out_s: 1.5 }]);
    const stages = seen.filter((s) => s.startsWith('rendering')).map((s) => s.split('/')[1]);
    expect(stages.indexOf('render')).toBeGreaterThanOrEqual(0);
    expect(stages.indexOf('clean')).toBeGreaterThan(stages.indexOf('render'));
    expect(stages.indexOf('grade')).toBeGreaterThan(stages.indexOf('clean'));
    expect(stages.lastIndexOf('render')).toBeLessThan(stages.indexOf('clean'));
    expect(seen.at(-1)).toBe('ready/null');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.out.videoAbs).toBe(abs(`${FINAL}/${SLUG}_final_v2_raw.mp4`)); // render ra bản raw (còn logo)
    expect(removeCalls()).toHaveLength(2);
    // xoá logo chạy trên bản raw và ghi ra BASE (không phải ra bản giao); bản giao sinh sau đó từ base
    expect(removeCalls()[1].argv[1]).toBe(abs(v2.raw_video_path));
    expect(removeCalls()[1].argv[3]).toContain(`.${SLUG}_final_v2_base.tmp.mp4`);
    expect(sha(v2.video_path)).not.toBe(sha(v2.base_path));
    expect(fs.readdirSync(abs(FINAL)).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(v2.contact_sheet_url).toMatch(/contact/);
  });

  it('tắt xoá logo: render ra thẳng `_base.mp4`, rồi chỉnh màu (không có _raw)', async () => {
    await env.close();
    await mk({ gwr: false });
    const v1 = await readyV1();
    expect(v1.watermark_removed).toBe(false);
    const f = await feedback(v1.id, 'cắt bớt, ấm hơn');
    expect(f.status, f.raw).toBe(201);
    const job = await claimEditPlan(sc);
    const done = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, v1, [0.3, 1.6]), grade: { contrast: 1.2 }, summary: 'x', not_done: [] } });
    expect(done.status, done.raw).toBe(200);
    await idle();
    const v2 = await get(f.body.final_cut.id);
    expect(v2).toMatchObject({ status: 'ready', raw_video_path: null, base_path: `${FINAL}/${SLUG}_final_v2_base.mp4`, watermark_removed: false });
    expect(fake.calls[1]!.out.videoAbs).toBe(abs(v2.base_path));
    expect(fs.existsSync(abs(`${FINAL}/${SLUG}_final_v2_raw.mp4`))).toBe(false);
  });
});

run('kiểm tra đầu ra của AI: sai → 400, job giữ nguyên', () => {
  beforeEach(() => mk());

  it('grade sai kiểu → 400 INVALID_GRADE; EDL sai → 400 INVALID_EDL; job vẫn claimed để worker sửa; sửa xong complete được', async () => {
    const v1 = await readyV1();
    const f = await feedback(v1.id, 'ấm hơn');
    const job = await claimEditPlan(sc);
    const bad = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: null, grade: { contrast: 'cao' }, summary: 's' } });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'INVALID_GRADE']);
    const badScene = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: null, grade: { scenes: [{ scene_id: 99999, gamma: 1.1 }] }, summary: 's' } });
    expect([badScene.status, badScene.body.error.code]).toEqual([400, 'INVALID_GRADE']);
    const badEdl = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: { scenes: [] }, grade: { contrast: 1.1 }, summary: 's' } });
    expect([badEdl.status, badEdl.body.error.code]).toEqual([400, 'INVALID_EDL']);
    expect(await get(f.body.final_cut.id)).toMatchObject({ status: 'planning' });
    expect((env.ctx.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string }).status).toBe('claimed');
    const ok = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: null, grade: { contrast: 9 }, summary: 'Tương phản kịch khung', not_done: [] } });
    expect(ok.status, ok.raw).toBe(200);
    await idle();
    expect((await get(f.body.final_cut.id)).grade).toMatchObject({ contrast: 1.5 }); // kẹp, không báo lỗi
  });

  it('thiếu summary → 400 (schema); job lỗi → bản mới failed, bản cha vẫn ready và vẫn góp ý lại được', async () => {
    const v1 = await readyV1();
    const f = await feedback(v1.id, 'ấm hơn');
    const job = await claimEditPlan(sc);
    expect((await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: null, grade: {} } })).status).toBe(400);
    const failed = await sc.worker.post(`/api/worker/jobs/${job.id}/fail`, { error: 'AI hỏng', error_code: 'X' });
    expect(failed.status, failed.raw).toBe(200);
    expect(await get(f.body.final_cut.id)).toMatchObject({ status: 'failed', error: 'AI hỏng', failed_stage: null });
    expect((await get(v1.id)).status).toBe('ready');
    expect((await feedback(v1.id, 'thử lại')).status).toBe(201);
  });
});

run('chỉnh màu tay (không AI)', () => {
  beforeEach(() => mk());

  it('POST /grade: phiên bản mới created_by=user, rendering/grade, KHÔNG job, KHÔNG render, KHÔNG xoá logo; kẹp giá trị; bỏ qua khoá lạ', async () => {
    const v1 = await readyV1();
    const jobsBefore = (env.ctx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
    const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { temperature_k: 5600, brightness: 5, saturation: 1.3 }, note: 'lạnh hơn cho giống bản gốc' });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.final_cut).toMatchObject({ version: 2, created_by: 'user', status: 'rendering', stage: 'grade', parent_id: v1.id, note: 'lạnh hơn cho giống bản gốc', grade: { temperature_k: 5600, brightness: 0.25, saturation: 1.3 } });
    await idle();
    const v2 = await get(r.body.final_cut.id);
    expect(v2).toMatchObject({ status: 'ready', revision: { kind: 'manual', edl_changed: false }, base_path: `${FINAL}/${SLUG}_final_v2_base.mp4`, job_id: null });
    expect(v2.revision.summary).toContain('Lạnh 5600K');
    expect((env.ctx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(jobsBefore);
    expect(fake.calls).toHaveLength(1);
    expect(removeCalls()).toHaveLength(1);
    expect(sha(v2.base_path)).toBe(sha(v1.video_path));
  });

  it('grade trung tính → bản giao là link của bản sạch (không chạy ffmpeg); grade sai → 400; cảnh lạ → 400; chỉnh theo cảnh lưu và chạy với enable', async () => {
    const v1 = await readyV1();
    const neutral = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: {} });
    expect(neutral.status, neutral.raw).toBe(201);
    await idle();
    const n = await get(neutral.body.final_cut.id);
    expect(n).toMatchObject({ status: 'ready', grade: null, base_path: null });
    expect(ino(n.video_path)).toBe(ino(v1.video_path));
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { gamma: 'x' } })).body.error.code).toBe('INVALID_GRADE');
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { scenes: [{ scene_id: 12345, gamma: 1.1 }] } })).body.error.code).toBe('INVALID_GRADE');
    const sceneOnly = await sc.user.post(`/api/final-cuts/${n.id}/grade`, { grade: { scenes: [{ scene_id: sc.scenes[1].id, brightness: 0.1 }] } });
    expect(sceneOnly.status, sceneOnly.raw).toBe(201);
    await idle();
    const s = await get(sceneOnly.body.final_cut.id);
    expect(s).toMatchObject({ status: 'ready', grade: { scenes: [{ scene_id: sc.scenes[1].id, brightness: 0.1 }] }, grade_chips: ['Riêng 1 cảnh'] });
    // base của bản chỉnh theo cảnh = bản sạch gốc v1 (qua chuỗi v1 → trung tính → s)
    expect(ino(s.base_path)).toBe(ino(v1.video_path));
  });

  it('chỉ chỉnh được bản ready, không khi đang có bản chạy', async () => {
    const v1 = await readyV1();
    expect((await feedback(v1.id, 'ấm hơn')).status).toBe(201); // v2 planning
    const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { contrast: 1.1 } });
    expect([r.status, r.body.error.code]).toEqual([409, 'FINAL_CUT_ACTIVE']);
    const planning = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body[0];
    expect((await sc.user.post(`/api/final-cuts/${planning.id}/grade`, { grade: {} })).body.error.code).toBe('INVALID_STATE');
  });
});

run('hủy giữa bước chỉnh màu, thử chỉnh màu lại, khởi động lại', () => {
  let slowFfmpeg: string;
  beforeEach(async () => {
    // ffmpeg bọc: bước chỉnh màu (có bộ lọc eq/colortemperature) chạy chậm 4 giây để hủy được giữa chừng; các lệnh khác chạy bình thường
    slowFfmpeg = path.join(tmp, 'ffmpeg-slow.sh');
    fs.writeFileSync(slowFfmpeg, `#!/bin/sh\ncase "$*" in *colortemperature*|*eq=*) sleep 4;; esac\nexec "${FFMPEG}" "$@"\n`, { mode: 0o755 });
    await mk({ config: { ffmpegPath: slowFfmpeg } });
  });

  it('hủy khi đang chỉnh màu → cancelled + failed_stage=grade, không còn file tạm/bản giao; bản sạch giữ; /regrade chạy lại RIÊNG bước chỉnh màu → ready', async () => {
    const v1 = await readyV1();
    const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { temperature_k: 7000 } });
    expect(r.status, r.raw).toBe(201);
    const id = r.body.final_cut.id as number;
    await waitFor(() => fs.existsSync(abs(`${FINAL}/${SLUG}_final_v2_base.mp4`)));
    expect(await get(id)).toMatchObject({ status: 'rendering', stage: 'grade' });
    const c = await sc.user.post(`/api/final-cuts/${id}/cancel`, {});
    expect(c.status, c.raw).toBe(200);
    expect(c.body.final_cut).toMatchObject({ status: 'cancelled', failed_stage: 'grade', stage: null });
    await idle();
    expect(fs.existsSync(abs(`${FINAL}/${SLUG}_final_v2.mp4`))).toBe(false);
    expect(fs.readdirSync(abs(FINAL)).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(fs.existsSync(abs(`${FINAL}/${SLUG}_final_v2_base.mp4`))).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(removeCalls()).toHaveLength(1);
    // thử lại: dùng ffmpeg thường
    env.ctx.config.ffmpegPath = FFMPEG!;
    const re = await sc.user.post(`/api/final-cuts/${id}/regrade`, {});
    expect(re.status, re.raw).toBe(200);
    expect(re.body.final_cut).toMatchObject({ status: 'rendering', stage: 'grade', failed_stage: null });
    await idle();
    expect(await get(id)).toMatchObject({ status: 'ready', base_path: `${FINAL}/${SLUG}_final_v2_base.mp4`, grade: { temperature_k: 7000 } });
    expect(fake.calls).toHaveLength(1);
    // bản ready không regrade được
    expect((await sc.user.post(`/api/final-cuts/${id}/regrade`, {})).body.error.code).toBe('INVALID_STATE');
  });

  it('khởi động lại giữa lúc chỉnh màu → failed + failed_stage=grade (dọn file tạm); lỗi ffmpeg → failed ở bước grade, bản cha nguyên vẹn', async () => {
    const v1 = await readyV1();
    const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade`, { grade: { contrast: 1.2 } });
    const id = r.body.final_cut.id as number;
    await waitFor(() => fs.existsSync(abs(`${FINAL}/${SLUG}_final_v2_base.mp4`)));
    await sc.user.post(`/api/final-cuts/${id}/cancel`, {});
    await idle();
    env.ctx.db.prepare("UPDATE final_cuts SET status = 'rendering', stage = 'grade', failed_stage = NULL WHERE id = ?").run(id);
    expect(recoverRenderingCuts(env.ctx)).toBe(1);
    expect(await get(id)).toMatchObject({ status: 'failed', failed_stage: 'grade', error: expect.stringContaining('chỉnh màu') });
    // ffmpeg hỏng
    env.ctx.config.ffmpegPath = path.join(tmp, 'ffmpeg-broken.sh');
    fs.writeFileSync(env.ctx.config.ffmpegPath, `#!/bin/sh\ncase "$1" in -version) exec "${FFMPEG}" "$@";; esac\necho boom >&2\nexit 3\n`, { mode: 0o755 });
    const re = await sc.user.post(`/api/final-cuts/${id}/regrade`, {});
    expect(re.status).toBe(200);
    await idle();
    expect(await get(id)).toMatchObject({ status: 'failed', failed_stage: 'grade', error: expect.stringContaining('Chỉnh màu thất bại') });
    expect((await get(v1.id)).status).toBe('ready');
  });
});

run('xem trước trước/sau', () => {
  beforeEach(() => mk());

  it('3 mốc thời gian, ảnh trước/sau khác nhau, phục vụ qua /files, cache theo hash grade (gọi lại không chạy lại), grade trung tính → sau = trước', async () => {
    const v1 = await readyV1();
    const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { temperature_k: 7800, contrast: 1.3 } });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.items).toHaveLength(3);
    expect(r.body.items.map((i: any) => i.t)).toEqual([0.3, 1, 1.7]);
    for (const it of r.body.items) {
      expect(it.before_url).toMatch(new RegExp(`^/files/output/${SLUG}/final/preview/v${v1.id}_t\\d_before\\.jpg$`));
      expect(it.after_url).toContain(`_${r.body.hash}.jpg`);
      const a = await sc.user.get(it.before_url);
      const b = await sc.user.get(it.after_url);
      expect([a.status, b.status]).toEqual([200, 200]);
    }
    const dir = abs(`${FINAL}/preview`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(6);
    expect(fs.readdirSync(dir).some((f) => f.includes('.tmp'))).toBe(false);
    expect(sha(`${FINAL}/preview/${files.find((f) => f.endsWith('_t1_before.jpg'))}`)).not.toBe(sha(`${FINAL}/preview/${files.find((f) => f.endsWith(`_t1_${r.body.hash}.jpg`))}`));
    // cache: lần hai không ghi lại file (mtime không đổi)
    const m1 = files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
    await new Promise((res) => setTimeout(res, 30));
    const r2 = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { contrast: 1.3, temperature_k: 7800 } });
    expect(r2.body.hash).toBe(r.body.hash);
    expect(fs.readdirSync(dir).sort().map((f) => fs.statSync(path.join(dir, f)).mtimeMs)).toEqual(m1);
    // grade khác → file mới, "trước" dùng lại
    const r3 = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { gamma: 0.8 } });
    expect(r3.body.hash).not.toBe(r.body.hash);
    expect(fs.readdirSync(dir)).toHaveLength(9);
    // trung tính
    const r4 = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: {} });
    const a = fs.readFileSync(abs(r4.body.items[0].before_url.replace('/files/', '')));
    const b = fs.readFileSync(abs(r4.body.items[0].after_url.replace('/files/', '')));
    expect(a.equals(b)).toBe(true);
    // ảnh nhỏ
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).size).toBeLessThan(60_000);
  });

  it('chặn: grade sai 400, bản chưa ready 409, bản không tồn tại 404; bộ nhớ đệm giới hạn số ảnh', async () => {
    const v1 = await readyV1();
    expect((await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { contrast: 'x' } })).body.error.code).toBe('INVALID_GRADE');
    expect((await sc.user.post(`/api/final-cuts/9999/grade-preview`, { grade: {} })).status).toBe(404);
    const f = await feedback(v1.id, 'ấm hơn');
    expect((await sc.user.post(`/api/final-cuts/${f.body.final_cut.id}/grade-preview`, { grade: {} })).body.error.code).toBe('INVALID_STATE');
    const { PREVIEW_CACHE_MAX_FILES } = await import('../src/services/final-render/grade-preview.js');
    expect(PREVIEW_CACHE_MAX_FILES).toBeLessThanOrEqual(200);
    // 20 grade khác nhau × 6 ảnh vượt trần → thư mục không phình quá trần
    await sc.worker.post(`/api/worker/jobs/${(await claim(sc)).id}/fail`, { error: 'bỏ', error_code: 'X' });
    for (let i = 0; i < 22; i++) {
      const r = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { contrast: 0.7 + i * 0.03 } });
      expect(r.status, r.raw).toBe(200);
    }
    expect(fs.readdirSync(abs(`${FINAL}/preview`)).length).toBeLessThanOrEqual(PREVIEW_CACHE_MAX_FILES);
  });
});

run('dự án trong thùng rác', () => {
  beforeEach(() => mk());

  it('xoá dự án (thùng rác) → feedback/grade/preview/regrade đều 404; file không phục vụ', async () => {
    const v1 = await readyV1();
    const pv = await sc.user.post(`/api/final-cuts/${v1.id}/grade-preview`, { grade: { contrast: 1.2 } });
    expect(pv.status).toBe(200);
    const del = await sc.user.del(`/api/projects/${sc.project.id}`, { confirm_name: sc.project.name });
    expect(del.status, del.raw).toBe(200);
    for (const tail of ['feedback', 'grade', 'grade-preview', 'regrade']) {
      const r = await sc.user.post(`/api/final-cuts/${v1.id}/${tail}`, { feedback: 'x', grade: {} });
      expect([tail, r.status]).toEqual([tail, 404]);
    }
    expect((await sc.user.get(pv.body.items[0].after_url)).status).toBe(404);
  });
});
