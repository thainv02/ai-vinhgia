import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { type Clock, toIso } from './lib/clock.js';
import type { FinalRenderService } from './services/final-render/index.js';
import { SseHub } from './services/sse.js';

export type SseEventName =
  | 'scene.updated'
  | 'job.updated'
  | 'asset.created'
  | 'asset.updated'
  | 'comment.created'
  | 'comment.updated'
  | 'worker.status'
  | 'budget.updated'
  | 'project.updated'
  | 'final_cut.updated'
  | 'event.created';

/**
 * Ngữ cảnh dùng chung của ứng dụng: DB, cấu hình, đồng hồ, SSE.
 * Mọi thay đổi ghi DB đi qua `tx()` (BEGIN IMMEDIATE); sự kiện SSE và tác vụ phụ (ghi file)
 * chỉ chạy SAU KHI transaction commit thành công.
 */
export class AppContext {
  private depth = 0;
  private after: Array<() => void> = [];
  private dedupe = new Set<string>();
  /** Trạng thái online gần nhất đã phát qua SSE `worker.status` (null = chưa phát lần nào). */
  public lastEmittedOnline: boolean | null = null;
  /** Dịch vụ render bản hoàn chỉnh (nền). Gán trong buildApp; null trong script/test không cần render. */
  public finalRender: FinalRenderService | null = null;

  constructor(
    public readonly db: DB,
    public readonly config: Config,
    public readonly clock: Clock,
    public readonly sse: SseHub,
  ) {}

  now(): string {
    return toIso(this.clock.now());
  }

  get inTx(): boolean {
    return this.depth > 0;
  }

  /** Chạy fn trong transaction BEGIN IMMEDIATE. Lồng nhau thì dùng lại transaction ngoài cùng. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth = 1;
    this.after = [];
    this.dedupe.clear();
    let result: T;
    try {
      result = this.db.transaction(fn).immediate();
    } catch (err) {
      this.depth = 0;
      this.after = [];
      this.dedupe.clear();
      throw err;
    }
    this.depth = 0;
    const tasks = this.after;
    this.after = [];
    this.dedupe.clear();
    for (const task of tasks) {
      try {
        task();
      } catch (err) {
        console.error('[after-commit] lỗi:', err);
      }
    }
    return result;
  }

  /** Chạy fn sau khi transaction hiện tại commit (hoặc ngay nếu không ở trong transaction). */
  afterCommit(fn: () => void, dedupeKey?: string): void {
    if (this.depth === 0) {
      fn();
      return;
    }
    if (dedupeKey) {
      if (this.dedupe.has(dedupeKey)) return;
      this.dedupe.add(dedupeKey);
    }
    this.after.push(fn);
  }

  /** Phát SSE sau commit. `data` có thể là hàm để đọc trạng thái đã commit. */
  publish(event: SseEventName, projectId: number | null, data: unknown | (() => unknown), dedupeKey?: string): void {
    this.afterCommit(() => {
      // Không ai nghe thì khỏi dựng payload (tiết kiệm truy vấn); worker.status luôn chạy để cập nhật lastEmittedOnline.
      if (this.sse.size === 0 && event !== 'worker.status') return;
      const payload = typeof data === 'function' ? (data as () => unknown)() : data;
      this.sse.publish(event, payload, projectId);
    }, dedupeKey);
  }
}
