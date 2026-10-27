import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { McpClient, RenderCancelled, ShotcutRenderer, type RenderRequest } from '../src/services/final-render/index.js';
import { claimEditPlan, edlFor, makeEnv, setupAllDone, type Env } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-shotcut-mcp.mjs', import.meta.url));
const NODE = process.execPath; // "python" giả: node chạy script MCP giả

let root: string;
let logFile: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-sc-'));
  logFile = path.join(root, 'mcp.log');
  process.env.FAKE_MCP_LOG = logFile;
  process.env.FAKE_MCP_MODE = 'ok';
  process.env.FAKE_MCP_CHECK = 'ok';
});
afterEach(() => {
  delete process.env.FAKE_MCP_LOG;
  delete process.env.FAKE_MCP_MODE;
  delete process.env.FAKE_MCP_CHECK;
  fs.rmSync(root, { recursive: true, force: true });
});

const logLines = (): any[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const tools = () => logLines().filter((l) => l.method === 'tools/call').map((l) => l.params.name);

const req = (extra: Partial<RenderRequest> = {}): RenderRequest => ({
  cutId: 7,
  version: 3,
  slug: 'demo',
  name: 'Demo',
  segments: [
    { path: path.join(root, 'a.mp4'), in_s: 0, out_s: 4.5, caption: 'C1 v2 #1' },
    { path: path.join(root, 'a.mp4'), in_s: 6, out_s: 9.5, caption: 'C1 v2 #2' },
    { path: path.join(root, 'b.mp4'), in_s: 0.3, out_s: 9.6, caption: 'C2 v1 #1' },
  ],
  out: {
    videoAbs: path.join(root, 'out', 'demo_final_v3.mp4'),
    contactAbs: path.join(root, 'out', 'demo_final_v3_contact.png'),
    mltAbs: path.join(root, 'out', 'shotcut', 'demo_final_v3.mlt'),
  },
  config: { ...defaultConfig(root, path.join(root, 'x.db')) },
  signal: new AbortController().signal,
  onProgress: () => undefined,
  onProjectFile: () => undefined,
  onRenderRef: () => undefined,
  ...extra,
});
const renderer = (o: { pollMs?: number; timeoutMs?: number } = {}) => new ShotcutRenderer({ python: NODE, script: FAKE, pollMs: 10, ...o });

describe('ShotcutRenderer (MCP stdio giả)', () => {
  it('trình tự: initialize → create_project (profile, clip theo thứ tự, caption) → contact sheet → start_render h264-high → poll tới completed; env MCP đúng', async () => {
    const progress: number[] = [];
    const files: string[] = [];
    const refs: string[] = [];
    const out = await renderer().render(req({ onProgress: (p) => progress.push(p), onProjectFile: (f) => files.push(f), onRenderRef: (r) => refs.push(r) }));
    expect(out).toEqual({
      renderer: 'shotcut',
      videoAbs: path.join(root, 'out', 'demo_final_v3.mp4'),
      contactAbs: path.join(root, 'out', 'demo_final_v3_contact.png'),
      projectFileAbs: path.join(root, 'out', 'shotcut', 'demo_final_v3.mlt'),
    });
    const lines = logLines();
    expect(lines[0].env).toEqual({ SHOTCUT_MCP_ALLOWED_ROOTS: root, SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS: '1' });
    expect(lines.map((l) => l.method ?? 'start')).toEqual(expect.arrayContaining(['start', 'initialize', 'notifications/initialized']));
    expect(tools().slice(0, 3)).toEqual(['create_project', 'render_contact_sheet', 'start_render']);
    expect(tools().slice(3).every((t) => t === 'render_status')).toBe(true);
    expect(tools().filter((t) => t === 'render_status').length).toBeGreaterThanOrEqual(3);
    const create = lines.find((l) => l.params?.name === 'create_project').params.arguments;
    expect(create).toMatchObject({ project_path: path.join(root, 'out', 'shotcut', 'demo_final_v3.mlt'), width: 720, height: 1280, fps_num: 24, fps_den: 1 });
    expect(create.clips).toEqual([
      { path: path.join(root, 'a.mp4'), in_seconds: 0, out_seconds: 4.5, caption: 'C1 v2 #1' },
      { path: path.join(root, 'a.mp4'), in_seconds: 6, out_seconds: 9.5, caption: 'C1 v2 #2' },
      { path: path.join(root, 'b.mp4'), in_seconds: 0.3, out_seconds: 9.6, caption: 'C2 v1 #1' },
    ]);
    const sheet = lines.find((l) => l.params?.name === 'render_contact_sheet').params.arguments;
    expect(sheet).toMatchObject({ project_path: create.project_path, output_path: path.join(root, 'out', 'demo_final_v3_contact.png') });
    const start = lines.find((l) => l.params?.name === 'start_render').params.arguments;
    expect(start).toEqual({ project_path: create.project_path, output_path: path.join(root, 'out', 'demo_final_v3.mp4'), preset: 'h264-high' });
    expect(files).toEqual([create.project_path]);
    expect(refs).toEqual(['fake-job-1']);
    expect(progress).toEqual([30, 60, 99].slice(0, progress.length));
    expect(progress.length).toBeGreaterThanOrEqual(2);
  });

  it('create_project lỗi → ném lỗi có tên tool; render_status failed → lỗi kèm log_tail; MCP chết giữa chừng → lỗi rõ ràng', async () => {
    process.env.FAKE_MCP_MODE = 'create_error';
    await expect(renderer().render(req())).rejects.toThrow(/Shotcut MCP create_project: Project path is outside/);
    process.env.FAKE_MCP_MODE = 'render_fail';
    await expect(renderer().render(req())).rejects.toThrow(/Shotcut render lỗi \(mã 1\).*melt: codec error/);
    process.env.FAKE_MCP_MODE = 'die_on_start_render';
    await expect(renderer().render(req())).rejects.toThrow(/Shotcut MCP thoát đột ngột/);
  });

  it('không chạy được python/script → lỗi rõ ràng; quá thời gian → cancel_render rồi ném lỗi', async () => {
    await expect(new ShotcutRenderer({ python: '/khong/co/python', script: FAKE, pollMs: 10 }).render(req())).rejects.toThrow(/Không chạy được Shotcut MCP/);
    process.env.FAKE_MCP_MODE = 'hang';
    await expect(renderer({ timeoutMs: 80 }).render(req())).rejects.toThrow(/quá thời gian/);
    expect(tools()).toContain('cancel_render');
  });

  it('hủy giữa chừng: gọi cancel_render, ném RenderCancelled, đóng tiến trình MCP', async () => {
    process.env.FAKE_MCP_MODE = 'hang';
    const ac = new AbortController();
    const p = renderer().render(req({ signal: ac.signal }));
    for (let i = 0; i < 400 && !tools().includes('render_status'); i++) await new Promise((r) => setTimeout(r, 20)); // chờ tới khi job render đã chạy
    ac.abort();
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RenderCancelled || /đóng|hủy/i.test(String((e as Error).message)));
    for (let i = 0; i < 150 && !tools().includes('cancel_render'); i++) await new Promise((r) => setTimeout(r, 20)); // chịu được máy bận
    expect(tools()).toContain('cancel_render');
  });
});

describe('McpClient', () => {
  it('parse JSON trong content[0].text; isError → McpToolError; bỏ qua dòng không phải JSON', async () => {
    const c = McpClient.start({ command: NODE, args: [FAKE], env: { FAKE_MCP_LOG: logFile } });
    try {
      await c.initialize();
      const r = await c.callTool('start_render', { project_path: '/x', output_path: path.join(root, 'o.mp4') });
      expect(r).toMatchObject({ job_id: 'fake-job-1', status: 'running' });
      await expect(c.callTool('khong_co', {})).rejects.toThrow(/Shotcut MCP khong_co: unknown tool/);
    } finally {
      c.close();
    }
  });
});

describe('chọn trình dựng (FINAL_RENDERER) và chạy thật qua app với Shotcut MCP giả', () => {
  let env: Env;
  afterEach(async () => {
    await env?.close();
  });

  const shotcutCfg = { shotcutMcpPython: NODE, shotcutMcpServerScript: FAKE };

  it('auto: cấu hình đủ và --check ok → shotcut; chưa cấu hình / --check hỏng → ffmpeg kèm lý do; mode=shotcut mà hỏng → active null', async () => {
    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'auto' }, finalRender: { shotcut: { pollMs: 10 } } });
    let st = await env.ctx.finalRender!.status(true);
    expect(st).toMatchObject({ mode: 'auto', active: 'shotcut', shotcut: { configured: true, ready: true, detail: null } });
    expect(st.reason).toContain('Shotcut MCP sẵn sàng');
    await env.close();

    process.env.FAKE_MCP_CHECK = 'bad';
    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'auto' } });
    st = await env.ctx.finalRender!.status(true);
    expect(st).toMatchObject({ active: 'ffmpeg', shotcut: { configured: true, ready: false } });
    expect(st.shotcut.detail).toContain('thiếu');
    expect(st.reason).toContain('ffmpeg');
    await env.close();

    env = await makeEnv({ config: { finalRenderer: 'auto' } });
    st = await env.ctx.finalRender!.status(true);
    expect(st).toMatchObject({ active: 'ffmpeg', shotcut: { configured: false, ready: null, detail: 'Chưa cấu hình SHOTCUT_MCP_PYTHON và SHOTCUT_MCP_SERVER_SCRIPT' } });
    await env.close();

    env = await makeEnv({ config: { ...shotcutCfg, shotcutMcpPython: 'tuong-doi/python', finalRenderer: 'auto' } });
    expect((await env.ctx.finalRender!.status(true)).shotcut.detail).toContain('tuyệt đối');
    await env.close();

    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'shotcut' } });
    st = await env.ctx.finalRender!.status(true);
    expect(st).toMatchObject({ mode: 'shotcut', active: null });
    expect(st.reason).toContain('FINAL_RENDERER=shotcut nhưng Shotcut MCP chưa sẵn sàng');
    await env.close();

    process.env.FAKE_MCP_CHECK = 'ok';
    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'ffmpeg' } });
    expect(await env.ctx.finalRender!.status(true)).toMatchObject({ mode: 'ffmpeg', active: 'ffmpeg', reason: 'FINAL_RENDERER=ffmpeg: dựng bằng ffmpeg' });
  });

  it('end-to-end: auto chọn Shotcut → render qua MCP giả → ready (renderer shotcut, có .mlt, render_ref); mode=shotcut hỏng → failed rõ lý do', async () => {
    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'auto' }, finalRender: { shotcut: { pollMs: 10 }, progressThrottleMs: 0 } });
    const sc = await setupAllDone(env, { scenes: 2 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 'ok' } });
    await env.ctx.finalRender!.idle();
    const done = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(done).toMatchObject({
      status: 'ready',
      renderer: 'shotcut',
      render_ref: 'fake-job-1',
      project_file_path: 'output/cacao-actiso-plus/final/shotcut/cacao-actiso-plus_final_v1.mlt',
      progress: 100,
    });
    expect(fs.existsSync(path.join(env.root, done.project_file_path))).toBe(true);
    expect(fs.readFileSync(path.join(env.root, done.video_path), 'utf8')).toBe('fake-shotcut-output');
    const create = logLines().find((l) => l.params?.name === 'create_project').params.arguments;
    expect(create.clips.map((c: any) => [c.caption, c.in_seconds, c.out_seconds])).toEqual([['C1 v1 #1', 0.5, 9.5], ['C2 v1 #1', 0.5, 9.5]]);
    expect(logLines()[0].env.SHOTCUT_MCP_ALLOWED_ROOTS).toBe(env.root);
    await env.close();

    process.env.FAKE_MCP_CHECK = 'bad';
    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'shotcut' } });
    const sc2 = await setupAllDone(env, { scenes: 1 });
    const j2 = await claimEditPlan(sc2);
    const c2 = (await sc2.user.get(`/api/final-cuts/${j2.payload.final_cut_id}`)).body;
    await sc2.worker.post(`/api/worker/jobs/${j2.id}/complete`, { result: { edl: edlFor(sc2, c2), summary: 'ok' } });
    await env.ctx.finalRender!.idle();
    const failed = (await sc2.user.get(`/api/final-cuts/${c2.id}`)).body;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Không có trình dựng khả dụng');
    expect(failed.error).toContain('FINAL_RENDERER=shotcut');
  });

  it('hủy bản đang render bằng Shotcut: cancel_render được gọi, bản cancelled', async () => {
    process.env.FAKE_MCP_MODE = 'hang';
    env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'shotcut' }, finalRender: { shotcut: { pollMs: 10 } } });
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 'ok' } });
    for (let i = 0; i < 100 && !tools().includes('render_status'); i++) await new Promise((r) => setTimeout(r, 20));
    expect((await sc.user.get(`/api/final-cuts/${cut.id}`)).body).toMatchObject({ status: 'rendering', renderer: 'shotcut', render_ref: 'fake-job-1' });
    expect((await sc.user.post(`/api/final-cuts/${cut.id}/cancel`, {})).body.final_cut.status).toBe('cancelled');
    await env.ctx.finalRender!.idle();
    expect(tools()).toContain('cancel_render');
    expect((await sc.user.get(`/api/final-cuts/${cut.id}`)).body.status).toBe('cancelled');
  });

  for (const n of [2, 3]) {
    it(`RENDER_CONCURRENCY=${n}: ${n} bản Shotcut chạy cùng lúc, mỗi bản một tiến trình MCP riêng; ${n > 2 ? 'MCP được nâng SHOTCUT_MCP_MAX_ACTIVE_RENDERS' : 'không đặt SHOTCUT_MCP_MAX_ACTIVE_RENDERS (mặc định 2 của MCP đã đủ)'}`, async () => {
      const saved = process.env.SHOTCUT_MCP_MAX_ACTIVE_RENDERS;
      delete process.env.SHOTCUT_MCP_MAX_ACTIVE_RENDERS;
      try {
        process.env.FAKE_MCP_MODE = 'hang';
        env = await makeEnv({ config: { ...shotcutCfg, finalRenderer: 'shotcut', renderConcurrency: n }, finalRender: { shotcut: { pollMs: 10 }, progressThrottleMs: 0 } });
        const cuts: { sc: Awaited<ReturnType<typeof setupAllDone>>; id: number }[] = [];
        for (let i = 0; i < n + 1; i++) {
          const sc = await setupAllDone(env, { scenes: 1, project: { name: `Song song ${i}` } });
          const job = await claimEditPlan(sc);
          const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
          await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 'ok' } });
          cuts.push({ sc, id: cut.id });
        }
        for (let i = 0; i < 200 && tools().filter((t) => t === 'start_render').length < n; i++) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 60));
        expect(tools().filter((t) => t === 'start_render')).toHaveLength(n); // đúng n bản đang render, bản thứ n+1 đang đợi
        const starts = logLines().filter((l) => l.started);
        expect(starts).toHaveLength(n); // mỗi bản một tiến trình MCP riêng
        for (const s of starts) expect(s.env.SHOTCUT_MCP_MAX_ACTIVE_RENDERS).toBe(n > 2 ? String(n) : undefined);
        expect((await cuts[n]!.sc.user.get(`/api/final-cuts/${cuts[n]!.id}`)).body).toMatchObject({ status: 'rendering', queue_state: 'waiting', queue_position: 1, running_count: n, concurrency: n });
        for (const c of cuts) await c.sc.user.post(`/api/final-cuts/${c.id}/cancel`, {});
        await env.ctx.finalRender!.idle();
      } finally {
        if (saved === undefined) delete process.env.SHOTCUT_MCP_MAX_ACTIVE_RENDERS;
        else process.env.SHOTCUT_MCP_MAX_ACTIVE_RENDERS = saved;
      }
    });
  }
});
