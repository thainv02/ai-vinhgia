import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEXT_JOB_TYPES } from '../src/config.js';
import { ensureHtmlPreview, stopHtmlPreview } from '../src/services/html/preview.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { managedClient } from './helpers-media.js';

// Kiểm tra thật bằng trình duyệt (bỏ qua khi không đặt HTML_RENDERER_BROWSER): JS trong composition phục vụ từ origin preview
// KHÔNG gọi được API planner (khác origin + CSP connect-src 'self'), nhưng vẫn lấy được file cùng origin.
const BROWSER = process.env.HTML_RENDERER_BROWSER;
let L: LanEnv;
let c: LanClient;
let honeypot: http.Server;
let hits: string[] = [];
beforeEach(async () => {
  L = await makeLanEnv({ config: { workerMode: 'managed', managedJobTypes: TEXT_JOB_TYPES } });
  c = L.client();
  hits = [];
  honeypot = http.createServer((q, r) => {
    hits.push(`${q.method} ${q.url}`);
    r.setHeader('Access-Control-Allow-Origin', '*');
    r.end('{"secret":1}');
  });
  await new Promise<void>((res) => honeypot.listen(0, '127.0.0.1', res));
});
afterEach(async () => {
  await stopHtmlPreview(L.env.ctx);
  await new Promise((res) => honeypot.close(res));
  await L.close();
});

describe.skipIf(!BROWSER || !fs.existsSync(BROWSER))('preview Video HTML: cô lập bằng trình duyệt thật', () => {
  it('fetch/XHR/WebSocket/img tới "API planner" (origin khác) bị chặn; fetch cùng origin preview chạy được; không nhúng được từ trang lạ', async () => {
    const P = '/lan/api/html-projects';
    const hp = `http://127.0.0.1:${(honeypot.address() as { port: number }).port}`;
    const index = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const out = {};
const done = (k, p) => p.then(() => (out[k] = 'ok'), (e) => (out[k] = 'blocked'));
Promise.all([
  done('fetch', fetch('${hp}/lan/api/status')),
  done('nocors', fetch('${hp}/lan/api/status', { mode: 'no-cors' })),
  done('self', fetch(location.pathname)),
  done('xhr', new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', '${hp}/xhr'); x.onload = res; x.onerror = rej; x.send(); })),
  done('ws', new Promise((res, rej) => { try { const w = new WebSocket('ws://${hp.slice(7)}/ws'); w.onopen = res; w.onerror = rej; } catch (e) { rej(e); } })),
  done('img', new Promise((res, rej) => { const i = new Image(); i.onload = res; i.onerror = rej; i.src = '${hp}/img.png'; })),
]).then(() => { document.title = 'done:' + JSON.stringify(out); });
</script></body></html>`;
    const p = (await c.post(P, { name: 'Cô lập', brief: 'b', aspect: '9:16', duration_s: 5, quality: '720p', template: null, model: {} })).body;
    const v1 = (await c.post(`${P}/${p.id}/compose`, { prompt: 'x', idempotency_key: 'key-isolation-0001' })).body.version;
    const job = (await managedClient(L.env).get('/api/worker/next?mode=managed')).body;
    const done = await managedClient(L.env, 'W1', job.lease_id, job.id).post(`/api/worker/jobs/${job.id}/complete`, { result: { files: [{ path: 'index.html', content: index }], summary: 's', variables: [] } }, { 'idempotency-key': 'done-iso-1' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const svc = ensureHtmlPreview(L.env.ctx);
    await svc.start(0);
    const { url } = (await c.post(`${P}/${p.id}/versions/${v1.version}/preview`, {})).body;

    const puppeteer = (await import('puppeteer-core')).default;
    const dir = fs.mkdtempSync(path.join(L.env.root, 'pp-'));
    const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: dir, args: [] });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => document.title.startsWith('done:'), { timeout: 15_000 });
      const out = JSON.parse((await page.title()).slice(5));
      expect(out).toMatchObject({ fetch: 'blocked', nocors: 'blocked', xhr: 'blocked', ws: 'blocked', img: 'blocked', self: 'ok' });
      expect(hits).toEqual([]); // honeypot không nhận request nào
      // Nhúng từ trang lạ (khác origin planner) bị frame-ancestors chặn: iframe không có nội dung
      const other = http.createServer((_q, r) => r.end(`<iframe id=f src="${url}"></iframe>`));
      await new Promise<void>((res) => other.listen(0, '127.0.0.1', res));
      try {
        await page.goto(`http://127.0.0.1:${(other.address() as { port: number }).port}/`);
        await new Promise((r) => setTimeout(r, 1500));
        const frames = page.frames().filter((f) => f.url().startsWith(svc.origin!));
        const title = await Promise.all(frames.map((f) => f.title().catch(() => 'x')));
        expect(title.every((t) => !t.startsWith('done:'))).toBe(true);
      } finally {
        await new Promise((res) => other.close(res));
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
