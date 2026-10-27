import crypto from 'node:crypto';

export const SESSION_COOKIE = 'autovideo_lan';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

/** So khớp mã truy cập: không phân biệt hoa thường, thời gian hằng số (so sánh băm). */
export function codeMatches(input: unknown, expected: string): boolean {
  if (typeof input !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(sha256(input.trim().toUpperCase()), sha256(expected.trim().toUpperCase()));
}

/** Phiên đăng nhập LAN trong bộ nhớ (mất khi khởi động lại server → đăng nhập lại). Token 256 bit; chỉ lưu băm. */
export class LanSessions {
  private readonly map = new Map<string, number>(); // sha256(token) → hết hạn (ms)

  constructor(
    private readonly now: () => number,
    private readonly max = 1000,
  ) {}

  private key(token: string): string {
    return sha256(token).toString('hex');
  }

  create(): { token: string; expiresAt: number } {
    this.prune();
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!); // đầy: bỏ phiên cũ nhất
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.map.set(this.key(token), expiresAt);
    return { token, expiresAt };
  }

  /** Trả thời điểm hết hạn nếu phiên còn hiệu lực, ngược lại null. */
  valid(token: string | undefined): number | null {
    if (!token) return null;
    const k = this.key(token);
    const exp = this.map.get(k);
    if (exp === undefined) return null;
    if (exp <= this.now()) {
      this.map.delete(k);
      return null;
    }
    return exp;
  }

  destroy(token: string | undefined): void {
    if (token) this.map.delete(this.key(token));
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.map) if (exp <= t) this.map.delete(k);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Cookie phiên: HttpOnly, SameSite=Strict, chỉ gửi cho đường dẫn /lan (cookie không phân biệt cổng nên Path thu hẹp tránh lẫn
 * với app chính cùng hostname). Không có `Secure` vì trang LAN chạy HTTP thuần.
 */
export const sessionCookie = (token: string, maxAgeS: number): string =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/lan; Max-Age=${maxAgeS}`;
export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/lan; Max-Age=0`;
