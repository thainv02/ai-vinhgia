import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE, FakeRenderer } from './final-helpers.js';
import { workerClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan, type LanPlanFixture } from './helpers-lan-plan.js';
import { clip } from './helpers-video.js';

/**
 * Hiển thị xếp hàng cho người dùng LAN: vị trí chờ worker AI (edit_plan) và vị trí/số việc đang chạy trong hàng đợi render song song,
 * cho bản dựng và việc xoá logo. API chỉ THÊM trường; `queue_ahead` (cũ) vẫn còn.
 */
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-gwr.mjs', import.meta.url));
const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c: LanClient;
let fake: FakeRenderer;
let tmp: string;
const db = () => L.env.ctx.db;
const rf = () => L.env.ctx.finalRender!;
const worker = () => workerClient(L.env.app);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await tick(10);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function mk(concurrency: number, wm: 'auto' | 'off' = 'off') {
  fake = new FakeRenderer();
  fake.gateEach = true;
  L = await makeLanEnv({
    app: { finalRenderer: fake, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50, queueNotifyMs: 0 } },
    config: { renderConcurrency: concurrency, gwrCli: FAKE_CLI, watermarkRemover: wm, gwrTimeoutMs: 60_000 },
  });
  c = L.client({ ip: '192.168.1.31' });
  await c.login();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'autovideo-lanqueue-'));
  process.env.FAKE_GWR_LOG = path.join(tmp, 'gwr.log');
  process.env.FAKE_GWR_MODE = 'ok';
  process.env.FAKE_GWR_HELP = 'ok';
  process.env.FAKE_GWR_CHILD_PID = path.join(tmp, 'child.pid');
  process.env.FAKE_GWR_FFMPEG = FFMPEG ?? 'ffmpeg';
});
afterEach(async () => {
  fake?.release();
  for (const k of ['FAKE_GWR_LOG', 'FAKE_GWR_MODE', 'FAKE_GWR_HELP', 'FAKE_GWR_CHILD_PID', 'FAKE_GWR_FFMPEG']) delete process.env[k];
  await L?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

run('bản dựng LAN: chờ AI rồi chờ render', () => {
  let fx: LanPlanFixture;
  const cutsUrl = (tail = '') => `/lan/api/plans/${fx.plan.id}/final-cuts${tail}`;
  const edlFrom = (cut: any) => ({
    scenes: cut.selection.map((s: any) => ({ scene_id: s.scene_id, asset_id: s.asset_id, segments: [{ in_s: 0.3, out_s: 2.5 }], removed: [], note: '' })),
  });

  it('planning: ai_queue có vị trí trong hàng đợi worker (không lộ id job/dự án khác), cập nhật khi worker nhận job trước, rồi "AI đang chọn" khi nhận chính nó', async () => {
    await mk(2);
    fx = await makeLanPlan(L, c, 1);
    expect((await c.uploadVideo(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, { name: 'a.mp4', data: clip(3) })).status).toBe(201);
    // một yêu cầu phân tích của người khác đến TRƯỚC khi bấm dựng → đứng trước edit_plan trong hàng đợi worker
    const other = (await c.post('/lan/api/plans', { name: 'Của người khác', created_by_name: 'B', brief: 'b' })).body.plan;
    const cb = L.client({ ip: '192.168.1.32' });
    await cb.login();
    expect((await cb.post(`/lan/api/plans/${other.id}/analyze`, {})).status).toBe(201);

    const built = await c.post(cutsUrl(), {});
    expect(built.status, built.raw).toBe(201);
    const id = built.body.final_cut.id as number;
    const get = async () => (await c.get(cutsUrl(`/${id}`))).body;
    // worker chưa từng nhận request → offline (đã dùng để dựng kế hoạch rồi im lặng)
    L.env.clock.advance((L.env.ctx.config.workerOnlineSeconds + 1) * 1000);
    expect(await get()).toMatchObject({
      status: 'planning',
      queue_state: null,
      queue_position: null,
      queue_ahead: null,
      ai_queue: { state: 'waiting', position: 2, ahead: 1, running: null, worker: { online: false, paused: false }, wait_reason: null },
    });
    expect(Object.keys((await get()).ai_queue).sort()).toEqual(['ahead', 'position', 'running', 'state', 'wait_reason', 'worker']); // không có job_id, dự án...
    expect(built.body.final_cut.ai_queue).toMatchObject({ state: 'waiting', position: 2 });
    // danh sách cũng có
    expect((await c.get(cutsUrl())).body[0].ai_queue).toMatchObject({ position: 2 });

    // worker nhận job phân tích của người khác: bản dựng này lên vị trí 1, worker bận với một job KHÁC
    const j1 = await worker().get('/api/worker/next?worker=w1');
    expect(j1.body.type).toBe('analyze_brief');
    expect((await get()).ai_queue).toMatchObject({ state: 'waiting', position: 1, ahead: 0, running: { type: 'analyze_brief', own: false }, worker: { online: true } });
    await worker().post(`/api/worker/jobs/${j1.body.id}/fail`, { error: 'x', code: 'OTHER' });

    // worker nhận edit_plan của mình
    const j2 = await worker().get('/api/worker/next?worker=w1');
    expect(j2.body.type).toBe('edit_plan');
    expect((await get()).ai_queue).toMatchObject({ state: 'running', position: null, ahead: 0, running: { type: 'edit_plan', own: true } });

    // AI gửi điểm cắt: hết ai_queue; bản dựng vào hàng đợi render (đang chạy ngay vì còn chỗ)
    const done = await worker().post(`/api/worker/jobs/${j2.body.id}/complete`, { result: { edl: edlFrom(built.body.final_cut), summary: 's' } });
    expect(done.status, done.raw).toBe(200);
    await waitFor(() => fake.started.includes(id));
    expect(await get()).toMatchObject({ status: 'rendering', ai_queue: null, queue_state: 'running', queue_position: null, running_count: 1, concurrency: 2, queue_ahead: 0 });
  });

  it('rendering mà chưa bắt đầu: queue_state=waiting, vị trí, số việc đang chạy/tối đa; queue_ahead cũ = running_count + vị trí; bắt đầu khi có chỗ', async () => {
    await mk(2);
    fx = await makeLanPlan(L, c, 1);
    await c.uploadVideo(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, { name: 'a.mp4', data: clip(3) });
    // hai việc LAN khác chiếm cả hai chỗ trước
    const gates: (() => void)[] = [];
    for (const id of [101, 102]) rf().enqueueTool(id, (abort) => new Promise<void>((resolve) => {
      gates.push(resolve);
      abort.signal.addEventListener('abort', () => resolve());
    }));
    const built = await c.post(cutsUrl(), {});
    const job = await worker().get('/api/worker/next?worker=w1');
    expect(job.body.type).toBe('edit_plan');
    expect((await worker().post(`/api/worker/jobs/${job.body.id}/complete`, { result: { edl: edlFrom(built.body.final_cut), summary: 's' } })).status).toBe(200);
    const id = built.body.final_cut.id as number;
    const get = async () => (await c.get(cutsUrl(`/${id}`))).body;
    expect(await get()).toMatchObject({ status: 'rendering', stage: 'render', progress: null, queue_state: 'waiting', queue_position: 1, running_count: 2, concurrency: 2, queue_ahead: 3, ai_queue: null });
    expect(fake.started).toEqual([]);
    gates[0]!(); // một chỗ trống → bản dựng bắt đầu
    await waitFor(() => fake.started.includes(id));
    expect(await get()).toMatchObject({ queue_state: 'running', queue_position: null, running_count: 2, queue_ahead: 0 });
    fake.release();
    gates[1]!();
    await rf().idle();
    expect(await get()).toMatchObject({ status: 'ready', queue_state: null, queue_position: null, running_count: null, concurrency: null, queue_ahead: null });
  });
});

run('việc xoá logo LAN trong hàng đợi render song song', () => {
  const post = (cl: LanClient, name: string) => cl.uploadVideo('/lan/api/tools/jobs', { name, data: clip(3) }, { created_by_name: 'Minh' });
  const get = async (cl: LanClient, id: number) => (await cl.get(`/lan/api/tools/jobs/${id}`)).body;

  it('RENDER_CONCURRENCY=2: hai việc xử lý cùng lúc (queue_state=running), việc thứ ba chờ vị trí 1; hủy một việc đang chạy thì việc chờ bắt đầu; status báo hàng đợi', async () => {
    process.env.FAKE_GWR_MODE = 'hang'; // tool giả treo cho tới khi bị hủy
    await mk(2, 'auto');
    const c2 = L.client({ ip: '192.168.1.33' });
    const c3 = L.client({ ip: '192.168.1.34' });
    await c2.login();
    await c3.login();
    const u1 = await post(c, 'a.mp4');
    const u2 = await post(c2, 'b.mp4');
    const u3 = await post(c3, 'c.mp4');
    for (const u of [u1, u2, u3]) expect(u.status, u.raw).toBe(201);
    const [id1, id2, id3] = [u1, u2, u3].map((u) => u.body.job.id as number);
    const row = (id: number) => db().prepare('SELECT status FROM lan_tool_jobs WHERE id = ?').get(id) as { status: string };
    await waitFor(() => row(id1!).status === 'processing' && row(id2!).status === 'processing');

    expect(await get(c, id1!)).toMatchObject({ status: 'processing', queue_state: 'running', queue_position: null, running_count: 2, concurrency: 2, queue_ahead: 0 });
    expect(await get(c2, id2!)).toMatchObject({ status: 'processing', queue_state: 'running' });
    expect(await get(c3, id3!)).toMatchObject({ status: 'queued', queue_state: 'waiting', queue_position: 1, running_count: 2, concurrency: 2, queue_ahead: 3 });
    expect(u3.body.job).toMatchObject({ status: 'queued', queue_state: 'waiting', queue_position: 1 });
    expect((await c.get('/lan/api/tools/status')).body.render).toEqual({ running_count: 2, waiting_count: 1, concurrency: 2 });
    expect((await c.get('/lan/api/status')).body.render).toEqual({ running_count: 2, waiting_count: 1, concurrency: 2 });
    expect((await c.get('/lan/api/status')).body.queue).toMatchObject({ tools: 3, total: 3, cap: 6 });

    // hai tiến trình tool thật sự sống cùng lúc
    await waitFor(() => fs.existsSync(process.env.FAKE_GWR_CHILD_PID!));
    const log = fs.readFileSync(process.env.FAKE_GWR_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.argv[0] === 'remove');
    expect(log).toHaveLength(2);
    expect(log.every((x) => alive(x.pid))).toBe(true);

    // hủy việc 1 (đang chạy): chỉ tiến trình của nó dừng; việc 3 bắt đầu; việc 2 vẫn chạy
    const pid1 = log.find((x) => String(x.argv[1]).includes(`lan-tools/${id1}/`))!.pid as number;
    const pid2 = log.find((x) => String(x.argv[1]).includes(`lan-tools/${id2}/`))!.pid as number;
    expect((await c.post(`/lan/api/tools/jobs/${id1}/cancel`, {})).status).toBe(200);
    await waitFor(() => !alive(pid1), 10_000);
    await waitFor(() => row(id3!).status === 'processing');
    expect(alive(pid2)).toBe(true);
    expect(await get(c2, id2!)).toMatchObject({ status: 'processing', queue_state: 'running' });
    expect(await get(c3, id3!)).toMatchObject({ status: 'processing', queue_state: 'running', queue_position: null, running_count: 2 });
    expect(await get(c, id1!)).toMatchObject({ status: 'cancelled', queue_state: null, queue_position: null, running_count: null, queue_ahead: null });

    // dọn: hủy các việc còn lại để không còn tiến trình mồ côi
    await c2.post(`/lan/api/tools/jobs/${id2}/cancel`, {});
    await c3.post(`/lan/api/tools/jobs/${id3}/cancel`, {});
    await rf().idle();
  });
});
