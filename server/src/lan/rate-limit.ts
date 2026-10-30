/**
 * Giới hạn tốc độ theo khóa (IP) dạng cửa sổ trượt, giữ trong bộ nhớ (mất khi khởi động lại: chấp nhận được cho trang LAN).
 * `now` lấy từ đồng hồ của AppContext để test điều khiển được thời gian.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Còn đủ chỗ cho `n` lượt nữa không? Khi hết: `retryAfterMs` = thời gian tới khi đủ chỗ. Không ghi nhận gì. */
  check(key: string, n = 1): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const list = this.live(key);
    const remaining = Math.max(0, this.max - list.length);
    if (list.length + n <= this.max) return { allowed: true, remaining, retryAfterMs: 0 };
    // lượt cũ nhất cần rời cửa sổ để giải phóng đủ chỗ cho n lượt
    const idx = Math.min(list.length - 1, list.length + n - this.max - 1);
    const retryAfterMs = Math.max(1000, (list[idx] ?? this.now()) + this.windowMs - this.now());
    return { allowed: false, remaining, retryAfterMs };
  }

  record(key: string, n = 1): void {
    const list = this.live(key);
    const t = this.now();
    for (let i = 0; i < n; i++) list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 5000) for (const k of [...this.hits.keys()]) this.live(k); // dọn khóa đã hết hạn
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}
