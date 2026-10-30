import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseCookies } from './session.js';

/**
 * Cookie client ẩn danh, DÀI HẠN, tách khỏi phiên đăng nhập (nếu LAN_REQUIRE_CODE=true; mặc định không có phiên): xác định "trình duyệt này"
 * để chỉ chủ của một việc công cụ (xoá logo Veo) mới thấy/tải/hủy được việc đó. Không phải danh tính: ai xoá cookie thì mất quyền xem
 * việc cũ (việc tự hết hạn sau 7 ngày dù cookie còn).
 * Giá trị là 256 bit ngẫu nhiên; DB chỉ lưu SHA-256 (`lan_tool_jobs.client_id_hash`). HttpOnly + SameSite=Strict + Path=/lan,
 * 400 ngày (mức tối đa trình duyệt chấp nhận: không có phiên nên cookie này là thứ duy nhất giữ quyền xem việc cũ).
 * Được cấp lười (lần đầu gọi route công cụ), KHÔNG cấp lúc đăng nhập để giữ nguyên hợp đồng cookie phiên.
 */
export const CLIENT_COOKIE = 'autovideo_lan_client';
export const CLIENT_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 byte base64url

export const clientCookieLine = (value: string): string => `${CLIENT_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/lan; Max-Age=${CLIENT_COOKIE_MAX_AGE_S}`;
export const hashClientId = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** Băm client của request nếu có cookie hợp lệ về hình dạng; không cấp cookie mới. */
export function peekClientHash(req: FastifyRequest): string | null {
  const v = parseCookies(req.headers.cookie)[CLIENT_COOKIE];
  return v && SHAPE.test(v) ? hashClientId(v) : null;
}

/** Băm client của request; chưa có cookie hợp lệ thì cấp một cookie mới (Set-Cookie trong chính phản hồi này). */
export function ensureClientHash(req: FastifyRequest, reply: FastifyReply): string {
  const existing = peekClientHash(req);
  if (existing) return existing;
  const value = crypto.randomBytes(32).toString('base64url');
  reply.header('Set-Cookie', clientCookieLine(value));
  return hashClientId(value);
}
