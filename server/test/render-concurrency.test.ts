import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampRenderConcurrency, defaultConfig, loadConfig, parseRenderConcurrency } from '../src/config.js';
import { mcpMaxActiveRendersEnv } from '../src/services/final-render/index.js';
import { FakeRenderer } from './final-helpers.js';
import { claimEditPlan, edlFor, makeEnv, setupAllDone, userClient, type Env, type Scenario } from './helpers.js';

/**
 * Hàng đợi render CHẠY SONG SONG (RENDER_CONCURRENCY): nhiều việc đang chạy cùng lúc, việc của app trước việc LAN, hủy đúng việc,
 * đếm hàng đợi/idle/đóng đúng với N việc chạy, khởi động lại khi đang có hai việc chạy.
 */
let env: Env;
let fake: FakeRenderer;
afterEach(async () => {
  fake?.release();
  await env?.close();
});

async function mk(concurrency = 2, extra: Record<string, unknown> = {}) {
  fake = new FakeRenderer();
  fake.gateEach = true; // mỗi bản chờ cổng riêng: mở từng bản bằng fake.releaseCut(id)
  env = await makeEnv({ finalRenderer: fake, finalRender: { progressThrottleMs: 0, queueNotifyMs: 0 }, config: { renderConcurrency: concurrency, ...extra } });
}
const rf = () => env.ctx.finalRender!;
const db = () => env.ctx.db;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await tick(5);
  }
}

interface Started {
  sc: Scenario;
  cutId: number;
}
/** Một dự án app xong video → AI (giả lập worker) gửi điểm cắt → bản dựng `rendering` và vào hàng đợi render. */
async function startCut(name: string): Promise<Started> {
  const sc = await setupAllDone(env, { scenes: 1, project: { name } });
  const job = await claimEditPlan(sc);
  const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
  const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: name } });
  expect(r.status, r.raw).toBe(200);
  return { sc, cutId: cut.id as number };
}
const cutOf = async (s: Started) => (await s.sc.user.get(`/api/final-cuts/${s.cutId}`)).body;

/** Việc công cụ giả: `run` chờ cổng riêng (hoặc bị hủy). Dùng để kiểm tra các việc LAN mà không cần HTTP/ffmpeg. */
function toolGate() {
  const log: string[] = [];
  const gates = new Map<number, () => void>();
  const aborted: number[] = [];
  const add = (id: number, lingerMs = 0) =>
    rf().enqueueTool(id, (abort) =>
      new Promise<void>((resolve) => {
        log.push(`start:${id}`);
        gates.set(id, () => {
          log.push(`end:${id}`);
          resolve();
        });
        abort.signal.addEventListener('abort', () => {
          aborted.push(id);
          setTimeout(() => gates.get(id)?.(), lingerMs); // tiến trình cần chút thời gian để dừng hẳn
        });
      }),
    );
  return { log, gates, aborted, add, finish: (id: number) => gates.get(id)?.() };
}

describe('cấu hình RENDER_CONCURRENCY', () => {
  it('mặc định 2; số nguyên kẹp 1–4; giá trị rác → 2', () => {
    expect(defaultConfig('/r', '/r/db').renderConcurrency).toBe(2);
    expect(loadConfig({}).renderConcurrency).toBe(2);
    const cases: [string | undefined, number][] = [
      [undefined, 2],
      ['', 2],
      ['  ', 2],
      ['abc', 2],
      ['1', 1],
      ['3', 3],
      ['4', 4],
      ['0', 1],
      ['-5', 1],
      ['9', 4],
      ['3.9', 3],
      [' 4 ', 4],
      ['Infinity', 2],
    ];
    for (const [v, want] of cases) expect(parseRenderConcurrency(v), String(v)).toBe(want);
    expect(loadConfig({ RENDER_CONCURRENCY: '3' }).renderConcurrency).toBe(3);
    expect([clampRenderConcurrency(7), clampRenderConcurrency(0), clampRenderConcurrency(NaN)]).toEqual([4, 1, 2]);
  });

  it('dịch vụ luôn dùng giá trị đã kẹp, kể cả khi cấu hình tay vượt giới hạn (9 → tối đa 4 việc cùng lúc)', async () => {
    await mk(9);
    expect(rf().concurrency).toBe(4);
    const t = toolGate();
    for (let i = 1; i <= 6; i++) t.add(i);
    expect(t.log).toEqual(['start:1', 'start:2', 'start:3', 'start:4']);
    expect(rf().summary()).toEqual({ running_count: 4, waiting_count: 2, concurrency: 4 });
    for (let i = 1; i <= 6; i++) t.finish(i);
    await tick();
    for (let i = 1; i <= 6; i++) t.finish(i);
    await rf().idle();
    expect(t.log.filter((l) => l.startsWith('start')).length).toBe(6);
  });
});

describe('hai việc chạy cùng lúc, việc thứ ba xếp hàng', () => {
  it('RENDER_CONCURRENCY=2: bản A, B render song song; C đợi (queue_state=waiting, vị trí 1); xong một bản thì C bắt đầu', async () => {
    await mk(2);
    const a = await startCut('A');
    const b = await startCut('B');
    const c = await startCut('C');
    await waitFor(() => fake.started.length === 2);
    await tick();
    expect(fake.started).toEqual([a.cutId, b.cutId]);
    expect(fake.concurrent).toBe(2);
    expect(await cutOf(a)).toMatchObject({ status: 'rendering', stage: 'render', queue_state: 'running', queue_position: null, running_count: 2, concurrency: 2 });
    expect(await cutOf(b)).toMatchObject({ queue_state: 'running', queue_position: null });
    expect(await cutOf(c)).toMatchObject({ status: 'rendering', progress: null, queue_state: 'waiting', queue_position: 1, running_count: 2, concurrency: 2 });
    expect(rf().summary()).toEqual({ running_count: 2, waiting_count: 1, concurrency: 2 });
    // danh sách của dự án và bản tóm tắt cũng mang trạng thái hàng đợi
    expect((await c.sc.user.get(`/api/projects/${c.sc.project.id}/final-cuts`)).body[0]).toMatchObject({ queue_state: 'waiting', queue_position: 1 });
    expect((await c.sc.user.get(`/api/projects/${c.sc.project.id}`)).body.latest_final_cut).toMatchObject({ status: 'rendering', queue_state: 'waiting', queue_position: 1 });

    fake.releaseCut(a.cutId);
    await waitFor(() => fake.started.length === 3);
    expect(fake.started).toEqual([a.cutId, b.cutId, c.cutId]);
    await waitFor(() => (db().prepare('SELECT status FROM final_cuts WHERE id = ?').get(a.cutId) as { status: string }).status === 'ready');
    expect(await cutOf(c)).toMatchObject({ queue_state: 'running', queue_position: null, running_count: 2 });
    expect((await cutOf(b)).status).toBe('rendering'); // B vẫn đang chạy, không bị ảnh hưởng

    fake.release();
    await rf().idle();
    expect(fake.maxConcurrent).toBe(2);
    for (const x of [a, b, c]) expect(await cutOf(x)).toMatchObject({ status: 'ready', queue_state: null, queue_position: null, running_count: null, concurrency: null });
  });

  it('RENDER_CONCURRENCY=3: ba bản cùng lúc, bản thứ tư vị trí 1 và bản thứ năm vị trí 2', async () => {
    await mk(3);
    const cuts: Started[] = [];
    for (const n of ['A', 'B', 'C', 'D', 'E']) cuts.push(await startCut(n));
    await waitFor(() => fake.started.length === 3);
    await tick();
    expect(fake.started).toEqual(cuts.slice(0, 3).map((x) => x.cutId));
    expect((await cutOf(cuts[3]!))).toMatchObject({ queue_state: 'waiting', queue_position: 1, running_count: 3, concurrency: 3 });
    expect((await cutOf(cuts[4]!))).toMatchObject({ queue_state: 'waiting', queue_position: 2 });
    fake.release();
    await rf().idle();
    expect(fake.maxConcurrent).toBe(3);
    expect(fake.calls).toHaveLength(5);
  });
});

describe('ưu tiên app trước LAN, không chen ngang việc đang chạy', () => {
  it('hai việc LAN đang chạy không bị ngắt; bản của app đến sau xếp TRƯỚC việc LAN đang chờ và lấy chỗ trống đầu tiên', async () => {
    await mk(2);
    const t = toolGate();
    t.add(1);
    t.add(2); // hai việc LAN chiếm cả hai chỗ
    t.add(3); // việc LAN thứ ba đang chờ
    expect(t.log).toEqual(['start:1', 'start:2']);
    const x = await startCut('X'); // bản của app, đến SAU việc LAN 3
    expect(rf().queueInfo('cut', x.cutId)).toEqual({ state: 'waiting', position: 1, running_count: 2, concurrency: 2 });
    expect(rf().queueInfo('tool', 3)).toEqual({ state: 'waiting', position: 2, running_count: 2, concurrency: 2 });
    expect(rf().queueInfo('tool', 1)).toMatchObject({ state: 'running', position: null }); // không bị ngắt
    expect(rf().lanLoad()).toBe(3);

    t.finish(1); // một chỗ trống → bản của app (không phải việc LAN 3)
    await waitFor(() => fake.started.length === 1);
    expect(fake.started).toEqual([x.cutId]);
    expect(t.log).toEqual(['start:1', 'start:2', 'end:1']);
    expect(rf().queueInfo('tool', 3)).toMatchObject({ state: 'waiting', position: 1 });
    expect(rf().lanLoad()).toBe(2); // việc 2 đang chạy + việc 3 đang chờ (bản của app không tính)

    fake.releaseCut(x.cutId); // bản app xong → việc LAN 3 mới được chạy
    await waitFor(() => t.log.includes('start:3'));
    expect(rf().lanLoad()).toBe(2);
    t.finish(2);
    t.finish(3);
    await rf().idle();
    expect(rf().lanLoad()).toBe(0);
  });

  it('hai bản của app đến sau nhiều việc LAN: FIFO giữa các bản app, tất cả đứng trước việc LAN đang chờ', async () => {
    await mk(1);
    const t = toolGate();
    t.add(1); // chạy
    t.add(2);
    t.add(3);
    const x = await startCut('X');
    const y = await startCut('Y');
    expect([rf().queueInfo('cut', x.cutId)?.position, rf().queueInfo('cut', y.cutId)?.position, rf().queueInfo('tool', 2)?.position, rf().queueInfo('tool', 3)?.position]).toEqual([1, 2, 3, 4]);
    t.finish(1);
    await waitFor(() => fake.started.length === 1);
    fake.releaseCut(x.cutId);
    await waitFor(() => fake.started.length === 2);
    fake.releaseCut(y.cutId);
    await waitFor(() => t.log.includes('start:2'));
    t.finish(2);
    await waitFor(() => t.log.includes('start:3'));
    t.finish(3);
    await rf().idle();
    expect(fake.started).toEqual([x.cutId, y.cutId]);
  });
});

describe('hủy đúng việc', () => {
  it('hủy bản đang chạy A: chỉ A bị dừng, B vẫn chạy, bản đang chờ C lấy chỗ trống; hủy bản đang chờ thì không bao giờ chạy', async () => {
    await mk(2);
    const a = await startCut('A');
    const b = await startCut('B');
    const c = await startCut('C');
    const d = await startCut('D');
    await waitFor(() => fake.started.length === 2);
    expect(await cutOf(c)).toMatchObject({ queue_position: 1 });
    expect(await cutOf(d)).toMatchObject({ queue_position: 2 });

    // hủy D đang chờ: vị trí của C giữ nguyên, D không bao giờ chạy
    const cd = await d.sc.user.post(`/api/final-cuts/${d.cutId}/cancel`, {});
    expect(cd.status, cd.raw).toBe(200);
    expect(rf().queueInfo('cut', d.cutId)).toBeNull();
    expect(rf().summary()).toMatchObject({ running_count: 2, waiting_count: 1 });

    // hủy A đang chạy
    const ca = await a.sc.user.post(`/api/final-cuts/${a.cutId}/cancel`, {});
    expect(ca.status, ca.raw).toBe(200);
    await waitFor(() => fake.aborted.includes(a.cutId));
    await waitFor(() => fake.started.includes(c.cutId)); // C vào chỗ trống
    expect(fake.aborted).toEqual([a.cutId]); // B không bị dừng
    expect(rf().queueInfo('cut', b.cutId)).toMatchObject({ state: 'running' });
    expect(await cutOf(a)).toMatchObject({ status: 'cancelled', queue_state: null });
    expect(await cutOf(b)).toMatchObject({ status: 'rendering', queue_state: 'running' });
    expect(await cutOf(c)).toMatchObject({ status: 'rendering', queue_state: 'running', running_count: 2 });

    fake.release();
    await rf().idle();
    expect(fake.started).toEqual([a.cutId, b.cutId, c.cutId]); // D không có trong danh sách
    expect(await cutOf(b)).toMatchObject({ status: 'ready' });
    expect(await cutOf(c)).toMatchObject({ status: 'ready' });
    expect(await cutOf(d)).toMatchObject({ status: 'cancelled' });
  });

  it('hủy việc công cụ: đang chạy → chỉ tín hiệu hủy của việc đó; đang chờ → bị gỡ khỏi hàng đợi và không bao giờ chạy', async () => {
    await mk(2);
    const t = toolGate();
    t.add(1);
    t.add(2);
    t.add(3);
    rf().cancelTool(3); // đang chờ
    expect(rf().queueInfo('tool', 3)).toBeNull();
    rf().cancelTool(1); // đang chạy
    await waitFor(() => t.log.includes('end:1'));
    expect(t.aborted).toEqual([1]);
    expect(rf().queueInfo('tool', 2)).toMatchObject({ state: 'running' });
    await tick();
    expect(t.log).toEqual(['start:1', 'start:2', 'end:1']); // việc 3 không chạy dù có chỗ trống
    t.finish(2);
    await rf().idle();
    expect(t.aborted).toEqual([1]);
  });

  it('hủy rồi xếp lại NGAY cùng một việc: việc mới đợi việc cũ dừng hẳn (không chạy chồng, không đụng file tạm của nhau)', async () => {
    await mk(2);
    const t = toolGate();
    t.add(7, 60); // việc cũ cần 60ms để dừng sau khi bị hủy
    rf().cancelTool(7);
    t.add(7); // thử lại ngay
    expect(t.log).toEqual(['start:7']); // chưa có lần chạy thứ hai
    expect(rf().queueInfo('tool', 7)).toMatchObject({ state: 'running' }); // việc cũ còn đang dừng
    await waitFor(() => t.log.filter((l) => l === 'start:7').length === 2);
    expect(t.log).toEqual(['start:7', 'end:7', 'start:7']); // lần hai chỉ bắt đầu sau khi lần một kết thúc
    t.finish(7);
    await rf().idle();
  });

  it('hủy ngay lúc việc vừa được lấy ra (còn đang kiểm tra trình dựng, chưa gọi renderer) thì KHÔNG bắt đầu render', async () => {
    await mk(2);
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    db().prepare("UPDATE final_cuts SET status = 'rendering', stage = 'render', edl = ? WHERE id = ?").run(JSON.stringify(edlFor(sc, cut)), cut.id);
    rf().enqueue(cut.id);
    expect(rf().queueInfo('cut', cut.id)).toMatchObject({ state: 'running' }); // đã có chỗ trống: đang chạy ngay (đồng bộ)
    rf().cancel(cut.id); // vẫn trong cùng nhịp: pick() chưa xong
    await rf().idle();
    expect(fake.calls).toHaveLength(0);
    const finalDir = path.join(env.root, 'output', 'cacao-actiso-plus', 'final');
    expect(fs.existsSync(finalDir) ? fs.readdirSync(finalDir).filter((f) => f.endsWith('.mp4')) : []).toEqual([]);
  });
});

describe('đếm hàng đợi, idle, đóng dịch vụ với N việc chạy', () => {
  it('idle() chỉ resolve khi MỌI việc đang chạy xong và hàng đợi rỗng', async () => {
    await mk(2);
    const t = toolGate();
    t.add(1);
    t.add(2);
    t.add(3);
    let done = false;
    void rf().idle().then(() => (done = true));
    t.finish(1);
    await tick();
    expect(done).toBe(false); // việc 2 đang chạy, việc 3 vừa lấy chỗ
    t.finish(2);
    await tick();
    expect(done).toBe(false); // việc 3 vẫn chạy
    t.finish(3);
    await waitFor(() => done);
    expect(rf().summary()).toEqual({ running_count: 0, waiting_count: 0, concurrency: 2 });
    // hàng đợi rỗng: idle() resolve ngay
    await rf().idle();
  });

  it('close() hủy MỌI việc đang chạy, bỏ hàng đợi và nhả các bên đang chờ idle()', async () => {
    await mk(2);
    const t = toolGate();
    t.add(1);
    t.add(2);
    t.add(3);
    let idled = false;
    void rf().idle().then(() => (idled = true));
    await rf().close();
    expect(t.aborted.sort()).toEqual([1, 2]);
    expect(t.log.filter((l) => l.startsWith('start'))).toEqual(['start:1', 'start:2']); // việc 3 không bao giờ chạy
    expect(idled).toBe(true);
    expect(rf().summary()).toMatchObject({ running_count: 0, waiting_count: 0 });
    t.add(9); // đã đóng: không nhận việc mới
    expect(t.log).not.toContain('start:9');
  });

  it('lanLoad() và position() đúng khi nhiều việc đang chạy; position() cũ = running_count + vị trí (0 khi đang chạy)', async () => {
    await mk(2);
    const t = toolGate();
    t.add(1);
    t.add(2);
    t.add(3);
    t.add(4);
    expect(rf().lanLoad()).toBe(4);
    expect([rf().position('tool', 1), rf().position('tool', 2), rf().position('tool', 3), rf().position('tool', 4), rf().position('tool', 99)]).toEqual([0, 0, 3, 4, null]);
    t.finish(1);
    await waitFor(() => t.log.includes('start:3'));
    expect(rf().lanLoad()).toBe(3);
    expect([rf().position('tool', 3), rf().position('tool', 4)]).toEqual([0, 3]);
    t.finish(2);
    t.finish(3);
    await waitFor(() => t.log.includes('start:4'));
    t.finish(4);
    await rf().idle();
    expect(rf().lanLoad()).toBe(0);
  });
});

describe('SSE final_cut.updated khi vị trí hàng đợi đổi', () => {
  it('phát cho bản đang chờ với queue_position mới (gộp, không phát lại khi không đổi); báo running khi bắt đầu', async () => {
    await mk(1);
    const events: { event: string; data: any }[] = [];
    const res: any = new EventEmitter();
    res.writeHead = vi.fn();
    res.write = (txt: string) => {
      const ev = /^event: (.+)$/m.exec(txt);
      const data = /^data: (.+)$/m.exec(txt);
      if (ev && data) events.push({ event: ev[1]!, data: JSON.parse(data[1]!) });
    };
    res.end = vi.fn();
    env.ctx.sse.add(res, null);
    const x = await startCut('X');
    await waitFor(() => fake.started.length === 1);
    const y = await startCut('Y');
    const z = await startCut('Z');
    const posEvents = (id: number) => events.filter((e) => e.event === 'final_cut.updated' && e.data.final_cut.id === id).map((e) => e.data.final_cut.queue_position);
    await waitFor(() => posEvents(y.cutId).includes(1) && posEvents(z.cutId).includes(2));
    const yBefore = posEvents(y.cutId).filter((p) => p === 1).length;
    await tick(60);
    expect(posEvents(y.cutId).filter((p) => p === 1).length).toBe(yBefore); // không đổi thì không phát thêm

    fake.releaseCut(x.cutId); // Y bắt đầu, Z lên vị trí 1
    await waitFor(() => posEvents(z.cutId).includes(1));
    expect(events.some((e) => e.event === 'final_cut.updated' && e.data.final_cut.id === y.cutId && e.data.final_cut.queue_state === 'running')).toBe(true);
    fake.release();
    await rf().idle();
  });
});

describe('khởi động lại khi đang có hai việc chạy', () => {
  it('cả hai bản `rendering` (một ở bước xoá logo) → failed đúng bước; việc công cụ processing/queued → failed giữ input; file tạm bị dọn; dịch vụ mới chạy được', async () => {
    await mk(2);
    const a = await startCut('A');
    const b = await startCut('B');
    await waitFor(() => fake.started.length === 2);
    // B đang ở bước xoá logo: có file tạm của tool
    const slugB = (db().prepare('SELECT p.slug, f.version FROM final_cuts f JOIN projects p ON p.id = f.project_id WHERE f.id = ?').get(b.cutId) as { slug: string; version: number });
    const finalDir = path.join(env.root, 'output', slugB.slug, 'final');
    fs.mkdirSync(finalDir, { recursive: true });
    const rawRel = `output/${slugB.slug}/final/${slugB.slug}_final_v${slugB.version}_raw.mp4`;
    fs.writeFileSync(path.join(env.root, rawRel), 'raw');
    const tmpB = path.join(finalDir, `.${slugB.slug}_final_v${slugB.version}.tmp.mp4`);
    fs.writeFileSync(tmpB, 'dở');
    db().prepare("UPDATE final_cuts SET stage = 'clean', raw_video_path = ? WHERE id = ?").run(rawRel, b.cutId);
    // hai việc công cụ LAN đang xử lý + một đang chờ (dòng DB; tiến trình của chúng thuộc server cũ)
    const ins = db().prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at, input_path) VALUES ('remove_logo', ?, 'v.mp4', 'h', '{}', ?, ?)");
    const toolIds = (['processing', 'processing', 'queued'] as const).map((st) => Number(ins.run(st, env.ctx.now(), 'output/lan-tools/x/input.mp4').lastInsertRowid));
    const toolDir = path.join(env.root, 'output', 'lan-tools', String(toolIds[0]));
    fs.mkdirSync(toolDir, { recursive: true });
    fs.writeFileSync(path.join(toolDir, '.clean.tmp.mp4'), 'dở');

    // server cũ chết: hai bản vẫn `rendering` trong DB
    expect((db().prepare("SELECT COUNT(*) AS n FROM final_cuts WHERE status = 'rendering'").get() as { n: number }).n).toBe(2);
    await env.app.close();
    fake.release();
    const fake2 = new FakeRenderer();
    const app2 = await env.second({ finalRenderer: fake2 });
    const rows = (id: number) => app2.ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(id) as any;
    expect(rows(a.cutId)).toMatchObject({ status: 'failed', stage: null, failed_stage: 'render' });
    expect(rows(a.cutId).error).toContain('Server khởi động lại trong lúc render');
    expect(rows(b.cutId)).toMatchObject({ status: 'failed', stage: null, failed_stage: 'clean', raw_video_path: rawRel });
    expect(rows(b.cutId).error).toContain('xoá logo Veo');
    expect(fs.existsSync(tmpB)).toBe(false); // file tạm của tool bị dọn
    expect(fs.existsSync(path.join(env.root, rawRel))).toBe(true); // bản raw giữ lại để thử xoá logo lại
    const tools = app2.ctx.db.prepare('SELECT status, error, input_path FROM lan_tool_jobs ORDER BY id').all() as { status: string; error: string; input_path: string }[];
    expect(tools.map((x) => x.status)).toEqual(['failed', 'failed', 'failed']);
    expect(tools.every((x) => x.error.includes('Server khởi động lại') && x.input_path)).toBe(true);
    expect(fs.existsSync(path.join(toolDir, '.clean.tmp.mp4'))).toBe(false);
    expect(app2.ctx.finalRender!.summary()).toEqual({ running_count: 0, waiting_count: 0, concurrency: 2 });

    // dịch vụ mới hoạt động bình thường: người dùng render lại từ EDL của bản A
    const cutA = (await userClient(app2).get(`/api/final-cuts/${a.cutId}`)).body;
    expect(cutA.edl).toBeTruthy();
    const re = await userClient(app2).post(`/api/final-cuts/${a.cutId}/rerender`, { edl: cutA.edl });
    expect(re.status, re.raw).toBe(201);
    await app2.ctx.finalRender!.idle();
    expect((await userClient(app2).get(`/api/final-cuts/${re.body.final_cut.id}`)).body).toMatchObject({ status: 'ready' });
    expect(fake2.calls).toHaveLength(1);
  });
});

describe('Shotcut MCP: số render đồng thời', () => {
  it('chỉ nâng SHOTCUT_MCP_MAX_ACTIVE_RENDERS khi RENDER_CONCURRENCY vượt mức hiện tại; không thì không đặt biến', () => {
    expect(mcpMaxActiveRendersEnv(undefined, undefined)).toBeNull();
    expect(mcpMaxActiveRendersEnv(1, undefined)).toBeNull();
    expect(mcpMaxActiveRendersEnv(2, undefined)).toBeNull(); // mặc định của MCP là 2
    expect(mcpMaxActiveRendersEnv(3, undefined)).toBe('3');
    expect(mcpMaxActiveRendersEnv(4, undefined)).toBe('4');
    expect(mcpMaxActiveRendersEnv(4, '2')).toBe('4');
    expect(mcpMaxActiveRendersEnv(3, '3')).toBeNull();
    expect(mcpMaxActiveRendersEnv(3, '6')).toBeNull(); // đã đặt cao hơn: giữ nguyên
    expect(mcpMaxActiveRendersEnv(3, 'abc')).toBe('3');
    expect(mcpMaxActiveRendersEnv(3, '')).toBe('3');
  });
});
