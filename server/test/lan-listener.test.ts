import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLanApp } from '../src/lan/app.js';
import { makeEnv, setupProject, type Env } from './helpers.js';
import { LAN_CODE } from './helpers-lan.js';

/** Hai listener THẬT trên cổng tạm (127.0.0.1): app chính và listener LAN dùng chung một AppContext. */
let env: Env;
let lan: Awaited<ReturnType<typeof buildLanApp>>;
let mainPort: number;
let lanPort: number;
let distDir: string;

beforeEach(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-lan-dist-'));
  fs.writeFileSync(path.join(distDir, 'planner.html'), '<!doctype html><title>planner</title>');
  env = await makeEnv({ config: { lanEnabled: true, lanRequireCode: true, lanAccessCode: LAN_CODE, lanDistDir: distDir } });
  lan = await buildLanApp(env.ctx, { logger: false });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  await lan.listen({ port: 0, host: '127.0.0.1' });
  mainPort = (env.app.server.address() as AddressInfo).port;
  lanPort = (lan.server.address() as AddressInfo).port;
});
afterEach(async () => {
  await lan.close();
  await env.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

function req(port: number, opts: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    r.end(opts.body);
  });
}

async function lanLogin(): Promise<string> {
  const host = `127.0.0.1:${lanPort}`;
  const res = await req(lanPort, { method: 'POST', path: '/lan/api/login', headers: { origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: LAN_CODE }) });
  expect(res.status, res.text).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

describe('hai listener thật cùng tiến trình', () => {
  it('app chính và LAN nghe ở hai cổng khác nhau, cùng DB', async () => {
    expect(mainPort).not.toBe(lanPort);
    const sc = await setupProject(env, { scenes: 1 }); // tạo qua app chính (inject)
    expect(sc.project.id).toBeGreaterThan(0);
    // kế hoạch tạo qua cổng LAN hiện ngay trong danh sách dự án của app chính (qua socket thật)
    const cookie = await lanLogin();
    const host = `127.0.0.1:${lanPort}`;
    const created = await req(lanPort, {
      method: 'POST',
      path: '/lan/api/plans',
      headers: { origin: `http://${host}`, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Qua socket', created_by_name: 'Lan', brief: 'b' }),
    });
    expect(created.status, created.text).toBe(201);
    const list = JSON.parse((await req(mainPort, { path: '/api/projects' })).text);
    expect(list.find((p: any) => p.name === 'Qua socket')).toMatchObject({ source: 'lan', created_by_name: 'Lan' });
  });

  it('cổng LAN không phục vụ bất kỳ API chính nào, kể cả có phiên và Host/Origin đúng', async () => {
    await setupProject(env, { scenes: 1 });
    const cookie = await lanLogin();
    for (const p of ['/api/projects', '/api/jobs', '/api/worker/ping', '/api/ai/accounts', '/api/meta', '/api/health', '/api/lan', '/api/stream', '/files/output/x.png']) {
      const anon = await req(lanPort, { path: p });
      expect(anon.status, `${p} không phiên`).toBe(401);
      const withSession = await req(lanPort, { path: p, headers: { cookie } });
      expect(withSession.status, `${p} có phiên`).toBe(404);
      expect(withSession.text).not.toContain('Cacao');
    }
    const post = await req(lanPort, { method: 'POST', path: '/api/queue/pause', headers: { cookie, origin: `http://127.0.0.1:${lanPort}`, 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(404);
    expect(JSON.parse((await req(mainPort, { path: '/api/worker/status' })).text).queue_paused).toBe(false);
  });

  it('cổng app chính không phục vụ route planner; vẫn từ chối Host không phải localhost (kể cả IP LAN)', async () => {
    const r = await req(mainPort, { path: '/lan/api/plans' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text).error.code).toBe('NOT_FOUND');
    expect((await req(mainPort, { path: '/api/projects', host: `192.168.1.50:${mainPort}` })).status).toBe(403);
    expect((await req(mainPort, { path: '/api/projects', host: `evil.com:${mainPort}` })).status).toBe(403);
    // cùng Host đó thì listener LAN chấp nhận (IP LAN) — hai listener có luật Host riêng
    expect((await req(lanPort, { path: '/', host: `192.168.1.50:${lanPort}` })).status).toBe(200);
    expect((await req(lanPort, { path: '/', host: `evil.com:${lanPort}` })).status).toBe(403);
  });

  it('listener LAN không có cookie/phiên của app chính: phiên AI admin hay worker token vô giá trị', async () => {
    const aiSession = await req(mainPort, { path: '/api/ai/session' });
    const aiCookie = String(aiSession.headers['set-cookie']).split(';')[0]!;
    expect((await req(lanPort, { path: '/lan/api/plans', headers: { cookie: aiCookie } })).status).toBe(401);
    expect((await req(lanPort, { path: '/lan/api/plans', headers: { authorization: 'Bearer test-worker-token' } })).status).toBe(401);
  });

  it('request ghi từ trang web khác (Origin lạ) vào cổng LAN thật bị chặn', async () => {
    const cookie = await lanLogin();
    const r = await req(lanPort, {
      method: 'POST',
      path: '/lan/api/plans',
      headers: { origin: 'http://evil.com', cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', created_by_name: 'Y', brief: 'b' }),
    });
    expect(r.status).toBe(403);
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE source = 'lan'").get()).toEqual({ n: 0 });
  });
});
