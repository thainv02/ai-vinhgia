import type { AppContext } from '../../context.js';
const backoff = new WeakMap<AppContext, number>();
export function composeParallel(ctx: AppContext, now = Date.now()) {
  return (backoff.get(ctx) ?? 0) > now ? 1 : Math.max(1, Math.min(3, Math.floor(ctx.config.htmlComposeParallel ?? 2)));
}
/** Rate limit chỉ giảm luồng tạm thời, không sửa cấu hình người dùng. */
export function composeRateLimited(ctx: AppContext, error: unknown, now = Date.now()) {
  const e = error as { status?: number; code?: string; details?: { reason?: string; code?: string; status?: number } };
  if (
    e?.status === 429 ||
    e?.code === 'RATE_LIMITED' ||
    e?.details?.status === 429 ||
    /rate.?limit|429/i.test(`${e?.details?.reason ?? ''} ${e?.details?.code ?? ''}`)
  )
    backoff.set(ctx, now + 300000);
}
