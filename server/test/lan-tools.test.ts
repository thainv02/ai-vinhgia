import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAN_RATE } from '../src/lan/routes.js';
import { expireToolJobs, recoverToolJobs } from '../src/services/lan-tools.js';
import { FFMPEG, FFPROBE, FakeRenderer, ffprobeJson } from './final-helpers.js';
import { claimEditPlan, edlFor, setupAllDone, type Scenario } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { clip, movOf } from './helpers-video.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-gwr.mjs', import.meta.url));
const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c1: LanClient;
let c2: LanClient;
let fake: FakeRenderer;
let tmp: string;
const db = () => L.env.ctx.db;
const idle = () => L.env.ctx.finalRender!.idle();
const toolRow = (id: number) => db().prepare('SELECT * FROM lan_tool_jobs WHERE id = ?').get(id) as any;
const toolDir = (id: number) => path.join(L.env.root, 'output', 'lan-tools', String(id));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (fn: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** Các test ở đây kiểm tra hàng đợi theo giả định MỘT việc một lúc (RENDER_CONCURRENCY=1); song song xem `render-concurrency.test.ts`. */
async function mk(o: { gwr?: boolean | 'off'; concurrency?: number } = {}) {
  fake = new FakeRenderer();
  fake.realVideo = { seconds: 2, audio: true };
  L = await makeLanEnv({
    app: { finalRenderer: fake, finalRender: { progressThrottleMs: 0, checkTtlMs: 0, watermarkGraceMs: 50 } },
    config: { renderConcurrency: o.concurrency ?? 1, ...(o.gwr === 'off' ? { gwrCli: FAKE_CLI, watermarkRemover: 'off' } : { gwrCli: o.gwr === false ? '/khong/co/gwr.mjs' : FAKE_CLI, watermarkRemover: 'auto', gwrTimeoutMs: 60_000 }) },
  });
  c1 = L.client({ ip: '192.168.1.11' });
  c2 = L.client({ ip: '192.168.1.12' });
  await c1.login();
  await c2.login();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'autovideo-lantool-'));
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

const post = (c: LanClient, name = 'video.mp4', data: Buffer = clip(3), fields: Record<string, string> = { created_by_name: 'Minh' }) => c.uploadVideo('/lan/api/tools/jobs', { name, data }, fields);
const get = async (c: LanClient, id: number) => (await c.get(`/lan/api/tools/jobs/${id}`)).body;
/** Các lần chạy tool xoá logo cho VIỆC CÔNG CỤ (bỏ qua lần chạy của bước clean bản dựng và `--help`). */
const removeCalls = () =>
  fs.existsSync(process.env.FAKE_GWR_LOG!)
    ? fs.readFileSync(process.env.FAKE_GWR_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.argv[0] === 'remove' && String(x.argv[1]).includes('lan-tools'))
    : [];

/** Chặn hàng đợi render bằng một bản dựng của app đang render (giữ lại) để việc công cụ nằm yên ở `queued`. */
async function blockQueue(): Promise<Scenario> {
  fake.hold();
  const sc = await setupAllDone(L.env, { scenes: 1 });
  const job = await claimEditPlan(sc);
  const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
  const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 'x' } });
  expect(r.status, r.raw).toBe(200);
  await waitFor(() => fake.calls.length === 1);
  return sc;
}

run('công cụ Xoá logo Veo: quyền theo cookie client', () => {
  beforeEach(() => mk());

  it('cookie client ẩn danh: HttpOnly, SameSite=Strict, Path=/lan, 400 ngày, giá trị ngẫu nhiên; DB chỉ lưu băm; KHÔNG cấp khi đăng nhập', async () => {
    const fresh = L.client({ ip: '192.168.1.13' });
    const login = await fresh.login();
    expect(String(login.headers['set-cookie'])).not.toContain('autovideo_lan_client'); // hợp đồng cookie phiên không đổi
    const first = await fresh.get('/lan/api/tools/jobs');
    expect(first.status).toBe(200);
    expect(first.body).toEqual([]);
    const line = String(first.headers['set-cookie']);
    expect(line).toMatch(/^autovideo_lan_client=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/lan; Max-Age=34560000$/);
    const value = line.split(';')[0]!.split('=')[1]!;
    // lần sau (đã có cookie) không cấp lại
    expect((await fresh.get('/lan/api/tools/jobs')).headers['set-cookie']).toBeUndefined();
    const up = await post(fresh);
    expect(up.status, up.raw).toBe(201);
    await idle();
    const row = toolRow(up.body.job.id);
    expect(row.client_id_hash).toBe(crypto.createHash('sha256').update(value).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(value);
    // cookie hai trình duyệt khác nhau
    expect((await c1.get('/lan/api/tools/jobs')).headers['set-cookie']).toContain('autovideo_lan_client=');
    const v1 = c1.cookie!.split('; ').find((x) => x.startsWith('autovideo_lan_client='))!;
    const v2 = (await c2.get('/lan/api/tools/jobs')) && c2.cookie!.split('; ').find((x) => x.startsWith('autovideo_lan_client='))!;
    expect(v1).not.toBe(v2);
    // cookie sai hình dạng bị bỏ qua và được cấp mới (không lỗi)
    const bad = L.client({ ip: '192.168.1.14', cookie: `${c1.cookie!.split('; ')[0]}; autovideo_lan_client=abc` });
    const r = await bad.get('/lan/api/tools/jobs');
    expect([r.status, r.body]).toEqual([200, []]);
    expect(String(r.headers['set-cookie'])).toContain('autovideo_lan_client=');
  });

  it('chỉ chủ của việc thấy, tải và hủy: người khác (cùng mã truy cập, khác trình duyệt) nhận 404; không cookie client → danh sách rỗng', async () => {
    const up = await post(c1);
    expect(up.status, up.raw).toBe(201);
    const id = up.body.job.id as number;
    await idle();
    expect((await get(c1, id)).status).toBe('ready');
    expect((await c1.get('/lan/api/tools/jobs')).body.map((j: any) => j.id)).toEqual([id]);
    // người khác
    expect((await c2.get('/lan/api/tools/jobs')).body).toEqual([]);
    for (const [m, u] of [['get', `/lan/api/tools/jobs/${id}`], ['post', `/lan/api/tools/jobs/${id}/cancel`], ['post', `/lan/api/tools/jobs/${id}/retry`]] as const) {
      const r = m === 'get' ? await c2.get(u) : await c2.post(u, {});
      expect([m, u, r.status, r.body.error.code]).toEqual([m, u, 404, 'NOT_FOUND']);
    }
    // cùng IP nhưng khác cookie client vẫn 404 (quyền theo cookie, không theo IP)
    const sameIp = L.client({ ip: '192.168.1.11', cookie: c1.cookie!.split('; ')[0] });
    expect((await sameIp.get(`/lan/api/tools/jobs/${id}`)).status).toBe(404);
    // tải bản sạch qua /lan/files: chủ 200, người khác/không cookie 404
    const out = (await get(c1, id)).output.url as string;
    expect(out).toBe(`/lan/files/output/lan-tools/${id}/clean.mp4`);
    expect((await c1.get(out)).status).toBe(200);
    expect((await c2.get(out)).status).toBe(404);
    expect((await sameIp.get(out)).status).toBe(404);
    expect((await L.client({ cookie: c1.cookie!.split('; ')[0] }).get(out)).status).toBe(404);
    // input của việc không bao giờ được phục vụ (kể cả cho chủ)
    expect((await c1.get(`/lan/files/output/lan-tools/${id}/input.mp4`)).status).toBe(404);
    // việc không tồn tại / id lạ
    for (const u of ['/lan/api/tools/jobs/9999', '/lan/api/tools/jobs/abc']) expect([404, 400]).toContain((await c1.get(u)).status);
    expect((await c1.get('/lan/files/output/lan-tools/9999/clean.mp4')).status).toBe(404);
  });

  it('mọi endpoint công cụ cần phiên LAN, Host/Origin đúng và không từ trang web khác; app chính không có các route này', async () => {
    const anon = L.client();
    for (const u of ['/lan/api/tools/status', '/lan/api/tools/jobs', '/lan/api/tools/jobs/1']) expect([u, (await anon.get(u)).status]).toEqual([u, 401]);
    for (const u of ['/lan/api/tools/jobs', '/lan/api/tools/jobs/1/cancel', '/lan/api/tools/jobs/1/retry']) expect([u, (await anon.post(u, {})).status]).toEqual([u, 401]);
    expect((await c1.get('/lan/api/tools/jobs', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const noOrigin = L.client({ ip: '192.168.1.11', cookie: c1.cookie, origin: null });
    expect((await noOrigin.post('/lan/api/tools/jobs/1/cancel', {})).status).toBe(403);
    expect((await L.client({ ip: '192.168.1.11', cookie: c1.cookie, origin: 'http://evil.example' }).uploadVideo('/lan/api/tools/jobs', { name: 'a.mp4', data: clip(2) })).status).toBe(403);
    expect((await L.client({ ip: '192.168.1.11', cookie: c1.cookie, host: 'evil.example.com' }).get('/lan/api/tools/jobs')).status).toBe(403);
    for (const [m, u] of [['GET', '/lan/api/tools/status'], ['GET', '/lan/api/tools/jobs'], ['POST', '/lan/api/tools/jobs']] as const) {
      expect(L.env.app.hasRoute({ method: m, url: u })).toBe(false);
      expect((await L.env.app.inject({ method: m, url: u, headers: { host: 'localhost:8787' } })).statusCode).toBe(404);
    }
    expect(L.lan.hasRoute({ method: 'GET', url: '/api/lan' })).toBe(false);
  });
});

run('công cụ Xoá logo Veo: tải lên, xử lý, hàng đợi', () => {
  beforeEach(() => mk());

  it('luồng đầy đủ: upload → queued → processing (tiến độ) → ready; bản sạch đúng thời lượng, có âm thanh, tải được (Range); CLI chạy đúng tham số', async () => {
    const seen: [string, number | null][] = [];
    const up = await post(c1, 'Cảnh 1 (bản cuối).mov', movOf(clip(3)));
    expect(up.status, up.raw).toBe(201);
    const job = up.body.job;
    expect(job).toMatchObject({ kind: 'remove_logo', original_name: 'Cảnh 1 (bản cuối).mov', created_by_name: 'Minh', error: null, output: null, can_retry: false });
    expect(['queued', 'processing']).toContain(job.status); // hàng đợi rảnh thì chạy ngay trong lúc trả lời
    expect(job.input).toMatchObject({ width: 160, height: 284, has_audio: true });
    expect(job.expires_at).toBe(new Date(Date.parse(job.created_at) + 7 * 86400_000).toISOString());
    const poll = setInterval(() => {
      const r = toolRow(job.id);
      if (r && !seen.some(([s, p]) => s === r.status && p === r.progress)) seen.push([r.status, r.progress]);
    }, 2);
    await idle();
    clearInterval(poll);
    const done = await get(c1, job.id);
    expect(done).toMatchObject({ status: 'ready', progress: 100, error: null, queue_ahead: null });
    expect(done.output).toMatchObject({ url: `/lan/files/output/lan-tools/${job.id}/clean.mp4` });
    expect(done.output.bytes).toBeGreaterThan(0);
    expect(Math.abs(done.output.duration_s - done.input.duration_s)).toBeLessThan(0.3);
    expect(seen.some(([s]) => s === 'processing')).toBe(true);
    expect(seen.filter(([s, p]) => s === 'processing' && (p ?? 0) > 0).length).toBeGreaterThan(0); // có tiến độ giữa chừng
    // file: input giữ nguyên tên đuôi, bản sạch có video + âm thanh, không còn file tạm
    expect(fs.readdirSync(toolDir(job.id)).sort()).toEqual(['clean.mp4', 'input.mov']);
    const probe = ffprobeJson(path.join(toolDir(job.id), 'clean.mp4'));
    expect(probe.streams.some((s: any) => s.codec_type === 'video')).toBe(true);
    expect(probe.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    const full = await c1.get(done.output.url);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toContain('video/mp4');
    expect((await c1.get(done.output.url, { range: 'bytes=0-9' })).status).toBe(206);
    // CLI: lệnh remove, input là file trong thư mục việc, output tạm trong cùng thư mục, có --json
    const [call] = removeCalls();
    expect(removeCalls()).toHaveLength(1);
    expect(call.argv.slice(0, 5)).toEqual(['remove', path.join(toolDir(job.id), 'input.mov'), '--output', path.join(toolDir(job.id), '.clean.tmp.mp4'), '--json']);
    expect(call.argv).toEqual(expect.arrayContaining(['--video-timeout-ms', '60000']));
    // việc này không tạo job AI nào, không tốn credit
    expect((db().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0);
  });

  it('tải lên kiểm tra kỹ: sai loại, hỏng, quá ngắn (<1s), quá dài (>120s), quá dung lượng, tên lạ; không để lại file tạm và không tạo việc', async () => {
    const cases: [string, Buffer, number, string][] = [
      ['a.mp4', Buffer.from('không phải video'), 415, 'UNSUPPORTED_FILE_TYPE'],
      ['b.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(300, 3)]), 422, 'INVALID_VIDEO'],
      ['ngan.mp4', clip(0.5), 422, 'VIDEO_DURATION'],
      ['dai.mp4', clip(125, { audio: false }), 422, 'VIDEO_DURATION'],
      ['../x.mp4', clip(2), 400, 'INVALID_FILENAME'],
    ];
    for (const [name, data, status, code] of cases) {
      const r = await post(c1, name, data);
      expect([name, r.status, r.body.error?.code]).toEqual([name, status, code]);
    }
    L.env.ctx.config.lanVideoMaxBytes = 32 * 1024;
    const big = await post(c1, 'to.mp4', Buffer.concat([clip(3).subarray(0, 64), Buffer.alloc(100 * 1024)]));
    expect([big.status, big.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    L.env.ctx.config.lanVideoMaxBytes = 200 * 1024 * 1024;
    expect((db().prepare('SELECT COUNT(*) AS n FROM lan_tool_jobs').get() as { n: number }).n).toBe(0);
    const incoming = path.join(L.env.root, 'output', 'lan-tools', '.incoming');
    expect(fs.existsSync(incoming) ? fs.readdirSync(incoming) : []).toEqual([]);
    // đúng 120 giây vẫn nhận; không file → 400
    expect((await post(c1, 'dai-vua.mp4', clip(120, { audio: false }))).status).toBe(201);
    expect((await c1.postRaw('/lan/api/tools/jobs', '{}', { 'content-type': 'application/json' })).status).toBe(400);
  });

  it('lỗi tool → failed (không lộ đường dẫn), giữ input; Thử lại chạy lại được; hủy/thử lại việc đã xong → 409', async () => {
    process.env.FAKE_GWR_MODE = 'fail';
    const up = await post(c1);
    const id = up.body.job.id as number;
    await idle();
    let j = await get(c1, id);
    expect(j).toMatchObject({ status: 'failed', can_retry: true, output: null });
    expect(j.error).toContain('Xoá logo Veo thất bại');
    expect(j.error).not.toContain(L.env.root);
    expect(fs.existsSync(path.join(toolDir(id), 'input.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(toolDir(id), '.clean.tmp.mp4'))).toBe(false);
    expect((await c1.post(`/lan/api/tools/jobs/${id}/cancel`, {})).status).toBe(409);

    process.env.FAKE_GWR_MODE = 'ok';
    const r = await c1.post(`/lan/api/tools/jobs/${id}/retry`, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.job).toMatchObject({ status: 'queued', error: null });
    await idle();
    j = await get(c1, id);
    expect(j).toMatchObject({ status: 'ready', progress: 100 });
    expect((await c1.post(`/lan/api/tools/jobs/${id}/retry`, {})).body.error.code).toBe('INVALID_STATE');
    expect(removeCalls()).toHaveLength(2);
  });

  it('hủy việc đang chạy: dừng cả cây tiến trình của tool, xoá file tạm, giữ input; thử lại sau hủy chạy được', async () => {
    process.env.FAKE_GWR_MODE = 'hang';
    const up = await post(c1);
    const id = up.body.job.id as number;
    await waitFor(() => toolRow(id).status === 'processing' && fs.existsSync(process.env.FAKE_GWR_CHILD_PID!));
    const child = Number(fs.readFileSync(process.env.FAKE_GWR_CHILD_PID!, 'utf8'));
    expect(alive(child)).toBe(true);
    const r = await c1.post(`/lan/api/tools/jobs/${id}/cancel`, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.job.status).toBe('cancelled');
    await waitFor(() => !alive(child), 8000);
    await idle();
    expect(await get(c1, id)).toMatchObject({ status: 'cancelled', can_retry: true, output: null, error: null });
    expect(fs.existsSync(path.join(toolDir(id), 'input.mp4'))).toBe(true);
    expect(fs.readdirSync(toolDir(id)).filter((f) => f.includes('tmp'))).toEqual([]);

    process.env.FAKE_GWR_MODE = 'ok';
    expect((await c1.post(`/lan/api/tools/jobs/${id}/retry`, {})).status).toBe(200);
    await idle();
    expect((await get(c1, id)).status).toBe('ready');
  });

  it('việc đang chờ trong hàng đợi hủy được ngay (không bao giờ chạy tool)', async () => {
    await blockQueue();
    const up = await post(c1);
    const id = up.body.job.id as number;
    expect((await get(c1, id))).toMatchObject({ status: 'queued', queue_ahead: 2 }); // 1 việc render đang chạy + chính nó
    expect((await c1.post(`/lan/api/tools/jobs/${id}/cancel`, {})).body.job.status).toBe('cancelled');
    fake.release();
    await idle();
    expect(removeCalls()).toHaveLength(0);
    expect((await get(c1, id)).status).toBe('cancelled');
  });

  it('CHUNG hàng đợi render: việc công cụ chờ sau bản dựng đang render; việc của app chính (đến sau) chạy TRƯỚC việc LAN đang chờ; FIFO trong từng nhóm', async () => {
    const x = await blockQueue(); // app X đang render (giữ)
    expect(L.env.ctx.finalRender!.position('cut', 1)).toBe(0);
    const up1 = await post(c1); // LAN tool T1 (chờ)
    const up2 = await post(c2); // LAN tool T2 (chờ, sau T1)
    // thêm hai bản dựng của app SAU các việc LAN: phải đứng trước chúng
    const y = await setupAllDone(L.env, { scenes: 1 });
    const jy = await claimEditPlan(y);
    const cy = (await y.user.get(`/api/final-cuts/${jy.payload.final_cut_id}`)).body;
    await y.worker.post(`/api/worker/jobs/${jy.id}/complete`, { result: { edl: edlFor(y, cy), summary: 'y' } });
    const rf = L.env.ctx.finalRender!;
    const t1 = up1.body.job.id as number;
    const t2 = up2.body.job.id as number;
    expect(rf.position('cut', cy.id)).toBe(2); // sau X đang chạy, trước cả hai việc LAN
    expect(rf.position('tool', t1)).toBe(3);
    expect(rf.position('tool', t2)).toBe(4);
    expect(rf.lanLoad()).toBe(2);
    fake.release();
    await idle();
    expect(fake.calls.map((k) => k.cutId)).toEqual([1, cy.id]);
    expect(await get(c1, t1)).toMatchObject({ status: 'ready' });
    expect(await get(c2, t2)).toMatchObject({ status: 'ready' });
    void x;
  });

  it('RENDER_CONCURRENCY=1: mỗi lúc MỘT việc: hai việc công cụ không bao giờ cùng ở trạng thái processing', async () => {
    const a = await post(c1);
    const b = await post(c2);
    let maxProcessing = 0;
    const poll = setInterval(() => {
      const n = (db().prepare("SELECT COUNT(*) AS n FROM lan_tool_jobs WHERE status = 'processing'").get() as { n: number }).n;
      maxProcessing = Math.max(maxProcessing, n);
    }, 1);
    await idle();
    clearInterval(poll);
    expect(maxProcessing).toBe(1);
    expect((await get(c1, a.body.job.id)).status).toBe('ready');
    expect((await get(c2, b.body.job.id)).status).toBe('ready');
    expect(removeCalls()).toHaveLength(2);
  });

  it(`trần hàng đợi toàn cục 6 (cả việc công cụ lẫn bản dựng LAN) → 429 "Hàng đợi đang đầy, thử lại sau"; không nhận file khi đầy`, async () => {
    await blockQueue();
    const ids: number[] = [];
    const clients: LanClient[] = [];
    for (let i = 0; i < 6; i++) {
      const cl = L.client({ ip: `192.168.2.${i + 1}`, cookie: c1.cookie!.split('; ')[0] });
      clients.push(cl);
      const r = await post(cl);
      expect(r.status, `việc ${i + 1}: ${r.raw}`).toBe(201);
      ids.push(r.body.job.id);
    }
    const seventh = L.client({ ip: '192.168.2.99', cookie: c1.cookie!.split('; ')[0] });
    const r = await post(seventh);
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([429, 'QUEUE_FULL', 'Hàng đợi đang đầy, thử lại sau']);
    expect((db().prepare('SELECT COUNT(*) AS n FROM lan_tool_jobs').get() as { n: number }).n).toBe(6);
    const incoming = path.join(L.env.root, 'output', 'lan-tools', '.incoming');
    expect(fs.existsSync(incoming) ? fs.readdirSync(incoming) : []).toEqual([]);
    // thử lại việc lỗi cũng chịu trần: hủy một việc rồi nạp lại cho đủ 6
    const cl0 = clients[0]!;
    expect((await cl0.post(`/lan/api/tools/jobs/${ids[0]}/cancel`, {})).status).toBe(200);
    expect((await post(seventh)).status).toBe(201); // còn chỗ
    expect((await cl0.post(`/lan/api/tools/jobs/${ids[0]}/retry`, {})).body.error.code).toBe('QUEUE_FULL');
    expect((await c1.get('/lan/api/tools/status')).body.queue).toMatchObject({ tools: 6, total: 6, cap: 6 });
    fake.release();
    await idle();
  });

  it(`giới hạn ${LAN_RATE.removeLogo.max} lần mỗi giờ theo IP cho xoá logo (việc mới + thử lại); IP khác không bị ảnh hưởng; hết giờ dùng lại được`, async () => {
    await blockQueue(); // giữ việc ở queued để hủy gọn
    for (let i = 0; i < LAN_RATE.removeLogo.max; i++) {
      const r = await post(c1);
      expect(r.status, `lượt ${i + 1}: ${r.raw}`).toBe(201);
      expect((await c1.post(`/lan/api/tools/jobs/${r.body.job.id}/cancel`, {})).status).toBe(200);
    }
    const over = await post(c1);
    expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    const first = db().prepare('SELECT id FROM lan_tool_jobs ORDER BY id LIMIT 1').get() as { id: number };
    expect((await c1.post(`/lan/api/tools/jobs/${first.id}/retry`, {})).body.error.code).toBe('RATE_LIMITED'); // thử lại cũng tính
    expect((await c1.get('/lan/api/tools/status')).body.remove_logo.remaining).toBe(0);
    expect((await post(c2)).status).toBe(201); // IP khác
    L.env.clock.advance(61 * 60_000);
    expect((await post(c1)).status).toBe(201);
    fake.release();
    await idle();
  });

  it('dọn 7 ngày: xoá file và đánh dấu expired; việc mới hơn và việc đang chạy giữ nguyên; file tải dở bị bỏ quên được dọn', async () => {
    const a = await post(c1);
    await idle();
    const idA = a.body.job.id as number;
    L.env.clock.advance(4 * 86400_000);
    await c1.login(); // phiên 12 giờ đã hết hạn theo đồng hồ giả; cookie client (400 ngày) vẫn còn
    const b = await post(c1);
    await idle();
    const idB = b.body.job.id as number;
    await blockQueue();
    await c2.login();
    const running = await post(c2); // đang chờ (queued) — không bị dọn dù cũ
    const idQ = running.body.job.id as number;
    // file tải dở bị bỏ quên trong .incoming
    const incoming = path.join(L.env.root, 'output', 'lan-tools', '.incoming');
    fs.mkdirSync(incoming, { recursive: true });
    const stale = path.join(incoming, '.lan-upload-aaaa1111.tmp');
    const freshTmp = path.join(incoming, '.lan-upload-bbbb2222.tmp');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(freshTmp, 'y');
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(stale, old, old);

    L.env.clock.advance(4 * 86400_000); // A = 8 ngày, B = 4 ngày
    expect(expireToolJobs(L.env.ctx)).toEqual({ expired: 1, staleTmp: 1 });
    expect(toolRow(idA)).toMatchObject({ status: 'expired', input_path: null, output_path: null });
    expect(fs.existsSync(toolDir(idA))).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(toolRow(idB).status).toBe('ready');
    expect(fs.existsSync(path.join(toolDir(idB), 'clean.mp4'))).toBe(true);
    expect(toolRow(idQ).status).toBe('queued');
    await c1.login(); // đồng hồ giả đã nhảy thêm 4 ngày
    const j = await get(c1, idA);
    expect(j).toMatchObject({ status: 'expired', output: null, can_retry: false });
    expect((await c1.get(`/lan/files/output/lan-tools/${idA}/clean.mp4`)).status).toBe(404);
    expect((await c1.post(`/lan/api/tools/jobs/${idA}/retry`, {})).body.error.message).toContain('hết hạn');
    expect(expireToolJobs(L.env.ctx)).toEqual({ expired: 0, staleTmp: 0 }); // idempotent
    fake.release();
    await idle();
  });
});

run('công cụ Xoá logo Veo: khởi động lại và tool tắt', () => {
  it('server khởi động lại giữa lúc xử lý/đang chờ → failed (giữ input, dọn file tạm); Thử lại hoạt động', async () => {
    await mk();
    await blockQueue();
    const queued = await post(c1);
    const idQ = queued.body.job.id as number;
    // giả lập việc đang xử lý của tiến trình cũ: có file tạm dở
    const proc = await post(c2);
    const idP = proc.body.job.id as number;
    db().prepare("UPDATE lan_tool_jobs SET status = 'processing', progress = 40 WHERE id = ?").run(idP);
    fs.writeFileSync(path.join(toolDir(idP), '.clean.tmp.mp4'), 'dở');
    const restarted = await L.env.second({ finalRenderer: new FakeRenderer(), finalRender: { progressThrottleMs: 0, checkTtlMs: 0 } });
    for (const id of [idQ, idP]) {
      expect(toolRow(id)).toMatchObject({ status: 'failed', progress: null, error: 'Server khởi động lại trong lúc xử lý; bấm Thử lại' });
      expect(fs.existsSync(path.join(toolDir(id), 'input.mp4'))).toBe(true);
    }
    expect(fs.existsSync(path.join(toolDir(idP), '.clean.tmp.mp4'))).toBe(false);
    expect(recoverToolJobs(restarted.ctx)).toBe(0); // idempotent
    expect((await get(c1, idQ)).can_retry).toBe(true);
    expect((await c1.post(`/lan/api/tools/jobs/${idQ}/retry`, {})).status).toBe(200);
    fake.release();
    await idle();
    expect((await get(c1, idQ)).status).toBe('ready');
    await restarted.close();
  });

  it('tool tắt (WATERMARK_REMOVER=off) hoặc hỏng: trạng thái nêu lý do (không lộ đường dẫn), tải lên/thử lại bị 409 và không nhận file', async () => {
    await mk({ gwr: 'off' });
    let s = (await c1.get('/lan/api/tools/status')).body;
    expect(s.remove_logo).toMatchObject({ available: false, reason: 'Chủ máy đã tắt bước xoá logo Veo', max_bytes: 200 * 1024 * 1024, min_s: 1, max_s: 120 });
    const r = await post(c1);
    expect([r.status, r.body.error.code]).toEqual([409, 'WATERMARK_REMOVER_UNAVAILABLE']);
    expect((db().prepare('SELECT COUNT(*) AS n FROM lan_tool_jobs').get() as { n: number }).n).toBe(0);
    await L.close();

    await mk({ gwr: false });
    s = (await c1.get('/lan/api/tools/status')).body;
    expect(s.remove_logo).toMatchObject({ available: false });
    expect(s.remove_logo.reason).not.toContain('/khong/co');
    expect((await post(c1)).body.error.code).toBe('WATERMARK_REMOVER_UNAVAILABLE');
    await L.close();

    await mk();
    s = (await c1.get('/lan/api/tools/status')).body;
    expect(s).toMatchObject({ remove_logo: { available: true, reason: null, remaining: 6 }, queue: { total: 0, cap: 6 }, retention_days: 7 });
  });
});
