import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLanHostAllowed, isOriginAllowed } from '../src/lan/security.js';
import { codeMatches } from '../src/lan/session.js';
import { SlidingWindowLimiter } from '../src/lan/rate-limit.js';
import { PNG_BYTES, WORKER_TOKEN, setupProject, userClient, writeFile } from './helpers.js';
import { LAN_CODE, LAN_HOST, LAN_ORIGIN, makeLanEnv, type LanEnv } from './helpers-lan.js';

let L: LanEnv;
beforeEach(async () => {
  L = await makeLanEnv();
});
afterEach(async () => {
  await L.close();
});

/** Danh sách (method, đường dẫn đầy đủ) của một Fastify instance, dựng lại từ cây printRoutes. */
async function routeTable(app: FastifyInstance): Promise<{ method: string; path: string }[]> {
  await app.ready();
  const out: { method: string; path: string }[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^((?:[│ ] {3})*)[├└]── (.+?) \(([A-Z, ]+)\)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    for (const method of m[3]!.split(', ')) if (method !== 'HEAD') out.push({ method, path: stack.join('') });
  }
  return out;
}

describe('đăng nhập bằng mã truy cập', () => {
  it('mọi route (kể cả đọc) đều cần phiên, trừ trang, assets build và đăng nhập', async () => {
    const anon = L.client();
    for (const url of ['/lan/api/plans', '/lan/api/plans/1', '/lan/api/status', '/lan/api/ref-library', '/lan/api/plans/1/plan.md', '/lan/api/plans/1/refs.zip', '/lan/files/refs/1/a.png', '/lan/api/khong-co', '/api/projects']) {
      const r = await anon.get(url);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code, url).toBe('UNAUTHENTICATED');
    }
    for (const url of ['/lan/api/plans', '/lan/api/plans/1/refs', '/lan/api/plans/1/analyze', '/lan/api/plans/1/scenes/1/storyboard', '/lan/api/plans/1/refs/from-library', '/lan/api/logout']) {
      expect((await anon.post(url, {})).status, url).toBe(401);
    }
    expect((await anon.get('/')).status).toBe(200);
    expect((await anon.get('/')).raw).toContain('planner');
    expect((await anon.get('/planner.html')).status).toBe(200);
    expect((await anon.get('/assets/planner-abc123.js')).status).toBe(200);
  });

  it('dò phiên công khai: chưa đăng nhập → 200 {authenticated:false}, không lộ gì thêm', async () => {
    const r = await L.client().get('/lan/api/session');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ authenticated: false, code_required: true });
    expect((await L.client({ cookie: 'autovideo_lan=gia' }).get('/lan/api/session')).body).toEqual({ authenticated: false, code_required: true });
  });

  it('mã sai → 401, không có cookie; mã đúng (không phân biệt hoa thường, bỏ khoảng trắng) → cookie HttpOnly; SameSite=Strict, 12 giờ', async () => {
    const c = L.client();
    const bad = await c.login('SAIMAKHAC');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CODE');
    expect(bad.headers['set-cookie']).toBeUndefined();
    expect((await c.get('/lan/api/plans')).status).toBe(401);

    const ok = await c.login(`  ${LAN_CODE.toLowerCase()} `);
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/^autovideo_lan=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/lan; Max-Age=43200$/);
    expect(cookie).not.toContain(LAN_CODE);
    expect(JSON.stringify(ok.body)).not.toContain(LAN_CODE);
    expect((await c.get('/lan/api/plans')).status).toBe(200);
    expect((await c.get('/lan/api/session')).body).toMatchObject({ authenticated: true });
  });

  it('phiên hết hạn sau 12 giờ; đăng xuất hủy phiên', async () => {
    const c = L.client();
    await c.login();
    expect((await c.get('/lan/api/plans')).status).toBe(200);
    L.env.clock.advance(11 * 3600_000 + 59 * 60_000);
    expect((await c.get('/lan/api/plans')).status).toBe(200);
    L.env.clock.advance(2 * 60_000);
    const gone = await c.get('/lan/api/plans');
    expect(gone.status).toBe(401);

    const c2 = L.client();
    await c2.login();
    const token = c2.cookie!;
    expect((await c2.post('/lan/api/logout')).status).toBe(200);
    const replay = L.client({ cookie: token });
    expect((await replay.get('/lan/api/plans')).status).toBe(401);
  });

  it('cookie giả/đoán/của app chính không tạo được phiên', async () => {
    for (const cookie of ['autovideo_lan=abc', 'autovideo_lan=', 'autovideo_ai=xyz', 'autovideo_lan=' + 'A'.repeat(43)]) {
      expect((await L.client({ cookie }).get('/lan/api/plans')).status, cookie).toBe(401);
    }
  });

  it('giới hạn sai mã theo IP: 10 lần/15 phút, kể cả mã đúng sau đó cũng bị chặn; IP khác không ảnh hưởng; hết cửa sổ thì đăng nhập lại được', async () => {
    const a = L.client({ ip: '192.168.1.10' });
    for (let i = 0; i < 10; i++) expect((await a.login('SAI' + i)).status).toBe(401);
    const blocked = await a.login(LAN_CODE);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.error.details.retry_after_s).toBeGreaterThan(0);
    expect((await L.client({ ip: '192.168.1.11' }).login()).status).toBe(200);
    L.env.clock.advance(15 * 60_000 + 1000);
    expect((await a.login(LAN_CODE)).status).toBe(200);
  });

  it('IPv4 ánh xạ IPv6 được tính là cùng một IP', async () => {
    const v4 = L.client({ ip: '192.168.1.20' });
    const mapped = L.client({ ip: '::ffff:192.168.1.20' });
    for (let i = 0; i < 5; i++) await v4.login('SAI');
    for (let i = 0; i < 5; i++) await mapped.login('SAI');
    expect((await v4.login(LAN_CODE)).status).toBe(429);
  });

  it('thiếu trường code → 400; JSON hỏng → 400; text/plain → 415; thân JSON quá 2 MB → 413', async () => {
    const c = L.client();
    expect((await c.post('/lan/api/login', {})).status).toBe(400);
    expect((await c.postRaw('/lan/api/login', '{hỏng', { 'content-type': 'application/json' })).body.error.code).toBe('INVALID_JSON');
    expect((await c.postRaw('/lan/api/login', 'code=x', { 'content-type': 'text/plain' })).status).toBe(415);
    const big = JSON.stringify({ code: 'x'.repeat(2 * 1024 * 1024 + 10) });
    expect((await c.postRaw('/lan/api/login', big, { 'content-type': 'application/json' })).status).toBe(413);
  });
});

describe('Host và Origin', () => {
  it('Host lạ (tên miền công cộng, DNS rebinding) bị chặn kể cả khi có phiên; IP/tên LAN thì qua', async () => {
    const cookie = await L.login();
    for (const host of ['evil.com', 'evil.com:8790', 'localhost.evil.com:8790', '192.168.1.50.evil.com', '192.168.1.5.nip.io', 'a.b.example.org']) {
      const r = await L.client({ cookie, host, origin: `http://${host}` }).get('/lan/api/plans');
      expect(r.status, host).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_HOST');
    }
    for (const host of ['192.168.1.50:8790', '10.0.0.5', '[::1]:8790', 'localhost:8790', 'macbook:8790', 'macbook.local:8790', 'LAPTOP.LOCAL', '[fe80::1]:8790']) {
      expect((await L.client({ cookie, host, origin: `http://${host}` }).get('/lan/api/plans')).status, host).toBe(200);
    }
  });

  it('LAN_ALLOWED_HOSTS cho phép thêm tên máy chủ nội bộ', async () => {
    await L.close();
    L = await makeLanEnv({ config: { lanAllowedHosts: ['video.congty.vn'] } });
    expect((await L.client({ host: 'video.congty.vn:8790' }).get('/')).status).toBe(200);
    expect((await L.client({ host: 'khac.congty.vn:8790' }).get('/')).status).toBe(403);
  });

  it('request ghi phải có Origin đúng bằng http://<Host>; thiếu hoặc khác đều 403 và không có tác dụng', async () => {
    const cookie = await L.login();
    const bad: (string | null)[] = [null, 'http://evil.com', 'null', 'https://192.168.1.50:8790', 'http://192.168.1.50:9999', 'http://192.168.1.51:8790', `${LAN_ORIGIN}.evil.com`, 'http://localhost:8787', 'http://127.0.0.1:5173'];
    for (const origin of bad) {
      const r = await L.client({ cookie, origin }).post('/lan/api/plans', { name: 'X', created_by_name: 'Y', brief: 'b' });
      expect(r.status, String(origin)).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_ORIGIN');
    }
    expect((L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE source = 'lan'").get() as { n: number }).n).toBe(0);
    // Origin khớp (không phân biệt hoa thường) thì qua
    expect((await L.client({ cookie, origin: LAN_ORIGIN.toUpperCase().replace('HTTP', 'http') }).post('/lan/api/plans', { name: 'X', created_by_name: 'Y', brief: 'b' })).status).toBe(201);
    // đăng nhập cũng kiểm tra Origin
    expect((await L.client({ origin: 'http://evil.com' }).login()).status).toBe(403);
    expect((await L.client({ origin: null }).login()).status).toBe(403);
  });

  it('API đọc/tải file từ trang khác (Sec-Fetch-Site: cross-site) bị chặn; mở trang từ liên kết (cross-site) vẫn được', async () => {
    const cookie = await L.login();
    expect((await L.client({ cookie }).get('/lan/api/plans', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await L.client({ cookie }).get('/lan/api/plans', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await L.client().get('/', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  });

  it('header an toàn trên mọi phản hồi (kể cả lỗi)', async () => {
    for (const r of [await L.client().get('/'), await L.client().get('/lan/api/plans'), await L.client().get('/khong-co')]) {
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
    const cookie = await L.login();
    expect((await L.client({ cookie }).get('/lan/api/plans')).headers['cache-control']).toBe('no-store');
  });

  it('hàm thuần isLanHostAllowed / isOriginAllowed / codeMatches', () => {
    expect(isLanHostAllowed('192.168.0.9:8790')).toBe(true);
    expect(isLanHostAllowed('999.1.1.1')).toBe(false);
    expect(isLanHostAllowed(undefined)).toBe(false);
    expect(isLanHostAllowed('a b')).toBe(false);
    expect(isOriginAllowed('http://h:1', 'h:1')).toBe(true);
    expect(isOriginAllowed(undefined, 'h:1')).toBe(false);
    expect(codeMatches('abcd2345', 'ABCD2345')).toBe(true);
    expect(codeMatches('abcd234', 'ABCD2345')).toBe(false);
    expect(codeMatches(123, 'ABCD2345')).toBe(false);
    expect(codeMatches('', '')).toBe(false);
  });
});

describe('SlidingWindowLimiter', () => {
  it('đếm theo cửa sổ trượt, tính thời gian chờ đúng', () => {
    let t = 0;
    const lim = new SlidingWindowLimiter(3, 1000, () => t);
    expect(lim.check('a').allowed).toBe(true);
    lim.record('a');
    t = 100;
    lim.record('a', 2);
    expect(lim.check('a')).toMatchObject({ allowed: false, remaining: 0 });
    expect(lim.check('a').retryAfterMs).toBe(1000); // lượt cũ nhất t=0 hết hạn ở t=1000, tối thiểu 1 giây
    t = 1001;
    expect(lim.check('a')).toMatchObject({ allowed: true, remaining: 1 }); // lượt t=0 đã hết hạn, còn 2 lượt ở t=100
    expect(lim.check('a', 3).allowed).toBe(false);
    expect(lim.check('b').allowed).toBe(true);
    lim.reset('a');
    expect(lim.check('a').remaining).toBe(3);
  });
});

describe('cô lập: listener LAN không đụng tới API chính', () => {
  it('bảng route của listener LAN chỉ gồm trang planner, assets và /lan/*; không route nào của app chính tồn tại trên LAN', async () => {
    const lanRoutes = await routeTable(L.lan);
    expect(lanRoutes.length).toBeGreaterThan(10);
    // cây printRoutes rút gọn route wildcard `/lan/files/*` thành `*`; kiểm tra riêng bằng hasRoute bên dưới
    const allowed = [/^\/$/, /^\/planner\.html$/, /^\/assets\/:file$/, /^\/lan\/api\/[A-Za-z0-9/:._-]+$/, /^\/?\*$/];
    expect(L.lan.hasRoute({ method: 'GET', url: '/lan/files/*' })).toBe(true);
    expect(L.lan.hasRoute({ method: 'GET', url: '/files/*' })).toBe(false); // route file của app chính
    for (const r of lanRoutes) expect(allowed.some((re) => re.test(r.path)), `${r.method} ${r.path}`).toBe(true);

    const mainRoutes = (await routeTable(L.env.app)).filter((r) => !/^\/?\*$/.test(r.path));
    expect(L.env.app.hasRoute({ method: 'GET', url: '/files/*' })).toBe(true);
    expect(mainRoutes.length).toBeGreaterThan(60);
    expect(mainRoutes.some((r) => r.path === '/api/worker/scenes')).toBe(true); // bảo đảm bộ dò route thấy cả route nhạy cảm
    const lanKeys = new Set(lanRoutes.map((r) => `${r.method} ${r.path}`));
    for (const r of mainRoutes) {
      expect(lanKeys.has(`${r.method} ${r.path}`), `${r.method} ${r.path} không được có trên LAN`).toBe(false);
      expect(L.lan.hasRoute({ method: r.method as 'GET', url: r.path }), `${r.method} ${r.path}`).toBe(false);
    }
    // ngược lại: route planner không tồn tại trên app chính
    for (const r of lanRoutes.filter((x) => x.path.startsWith('/lan/'))) {
      expect(L.env.app.hasRoute({ method: r.method as 'GET', url: r.path }), `${r.method} ${r.path}`).toBe(false);
    }
  });

  it('có phiên hợp lệ, Host/Origin đúng: mọi đường dẫn của app chính (đọc, ghi, worker, ai, approve, files) đều 404 và không đổi gì', async () => {
    const sc = await setupProject(L.env, { scenes: 2 });
    writeFile(L.env.root, 'output/cacao-actiso-plus/video/C1_v1.mp4', 'video-that');
    writeFile(L.env.root, 'refs/1/hop.png', PNG_BYTES);
    const cookie = await L.login();
    const c = L.client({ cookie });
    const before = JSON.stringify(await Promise.all([userClient(L.env.app).get('/api/jobs'), userClient(L.env.app).get('/api/worker/status')].map(async (p) => (await p).body)));
    const sceneId = sc.scenes[0].id;
    const mainGet = [
      '/api/projects', `/api/projects/${sc.project.id}`, `/api/projects/${sc.project.id}/scenes`, `/api/projects/${sc.project.id}/refs`, `/api/projects/${sc.project.id}/ledger`,
      `/api/projects/${sc.project.id}/events`, `/api/projects/${sc.project.id}/log.md`, `/api/scenes/${sceneId}`, '/api/jobs', '/api/jobs/1', '/api/worker/status',
      '/api/worker/ping', '/api/worker/next', '/api/ai/accounts', '/api/ai/session', '/api/ai/status', '/api/meta', '/api/stream', '/api/health', '/api/lan',
      '/api/ref-library', '/files/output/cacao-actiso-plus/video/C1_v1.mp4', '/files/refs/1/hop.png', '/api/final-cuts/1',
    ];
    for (const url of mainGet) {
      const r = await c.get(url, { authorization: `Bearer ${WORKER_TOKEN}` });
      expect(r.status, `GET ${url}`).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
      expect(r.raw).not.toContain('Cacao Actiso');
    }
    const mainWrite = [
      '/api/projects', `/api/projects/${sc.project.id}/brief`, `/api/projects/${sc.project.id}/approve-all`, `/api/scenes/${sceneId}/approve`, `/api/scenes/${sceneId}/comments`,
      `/api/scenes/${sceneId}/select-video`, `/api/scenes/${sceneId}/reset`, '/api/assets/1/verdict', '/api/jobs/1/cancel', '/api/jobs/1/reconcile', '/api/queue/pause', '/api/queue/resume',
      '/api/worker/scenes', '/api/worker/comments', '/api/worker/jobs/1/complete', '/api/worker/jobs/1/fail', '/api/worker/jobs/1/infer', '/api/ai/accounts', '/api/ai/quotas/refresh',
      `/api/projects/${sc.project.id}/final-cuts`, '/api/final-cuts/1/rerender',
    ];
    for (const url of mainWrite) {
      const r = await c.post(url, { stage: 'video', expectedCredits: 15, project_id: sc.project.id, scenes: [] }, { authorization: `Bearer ${WORKER_TOKEN}` });
      expect(r.status, `POST ${url}`).toBe(404);
    }
    for (const [method, url] of [['PATCH', `/api/projects/${sc.project.id}`], ['PATCH', `/api/scenes/${sceneId}/prompt`], ['DELETE', '/api/refs/1'], ['PATCH', '/api/refs/reorder']] as const) {
      const r = await L.lan.inject({ method, url, payload: {}, headers: { host: LAN_HOST, origin: LAN_ORIGIN, cookie: cookie } });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    // app chính không bị đổi gì
    const after = JSON.stringify(await Promise.all([userClient(L.env.app).get('/api/jobs'), userClient(L.env.app).get('/api/worker/status')].map(async (p) => (await p).body)));
    expect(after).toBe(before);
    expect((L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type != 'analyze_brief'").get() as { n: number }).n).toBe(0);
    expect((L.env.ctx.db.prepare("SELECT status FROM scenes WHERE id = ?").get(sceneId) as { status: string }).status).toBe('awaiting_approval');
  });

  it('không có phiên: các đường dẫn app chính trả 401 (không lộ route nào), file tĩnh khác của dist không phục vụ', async () => {
    const anon = L.client();
    for (const url of ['/api/projects', '/api/worker/status', '/files/output/x', '/index.html', '/secret.txt']) {
      expect((await anon.get(url)).status, url).toBe(401);
    }
    const cookie = await L.login();
    const c = L.client({ cookie });
    for (const url of ['/index.html', '/secret.txt', '/assets/../secret.txt', '/assets/%2e%2e%2fsecret.txt', '/assets/', '/assets/khong-co.js', '/assets/.hidden']) {
      const r = await c.get(url);
      expect([404, 400], url).toContain(r.status);
      expect(r.raw).not.toContain('không được phục vụ');
      expect(r.raw).not.toContain('ADMIN');
    }
  });

  it('mã nguồn listener LAN không import route của app chính', () => {
    const dir = path.join(__dirname, '..', 'src', 'lan');
    const forbidden = /from '\.\.\/routes\/(?!errors\.js)|from '\.\.\/app\.js'|services\/(jobs|worker|approvals|final-cuts|managed|ai)\//;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
      expect(forbidden.test(imports), `src/lan/${f} import route/service của app chính`).toBe(false);
    }
  });
});

describe('log không chứa mã truy cập hay cookie', () => {
  it('đăng nhập sai/đúng và gọi API không ghi mã, token phiên hay nội dung ảnh vào log', async () => {
    const lines: string[] = [];
    const { buildLanApp } = await import('../src/lan/app.js');
    const lan = await buildLanApp(L.env.ctx, { logStream: { write: (l: string) => void lines.push(l) } });
    try {
      const h = { host: LAN_HOST, origin: LAN_ORIGIN, 'content-type': 'application/json' };
      await lan.inject({ method: 'POST', url: '/lan/api/login', payload: { code: 'SAIMASAI' }, headers: h });
      const ok = await lan.inject({ method: 'POST', url: '/lan/api/login', payload: { code: LAN_CODE }, headers: h });
      const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
      await lan.inject({ method: 'GET', url: '/lan/api/plans', headers: { host: LAN_HOST, cookie } });
      const token = cookie.split('=')[1]!;
      const all = lines.join('\n');
      expect(all.length).toBeGreaterThan(0);
      expect(all).not.toContain(LAN_CODE);
      expect(all).not.toContain('SAIMASAI');
      expect(all).not.toContain(token);
      expect(all).toContain('Đăng nhập LAN sai mã'); // vẫn ghi nhận sự kiện (kèm IP) nhưng không ghi mã
    } finally {
      await lan.close();
    }
  });
});

describe('cấu hình LAN', () => {
  it('buildLanApp từ chối mã yếu/trống và cổng trùng app chính (không bật mặc định yếu)', async () => {
    const { buildLanApp } = await import('../src/lan/app.js');
    await expect(buildLanApp({ ...L.env.ctx, config: { ...L.env.ctx.config, lanAccessCode: '' } } as never, { logger: false })).rejects.toThrow(/LAN_ACCESS_CODE/);
    await expect(buildLanApp({ ...L.env.ctx, config: { ...L.env.ctx.config, lanAccessCode: 'abc' } } as never, { logger: false })).rejects.toThrow(/ít nhất 6/);
    await expect(buildLanApp({ ...L.env.ctx, config: { ...L.env.ctx.config, lanPort: L.env.ctx.config.port } } as never, { logger: false })).rejects.toThrow(/khác PORT/);
  });
});
