import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { descendants, killTree } from '../src/services/final-render/index.js';
import { FFMPEG, FFPROBE, FakeRenderer, ffprobeJson } from './final-helpers.js';
import { claimEditPlan, edlFor, makeEnv, setupAllDone, type Env, type Scenario } from './helpers.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-gwr.mjs', import.meta.url));
const TOOL_CWD = path.dirname(path.dirname(FAKE_CLI)); // cha của thư mục chứa script (giống "cha của bin/")
const SLUG = 'cacao-actiso-plus';
const MAIN = `output/${SLUG}/final/${SLUG}_final_v1.mp4`;
const RAW = `output/${SLUG}/final/${SLUG}_final_v1_raw.mp4`;

const run = FFMPEG && FFPROBE ? describe : describe.skip;

let env: Env;
let fake: FakeRenderer;
let tmp: string;
const logFile = () => path.join(tmp, 'gwr.log');
const calls = (): any[] => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const removeCalls = () => calls().filter((c) => c.argv[0] === 'remove');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function mk(extra: Partial<Parameters<typeof makeEnv>[0]> = {}, renderer = new FakeRenderer()) {
  fake = renderer;
  fake.realVideo = { seconds: 2, audio: true };
  env = await makeEnv({
    finalRenderer: fake,
    finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50, ...extra.finalRender },
    ...extra,
    config: { gwrCli: FAKE_CLI, watermarkRemover: 'auto', gwrTimeoutMs: 60_000, ...extra.config },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-gwr-'));
  process.env.FAKE_GWR_LOG = logFile();
  process.env.FAKE_GWR_MODE = 'ok';
  process.env.FAKE_GWR_HELP = 'ok';
  process.env.FAKE_GWR_CHILD_PID = path.join(tmp, 'child.pid');
  process.env.FAKE_GWR_FFMPEG = FFMPEG ?? 'ffmpeg';
});
afterEach(async () => {
  fake?.release();
  for (const k of ['FAKE_GWR_LOG', 'FAKE_GWR_MODE', 'FAKE_GWR_HELP', 'FAKE_GWR_CHILD_PID', 'FAKE_GWR_FFMPEG']) delete process.env[k];
  await env?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Tới bước ready/failed: chọn video → edit_plan → EDL → render nền (và xoá logo nếu bật). */
async function planAndRender(sc: Scenario) {
  const job = await claimEditPlan(sc);
  const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
  const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut, [0.2, 1.8]), summary: 'Cắt đầu cuối.' } });
  expect(r.status, r.raw).toBe(200);
  await env.ctx.finalRender!.idle();
  return (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
}
const get = async (sc: Scenario, id: number) => (await sc.user.get(`/api/final-cuts/${id}`)).body;

run('xoá logo Veo (CLI giả)', () => {
  it('render → clean → ready: bản raw còn logo + bản sạch hiển thị; stage/progress riêng từng bước; log.md ghi "đã xoá logo Veo"', async () => {
    await mk({ config: { gwrVideoBitrateMbps: 8 } });
    const sc = await setupAllDone(env, { scenes: 2 });
    const seen: { stage: string | null; progress: number | null; status: string }[] = [];
    const orig = env.ctx.sse.publish.bind(env.ctx.sse);
    env.ctx.sse.publish = (e: string, d: any, p: number | null) => {
      if (e === 'final_cut.updated') seen.push({ stage: d.final_cut.stage, progress: d.final_cut.progress, status: d.final_cut.status });
      orig(e, d, p);
    };
    env.ctx.sse.add({ writeHead() {}, write() {}, on() {}, end() {} } as any, sc.project.id);

    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({
      status: 'ready',
      stage: null,
      failed_stage: null,
      watermark_removed: true,
      video_path: MAIN,
      video_url: `/files/${MAIN}`,
      raw_video_path: RAW,
      raw_video_url: `/files/${RAW}`,
      renderer: 'ffmpeg',
      progress: 100,
      error: null,
    });
    expect(cut.watermark_meta).toMatchObject({ kind: 'video', meta: { status: 'processed', denoiseBackend: 'fake', actualControls: { videoBitrateMbps: 8 } } });
    // hai file: raw (bản render) và bản sạch (tên chính); không còn file tạm
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(true);
    expect(fs.existsSync(path.join(env.root, MAIN))).toBe(true);
    expect(fs.readdirSync(path.join(env.root, 'output', SLUG, 'final')).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(Math.abs(cut.duration_s - 2)).toBeLessThan(0.3); // FakeRenderer ghi video 2 giây
    expect(cut.contact_sheet_url).toBe(`/files/output/${SLUG}/final/${SLUG}_final_v1_contact.png`);
    // CLI: lệnh, cwd, tham số
    const [c] = removeCalls();
    expect(removeCalls()).toHaveLength(1);
    expect(c.cwd).toBe(fs.realpathSync(TOOL_CWD));
    expect(c.argv.slice(0, 5)).toEqual(['remove', path.join(env.root, RAW), '--output', path.join(env.root, `output/${SLUG}/final/.${SLUG}_final_v1.tmp.mp4`), '--json']);
    expect(c.argv).toEqual(expect.arrayContaining(['--video-bitrate-mbps', '8', '--video-timeout-ms', '60000']));
    // renderer ghi ra bản raw, không phải tên chính
    expect(fake.calls[0]!.out.videoAbs).toBe(path.join(env.root, RAW));
    // stage: render (0→…) rồi clean (0→…); progress riêng từng bước
    const stages = seen.filter((s) => s.status === 'rendering').map((s) => s.stage);
    expect(stages).toEqual([...stages].sort((a, b) => (a === b ? 0 : a === 'render' ? -1 : 1))); // render trước, clean sau
    expect(new Set(stages)).toEqual(new Set(['render', 'clean']));
    const prog = (st: string) => seen.filter((s) => s.stage === st && s.progress !== null).map((s) => s.progress);
    expect(prog('render')).toEqual([0, 25, 50, 90]);
    expect(prog('clean')[0]).toBe(0);
    expect(prog('clean').slice(1)).toEqual([25, 50, 74, 99]);
    expect(seen.at(-1)).toEqual({ stage: null, progress: 100, status: 'ready' });
    // log.md + event
    const log = fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8');
    expect(log).toContain('| FINAL | v1 | bản dựng (ffmpeg, cắt thẳng; đã xoá logo Veo) | Cắt đầu cuối. | Sẵn sàng |');
    expect((await sc.user.get(`/api/projects/${sc.project.id}/log.md`)).raw).toContain('bản dựng (ffmpeg, cắt thẳng; đã xoá logo Veo)');
    const ev = (await sc.user.get(`/api/projects/${sc.project.id}/events`)).body.find((e: any) => e.type === 'final_cut.ready');
    expect(ev.message).toContain('đã xoá logo Veo');
    expect((await sc.user.get(`/api/projects/${sc.project.id}`)).body.latest_final_cut).toMatchObject({ status: 'ready', stage: null, failed_stage: null, watermark_removed: true, url: `/files/${MAIN}` });
  });

  it('tool lỗi (exit 1): failed, failed_stage=clean, giữ raw, KHÔNG có bản chính; /clean chạy lại riêng bước xoá logo (không render lại)', async () => {
    await mk();
    process.env.FAKE_GWR_MODE = 'fail';
    const sc = await setupAllDone(env, { scenes: 1 });
    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'failed', failed_stage: 'clean', stage: null, watermark_removed: false, video_path: null, video_url: null, raw_video_path: RAW, raw_video_url: `/files/${RAW}` });
    expect(cut.error).toMatch(/^Xoá logo Veo thất bại: tool thoát với mã 1: .*Chromium launch failed/);
    expect(cut.error.length).toBeLessThan(400);
    expect(cut.error).not.toContain('[video] 10%'); // dòng tiến độ bị lược
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(true);
    expect(fs.existsSync(path.join(env.root, MAIN))).toBe(false);
    expect(fs.readdirSync(path.join(env.root, 'output', SLUG, 'final')).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    const p = (await sc.user.get(`/api/projects/${sc.project.id}`)).body;
    expect(p.latest_final_cut).toMatchObject({ status: 'failed', failed_stage: 'clean', url: null, watermark_removed: false });
    expect(fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8')).not.toContain('FINAL');

    process.env.FAKE_GWR_MODE = 'ok';
    const r = await sc.user.post(`/api/final-cuts/${cut.id}/clean`, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.final_cut).toMatchObject({ status: 'rendering', stage: 'clean', failed_stage: null, progress: 0, error: null, video_path: null, raw_video_path: RAW });
    await env.ctx.finalRender!.idle();
    const done = await get(sc, cut.id);
    expect(done).toMatchObject({ status: 'ready', watermark_removed: true, video_path: MAIN, raw_video_path: RAW, error: null, failed_stage: null });
    expect(fake.calls).toHaveLength(1); // KHÔNG render lại
    expect(removeCalls()).toHaveLength(2);
    expect(fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8')).toContain('| FINAL | v1 | xoá logo Veo | Bản dựng v1 đã xoá logo Veo (bản gốc còn logo: cacao-actiso-plus_final_v1_raw.mp4) | Sẵn sàng |');
    expect((await sc.user.post(`/api/final-cuts/${cut.id}/clean`, {})).body.error.code).toBe('INVALID_STATE'); // đã sạch rồi
  });

  it('quá thời gian: server dừng tool và cả cây con, failed ở bước clean', async () => {
    await mk({ config: { gwrTimeoutMs: 300 } });
    process.env.FAKE_GWR_MODE = 'hang';
    const sc = await setupAllDone(env, { scenes: 1 });
    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'failed', failed_stage: 'clean' });
    expect(cut.error).toContain('Quá thời gian xoá logo Veo');
    const childPid = Number(fs.readFileSync(process.env.FAKE_GWR_CHILD_PID!, 'utf8'));
    await waitFor(() => !alive(childPid) && !alive(removeCalls()[0].pid), 6000);
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(true);
  });

  it('hủy khi đang xoá logo: dừng cả cây tiến trình (node + "chromium"), xóa file tạm, bản cancelled giữ raw; retry /clean từ bản cancelled', async () => {
    await mk();
    process.env.FAKE_GWR_MODE = 'hang';
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const c = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, c, [0.2, 1.8]), summary: 's' } });
    await waitFor(() => fs.existsSync(process.env.FAKE_GWR_CHILD_PID!) && removeCalls().length === 1);
    const childPid = Number(fs.readFileSync(process.env.FAKE_GWR_CHILD_PID!, 'utf8'));
    const nodePid = removeCalls()[0].pid;
    expect(alive(childPid) && alive(nodePid)).toBe(true);
    expect(descendants(process.pid)).toContain(childPid);
    expect(await get(sc, c.id)).toMatchObject({ status: 'rendering', stage: 'clean', video_url: null });
    fs.writeFileSync(path.join(env.root, `output/${SLUG}/final/.${SLUG}_final_v1.tmp.mp4`), 'dở'); // file tạm dở

    const cancel = await sc.user.post(`/api/final-cuts/${c.id}/cancel`, {});
    expect(cancel.body.final_cut).toMatchObject({ status: 'cancelled', stage: null, failed_stage: 'clean', raw_video_path: RAW });
    await env.ctx.finalRender!.idle();
    await waitFor(() => !alive(childPid) && !alive(nodePid), 6000);
    expect(fs.existsSync(path.join(env.root, `output/${SLUG}/final/.${SLUG}_final_v1.tmp.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(true);
    expect(fs.existsSync(path.join(env.root, MAIN))).toBe(false);
    const after = await get(sc, c.id);
    expect(after).toMatchObject({ status: 'cancelled', video_path: null });
    // thử xoá logo lại từ bản đã hủy giữa chừng
    process.env.FAKE_GWR_MODE = 'ok';
    expect((await sc.user.post(`/api/final-cuts/${c.id}/clean`, {})).status).toBe(200);
    await env.ctx.finalRender!.idle();
    expect(await get(sc, c.id)).toMatchObject({ status: 'ready', watermark_removed: true });
  });

  it('hủy khi đang render (trước bước xoá logo) vẫn dọn bản raw dở và không chạy tool', async () => {
    await mk();
    fake.hold();
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const c = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, c, [0.2, 1.8]), summary: 's' } });
    await waitFor(() => fake.calls.length === 1);
    expect(await get(sc, c.id)).toMatchObject({ status: 'rendering', stage: 'render' });
    await sc.user.post(`/api/final-cuts/${c.id}/cancel`, {});
    await env.ctx.finalRender!.idle();
    expect(await get(sc, c.id)).toMatchObject({ status: 'cancelled', failed_stage: null, raw_video_path: null });
    expect(removeCalls()).toHaveLength(0);
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(false);
  });

  it.each([
    ['short', /lệch quá 0,25s/],
    ['noaudio', /mất âm thanh/],
    ['missing', /tool không tạo ra file kết quả/],
    ['empty', /tool không tạo ra file kết quả/],
  ])('kết quả sai (%s): bị từ chối trước khi đổi tên, không để lại bản chính/file tạm', async (mode, re) => {
    await mk();
    process.env.FAKE_GWR_MODE = mode;
    const sc = await setupAllDone(env, { scenes: 1 });
    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'failed', failed_stage: 'clean', video_path: null, raw_video_path: RAW });
    expect(cut.error).toMatch(/^Xoá logo Veo thất bại: /);
    expect(cut.error).toMatch(re);
    expect(fs.existsSync(path.join(env.root, MAIN))).toBe(false);
    expect(fs.readdirSync(path.join(env.root, 'output', SLUG, 'final')).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('thời lượng lệch trong ngưỡng 0,25 giây thì chấp nhận (tool copy nguyên)', async () => {
    await mk();
    const sc = await setupAllDone(env, { scenes: 1 });
    expect((await planAndRender(sc)).status).toBe('ready');
  });

  it('WATERMARK_REMOVER=off: bỏ bước clean — video_path = bản render, watermark_removed=0, tool không được gọi; /clean → 409 WATERMARK_REMOVER_UNAVAILABLE', async () => {
    await mk({ config: { watermarkRemover: 'off' } });
    const sc = await setupAllDone(env, { scenes: 1 });
    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'ready', watermark_removed: false, video_path: MAIN, raw_video_path: null, raw_video_url: null, stage: null });
    expect(fake.calls[0]!.out.videoAbs).toBe(path.join(env.root, MAIN));
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(false);
    expect(calls()).toEqual([]); // không gọi tool (kể cả --help)
    expect(fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8')).toContain('| FINAL | v1 | bản dựng (ffmpeg, cắt thẳng) |');
    const r = await sc.user.post(`/api/final-cuts/${cut.id}/clean`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('WATERMARK_REMOVER_UNAVAILABLE');
    expect(r.body.error.message).toContain('WATERMARK_REMOVER=off');
    expect(await get(sc, cut.id)).toMatchObject({ status: 'ready', video_path: MAIN, raw_video_path: null }); // không đụng gì
    expect((await sc.user.get('/api/meta')).body.watermark_remover).toMatchObject({ mode: 'off', active: false, cli: FAKE_CLI });
  });

  it('bản ready cũ (chưa có raw, còn logo): /clean đổi tên <slug>_final_v1.mp4 → _raw.mp4 (nguyên tử, cập nhật DB) rồi xoá logo ra tên chính', async () => {
    await mk({ config: { watermarkRemover: 'off' } }); // tạo bản "cũ": render thẳng ra tên chính, còn logo
    const sc = await setupAllDone(env, { scenes: 1 });
    const old = await planAndRender(sc);
    expect(old).toMatchObject({ status: 'ready', watermark_removed: false, raw_video_path: null, video_path: MAIN });
    const original = fs.readFileSync(path.join(env.root, MAIN));
    const mtime = fs.statSync(path.join(env.root, MAIN)).mtimeMs;

    // khởi động lại với tool xoá logo bật
    const app2 = await env.second({ config: { watermarkRemover: 'auto' }, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 } });
    const user2 = (await import('./helpers.js')).userClient(app2);
    expect((await user2.get('/api/meta')).body.watermark_remover).toMatchObject({ mode: 'auto', active: true, reason: 'Tự động: tool xoá logo Veo sẵn sàng' });
    const r = await user2.post(`/api/final-cuts/${old.id}/clean`, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.final_cut).toMatchObject({ status: 'rendering', stage: 'clean', video_path: null, raw_video_path: RAW, video_url: null, raw_video_url: `/files/${RAW}` });
    // bản cũ đã được đổi tên (nội dung và mtime nguyên vẹn)
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(true);
    expect(fs.readFileSync(path.join(env.root, RAW)).equals(original)).toBe(true);
    expect(fs.statSync(path.join(env.root, RAW)).mtimeMs).toBe(mtime);
    await app2.ctx.finalRender!.idle();
    const done = (await user2.get(`/api/final-cuts/${old.id}`)).body;
    expect(done).toMatchObject({ status: 'ready', watermark_removed: true, video_path: MAIN, raw_video_path: RAW, stage: null, renderer: 'ffmpeg', contact_sheet_path: old.contact_sheet_path });
    expect(fs.existsSync(path.join(env.root, MAIN))).toBe(true);
    expect(removeCalls()[0]!.argv[1]).toBe(path.join(env.root, RAW)); // đầu vào là bản raw vừa đổi tên
    expect(fake.calls).toHaveLength(1); // không render lại
    expect(done.watermark_meta).toMatchObject({ kind: 'video' });
  });

  it('/clean: 404; trạng thái không hợp lệ → 409 INVALID_STATE; raw đã tồn tại → 409 RAW_EXISTS (không đụng bản cũ); thiếu file → 409 FILE_MISSING', async () => {
    await mk({ config: { watermarkRemover: 'off' } });
    const sc = await setupAllDone(env, { scenes: 1 });
    const planning = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body[0];
    expect((await sc.user.post('/api/final-cuts/999/clean', {})).status).toBe(404);
    const app2 = await env.second({ config: { watermarkRemover: 'auto' }, finalRender: { progressThrottleMs: 0, checkTtlMs: 0 } });
    const u2 = (await import('./helpers.js')).userClient(app2);
    expect((await u2.post(`/api/final-cuts/${planning.id}/clean`, {})).body.error.code).toBe('INVALID_STATE'); // đang planning
    const cut = await planAndRender(sc);
    fs.writeFileSync(path.join(env.root, RAW), 'ai đó đã tạo');
    const clash = await u2.post(`/api/final-cuts/${cut.id}/clean`, {});
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('RAW_EXISTS');
    expect(fs.existsSync(path.join(env.root, MAIN))).toBe(true); // bản cũ nguyên vẹn
    expect(await get(sc, cut.id)).toMatchObject({ status: 'ready', video_path: MAIN, raw_video_path: null });
    fs.rmSync(path.join(env.root, RAW));
    fs.rmSync(path.join(env.root, MAIN));
    expect((await u2.post(`/api/final-cuts/${cut.id}/clean`, {})).body.error.code).toBe('FILE_MISSING');
    expect(await get(sc, cut.id)).toMatchObject({ status: 'ready' });
  });

  it('server khởi động lại giữa lúc xoá logo: failed (failed_stage=clean, raw còn, dọn file tạm); giữa lúc render: failed_stage=render', async () => {
    await mk();
    const sc = await setupAllDone(env, { scenes: 2 });
    const [c1] = (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body;
    fs.mkdirSync(path.join(env.root, 'output', SLUG, 'final'), { recursive: true });
    fs.writeFileSync(path.join(env.root, RAW), 'raw');
    fs.writeFileSync(path.join(env.root, `output/${SLUG}/final/.${SLUG}_final_v1.tmp.mp4`), 'tạm');
    env.ctx.db.prepare("UPDATE final_cuts SET status = 'rendering', stage = 'clean', raw_video_path = ?, progress = 40 WHERE id = ?").run(RAW, c1.id);
    const app2 = await env.second();
    const row = app2.ctx.db.prepare('SELECT status, stage, failed_stage, error, raw_video_path FROM final_cuts WHERE id = ?').get(c1.id) as any;
    expect(row).toMatchObject({ status: 'failed', stage: null, failed_stage: 'clean', raw_video_path: RAW });
    expect(row.error).toBe('Server khởi động lại trong lúc xoá logo Veo; bấm Thử xoá logo lại');
    expect(fs.existsSync(path.join(env.root, `output/${SLUG}/final/.${SLUG}_final_v1.tmp.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(env.root, RAW))).toBe(true);
    // đang render
    const c2 = await sc.user.post(`/api/projects/${sc.project.id}/final-cuts`, {});
    app2.ctx.db.prepare("UPDATE final_cuts SET status = 'rendering', stage = 'render' WHERE id = ?").run(c2.body.final_cut.id);
    const app3 = await env.second();
    expect(app3.ctx.db.prepare('SELECT status, failed_stage, error FROM final_cuts WHERE id = ?').get(c2.body.final_cut.id)).toEqual({
      status: 'failed',
      failed_stage: 'render',
      error: 'Server khởi động lại trong lúc render; bấm Render lại',
    });
  });

  it('rerender (người dùng chỉnh EDL) đi qua đủ render → xoá logo', async () => {
    await mk();
    const sc = await setupAllDone(env, { scenes: 1 });
    const v1 = await planAndRender(sc);
    const r = await sc.user.post(`/api/final-cuts/${v1.id}/rerender`, { edl: edlFor(sc, v1, [0.3, 1.5]), note: 'chỉnh tay' });
    expect(r.status).toBe(201);
    expect(r.body.final_cut).toMatchObject({ version: 2, status: 'rendering', stage: 'render' });
    await env.ctx.finalRender!.idle();
    const v2 = await get(sc, r.body.final_cut.id);
    expect(v2).toMatchObject({
      status: 'ready',
      watermark_removed: true,
      video_path: `output/${SLUG}/final/${SLUG}_final_v2.mp4`,
      raw_video_path: `output/${SLUG}/final/${SLUG}_final_v2_raw.mp4`,
      created_by: 'user',
    });
    expect(removeCalls()).toHaveLength(2);
    expect(await get(sc, v1.id)).toMatchObject({ status: 'ready', video_path: MAIN }); // bản cũ nguyên vẹn
  });

  it('đường dẫn raw hoặc chính đã bị chiếm → render báo lỗi, không ghi đè', async () => {
    await mk();
    const sc = await setupAllDone(env, { scenes: 1 });
    fs.mkdirSync(path.join(env.root, 'output', SLUG, 'final'), { recursive: true });
    fs.writeFileSync(path.join(env.root, RAW), 'ai đó vừa tạo');
    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'failed', failed_stage: 'render' });
    expect(cut.error).toContain('không ghi đè');
    expect(fs.readFileSync(path.join(env.root, RAW), 'utf8')).toBe('ai đó vừa tạo');
  });

  it('version kế tiếp tính cả file _raw trên đĩa', async () => {
    await mk();
    fs.mkdirSync(path.join(env.root, 'output', SLUG, 'final'), { recursive: true });
    fs.writeFileSync(path.join(env.root, `output/${SLUG}/final/${SLUG}_final_v4_raw.mp4`), 'x');
    const sc = await setupAllDone(env, { scenes: 1 });
    expect((await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body[0].version).toBe(5);
  });
});

describe('GET /api/meta → watermark_remover', () => {
  it('auto + tool chạy được → active; chưa cấu hình / thiếu file / --help lỗi → không active kèm lý do', async () => {
    await mk();
    expect((await (await import('./helpers.js')).userClient(env.app).get('/api/meta')).body.watermark_remover).toEqual({
      mode: 'auto',
      active: true,
      reason: 'Tự động: tool xoá logo Veo sẵn sàng',
      cli: FAKE_CLI,
    });
    await env.close();

    await mk({ config: { gwrCli: null } });
    expect(await env.ctx.finalRender!.watermarkStatus(true)).toMatchObject({ mode: 'auto', active: false, reason: 'Chưa cấu hình GWR_CLI: không xoá logo Veo', cli: null });
    await env.close();

    await mk({ config: { gwrCli: '/khong/co/gwr.mjs' } });
    expect((await env.ctx.finalRender!.watermarkStatus(true)).reason).toContain('Không thấy tool xoá logo Veo');
    await env.close();

    await mk({ config: { gwrCli: 'tuong-doi/gwr.mjs' } });
    expect((await env.ctx.finalRender!.watermarkStatus(true)).reason).toBe('GWR_CLI phải là đường dẫn tuyệt đối');
    await env.close();

    process.env.FAKE_GWR_HELP = 'fail';
    await mk();
    const st = await env.ctx.finalRender!.watermarkStatus(true);
    expect(st).toMatchObject({ active: false });
    expect(st.reason).toContain('Tool xoá logo Veo không chạy được');
  });

  it('không có tool → bản dựng vẫn ready ngay (như tắt) với watermark_removed=false', async () => {
    await mk({ config: { gwrCli: null } });
    const sc = await setupAllDone(env, { scenes: 1 });
    const cut = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'ready', watermark_removed: false, video_path: MAIN });
  });
});

describe('killTree', () => {
  it('dừng tiến trình và mọi tiến trình con cháu', async () => {
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const childPid = await new Promise<number>((resolve) => parent.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    expect(descendants(parent.pid!)).toContain(childPid);
    killTree(parent.pid!);
    await waitFor(() => !alive(parent.pid!) && !alive(childPid), 6000);
    expect(ffprobeJson).toBeTypeOf('function');
  });
});
