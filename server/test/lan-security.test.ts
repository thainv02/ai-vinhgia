import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLanHostAllowed, isOriginAllowed } from '../src/lan/security.js';
import { SlidingWindowLimiter } from '../src/lan/rate-limit.js';
import { PNG_BYTES, WORKER_TOKEN, setupProject, userClient, writeFile } from './helpers.js';
import { LAN_HOST, LAN_ORIGIN, makeLanEnv, type LanEnv } from './helpers-lan.js';

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

describe('Host và Origin', () => {
  it('Host không phải loopback (tên miền, DNS rebinding, IP/tên máy trong LAN) bị chặn; 127.0.0.1/localhost/[::1] thì qua', async () => {
    for (const host of ['evil.com', 'evil.com:8790', 'localhost.evil.com:8790', '127.0.0.1.nip.io', 'a.b.example.org', '192.168.1.50:8790', '10.0.0.5', 'macbook:8790', 'macbook.local:8790', '[fe80::1]:8790']) {
      const r = await L.client({ host, origin: `http://${host}` }).get('/lan/api/plans');
      expect(r.status, host).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_HOST');
    }
    for (const host of ['127.0.0.1:8790', '127.0.0.1', '[::1]:8790', 'localhost:8790', 'LOCALHOST']) {
      expect((await L.client({ host, origin: `http://${host}` }).get('/lan/api/plans')).status, host).toBe(200);
    }
  });

  it('request ghi phải có Origin đúng bằng http://<Host>; thiếu hoặc khác đều 403 và không có tác dụng', async () => {
    const bad: (string | null)[] = [null, 'http://evil.com', 'null', 'https://127.0.0.1:8790', 'http://127.0.0.1:9999', 'http://localhost:8790', `${LAN_ORIGIN}.evil.com`, 'http://localhost:8787', 'http://127.0.0.1:5173'];
    for (const origin of bad) {
      const r = await L.client({ origin }).post('/lan/api/plans', { name: 'X', created_by_name: 'Y', brief: 'b' });
      expect(r.status, String(origin)).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_ORIGIN');
    }
    expect((L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE source = 'lan'").get() as { n: number }).n).toBe(0);
    // Origin khớp (không phân biệt hoa thường) thì qua
    expect((await L.client({ origin: LAN_ORIGIN.toUpperCase().replace('HTTP', 'http') }).post('/lan/api/plans', { name: 'X', created_by_name: 'Y', brief: 'b' })).status).toBe(201);
  });

  it('API đọc/tải file từ trang khác (Sec-Fetch-Site: cross-site) bị chặn; mở trang từ liên kết (cross-site) vẫn được', async () => {
    expect((await L.client().get('/lan/api/plans', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await L.client().get('/lan/api/plans', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
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
    expect((await L.client().get('/lan/api/plans')).headers['cache-control']).toBe('no-store');
  });

  it('hàm thuần isLanHostAllowed / isOriginAllowed', () => {
    expect(isLanHostAllowed('127.0.0.1:8790')).toBe(true);
    expect(isLanHostAllowed('192.168.0.9:8790')).toBe(false);
    expect(isLanHostAllowed('999.1.1.1')).toBe(false);
    expect(isLanHostAllowed(undefined)).toBe(false);
    expect(isLanHostAllowed('a b')).toBe(false);
    expect(isOriginAllowed('http://h:1', 'h:1')).toBe(true);
    expect(isOriginAllowed(undefined, 'h:1')).toBe(false);
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

  it('Host/Origin đúng: mọi đường dẫn của app chính (đọc, ghi, worker, ai, approve, files) đều 404 và không đổi gì', async () => {
    const sc = await setupProject(L.env, { scenes: 2 });
    writeFile(L.env.root, 'output/cacao-actiso-plus/video/C1_v1.mp4', 'video-that');
    writeFile(L.env.root, 'refs/1/hop.png', PNG_BYTES);
    const c = L.client();
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
      const r = await L.lan.inject({ method, url, payload: {}, headers: { host: LAN_HOST, origin: LAN_ORIGIN } });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    // app chính không bị đổi gì
    const after = JSON.stringify(await Promise.all([userClient(L.env.app).get('/api/jobs'), userClient(L.env.app).get('/api/worker/status')].map(async (p) => (await p).body)));
    expect(after).toBe(before);
    expect((L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type != 'analyze_brief'").get() as { n: number }).n).toBe(0);
    expect((L.env.ctx.db.prepare("SELECT status FROM scenes WHERE id = ?").get(sceneId) as { status: string }).status).toBe('awaiting_approval');
  });

  it('file tĩnh khác của dist không phục vụ', async () => {
    const c = L.client();
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

