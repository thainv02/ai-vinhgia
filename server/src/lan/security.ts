import net from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { LanSessions, SESSION_COOKIE, parseCookies } from './session.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCAL_SUFFIXES = ['.local', '.lan', '.internal', '.home.arpa'];

/**
 * Host hợp lệ của listener LAN: IP (IPv4/IPv6), localhost, tên một nhãn (hostname trong LAN), *.local (mDNS) và vài hậu tố mạng nội bộ,
 * hoặc nằm trong LAN_ALLOWED_HOSTS. Chặn tên miền công cộng (DNS rebinding trỏ tên miền của kẻ tấn công về IP LAN).
 */
export function isLanHostAllowed(hostHeader: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!hostHeader || hostHeader.length > 255) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(bare) !== 0) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (!hostname.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((s) => hostname.endsWith(s))) return true;
  return extraHosts.includes(hostname);
}

/** `Origin` của request ghi phải đúng bằng `http://<Host của chính listener LAN>`. Thiếu Origin cũng bị từ chối. */
export function isOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || !hostHeader) return false;
  return origin.toLowerCase() === `http://${hostHeader.toLowerCase()}`;
}

export const lanIp = (req: FastifyRequest): string => req.ip.replace(/^::ffff:/, '');

export const sessionTokenOf = (req: FastifyRequest): string | undefined => parseCookies(req.headers.cookie)[SESSION_COOKIE];

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

/**
 * Request công khai (không cần phiên): trang planner, assets build, đăng nhập và dò trạng thái phiên (trả 200 {authenticated:false}
 * thay vì 401 để trình duyệt không ghi lỗi đỏ ở lần mở đầu). Mọi thứ khác phải có phiên.
 */
export function isPublicRequest(method: string, url: string): boolean {
  const path = url.split('?')[0]!;
  if (method === 'POST' && path === '/lan/api/login') return true;
  if (method === 'GET' || method === 'HEAD') return path === '/' || path === '/planner.html' || path === '/lan/api/session' || path.startsWith('/assets/');
  return false;
}

/**
 * Hook bảo mật của listener LAN, chạy cho MỌI request (kể cả 404):
 * 1. Host hợp lệ; 2. request ghi có Origin khớp Host; 3. chặn Sec-Fetch-Site=cross-site với route không công khai;
 * 4. cần phiên trừ route công khai — CHỈ khi `requireCode` (LAN_REQUIRE_CODE=true; mặc định không cần mã nên không có phiên);
 * 5. header an toàn (CSP, nosniff, no-referrer, chống nhúng khung).
 * Bỏ mã truy cập KHÔNG nới các bước 1, 2, 3, 5 (cũng như rate limit, trần hàng đợi và danh sách file được phép ở route).
 */
export function registerLanSecurity(app: FastifyInstance, sessions: LanSessions, extraHosts: readonly string[], requireCode = true): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.url.startsWith('/lan/api/')) reply.header('Cache-Control', 'no-store');
    if (!isLanHostAllowed(req.headers.host, extraHosts)) {
      throw new AppError('FORBIDDEN_HOST', 'Header Host không được phép (dùng địa chỉ IP hoặc tên máy trong mạng LAN)', 403);
    }
    if (WRITE_METHODS.has(req.method) && !isOriginAllowed(req.headers.origin, req.headers.host)) {
      throw new AppError('FORBIDDEN_ORIGIN', 'Origin không được phép gọi API này', 403);
    }
    if (!isPublicRequest(req.method, req.url)) {
      // Mở trang từ liên kết ở app khác (cross-site) là bình thường; gọi API/tải file từ trang web khác thì không.
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        throw new AppError('FORBIDDEN_ORIGIN', 'Yêu cầu từ trang web khác không được phép', 403);
      }
      if (requireCode && !sessions.valid(sessionTokenOf(req))) {
        throw new AppError('UNAUTHENTICATED', 'Cần nhập mã truy cập để dùng trang này', 401);
      }
    }
  });
}
