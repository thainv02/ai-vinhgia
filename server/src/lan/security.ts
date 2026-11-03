import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Host hợp lệ của listener giao diện: chỉ địa chỉ loopback (127.0.0.1, localhost, [::1]) vì listener chỉ nghe trên máy này.
 * Chặn mọi tên miền khác (DNS rebinding: tên miền của kẻ tấn công trỏ về 127.0.0.1).
 */
export function isLanHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader || hostHeader.length > 255) return false;
  try {
    return LOOPBACK.has(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** `Origin` của request ghi phải đúng bằng `http://<Host của chính listener>`. Thiếu Origin cũng bị từ chối. */
export function isOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || !hostHeader) return false;
  return origin.toLowerCase() === `http://${hostHeader.toLowerCase()}`;
}

export const lanIp = (req: FastifyRequest): string => req.ip.replace(/^::ffff:/, '');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** CSP của trang planner khi có preview: như `CSP` + `frame-src <origin preview>` (không nới gì khác). */
export const pagePolicy = (previewOrigin: string): string => `${CSP}; frame-src ${previewOrigin}`;

/** Trang planner và assets build: mở được từ liên kết bất kỳ (kể cả cross-site). Mọi route khác chặn request cross-site. */
export function isPublicRequest(method: string, url: string): boolean {
  const path = url.split('?')[0]!;
  return (method === 'GET' || method === 'HEAD') && (path === '/' || path === '/planner.html' || path.startsWith('/assets/'));
}

/**
 * Hook bảo mật của listener giao diện, chạy cho MỌI request (kể cả 404):
 * 1. Host là loopback; 2. request ghi có Origin khớp Host; 3. chặn Sec-Fetch-Site=cross-site với route không công khai;
 * 4. header an toàn (CSP, nosniff, no-referrer, chống nhúng khung).
 */
export function registerLanSecurity(
  app: FastifyInstance,
  /** Origin preview Video HTML. Chỉ thêm `frame-src` cho CHÍNH trang planner (`/`, `/planner.html`); route khác giữ nguyên CSP. */
  previewOrigin?: () => string | null,
): void {
  app.addHook('onRequest', async (req, reply) => {
    const pagePath = req.url.split('?')[0];
    const fo = previewOrigin && (pagePath === '/' || pagePath === '/planner.html') ? previewOrigin() : null;
    reply.header('Content-Security-Policy', fo ? pagePolicy(fo) : CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.url.startsWith('/lan/api/')) reply.header('Cache-Control', 'no-store');
    if (!isLanHostAllowed(req.headers.host)) {
      throw new AppError('FORBIDDEN_HOST', 'Header Host không được phép (chỉ 127.0.0.1 hoặc localhost)', 403);
    }
    if (WRITE_METHODS.has(req.method) && !isOriginAllowed(req.headers.origin, req.headers.host)) {
      throw new AppError('FORBIDDEN_ORIGIN', 'Origin không được phép gọi API này', 403);
    }
    // Mở trang từ liên kết ở app khác (cross-site) là bình thường; gọi API/tải file từ trang web khác thì không.
    if (!isPublicRequest(req.method, req.url) && req.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError('FORBIDDEN_ORIGIN', 'Yêu cầu từ trang web khác không được phép', 403);
    }
  });
}
