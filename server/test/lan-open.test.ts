import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG_BYTES, WORKER_TOKEN, setupProject, userClient, writeFile } from './helpers.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';
import { makeLanPlan } from './helpers-lan-plan.js';

/**
 * Giao diện app (listener planner, 127.0.0.1): không đăng nhập, không phiên. Các bảo vệ vẫn giữ: Host loopback, Origin cho request ghi,
 * chặn cross-site, CSP, danh sách file được phép, API chính không lộ.
 */
let L: LanEnv;
afterEach(async () => {
  delete process.env.FAKE_GWR_HELP;
  await L?.close();
});

const open = (o: Parameters<typeof makeLanEnv>[0] = {}) => makeLanEnv(o);
const setCookies = (r: { headers: Record<string, unknown> }): string[] => {
  const sc = r.headers['set-cookie'];
  return Array.isArray(sc) ? (sc as string[]) : sc ? [String(sc)] : [];
};

describe('mọi route dùng được ngay, không đăng nhập', () => {
  it('không đăng nhập vẫn đọc/ghi: danh sách, tạo kế hoạch, ảnh tham chiếu, phân tích, trạng thái, tải kế hoạch; không bao giờ có cookie phiên', async () => {
    L = await open();
    const c = L.client();
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
    // không có route đăng nhập/phiên; không phản hồi nào đặt cookie phiên
    for (const u of ['/lan/api/login', '/lan/api/logout']) expect((await c.post(u, {})).status).toBe(404);
    expect((await c.get('/lan/api/session')).status).toBe(404);
    for (const r of responses) expect(setCookies(r).filter((l) => l.startsWith('autovideo_lan=')), r.raw).toEqual([]);
  });



});

describe('các bảo vệ của listener giao diện', () => {
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


