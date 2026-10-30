import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LAN_RATE } from '../src/lan/routes.js';
import { LAN_QUEUE_CAP } from '../src/services/lan-queue.js';
import { PNG_BYTES, WORKER_TOKEN, setupProject, userClient, writeFile } from './helpers.js';
import { LAN_CODE, makeLanEnv, type LanEnv } from './helpers-lan.js';
import { makeLanPlan } from './helpers-lan-plan.js';

/**
 * Trang planner LAN MỞ, KHÔNG CẦN MÃ (LAN_REQUIRE_CODE=false, mặc định): không đăng nhập, không phiên. Mọi bảo vệ khác vẫn giữ:
 * Host, Origin cho request ghi, chặn cross-site, CSP, rate limit theo IP, trần hàng đợi, danh sách file được phép, app chính không lộ.
 */
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-gwr.mjs', import.meta.url));
let L: LanEnv;
afterEach(async () => {
  delete process.env.FAKE_GWR_HELP;
  await L?.close();
});

const open = (o: Parameters<typeof makeLanEnv>[0] = {}) => makeLanEnv({ ...o, config: { lanRequireCode: false, ...o.config } });
const setCookies = (r: { headers: Record<string, unknown> }): string[] => {
  const sc = r.headers['set-cookie'];
  return Array.isArray(sc) ? (sc as string[]) : sc ? [String(sc)] : [];
};

describe('không cần mã: mọi route dùng được ngay', () => {
  it('không đăng nhập vẫn đọc/ghi: danh sách, tạo kế hoạch, ảnh tham chiếu, phân tích, trạng thái, tải kế hoạch; không bao giờ có cookie phiên', async () => {
    L = await open();
    const c = L.client(); // KHÔNG login
    expect(c.cookie).toBeNull();
    const responses = [
      await c.get('/lan/api/plans'),
      await c.get('/lan/api/status'),
      await c.get('/lan/api/ref-library'),
      await c.get('/lan/api/tools/status'),
    ];
    for (const r of responses) expect(r.status, r.raw).toBe(200);
    const fx = await makeLanPlan(L, c, 2, 'Không cần mã');
    expect((await c.get(`/lan/api/plans/${fx.plan.id}`)).status).toBe(200);
    expect((await c.get(`/lan/api/plans/${fx.plan.id}/plan.md`)).status).toBe(200);
    const up = await c.upload(`/lan/api/plans/${fx.plan.id}/refs`, [{ name: 'hop.png', data: PNG_BYTES, label: 'Hộp' }]);
    expect(up.status, up.raw).toBe(201);
    expect((await c.get(up.body[0].url)).status).toBe(200); // ảnh tham chiếu của kế hoạch LAN tải được
    expect((await c.post(`/lan/api/plans/${fx.plan.id}/analyze`, {})).status).toBeLessThan(500);
    // không phản hồi nào (kể cả đăng nhập) đặt cookie phiên
    const all = [...responses, await c.post('/lan/api/login', { code: 'sai-bet' }), await c.post('/lan/api/login', {}), await c.post('/lan/api/logout')];
    for (const r of all) expect(setCookies(r).filter((l) => l.startsWith('autovideo_lan=') && !/Max-Age=0/.test(l)), r.raw).toEqual([]);
  });

  it('GET /lan/api/session: luôn authenticated:true, code_required:false, KHÔNG có hạn phiên; status báo code_required=false', async () => {
    L = await open();
    const r = await L.client().get('/lan/api/session');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ authenticated: true, code_required: false, expires_at: null });
    expect((await L.client({ cookie: 'autovideo_lan=gia' }).get('/lan/api/session')).body).toEqual({ authenticated: true, code_required: false, expires_at: null });
    expect((await L.client().get('/lan/api/status')).body).toMatchObject({ code_required: false });
  });

  it('POST /lan/api/login (bản trang cũ còn mở): trả ok, không tạo phiên, không đọc mã, không tính vào hạn mức sai mã', async () => {
    L = await open();
    const c = L.client({ ip: '192.168.1.90' });
    for (let i = 0; i < LAN_RATE.loginFailures.max + 3; i++) {
      const r = await c.post('/lan/api/login', { code: `sai${i}` });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, code_required: false, expires_at: null });
      expect(setCookies(r)).toEqual([]);
    }
    expect((await c.get('/lan/api/plans')).status).toBe(200);
    // Origin vẫn bắt buộc cho request ghi, kể cả đăng nhập
    expect((await L.client({ origin: 'http://evil.com' }).post('/lan/api/login', { code: LAN_CODE })).status).toBe(403);
  });

  it('LAN_REQUIRE_CODE=true: hoạt động như cũ (cần mã, phiên 12 giờ); trang biết code_required=true', async () => {
    L = await makeLanEnv(); // mặc định của helper: đòi mã
    const anon = L.client();
    expect((await anon.get('/lan/api/plans')).status).toBe(401);
    expect((await anon.get('/lan/api/session')).body).toEqual({ authenticated: false, code_required: true });
    expect((await anon.login('sai')).status).toBe(401);
    const ok = await anon.login();
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, code_required: true, expires_at: expect.any(String) });
    expect(setCookies(ok)[0]).toMatch(/^autovideo_lan=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/lan; Max-Age=43200$/);
    expect((await anon.get('/lan/api/plans')).status).toBe(200);
    expect((await anon.get('/lan/api/session')).body).toMatchObject({ authenticated: true, code_required: true });
    expect((await anon.get('/lan/api/status')).body).toMatchObject({ code_required: true });
  });
});

describe('không cần mã: các bảo vệ còn lại vẫn đúng', () => {
  it('Host lạ → 403; request ghi thiếu/sai Origin → 403 (không có tác dụng); API từ trang khác (cross-site) → 403, mở trang thì được', async () => {
    L = await open();
    for (const host of ['evil.com', 'localhost.evil.com:8790', '192.168.1.5.nip.io']) {
      const r = await L.client({ host, origin: `http://${host}` }).get('/lan/api/plans');
      expect([r.status, r.body.error.code], host).toEqual([403, 'FORBIDDEN_HOST']);
      expect((await L.client({ host }).get('/')).status, host).toBe(403);
    }
    for (const origin of [null, 'http://evil.com', 'null', 'http://192.168.1.51:8790', 'http://localhost:8787']) {
      const r = await L.client({ origin }).post('/lan/api/plans', { name: 'X', created_by_name: 'Y', brief: 'b' });
      expect([r.status, r.body.error.code], String(origin)).toEqual([403, 'FORBIDDEN_ORIGIN']);
    }
    expect((L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE source = 'lan'").get() as { n: number }).n).toBe(0);
    expect((await L.client().get('/lan/api/plans', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await L.client().get('/lan/api/plans', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await L.client().get('/', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  });

  it('header an toàn (CSP, nosniff, DENY, no-referrer, no-store cho API) vẫn có trên mọi phản hồi', async () => {
    L = await open();
    for (const r of [await L.client().get('/'), await L.client().get('/lan/api/plans'), await L.client().get('/khong-co')]) {
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
    expect((await L.client().get('/lan/api/plans')).headers['cache-control']).toBe('no-store');
  });

  it('app chính vẫn không lộ: mọi đường dẫn /api/*, /files/* trên listener LAN là 404 (không phải 401), không đổi gì', async () => {
    L = await open();
    const sc = await setupProject(L.env, { scenes: 2 });
    writeFile(L.env.root, 'output/cacao-actiso-plus/video/C1_v1.mp4', 'video-that');
    const c = L.client();
    const before = JSON.stringify((await userClient(L.env.app).get('/api/jobs')).body);
    for (const url of ['/api/projects', `/api/projects/${sc.project.id}`, '/api/jobs', '/api/worker/ping', '/api/worker/next', '/api/ai/accounts', '/api/meta', '/api/lan', '/api/stream', '/files/output/cacao-actiso-plus/video/C1_v1.mp4', '/index.html', '/secret.txt']) {
      const r = await c.get(url, { authorization: `Bearer ${WORKER_TOKEN}` });
      expect(r.status, `GET ${url}`).toBe(404);
      expect(r.raw).not.toContain('Cacao Actiso');
    }
    for (const url of ['/api/projects', '/api/queue/pause', '/api/worker/scenes', `/api/projects/${sc.project.id}/final-cuts`]) {
      expect((await c.post(url, {}, { authorization: `Bearer ${WORKER_TOKEN}` })).status, `POST ${url}`).toBe(404);
    }
    expect(JSON.stringify((await userClient(L.env.app).get('/api/jobs')).body)).toBe(before);
    // ngược lại app chính không có route planner
    expect((await userClient(L.env.app).get('/lan/api/plans')).status).toBe(404);
  });

  it('danh sách file được phép vẫn áp dụng: file của dự án app, file mồ côi, traversal → 404; ảnh của kế hoạch LAN → 200', async () => {
    L = await open();
    const c = L.client();
    const fx = await makeLanPlan(L, c, 1);
    const up = await c.upload(`/lan/api/plans/${fx.plan.id}/refs`, [{ name: 'hop.png', data: PNG_BYTES, label: 'Hộp' }]);
    expect((await c.get(up.body[0].url)).status).toBe(200);
    await setupProject(L.env, { scenes: 1, project: { name: 'Dự án của chủ máy' } });
    writeFile(L.env.root, 'refs/999/rieng.png', PNG_BYTES);
    writeFile(L.env.root, 'output/mo-coi/x.mp4', 'x');
    for (const url of ['/lan/files/refs/999/rieng.png', '/lan/files/output/mo-coi/x.mp4', '/lan/files/output/../data/test.db', '/lan/files/%2e%2e/secret', '/lan/files/refs/', '/lan/files/data/test.db']) {
      expect((await c.get(url)).status, url).toBe(404);
    }
  });

  it('rate limit theo IP vẫn áp dụng: tạo kế hoạch tối đa 20/giờ/IP, IP khác không bị ảnh hưởng; trang/status hiển thị hạn mức còn lại', async () => {
    L = await open();
    const c = L.client({ ip: '192.168.1.61' });
    for (let i = 0; i < LAN_RATE.createPlan.max; i++) expect((await c.post('/lan/api/plans', { name: `K${i}`, created_by_name: 'A', brief: 'b' })).status, `lượt ${i + 1}`).toBe(201);
    const over = await c.post('/lan/api/plans', { name: 'dư', created_by_name: 'A', brief: 'b' });
    expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await L.client({ ip: '192.168.1.62' }).post('/lan/api/plans', { name: 'khác', created_by_name: 'B', brief: 'b' })).status).toBe(201);
    expect((await c.get('/lan/api/status')).body.rate.createPlan.max).toBe(20);
  });

  it(`trần hàng đợi LAN ${LAN_QUEUE_CAP} vẫn áp dụng: đầy → 429 QUEUE_FULL, không nhận file`, async () => {
    process.env.FAKE_GWR_HELP = 'ok';
    L = await open({ config: { gwrCli: FAKE_CLI, watermarkRemover: 'auto', gwrTimeoutMs: 60_000 } });
    const ins = L.env.ctx.db.prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'queued', 'v.mp4', 'h', '{}', ?)");
    for (let i = 0; i < LAN_QUEUE_CAP; i++) ins.run(L.env.ctx.now());
    const r = await L.client().uploadVideo('/lan/api/tools/jobs', { name: 'a.mp4', data: Buffer.from('khong-can-doc') }, { created_by_name: 'A' });
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([429, 'QUEUE_FULL', 'Hàng đợi đang đầy, thử lại sau']);
    expect((L.env.ctx.db.prepare('SELECT COUNT(*) AS n FROM lan_tool_jobs').get() as { n: number }).n).toBe(LAN_QUEUE_CAP);
  });
});

describe('cookie client ẩn danh (quyền xem việc xoá logo) giữ, Max-Age 400 ngày', () => {
  it('cấp lười khi gọi route công cụ, HttpOnly; SameSite=Strict; Path=/lan; Max-Age=34560000; chỉ đúng trình duyệt thấy/hủy việc của mình; trình duyệt khác 404', async () => {
    L = await open();
    const a = L.client({ ip: '192.168.1.71' });
    const b = L.client({ ip: '192.168.1.72' });
    const first = await a.get('/lan/api/tools/jobs');
    expect(first.status).toBe(200);
    const line = setCookies(first).find((l) => l.startsWith('autovideo_lan_client='))!;
    expect(line).toMatch(/^autovideo_lan_client=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/lan; Max-Age=34560000$/);
    expect(Number(/Max-Age=(\d+)/.exec(line)![1])).toBe(400 * 24 * 60 * 60);
    expect(setCookies(await a.get('/lan/api/tools/jobs'))).toEqual([]); // có rồi thì không cấp lại

    const hash = crypto.createHash('sha256').update(line.split(';')[0]!.split('=')[1]!).digest('hex');
    const id = Number(
      L.env.ctx.db
        .prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'failed', 'v.mp4', ?, '{}', ?)")
        .run(hash, L.env.ctx.now()).lastInsertRowid,
    );
    expect((await a.get('/lan/api/tools/jobs')).body.map((j: any) => j.id)).toEqual([id]);
    expect((await a.get(`/lan/api/tools/jobs/${id}`)).status).toBe(200);
    expect((await b.get('/lan/api/tools/jobs')).body).toEqual([]);
    expect((await b.get(`/lan/api/tools/jobs/${id}`)).status).toBe(404);
    expect((await b.post(`/lan/api/tools/jobs/${id}/cancel`, {})).status).toBe(404);
  });
});

describe('khối "Chia sẻ LAN" ở app chính (GET /api/lan)', () => {
  it('không cần mã: require_code=false và access_code=null dù .env còn LAN_ACCESS_CODE; cần mã: có mã', async () => {
    L = await open({ config: { lanAccessCode: 'ABCD2345' } });
    L.env.ctx.config.lanEnabled = true;
    const r = await userClient(L.env.app).get('/api/lan');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, require_code: false, access_code: null });
    expect(r.raw).not.toContain('ABCD2345');
    L.env.ctx.config.lanRequireCode = true;
    expect((await userClient(L.env.app).get('/api/lan')).body).toMatchObject({ require_code: true, access_code: 'ABCD2345' });
  });
});

describe('cấu hình LAN_REQUIRE_CODE', () => {
  it('buildLanApp: không đòi mã thì không cần LAN_ACCESS_CODE; đòi mã mà trống/yếu thì từ chối; cổng trùng app chính vẫn từ chối', async () => {
    L = await open();
    const { buildLanApp } = await import('../src/lan/app.js');
    const base = L.env.ctx.config;
    const app = await buildLanApp({ ...L.env.ctx, config: { ...base, lanAccessCode: '', lanRequireCode: false } } as never, { logger: false });
    await app.close();
    await expect(buildLanApp({ ...L.env.ctx, config: { ...base, lanAccessCode: '', lanRequireCode: true } } as never, { logger: false })).rejects.toThrow(/LAN_REQUIRE_CODE=true.*LAN_ACCESS_CODE/);
    await expect(buildLanApp({ ...L.env.ctx, config: { ...base, lanAccessCode: 'abc', lanRequireCode: true } } as never, { logger: false })).rejects.toThrow(/ít nhất 6/);
    await expect(buildLanApp({ ...L.env.ctx, config: { ...base, lanAccessCode: '', lanRequireCode: false, lanPort: base.port } } as never, { logger: false })).rejects.toThrow(/khác PORT/);
  });

  it('mở trang không cần mã thật sự độc lập với mã: có mã trong cấu hình nhưng không đòi thì mã đúng/sai đều không đổi gì', async () => {
    L = await open({ config: { lanAccessCode: LAN_CODE } });
    const c = L.client();
    expect((await c.get('/lan/api/plans')).status).toBe(200);
    expect((await c.login(LAN_CODE)).body.code_required).toBe(false);
    expect((await c.login('khong-dung')).status).toBe(200);
  });
});
