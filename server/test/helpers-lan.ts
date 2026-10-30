import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildLanApp } from '../src/lan/app.js';
import type { Config } from '../src/config.js';
import { Readable } from 'node:stream';
import { makeEnv, multipart, type Env, type Res } from './helpers.js';
import type { BuildAppOptions } from '../src/app.js';

export const LAN_CODE = 'K7M2QX9P';
export const LAN_HOST = '192.168.1.50:8790';
export const LAN_ORIGIN = `http://${LAN_HOST}`;

export interface LanEnv {
  env: Env;
  lan: FastifyInstance;
  distDir: string;
  /** Client LAN: giữ cookie phiên, mặc định Host = IP LAN và Origin khớp cho request ghi. */
  client(opts?: { ip?: string; host?: string; origin?: string | null; cookie?: string | null }): LanClient;
  login(ip?: string): Promise<string>;
  close(): Promise<void>;
}

export interface LanClient {
  cookie: string | null;
  get(url: string, headers?: Record<string, string>): Promise<Res>;
  post(url: string, payload?: unknown, headers?: Record<string, string>): Promise<Res>;
  patch(url: string, payload?: unknown, headers?: Record<string, string>): Promise<Res>;
  put(url: string, payload?: unknown, headers?: Record<string, string>): Promise<Res>;
  del(url: string, headers?: Record<string, string>): Promise<Res>;
  postRaw(url: string, payload: Buffer | string, headers: Record<string, string>): Promise<Res>;
  upload(url: string, files: { name: string; data: Buffer; label?: string }[]): Promise<Res>;
  /** Tải video (multipart, một file; `fields` đứng trước file). `data` là Buffer hoặc Readable (giả lập file lớn bằng luồng, kèm `size` để đặt Content-Length). */
  uploadVideo(url: string, file: { name: string; data: Buffer | Readable; size?: number; type?: string }, fields?: Record<string, string>): Promise<Res>;
  login(code?: string): Promise<Res>;
}

export async function makeLanEnv(opts: { config?: Partial<Config>; app?: Partial<BuildAppOptions> } = {}): Promise<LanEnv> {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-lan-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'planner.html'), '<!doctype html><title>planner</title><div id="root"></div>');
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>ADMIN</title>');
  fs.writeFileSync(path.join(distDir, 'assets', 'planner-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(distDir, 'secret.txt'), 'không được phục vụ');
  const env = await makeEnv({ ...opts.app, config: { lanEnabled: true, lanRequireCode: true, lanAccessCode: LAN_CODE, lanDistDir: distDir, ...opts.config } });
  const lan = await buildLanApp(env.ctx, { logger: false });

  const client: LanEnv['client'] = (o = {}) => {
    // Hũ cookie: phiên (`autovideo_lan`) và cookie client (`autovideo_lan_client`, chỉ có sau khi gọi route công cụ) cùng tồn tại.
    const jar = new Map<string, string>();
    const load = (line: string | null | undefined) => {
      jar.clear();
      for (const part of (line ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
    };
    load(o.cookie);
    const state = {
      get cookie(): string | null {
        return jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : null;
      },
    };
    const base = (method: string, extra: Record<string, string> = {}) => {
      const headers: Record<string, string> = { host: o.host ?? LAN_HOST, ...extra };
      if (state.cookie) headers.cookie = state.cookie;
      if (method !== 'GET' && method !== 'HEAD' && o.origin !== null && headers.origin === undefined) headers.origin = o.origin ?? LAN_ORIGIN;
      return headers;
    };
    const wrap = async (res: Awaited<ReturnType<FastifyInstance['inject']>>): Promise<Res> => {
      const sc = res.headers['set-cookie'];
      for (const line of Array.isArray(sc) ? sc : sc ? [sc] : []) {
        const pair = String(line).split(';')[0]!;
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq);
        if (pair.length === eq + 1) jar.delete(name);
        else jar.set(name, pair.slice(eq + 1));
      }
      let body: any = res.body;
      if (String(res.headers['content-type'] ?? '').includes('application/json')) {
        try {
          body = JSON.parse(res.body);
        } catch {
          /* giữ nguyên */
        }
      }
      return { status: res.statusCode, body, headers: res.headers, raw: res.body };
    };
    const inject = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      lan
        .inject({ method: method as 'GET', url, payload: payload as object | undefined, headers: base(method, headers), remoteAddress: o.ip ?? '192.168.1.77' })
        .then(wrap);
    const c: LanClient = {
      get cookie() {
        return state.cookie;
      },
      set cookie(v) {
        load(v);
      },
      get: (url, headers) => inject('GET', url, undefined, headers),
      post: (url, payload, headers) => inject('POST', url, payload ?? {}, headers),
      patch: (url, payload, headers) => inject('PATCH', url, payload ?? {}, headers),
      put: (url, payload, headers) => inject('PUT', url, payload ?? {}, headers),
      del: (url, headers) => inject('DELETE', url, undefined, headers),
      postRaw: (url, payload, headers) => inject('POST', url, payload as unknown, headers),
      upload: (url, files) => {
        const parts = files.flatMap((f) => [
          ...(f.label !== undefined ? [{ name: 'label', value: f.label }] : []),
          { name: 'file', filename: f.name, data: f.data, type: 'image/png' },
        ]);
        const m = multipart(parts);
        return inject('POST', url, m.payload, m.headers);
      },
      uploadVideo: (url, file, fields = {}) => {
        const boundary = '----videoboundary' + Math.random().toString(16).slice(2);
        const head = Buffer.concat([
          ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'video/mp4'}\r\n\r\n`),
        ]);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const headers: Record<string, string> = { 'content-type': `multipart/form-data; boundary=${boundary}` };
        if (Buffer.isBuffer(file.data)) return inject('POST', url, Buffer.concat([head, file.data, tail]), headers);
        const data = file.data;
        const body = Readable.from(
          (async function* () {
            yield head;
            for await (const chunk of data) yield chunk as Buffer;
            yield tail;
          })(),
        );
        if (file.size !== undefined) headers['content-length'] = String(head.length + file.size + tail.length);
        return inject('POST', url, body, headers);
      },
      login: (code = LAN_CODE) => inject('POST', '/lan/api/login', { code }),
    };
    return c;
  };

  return {
    env,
    lan,
    distDir,
    client,
    async login(ip) {
      const c = client({ ip });
      const r = await c.login();
      if (r.status !== 200) throw new Error('đăng nhập LAN lỗi: ' + r.raw);
      return c.cookie!;
    },
    async close() {
      await lan.close();
      await env.close();
      fs.rmSync(distDir, { recursive: true, force: true });
    },
  };
}
