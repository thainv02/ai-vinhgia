import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { clampRenderConcurrency } from '../../config.js';
import type { AppContext } from '../../context.js';
import {
  type Edl,
  emitFinalCut,
  type SelectionItem,
  finalPaths,
  getFinalCutRow,
  markFailed,
  markReady,
  tmpCleanPath,
  updateCut,
} from '../final-cuts.js';
import { emitCut } from '../clips/view.js';
import { resolveMatchLuts } from '../color-match.js';
import { buildGradeFilter, isNeutralGrade, outRanges, parseStoredGrade, type Grade } from '../grade.js';
import { cleanBaseOf } from '../final-revisions.js';
import { ffmpegOf, probeMedia } from '../media.js';
import { getProject, parseJson } from '../repo.js';
import { FfmpegRenderer, makeContactSheet } from './ffmpeg-renderer.js';
import { encodeGraded, GradeError, linkOrCopy, verifyGraded } from './grade-step.js';
import { ShotcutRenderer } from './shotcut-renderer.js';
import { RenderCancelled, type RenderSegment, type Renderer } from './types.js';
import { computeWatermarkStatus, runWatermarkCli, verifyCleaned, WatermarkError, type WatermarkStatus } from './watermark.js';

export type { Renderer, RenderRequest, RenderOutcome, RenderSegment } from './types.js';
export { RenderCancelled } from './types.js';
export { FfmpegRenderer, buildFfmpegArgs } from './ffmpeg-renderer.js';
export { ShotcutRenderer, mcpMaxActiveRendersEnv } from './shotcut-renderer.js';
export { McpClient, McpToolError } from './mcp-client.js';
export { gradePreview, type GradePreviewResult } from './grade-preview.js';
export { buildGradeFilter } from '../grade.js';
export { computeWatermarkStatus, descendants, killTree, runWatermarkCli, verifyCleaned, type WatermarkStatus } from './watermark.js';

export interface RendererStatus {
  mode: 'auto' | 'shotcut' | 'ffmpeg';
  /** Trình dựng sẽ dùng cho lần render kế tiếp; null nếu không có cái nào khả dụng. */
  active: 'shotcut' | 'ffmpeg' | null;
  /** Lý do (tiếng Việt) để giao diện hiển thị. */
  reason: string;
  shotcut: { configured: boolean; ready: boolean | null; detail: string | null };
  ffmpeg: { available: boolean; path: string | null };
}

export interface FinalRenderOptions {
  /** Ép dùng một renderer cụ thể (test). */
  renderer?: Renderer;
  /** Mở file .mlt trong Shotcut (mặc định macOS `open -a Shotcut`). */
  opener?: (abs: string) => Promise<void>;
  /** Giãn cách tối thiểu giữa hai lần ghi progress (mặc định 1000ms). */
  progressThrottleMs?: number;
  /** Tùy chọn cho ShotcutRenderer (test). */
  shotcut?: { pollMs?: number; timeoutMs?: number };
  /** Thời gian nhớ kết quả `--check` của MCP (mặc định 60 giây). */
  checkTtlMs?: number;
  /** Thời gian chờ thêm ngoài GWR_TIMEOUT_MS trước khi tự dừng tool xoá logo (mặc định 30 giây; test đặt nhỏ). */
  watermarkGraceMs?: number;
  /** Giãn cách tối thiểu giữa hai lần phát `final_cut.updated` vì vị trí hàng đợi đổi (mặc định 300ms; 0 = phát ngay trong test). */
  queueNotifyMs?: number;
}

/** Tình trạng của một việc trong hàng đợi render (xem `FinalRenderService.queueInfo`). */
export interface QueueInfo {
  /** `waiting`: đã xếp hàng nhưng CHƯA bắt đầu (đợi có chỗ trống); `running`: đang chạy. */
  state: 'waiting' | 'running';
  /** 1 = sẽ chạy tiếp theo; `null` khi đang chạy. */
  position: number | null;
  /** Số việc đang chạy lúc này (cả bản dựng và việc công cụ). */
  running_count: number;
  /** Số việc được chạy cùng lúc tối đa (`RENDER_CONCURRENCY`). */
  concurrency: number;
}

const defaultOpener = (abs: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') return reject(new Error('Chỉ hỗ trợ mở Shotcut trên macOS'));
    const child = spawn('open', ['-a', 'Shotcut', abs], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Không mở được Shotcut (open thoát mã ${code})`))));
  });

/**
 * Hàng đợi render bản hoàn chỉnh trong tiến trình: mỗi lúc chỉ render MỘT bản. Chọn renderer theo FINAL_RENDERER
 * (auto = Shotcut nếu cấu hình đủ và `--check` của MCP chạy được, ngược lại ffmpeg).
 */
/** Một việc trong hàng đợi: render/clean một bản dựng (`cut`) hoặc một việc công cụ LAN (`tool`, tự mang hàm chạy). `lan`: việc từ LAN. */
interface QueueItem {
  kind: QueueKind;
  id: number;
  mode: 'full' | 'clean' | 'grade';
  lan: boolean;
  run?: (abort: AbortController) => Promise<void>;
}

/** Một việc ĐANG chạy (đã lấy ra khỏi hàng đợi, có AbortController riêng ngay từ lúc nhận để hủy được cả khi còn đang kiểm tra trình dựng). */
interface RunningItem {
  kind: QueueKind;
  id: number;
  abort: AbortController;
  lan: boolean;
}

/** `cut`: bản dựng hoàn chỉnh; `tool`: việc công cụ LAN; `clip`: bản dựng clip cắt từ video dài; `preview`: bản xem thử 480p của video nguồn LAN. */
export type QueueKind = 'cut' | 'tool' | 'clip' | 'preview';
const keyOf = (kind: QueueKind, id: number): string => `${kind}:${id}`;

export class FinalRenderService {
  private queue: QueueItem[] = [];
  /** Các việc đang chạy, theo khoá `kind:id`. Kích thước ≤ `concurrency`. */
  private readonly running = new Map<string, RunningItem>();
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;
  private statusCache: { at: number; value: RendererStatus } | null = null;
  private statusPending: Promise<RendererStatus> | null = null;
  private wmCache: { at: number; value: WatermarkStatus } | null = null;
  private wmPending: Promise<WatermarkStatus> | null = null;
  private idleWaiters: Array<() => void> = [];
  /** Vị trí hàng đợi đã phát qua SSE cho từng bản dựng (0 = đang chạy), để chỉ phát khi đổi. */
  private readonly emittedPos = new Map<number, number>();
  /** Như `emittedPos` nhưng cho bản dựng clip (id của `clip_cuts` và `final_cuts` không chung không gian). */
  private readonly emittedClipPos = new Map<number, number>();
  private notifyTimer: NodeJS.Timeout | null = null;
  private lastNotify = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: FinalRenderOptions = {},
  ) {}

  // ---------------------------------------------------------------- chọn renderer

  /** Giãn cách tối thiểu giữa hai lần ghi progress (dùng chung cho việc công cụ LAN). */
  get progressThrottleMs(): number {
    return this.opts.progressThrottleMs ?? 1000;
  }

  /** Trạng thái trình dựng cho `GET /api/meta` (có cache). */
  async status(force = false): Promise<RendererStatus> {
    const ttl = this.opts.checkTtlMs ?? 60_000;
    if (!force && this.statusCache && Date.now() - this.statusCache.at < ttl) return this.statusCache.value;
    // nhiều việc bắt đầu cùng lúc khi cache hết hạn: chỉ chạy `--check` của Shotcut MCP một lần
    if (!force && this.statusPending) return this.statusPending;
    const pending = this.computeStatus().then((value) => {
      this.statusCache = { at: Date.now(), value };
      return value;
    });
    this.statusPending = pending;
    try {
      return await pending;
    } finally {
      if (this.statusPending === pending) this.statusPending = null;
    }
  }

  private async computeStatus(): Promise<RendererStatus> {
    const cfg = this.ctx.config;
    const ffPath = ffmpegOf(cfg);
    const ffmpeg = { available: !!ffPath, path: ffPath };
    if (this.opts.renderer) {
      const n = this.opts.renderer.name;
      return {
        mode: cfg.finalRenderer,
        active: n,
        reason: `Trình dựng được chỉ định: ${n}`,
        shotcut: { configured: n === 'shotcut', ready: n === 'shotcut' ? true : null, detail: null },
        ffmpeg,
      };
    }
    const py = cfg.shotcutMcpPython;
    const script = cfg.shotcutMcpServerScript;
    const configured = !!py && !!script;
    let ready: boolean | null = null;
    let detail: string | null = null;
    if (!configured) detail = 'Chưa cấu hình SHOTCUT_MCP_PYTHON và SHOTCUT_MCP_SERVER_SCRIPT';
    else if (!path.isAbsolute(py!) || !path.isAbsolute(script!)) detail = 'SHOTCUT_MCP_PYTHON và SHOTCUT_MCP_SERVER_SCRIPT phải là đường dẫn tuyệt đối';
    else if (!fs.existsSync(py!) || !fs.existsSync(script!)) detail = 'Không thấy file Python hoặc script Shotcut MCP';
    else if (cfg.finalRenderer !== 'ffmpeg') {
      const check = await runCheck(py!, script!);
      ready = check.ready;
      detail = check.detail;
    }
    const base = { mode: cfg.finalRenderer, shotcut: { configured, ready, detail }, ffmpeg };
    if (cfg.finalRenderer === 'ffmpeg') {
      return { ...base, active: ffmpeg.available ? 'ffmpeg' : null, reason: ffmpeg.available ? 'FINAL_RENDERER=ffmpeg: dựng bằng ffmpeg' : 'FINAL_RENDERER=ffmpeg nhưng không tìm thấy ffmpeg' };
    }
    if (cfg.finalRenderer === 'shotcut') {
      return ready
        ? { ...base, active: 'shotcut', reason: 'FINAL_RENDERER=shotcut: dựng bằng Shotcut MCP' }
        : { ...base, active: null, reason: `FINAL_RENDERER=shotcut nhưng Shotcut MCP chưa sẵn sàng: ${detail ?? 'không rõ lý do'}` };
    }
    if (ready) return { ...base, active: 'shotcut', reason: 'Tự động: Shotcut MCP sẵn sàng, dựng bằng Shotcut' };
    if (ffmpeg.available) return { ...base, active: 'ffmpeg', reason: `Tự động: dùng ffmpeg vì ${detail ?? 'Shotcut MCP chưa sẵn sàng'}` };
    return { ...base, active: null, reason: `Không có trình dựng khả dụng (Shotcut: ${detail ?? 'chưa sẵn sàng'}; ffmpeg: không tìm thấy)` };
  }

  /** Trạng thái bước xoá logo Veo cho `GET /api/meta` → `watermark_remover` (có cache). */
  async watermarkStatus(force = false): Promise<WatermarkStatus> {
    const ttl = this.opts.checkTtlMs ?? 60_000;
    if (!force && this.wmCache && Date.now() - this.wmCache.at < ttl) return this.wmCache.value;
    // nhiều người dùng LAN hỏi cùng lúc khi cache hết hạn: chỉ chạy `--help` của tool một lần
    if (!force && this.wmPending) return this.wmPending;
    const pending = computeWatermarkStatus(this.ctx.config).then((value) => {
      this.wmCache = { at: Date.now(), value };
      return value;
    });
    this.wmPending = pending;
    try {
      return await pending;
    } finally {
      if (this.wmPending === pending) this.wmPending = null;
    }
  }

  private async pick(): Promise<{ renderer: Renderer | null; status: RendererStatus }> {
    const status = await this.status();
    if (this.opts.renderer) return { renderer: this.opts.renderer, status };
    if (status.active === 'shotcut') {
      return {
        renderer: new ShotcutRenderer({
          python: this.ctx.config.shotcutMcpPython!,
          script: this.ctx.config.shotcutMcpServerScript!,
          // mỗi render một tiến trình MCP riêng; MCP tự giới hạn số render cùng lúc (mặc định 2) nên phải nâng theo RENDER_CONCURRENCY
          maxActiveRenders: this.concurrency,
          ...this.opts.shotcut,
        }),
        status,
      };
    }
    if (status.active === 'ffmpeg') return { renderer: new FfmpegRenderer(), status };
    return { renderer: null, status };
  }

  // ---------------------------------------------------------------- hàng đợi

  /** Số việc chạy cùng lúc (`RENDER_CONCURRENCY`, luôn nguyên 1–4). */
  get concurrency(): number {
    return clampRenderConcurrency(this.ctx.config.renderConcurrency);
  }

  /** Số việc đang chạy lúc này. */
  get runningCount(): number {
    return this.running.size;
  }

  /**
   * `full`: render rồi (nếu bật) xoá logo rồi (nếu grade không trung tính) chỉnh màu; `clean`: chỉ chạy lại bước xoá logo trên bản raw có sẵn (rồi chỉnh màu nếu có);
   * `grade`: chỉ chạy bước chỉnh màu trên bản sạch có sẵn (không render, không xoá logo).
   * Ưu tiên: việc của dự án `app` (chủ máy) đứng TRƯỚC mọi việc LAN đang chờ (FIFO trong từng nhóm). Việc đang chạy không bị ngắt.
   */
  enqueue(id: number, mode: 'full' | 'clean' | 'grade' = 'full'): void {
    // đang chạy nhưng đã bị hủy (đang dừng tiến trình) thì cho xếp lại: "hủy rồi bấm xoá logo lại ngay" không được bị nuốt
    if (this.closed || this.isQueued('cut', id) || this.isRunning('cut', id)) return;
    const src = this.ctx.db
      .prepare('SELECT p.source FROM final_cuts f JOIN projects p ON p.id = f.project_id WHERE f.id = ?')
      .get(id) as { source: string } | undefined;
    this.push({ kind: 'cut', id, mode, lan: src?.source === 'lan' });
  }

  /**
   * Việc của dự án cắt clip (`clip`: bản dựng clip; `preview`: bản xem thử 480p của video nguồn LAN): cùng hàng đợi, cùng `RENDER_CONCURRENCY`;
   * việc của app đứng trước việc LAN đang chờ. `run` tự cập nhật DB của việc.
   */
  enqueueClipTask(kind: 'clip' | 'preview', id: number, lan: boolean, run: (abort: AbortController) => Promise<void>): void {
    if (this.closed || this.isQueued(kind, id) || this.isRunning(kind, id)) return;
    this.push({ kind, id, mode: 'full', lan, run });
  }

  /** Hủy việc `clip`/`preview` đang chờ hoặc đang chạy (dừng ffmpeg qua AbortSignal). */
  cancelClipTask(kind: 'clip' | 'preview', id: number): void {
    this.drop(kind, id);
  }

  /** Việc công cụ LAN (vd xoá logo video tải lên): cùng hàng đợi, luôn xếp sau việc của app. `run` tự cập nhật DB của việc. */
  enqueueTool(id: number, run: (abort: AbortController) => Promise<void>): void {
    if (this.closed || this.isQueued('tool', id) || this.isRunning('tool', id)) return;
    this.push({ kind: 'tool', id, mode: 'full', lan: true, run });
  }

  private isQueued(kind: QueueKind, id: number): boolean {
    return this.queue.some((j) => j.kind === kind && j.id === id);
  }

  /** Đang chạy VÀ chưa bị hủy (việc đang dừng dở thì coi như không chạy, để xếp lại được). */
  private isRunning(kind: QueueKind, id: number): boolean {
    const r = this.running.get(keyOf(kind, id));
    return !!r && !r.abort.signal.aborted;
  }

  private push(item: QueueItem): void {
    if (item.lan) this.queue.push(item);
    else {
      const firstLan = this.queue.findIndex((j) => j.lan);
      if (firstLan < 0) this.queue.push(item);
      else this.queue.splice(firstLan, 0, item);
    }
    this.schedule();
  }

  /**
   * Lấp đầy các chỗ trống: lấy việc đầu hàng đợi (app trước LAN) cho tới khi đủ `concurrency` việc đang chạy.
   * Việc có cùng khoá với một việc ĐANG dừng dở (vừa bị hủy, tiến trình chưa thoát) được hoãn cho tới khi việc cũ xong,
   * để hai tiến trình không dùng chung thư mục/file tạm.
   */
  private schedule(): void {
    while (!this.closed && this.running.size < this.concurrency) {
      const i = this.queue.findIndex((j) => !this.running.has(keyOf(j.kind, j.id)));
      if (i < 0) break;
      const job = this.queue.splice(i, 1)[0]!;
      const item: RunningItem = { kind: job.kind, id: job.id, abort: new AbortController(), lan: job.lan };
      const key = keyOf(job.kind, job.id);
      this.running.set(key, item);
      const p: Promise<void> = this.execute(job, item)
        .catch((err) => console.error('[final-render] lỗi không lường trước:', err))
        .finally(() => {
          this.running.delete(key);
          this.inflight.delete(p);
          if (job.kind === 'cut') this.emittedPos.delete(job.id);
          else if (job.kind === 'clip') this.emittedClipPos.delete(job.id);
          this.schedule();
        });
      this.inflight.add(p);
    }
    this.notifyQueue();
    this.resolveIdleIfDone();
  }

  private resolveIdleIfDone(): void {
    if (this.queue.length === 0 && this.running.size === 0) for (const w of this.idleWaiters.splice(0)) w();
  }

  /** Hủy một bản đang render hoặc đang chờ trong hàng đợi (trạng thái DB do người gọi đặt). Chỉ ảnh hưởng đúng bản đó. */
  cancel(id: number): void {
    this.drop('cut', id);
  }

  /** Hủy việc công cụ đang chờ hoặc đang chạy (dừng cả cây tiến trình của tool qua AbortSignal). Chỉ ảnh hưởng đúng việc đó. */
  cancelTool(id: number): void {
    this.drop('tool', id);
  }

  private drop(kind: QueueKind, id: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((j) => !(j.kind === kind && j.id === id));
    this.running.get(keyOf(kind, id))?.abort.abort();
    if (this.queue.length !== before) {
      if (kind === 'cut') this.emittedPos.delete(id);
      else if (kind === 'clip') this.emittedClipPos.delete(id);
      this.notifyQueue();
      this.resolveIdleIfDone();
    }
  }

  /**
   * Tình trạng của một việc trong hàng đợi: `running` (đang chạy) hoặc `waiting` với `position` (1 = chạy tiếp theo).
   * `null` = không có trong hàng đợi (đã xong, chưa xếp hàng, hoặc dịch vụ đã tắt).
   */
  queueInfo(kind: QueueKind, id: number): QueueInfo | null {
    const base = { running_count: this.running.size, concurrency: this.concurrency };
    if (this.running.has(keyOf(kind, id))) return { state: 'running', position: null, ...base };
    const i = this.queue.findIndex((j) => j.kind === kind && j.id === id);
    return i < 0 ? null : { state: 'waiting', position: i + 1, ...base };
  }

  /**
   * (Tương thích ngược với trường `queue_ahead`) 0 = đang chạy; n = số thứ tự nếu mọi việc chạy tuần tự, tính cả các việc đang chạy
   * (= `running_count + queue_position`); null = không có trong hàng đợi. Giao diện mới dùng `queueInfo`.
   */
  position(kind: QueueKind, id: number): number | null {
    const q = this.queueInfo(kind, id);
    if (!q) return null;
    return q.state === 'running' ? 0 : q.position! + q.running_count;
  }

  /** Tóm tắt hàng đợi render để hiển thị: đang chạy, đang chờ, số việc được chạy cùng lúc. */
  summary(): { running_count: number; waiting_count: number; concurrency: number } {
    return { running_count: this.running.size, waiting_count: this.queue.length, concurrency: this.concurrency };
  }

  /** Số việc LAN đang chờ + đang chạy trong hàng đợi (chỉ để hiển thị cho chủ máy). */
  lanLoad(): number {
    return this.queue.filter((j) => j.lan).length + [...this.running.values()].filter((r) => r.lan).length;
  }

  /** Resolve khi hàng đợi rỗng và không còn việc nào đang chạy (dùng trong test). */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Tắt: hủy MỌI việc đang chạy và chờ chúng dừng (các bản đó giữ `rendering` trong DB và sẽ được đánh dấu failed ở lần khởi động sau). */
  async close(): Promise<void> {
    this.closed = true;
    this.queue = [];
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    for (const r of this.running.values()) r.abort.abort();
    await Promise.allSettled([...this.inflight]);
    for (const w of this.idleWaiters.splice(0)) w();
  }

  async openInShotcut(abs: string): Promise<void> {
    await (this.opts.opener ?? defaultOpener)(abs);
  }

  // ---- SSE: vị trí hàng đợi của bản dựng đổi (gộp, có throttle) ----

  private notifyQueue(): void {
    if (this.closed || this.notifyTimer) return;
    const wait = Math.max(0, (this.opts.queueNotifyMs ?? 300) - (Date.now() - this.lastNotify));
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.lastNotify = Date.now();
      this.flushQueueEvents();
    }, wait);
    this.notifyTimer.unref();
  }

  /** Phát `final_cut.updated` cho bản dựng nào có vị trí hàng đợi khác lần phát trước (đang chờ đổi số thứ tự, hoặc vừa chuyển sang chạy). */
  private flushQueueEvents(): void {
    if (this.closed) return;
    const changed: number[] = [];
    const seen = new Set<number>();
    const consider = (id: number, pos: number) => {
      seen.add(id);
      if (this.emittedPos.get(id) !== pos) {
        this.emittedPos.set(id, pos);
        changed.push(id);
      }
    };
    this.queue.forEach((j, i) => j.kind === 'cut' && consider(j.id, i + 1));
    for (const r of this.running.values()) {
      if (r.kind !== 'cut') continue;
      seen.add(r.id);
      const prev = this.emittedPos.get(r.id);
      this.emittedPos.set(r.id, 0);
      // việc bắt đầu ngay (chưa từng báo "đang chờ") không cần thêm sự kiện: updateCut của chính nó đã phát
      if (prev !== undefined && prev !== 0) changed.push(r.id);
    }
    for (const id of [...this.emittedPos.keys()]) if (!seen.has(id)) this.emittedPos.delete(id);
    for (const id of changed) {
      try {
        const row = this.ctx.db.prepare('SELECT project_id, status FROM final_cuts WHERE id = ?').get(id) as { project_id: number; status: string } | undefined;
        if (row?.status === 'rendering') emitFinalCut(this.ctx, id, row.project_id);
      } catch {
        /* DB đã đóng khi tắt server */
      }
    }
    this.flushClipQueueEvents();
  }

  /** Như `flushQueueEvents` nhưng cho bản dựng clip: phát `clip_cut.updated` khi vị trí hàng đợi đổi (chờ đổi số thứ tự, hoặc vừa chuyển sang chạy). */
  private flushClipQueueEvents(): void {
    const changed: number[] = [];
    const seen = new Set<number>();
    this.queue.forEach((j, i) => {
      if (j.kind !== 'clip') return;
      seen.add(j.id);
      if (this.emittedClipPos.get(j.id) !== i + 1) {
        this.emittedClipPos.set(j.id, i + 1);
        changed.push(j.id);
      }
    });
    for (const r of this.running.values()) {
      if (r.kind !== 'clip') continue;
      seen.add(r.id);
      const prev = this.emittedClipPos.get(r.id);
      this.emittedClipPos.set(r.id, 0);
      if (prev !== undefined && prev !== 0) changed.push(r.id);
    }
    for (const id of [...this.emittedClipPos.keys()]) if (!seen.has(id)) this.emittedClipPos.delete(id);
    for (const id of changed) {
      try {
        const row = this.ctx.db.prepare('SELECT project_id, status FROM clip_cuts WHERE id = ?').get(id) as { project_id: number; status: string } | undefined;
        if (row?.status === 'rendering') emitCut(this.ctx, id, row.project_id);
      } catch {
        /* DB đã đóng khi tắt server */
      }
    }
  }

  /** Thực thi một việc đã được lấy ra khỏi hàng đợi. Lỗi không lường trước đã được xử lý bên trong; ở đây không ném. */
  private async execute(job: QueueItem, item: RunningItem): Promise<void> {
    if (job.kind !== 'cut') await job.run?.(item.abort);
    else await this.runOne(job.id, job.mode, item);
  }

  /** Ghi `progress` (throttle) chỉ khi bản vẫn `rendering`. */
  private progressWriter(id: number, abort: AbortController): (pct: number) => void {
    const throttle = this.opts.progressThrottleMs ?? 1000;
    let lastWrite = 0;
    let lastPct = -1;
    return (pct: number) => {
      if (this.closed || abort.signal.aborted) return;
      const now = Date.now();
      const p = Math.max(0, Math.min(99, Math.round(pct * 10) / 10));
      if (p === lastPct || (now - lastWrite < throttle && p < 99)) return;
      lastWrite = now;
      lastPct = p;
      const cur = this.ctx.db.prepare('SELECT status FROM final_cuts WHERE id = ?').get(id) as { status: string } | undefined;
      if (cur?.status === 'rendering') updateCut(this.ctx, id, { progress: p });
    };
  }

  /** Cập nhật cột chỉ khi bản vẫn `rendering` (chưa bị hủy). */
  private updateIfRendering(id: number, patch: Parameters<typeof updateCut>[2]): boolean {
    const cur = this.ctx.db.prepare('SELECT status FROM final_cuts WHERE id = ?').get(id) as { status: string } | undefined;
    if (cur?.status !== 'rendering') return false;
    updateCut(this.ctx, id, patch);
    return true;
  }

  private async runOne(id: number, mode: 'full' | 'clean' | 'grade', item: RunningItem): Promise<void> {
    const ctx = this.ctx;
    const cut = ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(id) as ReturnType<typeof getFinalCutRow> | undefined;
    if (!cut || cut.status !== 'rendering') return;
    const project = getProject(ctx, cut.project_id);
    const root = ctx.config.rootDir;
    const rel = finalPaths(project.slug, cut.version);
    const relOf = (abs: string | null) => (abs ? path.relative(root, abs).split(path.sep).join('/') : null);

    const grade = parseStoredGrade(cut.grade);
    const grading = !isNeutralGrade(grade);
    /** Nơi bước xoá logo (hoặc render khi tắt xoá logo) ghi bản sạch: có chỉnh màu → `_base.mp4` (bản giao do bước chỉnh màu tạo), không thì bản giao. */
    const cleanTargetRel = grading ? rel.base_path : rel.video_path;

    if (mode === 'grade') {
      if (item.abort.signal.aborted) return; // bị hủy khi còn đang chờ chỗ
      await this.gradeOnly(cut, item);
      return;
    }

    if (mode === 'clean') {
      if (!cut.raw_video_path) {
        markFailed(ctx, id, 'Xoá logo Veo thất bại: không có bản gốc (raw) để xử lý', 'clean');
        return;
      }
      if (item.abort.signal.aborted) return; // bị hủy khi còn đang chờ chỗ
      const cleaned = await this.cleanStep(cut, path.join(root, cut.raw_video_path), path.join(root, cleanTargetRel), item.abort, { cleanOnly: true, gradeNext: grading });
      if (cleaned) await this.gradeStep(getFinalCutRow(ctx, id), path.join(root, cleanTargetRel), item.abort);
      return;
    }

    const selection = parseJson<SelectionItem[]>(cut.selection, []);
    const edl = parseJson<Edl | null>(cut.edl, null);
    if (!edl) {
      markFailed(ctx, id, 'Bản dựng chưa có EDL');
      return;
    }

    // đoạn cần dựng theo thứ tự cảnh
    const segments: RenderSegment[] = [];
    for (let i = 0; i < edl.scenes.length; i++) {
      const sc = edl.scenes[i]!;
      const sel = selection[i]!;
      const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(sc.asset_id) as { file_path: string; attempt: number } | undefined;
      const abs = asset ? path.join(root, asset.file_path) : null;
      if (!abs || !fs.existsSync(abs)) {
        markFailed(ctx, id, `Thiếu file video của cảnh ${sel.code} (asset #${sc.asset_id})`);
        return;
      }
      sc.segments.forEach((seg, k) => segments.push({ path: abs, in_s: seg.in_s, out_s: seg.out_s, caption: `${sel.code} v${asset!.attempt} #${k + 1}` }));
    }

    const { renderer, status } = await this.pick();
    if (this.closed || item.abort.signal.aborted) return;
    if (!renderer) {
      markFailed(ctx, id, `Không có trình dựng khả dụng: ${status.reason}`);
      return;
    }
    // Bật xoá logo: render ra bản raw (còn logo), bước clean tạo bản chính. Tắt: render thẳng ra tên chính.
    const wm = await this.watermarkStatus();
    if (this.closed || item.abort.signal.aborted) return;
    const cleaning = wm.active;

    const out = {
      videoAbs: path.join(root, cleaning ? rel.raw_video_path : cleanTargetRel),
      contactAbs: path.join(root, rel.contact_sheet_path),
      mltAbs: path.join(root, rel.project_file_path),
    };
    // Không bao giờ ghi đè: đường dẫn đã bị chiếm (hiếm) → báo lỗi rõ ràng thay vì đè bản cũ
    for (const taken of [rel.video_path, rel.raw_video_path, ...(grading ? [rel.base_path] : [])]) {
      if (fs.existsSync(path.join(root, taken))) {
        markFailed(ctx, id, `File ${taken} đã tồn tại; không ghi đè. Hãy dựng lại để lấy số version mới`);
        return;
      }
    }

    const abort = item.abort;
    updateCut(ctx, id, { renderer: renderer.name, stage: 'render', progress: 0, error: null, failed_stage: null });
    const onProgress = this.progressWriter(id, abort);

    try {
      const outcome = await renderer.render({
        cutId: id,
        version: cut.version,
        slug: project.slug,
        name: project.name,
        segments,
        out,
        config: ctx.config,
        signal: abort.signal,
        onProgress,
        onProjectFile: (abs) => {
          if (!this.closed) updateCut(ctx, id, { project_file_path: relOf(abs) });
        },
        onRenderRef: (ref) => {
          if (!this.closed) updateCut(ctx, id, { render_ref: ref });
        },
      });
      if (this.closed) return;
      const dur = Math.round((probeMedia(ctx.config, outcome.videoAbs)?.duration_s ?? segments.reduce((a, s) => a + (s.out_s - s.in_s), 0)) * 1000) / 1000;
      if (cleaning) {
        const still = this.updateIfRendering(id, {
          raw_video_path: relOf(outcome.videoAbs),
          contact_sheet_path: relOf(outcome.contactAbs),
          project_file_path: relOf(outcome.projectFileAbs) ?? cut.project_file_path,
          renderer: outcome.renderer,
          duration_s: dur,
          stage: 'clean',
          progress: 0,
        });
        if (!still) {
          fs.rmSync(outcome.videoAbs, { force: true }); // bị hủy ngay lúc render xong
          return;
        }
        const cleaned = await this.cleanStep(getFinalCutRow(ctx, id), outcome.videoAbs, path.join(root, cleanTargetRel), abort, { cleanOnly: false, gradeNext: grading });
        if (cleaned) await this.gradeStep(getFinalCutRow(ctx, id), path.join(root, cleanTargetRel), abort);
      } else if (grading) {
        // tắt xoá logo: bản render là bản sạch (`_base.mp4`); bước chỉnh màu tạo bản giao
        const still = this.updateIfRendering(id, {
          base_path: relOf(outcome.videoAbs),
          contact_sheet_path: relOf(outcome.contactAbs),
          project_file_path: relOf(outcome.projectFileAbs) ?? cut.project_file_path,
          renderer: outcome.renderer,
          duration_s: dur,
          stage: 'grade',
          progress: 0,
        });
        if (!still) {
          fs.rmSync(outcome.videoAbs, { force: true });
          return;
        }
        await this.gradeStep(getFinalCutRow(ctx, id), outcome.videoAbs, abort);
      } else {
        const wrote = markReady(ctx, id, {
          renderer: outcome.renderer,
          video_path: relOf(outcome.videoAbs)!,
          raw_video_path: null,
          contact_sheet_path: relOf(outcome.contactAbs),
          project_file_path: relOf(outcome.projectFileAbs),
          duration_s: dur,
          watermark_removed: false,
        });
        if (!wrote) fs.rmSync(outcome.videoAbs, { force: true });
      }
    } catch (err) {
      if (!this.closed && !(abort.signal.aborted || err instanceof RenderCancelled)) {
        markFailed(ctx, id, err instanceof Error ? err.message : String(err), 'render');
      }
      // Dọn video render dở (đường dẫn này là của riêng version này). Bản raw ĐÃ xong thì giữ lại nếu hủy/lỗi ở bước clean.
      const fresh = ctx.db.prepare('SELECT raw_video_path, stage FROM final_cuts WHERE id = ?').get(id) as { raw_video_path: string | null; stage: string | null } | undefined;
      if (!(cleaning && fresh?.raw_video_path)) fs.rmSync(out.videoAbs, { force: true });
    }
  }

  /**
   * Bước xoá logo Veo: chạy tool ra file tạm `.<tên>.tmp.mp4` cùng thư mục, kiểm tra bằng ffprobe, rồi đổi tên nguyên tử sang tên chính.
   * Thất bại → failed (failed_stage='clean', GIỮ bản raw). Bị hủy → không ghi gì (bản đã `cancelled`), bản raw được giữ.
   */
  private async cleanStep(
    cut: ReturnType<typeof getFinalCutRow>,
    rawAbs: string,
    mainAbs: string,
    abort: AbortController,
    o: { cleanOnly: boolean; /** true = `mainAbs` là bản sạch (`_base.mp4`) và bước chỉnh màu chạy tiếp ngay sau đó (không đánh dấu `ready`). */ gradeNext?: boolean },
  ): Promise<boolean> {
    const ctx = this.ctx;
    const root = ctx.config.rootDir;
    const relOf = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
    const tmpAbs = tmpCleanPath(root, relOf(mainAbs));
    const onProgress = this.progressWriter(cut.id, abort);
    fs.rmSync(tmpAbs, { force: true });
    try {
      if (fs.existsSync(mainAbs)) throw new WatermarkError(`File ${path.basename(mainAbs)} đã tồn tại; không ghi đè`);
      if (!fs.existsSync(rawAbs)) throw new WatermarkError(`không thấy bản gốc ${path.basename(rawAbs)}`);
      const meta = await runWatermarkCli({ config: ctx.config, inputAbs: rawAbs, tmpAbs, signal: abort.signal, onProgress, graceMs: this.opts.watermarkGraceMs });
      if (this.closed) {
        fs.rmSync(tmpAbs, { force: true });
        return false;
      }
      const dur = verifyCleaned(ctx.config, rawAbs, tmpAbs);
      const cur = ctx.db.prepare('SELECT status FROM final_cuts WHERE id = ?').get(cut.id) as { status: string } | undefined;
      if (cur?.status !== 'rendering') {
        fs.rmSync(tmpAbs, { force: true });
        return false;
      }
      fs.renameSync(tmpAbs, mainAbs); // nguyên tử: bản chính chỉ xuất hiện khi đã đầy đủ và hợp lệ
      if (o.gradeNext) {
        // Xoá logo xong, TRƯỚC khi chỉnh màu: lưu bản sạch + kết quả xoá logo rồi chuyển sang bước chỉnh màu
        const still = this.updateIfRendering(cut.id, {
          raw_video_path: relOf(rawAbs),
          base_path: relOf(mainAbs),
          watermark_removed: 1,
          watermark_meta: JSON.stringify(meta),
          duration_s: dur !== null ? Math.round(dur * 1000) / 1000 : cut.duration_s,
          stage: 'grade',
          progress: 0,
        });
        if (!still) fs.rmSync(mainAbs, { force: true });
        return still;
      }
      const wrote = markReady(ctx, cut.id, {
        renderer: null,
        video_path: relOf(mainAbs),
        raw_video_path: relOf(rawAbs),
        contact_sheet_path: null,
        project_file_path: null,
        duration_s: dur !== null ? Math.round(dur * 1000) / 1000 : cut.duration_s,
        watermark_removed: true,
        watermark_meta: meta,
        cleanOnly: o.cleanOnly,
      });
      if (!wrote) fs.rmSync(mainAbs, { force: true });
      return false;
    } catch (err) {
      fs.rmSync(tmpAbs, { force: true });
      if (this.closed || abort.signal.aborted || err instanceof RenderCancelled) return false;
      const msg = err instanceof Error ? err.message : String(err);
      markFailed(ctx, cut.id, `Xoá logo Veo thất bại: ${msg}`, 'clean');
      return false;
    }
  }

  /**
   * Chỉ chạy bước chỉnh màu (phiên bản chỉ đổi màu, hoặc «Thử chỉnh màu lại»): KHÔNG render, KHÔNG xoá logo. Bản sạch là `base_path` của chính bản này
   * nếu còn, không thì bản sạch của BẢN CHA (`base_path` của bản cha, hoặc `video_path` nếu bản cha chưa chỉnh màu) → luôn chỉnh từ bản gốc, không chỉnh chồng.
   * Grade khác trung tính: hard link/sao chép thành `<slug>_final_v<n>_base.mp4` (tên mới, không ghi đè). Trung tính: bản giao là link/sao chép của bản sạch.
   */
  private async gradeOnly(cut: ReturnType<typeof getFinalCutRow>, item: RunningItem): Promise<void> {
    const ctx = this.ctx;
    const root = ctx.config.rootDir;
    const project = getProject(ctx, cut.project_id);
    const rel = finalPaths(project.slug, cut.version);
    const grading = !isNeutralGrade(parseStoredGrade(cut.grade));
    try {
      let baseAbs: string | null = cut.base_path && fs.existsSync(path.join(root, cut.base_path)) ? path.join(root, cut.base_path) : null;
      if (!baseAbs) {
        const parent = cut.parent_id ? (ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(cut.parent_id) as ReturnType<typeof getFinalCutRow> | undefined) : undefined;
        const srcRel = parent ? cleanBaseOf(parent) : null;
        const srcAbs = srcRel ? path.join(root, srcRel) : null;
        if (!srcAbs || !fs.existsSync(srcAbs)) throw new GradeError('không thấy bản sạch (chưa chỉnh màu) của bản cha để chỉnh màu');
        if (grading) {
          const dst = path.join(root, rel.base_path);
          if (!fs.existsSync(dst)) linkOrCopy(srcAbs, dst);
          if (!this.updateIfRendering(cut.id, { base_path: rel.base_path })) return;
          baseAbs = dst;
        } else {
          baseAbs = srcAbs;
        }
      }
      await this.gradeStep(getFinalCutRow(ctx, cut.id), baseAbs, item.abort);
    } catch (err) {
      if (this.closed || item.abort.signal.aborted || err instanceof RenderCancelled) return;
      markFailed(ctx, cut.id, `Chỉnh màu thất bại: ${err instanceof Error ? err.message : String(err)}`, 'grade');
    }
  }

  /**
   * Bước chỉnh màu: ffmpeg `eq` → `colortemperature` → `vibrance` (+ theo cảnh với `enable='between(t,a,b)'` từ EDL) trên bản sạch `baseAbs`, ra file tạm
   * `.<tên>.tmp.mp4` cùng thư mục, kiểm tra bằng ffprobe rồi đổi tên nguyên tử thành bản giao. Thất bại → failed (failed_stage='grade', bản sạch được giữ).
   * Bị hủy → không ghi gì. Grade trung tính → không chạy ffmpeg: bản giao là hard link/bản sao của bản sạch.
   */
  private async gradeStep(cut: ReturnType<typeof getFinalCutRow>, baseAbs: string, abort: AbortController): Promise<void> {
    const ctx = this.ctx;
    const root = ctx.config.rootDir;
    const project = getProject(ctx, cut.project_id);
    const rel = finalPaths(project.slug, cut.version);
    const relOf = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
    const outAbs = path.join(root, rel.video_path);
    const tmpAbs = tmpCleanPath(root, rel.video_path);
    const grade: Grade | null = parseStoredGrade(cut.grade);
    const edl = parseJson<Edl | null>(cut.edl, null);
    const onProgress = this.progressWriter(cut.id, abort);
    try {
      if (fs.existsSync(outAbs)) throw new GradeError(`File ${path.basename(outAbs)} đã tồn tại; không ghi đè`);
      if (!fs.existsSync(baseAbs)) throw new GradeError(`không thấy bản sạch ${path.basename(baseAbs)}`);
      // màu theo ảnh mẫu / LUT: lấy mẫu BẢN SẠCH rồi sinh (hoặc dùng lại) file .cube theo hash; lut3d chạy TRƯỚC eq/colortemperature/vibrance
      const ranges = edl ? outRanges(edl) : [];
      const luts = grade?.match ? await resolveMatchLuts(ctx, project, grade, { baseAbs, ranges, signal: abort.signal }) : null;
      if (abort.signal.aborted) return;
      const filter = grade ? buildGradeFilter(grade, ranges, luts) : null;
      if (filter) {
        await encodeGraded({ config: ctx.config, inAbs: baseAbs, tmpAbs, filter, signal: abort.signal, onProgress });
        if (this.closed) {
          fs.rmSync(tmpAbs, { force: true });
          return;
        }
        verifyGraded(ctx.config, baseAbs, tmpAbs);
        if (!this.stillRendering(cut.id)) {
          fs.rmSync(tmpAbs, { force: true });
          return;
        }
        fs.renameSync(tmpAbs, outAbs); // nguyên tử: bản giao chỉ xuất hiện khi đã đầy đủ và hợp lệ
      } else {
        if (!this.stillRendering(cut.id)) return;
        linkOrCopy(baseAbs, outAbs);
      }
      // Lưới khung hình của bản đã chỉnh màu (lỗi thì bỏ qua): tên mới, không ghi đè lưới của bước render
      const hadContact = !!cut.contact_sheet_path && fs.existsSync(path.join(root, cut.contact_sheet_path));
      const contactRel = hadContact ? rel.contact_graded_path : rel.contact_sheet_path;
      const total = probeMedia(ctx.config, outAbs)?.duration_s ?? cut.duration_s ?? 0;
      const contactAbs = filter || !hadContact ? await makeContactSheet(ctx.config, outAbs, path.join(root, contactRel), total, abort.signal) : null;
      const dur = probeMedia(ctx.config, outAbs)?.duration_s ?? cut.duration_s;
      const wrote = markReady(ctx, cut.id, {
        renderer: null,
        video_path: relOf(outAbs),
        base_path: !isNeutralGrade(grade) ? relOf(baseAbs) : null,
        contact_sheet_path: contactAbs ? relOf(contactAbs) : null,
        project_file_path: null,
        duration_s: dur !== null && dur !== undefined ? Math.round(dur * 1000) / 1000 : null,
        watermark_removed: !!cut.watermark_removed,
      });
      if (!wrote) fs.rmSync(outAbs, { force: true });
    } catch (err) {
      fs.rmSync(tmpAbs, { force: true });
      if (this.closed || abort.signal.aborted || err instanceof RenderCancelled) return;
      markFailed(ctx, cut.id, `Chỉnh màu thất bại: ${err instanceof Error ? err.message : String(err)}`, 'grade');
    }
  }

  private stillRendering(id: number): boolean {
    const cur = this.ctx.db.prepare('SELECT status FROM final_cuts WHERE id = ?').get(id) as { status: string } | undefined;
    return cur?.status === 'rendering';
  }
}

function runCheck(python: string, script: string): Promise<{ ready: boolean; detail: string | null }> {
  return new Promise((resolve) => {
    execFile(python, [script, '--check'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env } }, (err, stdout) => {
      if (err && !stdout) return resolve({ ready: false, detail: `Không chạy được "--check" của Shotcut MCP: ${err.message.slice(0, 160)}` });
      try {
        const j = JSON.parse(stdout) as { runtime_ready?: boolean; runtime?: { shotcut?: { found?: boolean }; melt?: { found?: boolean } } };
        if (j.runtime_ready === true) return resolve({ ready: true, detail: null });
        const missing = ['shotcut', 'melt'].filter((k) => !(j.runtime as Record<string, { found?: boolean }> | undefined)?.[k]?.found);
        resolve({ ready: false, detail: missing.length ? `Shotcut MCP báo thiếu: ${missing.join(', ')}` : 'Shotcut MCP báo runtime chưa sẵn sàng' });
      } catch {
        resolve({ ready: false, detail: '"--check" của Shotcut MCP không trả JSON hợp lệ' });
      }
    });
  });
}
