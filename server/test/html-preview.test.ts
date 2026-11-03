import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEXT_JOB_TYPES } from '../src/config.js';
import { setCompositionValidator } from '../src/services/html/compose-lifecycle.js';
import { ensureHtmlPreview, previewCsp, safeRelPath, stopHtmlPreview } from '../src/services/html/preview.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { managedClient } from './helpers-media.js';

// Engine do W1a viết: ở đây dùng bản giả có cùng hợp đồng (CSP mẫu theo spike §6, injectHead chèn dấu vết để kiểm tra).
vi.mock('../src/services/html/engine/index.js', () => ({
  HTML_CSP: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
  injectHead: (html: string, o: { mode: string; runtimeSrc?: string; fonts?: boolean; base?: string }) => html.replace('<head>', `<head><meta data-inj="${o.mode}|${o.runtimeSrc}|${o.fonts}|${o.base}">`),
}));

let L: LanEnv;
let c: LanClient;
const PORT = 51234;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
let runtimeDir: string;
beforeEach(async () => {
  L = await makeLanEnv({ config: { workerMode: 'managed', managedJobTypes: TEXT_JOB_TYPES } });
  c = L.client();
  runtimeDir = fs.mkdtempSync(path.join(L.env.root, 'rt-'));
  fs.mkdirSync(path.join(runtimeDir, 'fonts'));
  fs.writeFileSync(path.join(runtimeDir, 'runtime.js'), 'window.__rt=1');
  fs.writeFileSync(path.join(runtimeDir, 'gsap.min.js'), 'window.gsap=1');
  fs.writeFileSync(path.join(runtimeDir, 'fonts', 'bvp-400.woff2'), 'FONT');
});
afterEach(async () => {
  setCompositionValidator(null);
  await stopHtmlPreview(L.env.ctx);
  await L.close();
});

const P = '/lan/api/html-projects';
const db = () => L.env.ctx.db;
let seq = 0;
const key = () => `key-${Date.now()}-${++seq}-abcdef`;
const INDEX = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Giảm giá</h1></body></html>';
const VIDEO = Buffer.alloc(1000, 7);

async function ready(files: { path: string; content: string }[] = []) {
  const p = (await c.post(P, { name: 'Preview thử', brief: 'b', aspect: '9:16', duration_s: 5, quality: '720p', template: null, model: {} })).body;
  const v1 = (await c.post(`${P}/${p.id}/compose`, { prompt: 'x', idempotency_key: key() })).body.version;
  const job = (await managedClient(L.env).get('/api/worker/next?mode=managed')).body;
  const res = await managedClient(L.env, 'W1', job.lease_id, job.id).post(
    `/api/worker/jobs/${job.id}/complete`,
    { result: { files: [{ path: 'index.html', content: INDEX }, { path: 'compositions/cảnh-1.html', content: '<head></head><div>Cảnh 1</div>' }, { path: 'assets/css/style.css', content: 'h1{color:red}' }, ...files], summary: 's', variables: [] } },
    { 'idempotency-key': `done-${job.id}` },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = db().prepare('SELECT * FROM html_versions WHERE project_id = ? AND version = ?').get(p.id, v1.version) as any;
  return { p, v: v1.version as number, row };
}

function svc() {
  const s = ensureHtmlPreview(L.env.ctx, { runtimeDir });
  s.useOrigin(ORIGIN);
  return s;
}
const get = (s: ReturnType<typeof svc>, url: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET') =>
  s.handler().inject({ method, url, headers: { host: HOST, ...headers } });
const tokenOf = (url: string) => /\/s\/([^/]+)\//.exec(url)![1]!;
const sessionOf = async (pid: number, v: number) => {
  const r = await c.post(`${P}/${pid}/versions/${v}/preview`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { url: string; origin: string; expires_at: string };
};

describe('preview Video HTML: phiên và route cấp phiên', () => {
  it('chưa chạy listener → 409 PREVIEW_UNAVAILABLE; có chạy → {url, origin, expires_at} token 32 byte, gắn phiên bản', async () => {
    const { p, v } = await ready();
    const r0 = await c.post(`${P}/${p.id}/versions/${v}/preview`, {});
    expect([r0.status, r0.body.error.code]).toEqual([409, 'PREVIEW_UNAVAILABLE']);
    svc();
    const s = await sessionOf(p.id, v);
    expect(s.origin).toBe(ORIGIN);
    expect(s.url).toMatch(new RegExp(`^${ORIGIN}/s/[A-Za-z0-9_-]{43}/index\\.html$`));
    expect(Date.parse(s.expires_at)).toBeGreaterThan(L.env.ctx.clock.now() + 100 * 60_000);
    expect((await sessionOf(p.id, v)).url).toBe(s.url); // dùng lại phiên của cùng phiên bản
  });

  it('phiên bản chưa ready / không tồn tại / dự án khác loại → 409/404', async () => {
    svc();
    const p = (await c.post(P, { name: 'Chưa có', brief: 'b', aspect: '9:16', duration_s: 5, quality: '720p', template: null, model: {} })).body;
    const v1 = (await c.post(`${P}/${p.id}/compose`, { prompt: 'x', idempotency_key: key() })).body.version;
    const r = await c.post(`${P}/${p.id}/versions/${v1.version}/preview`, {});
    expect([r.status, r.body.error.code]).toEqual([409, 'VERSION_NOT_READY']);
    expect((await c.post(`${P}/${p.id}/versions/99/preview`, {})).status).toBe(404);
    const plan = (await c.post('/lan/api/plans', { name: 'Kế hoạch', created_by_name: 'Minh' })).body.plan;
    expect((await c.post(`${P}/${plan.id}/versions/1/preview`, {})).status).toBe(404);
  });

  it('LRU: vượt số phiên tối đa thì phiên cũ nhất bị loại', async () => {
    const { row } = await ready();
    const s = ensureHtmlPreview(L.env.ctx, { runtimeDir, maxSessions: 2 });
    s.useOrigin(ORIGIN);
    const mkRow = (id: number) => ({ ...row, id }); // id giả: chỉ kiểm LRU
    const a = tokenOf(s.createSession(mkRow(1001)).url);
    s.createSession(mkRow(1002));
    expect(s.sessionCount).toBe(2);
    s.createSession(mkRow(1003));
    expect(s.sessionCount).toBe(2);
    // a đã bị loại: tạo lại cho đúng phiên bản 1001 phải ra token MỚI
    expect(tokenOf(s.createSession(mkRow(1001)).url)).not.toBe(a);
  });

  it('hết hạn trượt 2 giờ: truy cập gia hạn; im lặng quá 2 giờ → 404', async () => {
    const { p, v } = await ready();
    const s = svc();
    const t = tokenOf((await sessionOf(p.id, v)).url);
    const clock = L.env.ctx.clock as any;
    const orig = clock.now.bind(clock);
    let skew = 0;
    clock.now = () => orig() + skew;
    try {
      skew = 100 * 60_000;
      expect((await get(s, `/s/${t}/index.html`)).statusCode).toBe(200); // gia hạn
      skew = 200 * 60_000; // 100 phút sau lần dùng cuối: còn hạn
      expect((await get(s, `/s/${t}/index.html`)).statusCode).toBe(200);
      skew = 200 * 60_000 + 121 * 60_000;
      expect((await get(s, `/s/${t}/index.html`)).statusCode).toBe(404);
      expect(s.sessionCount).toBe(0);
    } finally {
      clock.now = orig;
    }
  });
});

describe('preview Video HTML: phục vụ file', () => {
  it('chỉ file trong manifest: index/composition được chèn head, css nguyên bản; token sai/thiếu/dạng lạ → 404', async () => {
    const { p, v } = await ready();
    const s = svc();
    const t = tokenOf((await sessionOf(p.id, v)).url);
    const idx = await get(s, `/s/${t}/index.html`);
    expect(idx.statusCode).toBe(200);
    expect(idx.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(idx.body).toContain('<head><meta data-inj="preview|__hf/runtime.js|undefined|undefined">');
    expect(idx.body).toContain('Giảm giá');
    expect(Number(idx.headers['content-length'])).toBe(Buffer.byteLength(idx.body));
    const comp = await get(s, `/s/${t}/compositions/${encodeURIComponent('cảnh-1.html')}`);
    expect(comp.statusCode).toBe(200);
    expect(comp.body).toContain('data-inj="preview|undefined|false|../"');
    const css = await get(s, `/s/${t}/assets/css/style.css`);
    expect([css.statusCode, css.body, css.headers['content-type']]).toEqual([200, 'h1{color:red}', 'text/css; charset=utf-8']);
    for (const bad of [`/s/${'A'.repeat(43)}/index.html`, `/s/short/index.html`, `/s//index.html`, `/index.html`, `/s/${t}`, `/`]) {
      expect((await get(s, bad)).statusCode, bad).toBe(404);
    }
    expect((await get(s, `/s/${t}/index.html`, { host: 'evil.example:51234' })).statusCode).toBe(404); // Host lạ (DNS rebinding)
    expect((await get(s, `/s/${t}/index.html`, { host: '127.0.0.1:1' })).statusCode).toBe(404);
    expect((await get(s, `/s/${t}/index.html`, { host: `localhost:${PORT}` })).statusCode).toBe(200);
  });

  it('phiên bản/dự án khác: token của A không mở file của B (kể cả file chỉ có ở B) và file ngoài manifest', async () => {
    const a = await ready();
    const s = svc();
    const sa = tokenOf((await sessionOf(a.p.id, a.v)).url);
    const b = await ready([{ path: 'assets/css/only-b.css', content: 'b{}' }]);
    const sb = tokenOf((await sessionOf(b.p.id, b.v)).url);
    expect((await get(s, `/s/${sb}/assets/css/only-b.css`)).statusCode).toBe(200);
    expect((await get(s, `/s/${sa}/assets/css/only-b.css`)).statusCode).toBe(404);
    // file có trên đĩa nhưng KHÔNG nằm trong manifest → 404
    fs.writeFileSync(path.join(L.env.root, a.row.files_dir, 'secret.txt'), 'bí mật');
    expect((await get(s, `/s/${sa}/secret.txt`)).statusCode).toBe(404);
    // asset snapshot chỉ phục vụ khi thuộc đúng phiên bản
    fs.mkdirSync(path.join(L.env.root, b.row.files_dir, 'assets', 'u'), { recursive: true });
    fs.writeFileSync(path.join(L.env.root, b.row.files_dir, 'assets', 'u', '7.png'), 'PNGB');
    db().prepare('INSERT INTO html_version_assets (version_id, asset_ref, stored_path, content_hash, snapshot_path) VALUES (?,?,?,?,?)').run(b.row.id, 7, 'x/7.png', 'h', `${b.row.files_dir}/assets/u/7.png`);
    expect((await get(s, `/s/${sb}/assets/u/7.png`)).body).toBe('PNGB');
    expect((await get(s, `/s/${sa}/assets/u/7.png`)).statusCode).toBe(404);
    // phiên bản không còn ready → phiên vô hiệu
    db().prepare("UPDATE html_versions SET status = 'failed' WHERE id = ?").run(b.row.id);
    expect((await get(s, `/s/${sb}/assets/css/only-b.css`)).statusCode).toBe(404);
  });

  it('đường dẫn nguy hiểm đều 404: ../ (mã hoá), backslash, ADS, thư mục, file ẩn, NUL, //, dấu chấm cuối', async () => {
    const a = await ready();
    const s = svc();
    fs.writeFileSync(path.join(L.env.root, a.row.files_dir, '.env'), 'X=1');
    const t = tokenOf((await sessionOf(a.p.id, a.v)).url);
    const bad = [
      '%2e%2e/%2e%2e/etc/passwd', '..%2findex.html', 'assets%2fcss%2f..%2f..%2findex.html', '%252e%252e/index.html',
      'assets%5cstyle.css', '..%5cindex.html', 'index.html::$DATA', 'index.html:stream', 'index.html%3a%3a%24DATA', 'C:/Windows/win.ini', 'c%3a/x',
      'assets/', 'assets', 'compositions/', '', '.env', 'assets/.env', '.hidden/x', 'assets//css/style.css', 'index.html.', 'index.html%20', 'index.html%00.css', 'INDEX.HTML', 'assets/css', 'assets/CSS/style.css',
      '__hf/', '__hf/runtime.js/', '__hf/fonts/', '__hf/fonts/..%2f..%2fruntime.js', '__hf/fonts/nope.woff2', '__hf/secret.js', '__hf/fonts/a.txt',
      'node_modules/x', '.git/config',
    ];
    for (const rel of bad) expect((await get(s, `/s/${t}/${rel}`)).statusCode, rel).toBe(404);
    for (const dir of ['/s/', `/s/${t}`, `/s/${t}/`]) expect((await get(s, dir)).statusCode).toBe(404);
  });

  it('runtime __hf/*: runtime.js, gsap.min.js, fonts/*.woff2 đúng tên; có CORS', async () => {
    const a = await ready();
    const s = svc();
    const t = tokenOf((await sessionOf(a.p.id, a.v)).url);
    for (const [rel, body, ct] of [['__hf/runtime.js', 'window.__rt=1', 'text/javascript; charset=utf-8'], ['__hf/gsap.min.js', 'window.gsap=1', 'text/javascript; charset=utf-8'], ['__hf/fonts/bvp-400.woff2', 'FONT', 'font/woff2']] as const) {
      const r = await get(s, `/s/${t}/${rel}`);
      expect([r.statusCode, r.body, r.headers['content-type']], rel).toEqual([200, body, ct]);
      expect(r.headers['access-control-allow-origin']).toBe('*');
    }
  });

  it('media: Range -> 206 + Content-Range (đầu/hậu tố/ngoài phạm vi 416); HEAD không có body', async () => {
    const a = await ready();
    const s = svc();
    const t = tokenOf((await sessionOf(a.p.id, a.v)).url);
    const dir = path.join(L.env.root, a.row.files_dir);
    fs.mkdirSync(path.join(dir, 'assets', 'media'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'media', 'clip.mp4'), VIDEO);
    const man = JSON.parse(a.row.manifest_json);
    man.push({ path: 'assets/media/clip.mp4', bytes: VIDEO.length, sha256: 'x' });
    db().prepare('UPDATE html_versions SET manifest_json = ? WHERE id = ?').run(JSON.stringify(man), a.row.id);
    const u = `/s/${t}/assets/media/clip.mp4`;
    const full = await get(s, u);
    expect([full.statusCode, full.headers['content-type'], full.headers['accept-ranges'], full.rawPayload.length]).toEqual([200, 'video/mp4', 'bytes', 1000]);
    const r1 = await get(s, u, { range: 'bytes=0-99' });
    expect([r1.statusCode, r1.headers['content-range'], r1.rawPayload.length]).toEqual([206, 'bytes 0-99/1000', 100]);
    const r2 = await get(s, u, { range: 'bytes=900-' });
    expect([r2.statusCode, r2.headers['content-range']]).toEqual([206, 'bytes 900-999/1000']);
    const r3 = await get(s, u, { range: 'bytes=-10' });
    expect([r3.statusCode, r3.headers['content-range']]).toEqual([206, 'bytes 990-999/1000']);
    const r4 = await get(s, u, { range: 'bytes=5000-' });
    expect([r4.statusCode, r4.headers['content-range']]).toEqual([416, 'bytes */1000']);
    expect((await get(s, u, { range: 'bytes=abc' })).statusCode).toBe(416);
    const h = await get(s, u, {}, 'HEAD');
    expect([h.statusCode, h.headers['content-length'], h.rawPayload.length]).toEqual([200, '1000', 0]);
  });

  it('header bắt buộc trên mọi phản hồi (kể cả 404): CSP frame-ancestors = origin planner, CORS *, CORP cross-origin, nosniff, no-store, không X-Frame-Options', async () => {
    const a = await ready();
    const s = svc();
    const t = tokenOf((await sessionOf(a.p.id, a.v)).url);
    for (const u of [`/s/${t}/index.html`, `/s/${t}/assets/css/style.css`, `/s/${t}/nope.html`, '/zzz']) {
      const h = (await get(s, u)).headers;
      expect(h['content-security-policy'], u).toBe(previewCsp(['http://127.0.0.1:8790', 'http://localhost:8790']));
      expect(h['content-security-policy']).toMatch(/connect-src 'self'/);
      expect(h['content-security-policy']).toMatch(/frame-ancestors http:\/\/127\.0\.0\.1:8790 http:\/\/localhost:8790$/);
      expect(h['access-control-allow-origin']).toBe('*');
      expect(h['access-control-allow-credentials']).toBeUndefined();
      expect(h['cross-origin-resource-policy']).toBe('cross-origin');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['cache-control']).toBe('no-store');
      expect(h['x-frame-options']).toBeUndefined();
      expect(h['set-cookie']).toBeUndefined();
    }
  });

  it('chỉ GET/HEAD (+OPTIONS preflight): POST/PUT/DELETE/PATCH -> 404, không có API', async () => {
    const a = await ready();
    const s = svc();
    const t = tokenOf((await sessionOf(a.p.id, a.v)).url);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      expect((await s.handler().inject({ method, url: `/s/${t}/index.html`, headers: { host: HOST } })).statusCode, method).toBe(404);
    }
    for (const u of ['/lan/api/status', '/api/projects', `/s/${t}/lan/api/status`]) expect((await get(s, u)).statusCode, u).toBe(404);
    const pre = await s.handler().inject({ method: 'OPTIONS', url: `/s/${t}/index.html`, headers: { host: HOST, origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' } });
    expect([pre.statusCode, pre.headers['access-control-allow-origin'], pre.headers['access-control-allow-methods']]).toEqual([204, '*', 'GET, HEAD, OPTIONS']);
  });
});

describe('preview Video HTML: planner CSP và cô lập', () => {
  it('trang planner (/ và /planner.html) có frame-src đúng origin preview; route khác và X-Frame-Options DENY giữ nguyên', async () => {
    const base = (await c.get('/planner.html')).headers['content-security-policy'] as string;
    expect(base).not.toMatch(/frame-src/); // chưa có preview
    svc();
    for (const u of ['/', '/planner.html']) {
      const r = await c.get(u);
      expect(r.headers['content-security-policy'], u).toBe(`${base}; frame-src ${ORIGIN}`);
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
      expect(r.headers['content-security-policy']).toMatch(/script-src 'self';/);
    }
    for (const u of ['/lan/api/status', '/lan/api/session', P, '/assets/planner-abc123.js', '/nope']) {
      const r = await c.get(u);
      expect(r.headers['content-security-policy'], u).toBe(base);
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
    expect((await c.get('/lan/api/status')).body.html_preview_origin).toBe(ORIGIN);
  });


  it('route cấp phiên nằm dưới /lan/api, chỉ có trên listener planner desktop', () => {
    expect(L.lan.hasRoute({ method: 'POST', url: `${P}/:id/versions/:v/preview` })).toBe(true);
    expect(L.env.app.hasRoute({ method: 'POST', url: `${P}/:id/versions/:v/preview` })).toBe(false);
  });

  it('listener thật: mở cổng 127.0.0.1 ngẫu nhiên, phục vụ file, đóng thì dừng', async () => {
    const a = await ready();
    const s = ensureHtmlPreview(L.env.ctx, { runtimeDir });
    await s.start(0);
    const origin = s.origin!;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const { url } = await sessionOf(a.p.id, a.v);
    expect(url.startsWith(origin)).toBe(true);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toContain('data-inj="preview|__hf/runtime.js|undefined|undefined"');
    expect((await fetch(`${origin}/s/${tokenOf(url)}/%2e%2e/%2e%2e/index.html`)).status).toBe(404);
    // request thô (không qua WHATWG URL nên `..` giữ nguyên) vẫn 404
    const raw = (p: string) =>
      new Promise<number>((resolve, reject) => {
        const q = http.request({ host: '127.0.0.1', port: Number(new URL(origin).port), path: p, method: 'GET' }, (r) => {
          r.resume();
          resolve(r.statusCode!);
        });
        q.on('error', reject);
        q.end();
      });
    const t = tokenOf(url);
    for (const p of [`/s/${t}/assets/../index.html`, `/s/${t}/assets/%2e%2e/index.html`, `/s/${t}/%2e%2e/%2e%2e/etc/passwd`, `/s/${t}/assets%5c..%5cindex.html`, `/s/${t}/index.html::$DATA`, `/s/${t}/assets/`]) expect(await raw(p), p).toBe(404);
    expect(await raw(`/s/${t}/index.html`)).toBe(200);
    await stopHtmlPreview(L.env.ctx);
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe('safeRelPath', () => {
  it('chấp nhận đường dẫn bình thường (có tiếng Việt), từ chối phần còn lại', () => {
    expect(safeRelPath('assets/css/style.css')).toBe('assets/css/style.css');
    expect(safeRelPath(encodeURIComponent('cảnh-1.html'))).toBe('cảnh-1.html');
    for (const x of ['', '..', 'a/../b', 'a\\b', 'a:b', '.x', 'a/.x', 'a//b', 'a/', '%2e%2e', 'a%00b', 'a%', '%252e']) expect(safeRelPath(x), x).toBeNull();
  });
});
