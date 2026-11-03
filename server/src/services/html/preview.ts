import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { APP_DIR } from '../../config.js';
import type { AppContext } from '../../context.js';
import { conflict } from '../../lib/errors.js';
import { parseJson } from '../repo.js';
import type { ManifestEntry } from './safe-path.js';
import { HTML_CSP, injectHead } from './engine/index.js';
import type { HtmlVersionRow } from './repo.js';

/**
 * Preview Video HTML (CHỈ bản desktop): listener static RIÊNG, bind 127.0.0.1, origin khác trang planner. Mã HTML do AI viết chạy trong iframe
 * `sandbox="allow-scripts"` (origin opaque) trỏ tới đây nên không đụng được API planner (khác cổng + CSP connect-src 'self' + không cookie).
 * Chỉ GET/HEAD (+ OPTIONS preflight), không API, không cookie, không liệt kê thư mục, không file ẩn. Phục vụ DUY NHẤT: file trong manifest của đúng phiên bản
 * gắn với phiên (token), asset snapshot `assets/u/*` của phiên bản đó, và `__hf/*` (runtime do server cung cấp). Mọi lỗi đều là 404 trơn (không lộ lý do).
 */

export const PREVIEW_TTL_MS = 2 * 60 * 60_000;
export const PREVIEW_MAX_SESSIONS = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface Session {
  versionId: number;
  filesDir: string;
  expires: number;
}

export interface PreviewSessionInfo {
  url: string;
  origin: string;
  expires_at: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};

/** CSP của composition cho origin preview: `HTML_CSP` của engine, bỏ frame-ancestors cũ (nếu có) rồi đặt đúng origin planner. */
export function previewCsp(plannerOrigins: readonly string[]): string {
  const base = HTML_CSP.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d));
  return [...base, `frame-ancestors ${plannerOrigins.join(' ')}`].join('; ');
}

/** Origin của trang planner desktop (cổng LAN) — chấp nhận cả 127.0.0.1 và localhost. */
export function plannerOrigins(ctx: AppContext): string[] {
  const port = ctx.lan?.port ?? ctx.config.lanPort;
  const hosts = new Set(['127.0.0.1', 'localhost']);
  const h = ctx.config.lanHost;
  if (h && h !== '0.0.0.0' && h !== '::') hosts.add(h);
  return [...hosts].map((x) => `http://${x}:${port}`);
}

/** File runtime do server cung cấp ở `__hf/*`. Chỉ tên cố định/an toàn; null = không có. */
export function runtimeFileAbs(rel: string, runtimeDir: string): string | null {
  const dir = path.resolve(runtimeDir);
  let abs: string | null = null;
  if (rel === '__hf/runtime.js') {
    abs = [path.join(dir, 'runtime.js'), path.join(dir, 'hyperframe.runtime.iife.js')].find((f) => fs.existsSync(f)) ?? null;
    if (!abs) {
      try {
        abs = path.join(path.dirname(createRequire(import.meta.url).resolve('@hyperframes/core/package.json')), 'dist', 'hyperframe.runtime.iife.js');
      } catch {
        abs = null;
      }
    }
  } else if (rel === '__hf/gsap.min.js') abs = path.join(dir, 'gsap.min.js');
  else {
    const m = /^__hf\/fonts\/([A-Za-z0-9][A-Za-z0-9._-]*\.woff2)$/.exec(rel);
    if (m) abs = path.join(dir, 'fonts', m[1]!);
  }
  return abs && fs.existsSync(abs) ? abs : null;
}

/** Chuẩn hoá đường dẫn yêu cầu (đã bỏ query): null = từ chối. Chặn `..`, `\`, `:` (ADS/ổ đĩa), NUL, file ẩn, `//`, thư mục (dấu `/` cuối). */
export function safeRelPath(rawPath: string): string | null {
  let dec: string;
  try {
    dec = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!dec || /[\u0000-\u001f\\:*?"<>|]/.test(dec) || dec.endsWith('/') || dec.includes('//') || dec.includes('%')) return null;
  const segs = dec.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || s.startsWith('.') || /[. ]$/.test(s))) return null;
  return segs.join('/');
}

const isInjectable = (rel: string): boolean => rel === 'index.html' || (rel.startsWith('compositions/') && rel.endsWith('.html'));

export class HtmlPreviewService {
  private readonly sessions = new Map<string, Session>(); // thứ tự chèn = thứ tự dùng gần nhất (LRU)
  private server: FastifyInstance | null = null;
  private app: FastifyInstance | null = null;
  private originValue: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: { runtimeDir?: string; maxSessions?: number; ttlMs?: number } = {},
  ) {}

  /** `http://127.0.0.1:<port>` sau khi listen (hoặc `useOrigin` trong test). */
  get origin(): string | null {
    return this.originValue;
  }
  get sessionCount(): number {
    return this.sessions.size;
  }
  private get ttl(): number {
    return this.opts.ttlMs ?? PREVIEW_TTL_MS;
  }
  private get max(): number {
    return this.opts.maxSessions ?? PREVIEW_MAX_SESSIONS;
  }
  private get runtimeDir(): string {
    return this.opts.runtimeDir ?? path.join(APP_DIR, 'server', 'assets', 'html-runtime');
  }

  /** Test: đặt origin giả, dùng `handler()` với inject thay vì mở cổng thật. */
  useOrigin(origin: string): void {
    this.originValue = origin;
  }

  /** Fastify của listener preview (cho inject). Không đăng ký log request (URL chứa token). */
  handler(): FastifyInstance {
    if (!this.app) this.app = this.build();
    return this.app;
  }

  async start(port = this.ctx.config.previewPort): Promise<void> {
    if (this.server) return;
    const app = this.handler();
    await app.listen({ port, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Không lấy được cổng preview');
    this.server = app;
    this.originValue = `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    const s = this.server ?? this.app;
    this.server = null;
    this.app = null;
    this.originValue = null;
    await s?.close();
  }

  /** Tạo (hoặc dùng lại) phiên cho phiên bản `ready`. Token 32 byte ngẫu nhiên, TTL trượt 2 giờ, LRU tối đa N phiên. */
  createSession(v: HtmlVersionRow): PreviewSessionInfo {
    if (!this.originValue) throw conflict('PREVIEW_UNAVAILABLE', 'Dịch vụ xem trước chưa sẵn sàng');
    if (v.status !== 'ready' || !v.files_dir) throw conflict('VERSION_NOT_READY', `Phiên bản v${v.version} chưa sẵn sàng để xem trước`);
    const now = this.ctx.clock.now();
    this.sweep(now);
    let token = [...this.sessions].find(([, s]) => s.versionId === v.id && s.filesDir === v.files_dir)?.[0];
    if (token) this.sessions.delete(token);
    else token = randomBytes(32).toString('base64url');
    const expires = now + this.ttl;
    this.sessions.set(token, { versionId: v.id, filesDir: v.files_dir, expires });
    while (this.sessions.size > this.max) this.sessions.delete(this.sessions.keys().next().value as string);
    return { url: `${this.originValue}/s/${token}/index.html`, origin: this.originValue, expires_at: new Date(expires).toISOString() };
  }

  private sweep(now: number): void {
    for (const [t, s] of this.sessions) if (s.expires <= now) this.sessions.delete(t);
  }

  /** Phiên hợp lệ (chưa hết hạn, phiên bản còn ready và vẫn đúng thư mục) + gia hạn trượt + đẩy lên đầu LRU. */
  private touch(token: string): { session: Session; row: HtmlVersionRow } | null {
    if (!TOKEN_RE.test(token)) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const now = this.ctx.clock.now();
    if (s.expires <= now) {
      this.sessions.delete(token);
      return null;
    }
    const row = this.ctx.db.prepare('SELECT * FROM html_versions WHERE id = ?').get(s.versionId) as HtmlVersionRow | undefined;
    if (!row || row.status !== 'ready' || row.files_dir !== s.filesDir) {
      this.sessions.delete(token);
      return null;
    }
    s.expires = now + this.ttl;
    this.sessions.delete(token);
    this.sessions.set(token, s);
    return { session: s, row };
  }

  /** Đường dẫn tuyệt đối của file được phép phục vụ (manifest / asset snapshot / __hf), null nếu không. */
  private resolveFile(row: HtmlVersionRow, rel: string): string | null {
    if (rel.startsWith('__hf/')) return runtimeFileAbs(rel, this.runtimeDir);
    const root = path.resolve(this.ctx.config.rootDir, row.files_dir!);
    let ok = parseJson<ManifestEntry[]>(row.manifest_json, []).some((m) => m.path === rel);
    if (!ok && /^assets\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(rel)) {
      const snap = this.ctx.db.prepare('SELECT 1 FROM html_version_assets WHERE version_id = ? AND snapshot_path = ?').get(row.id, `${row.files_dir}/${rel}`);
      ok = !!snap;
    }
    if (!ok) return null;
    const abs = path.resolve(root, ...rel.split('/'));
    return abs.startsWith(root + path.sep) ? abs : null;
  }

  private cspValue(): string {
    return previewCsp(plannerOrigins(this.ctx));
  }

  private hostOk(host: string | undefined): boolean {
    if (!host || !this.originValue) return false;
    const port = new URL(this.originValue).port;
    return host.toLowerCase() === `127.0.0.1:${port}` || host.toLowerCase() === `localhost:${port}`;
  }

  private build(): FastifyInstance {
    const app = Fastify({ logger: false, trustProxy: false });
    app.addHook('onRequest', async (req, reply) => {
      reply
        .header('Content-Security-Policy', this.cspValue())
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-DNS-Prefetch-Control', 'off')
        .header('Cache-Control', 'no-store');
      if (!this.hostOk(req.headers.host)) return reply.code(404).type('text/plain; charset=utf-8').send('Not found'); // chống DNS rebinding
      return undefined;
    });
    const nf = (reply: FastifyReply) => reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    app.setNotFoundHandler((_req, reply) => nf(reply));
    app.setErrorHandler((_err, _req, reply) => nf(reply));
    app.options('/s/*', async (_req, reply) =>
      reply.code(204).header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS').header('Access-Control-Allow-Headers', 'Range').header('Access-Control-Max-Age', '600').send(),
    );
    app.get('/s/:token/*', (req, reply) => this.serve(req, reply));
    return app;
  }

  private serve(req: FastifyRequest, reply: FastifyReply): FastifyReply {
    const nf = () => reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    const rawPath = req.raw.url!.split('?')[0]!;
    const m = /^\/s\/([^/]+)\/(.*)$/.exec(rawPath);
    if (!m) return nf();
    const t = this.touch(m[1]!);
    if (!t) return nf();
    const rel = safeRelPath(m[2]!);
    if (!rel) return nf();
    const abs = this.resolveFile(t.row, rel);
    if (!abs) return nf();
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return nf();
    }
    if (!st.isFile() || st.isSymbolicLink()) return nf();
    const ext = path.extname(rel).toLowerCase();
    reply.type(MIME[ext] ?? 'application/octet-stream').header('Accept-Ranges', 'bytes');

    if (isInjectable(rel)) {
      // index.html: CSP meta + @font-face + runtime; compositions/*.html (được nhúng vào index) chỉ CSP. Chèn ngay khi phục vụ (file trên đĩa giữ nguyên, bất biến).
      const html = injectHead(fs.readFileSync(abs, 'utf8'), rel === 'index.html' ? { mode: 'preview', runtimeSrc: '__hf/runtime.js' } : { mode: 'preview', fonts: false, base: '../' });
      return reply.code(200).header('Content-Length', Buffer.byteLength(html)).send(html);
    }

    const size = st.size;
    const range = req.headers.range;
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start = NaN;
      let end = NaN;
      if (r && (r[1] || r[2])) {
        if (!r[1]) {
          start = Math.max(0, size - Number(r[2]));
          end = size - 1;
        } else {
          start = Number(r[1]);
          end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        }
      }
      if (!Number.isFinite(start) || start >= size || start > end) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(abs, { start, end }));
    }
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(abs));
  }
}

const services = new WeakMap<AppContext, HtmlPreviewService>();

/** Dịch vụ preview của ctx (null nếu chưa tạo: bản LAN thật, hoặc chưa khởi động). */
export const getHtmlPreview = (ctx: AppContext): HtmlPreviewService | null => services.get(ctx) ?? null;

/** Tạo dịch vụ (chưa mở cổng). Chỉ bản desktop. */
export function ensureHtmlPreview(ctx: AppContext, opts?: ConstructorParameters<typeof HtmlPreviewService>[1]): HtmlPreviewService {
  let s = services.get(ctx);
  if (!s) {
    s = new HtmlPreviewService(ctx, opts);
    services.set(ctx, s);
  }
  return s;
}

/** Origin preview hiện hành (null nếu chưa chạy) — dùng cho `frame-src` của trang planner. */
export const htmlPreviewOrigin = (ctx: AppContext): string | null => services.get(ctx)?.origin ?? null;

/** Mở listener preview (desktop). Lỗi mở cổng → throw (index.ts bắt, app vẫn chạy, tab Video HTML báo không xem trước được). */
export async function startHtmlPreview(ctx: AppContext): Promise<HtmlPreviewService> {
  const s = ensureHtmlPreview(ctx);
  await s.start();
  return s;
}

export async function stopHtmlPreview(ctx: AppContext): Promise<void> {
  const s = services.get(ctx);
  services.delete(ctx);
  await s?.close();
}
