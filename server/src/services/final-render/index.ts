import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { AppContext } from '../../context.js';
import {
  type Edl,
  type SelectionItem,
  finalPaths,
  getFinalCutRow,
  markFailed,
  markReady,
  tmpCleanPath,
  updateCut,
} from '../final-cuts.js';
import { ffmpegOf, probeMedia } from '../media.js';
import { getProject, parseJson } from '../repo.js';
import { FfmpegRenderer } from './ffmpeg-renderer.js';
import { ShotcutRenderer } from './shotcut-renderer.js';
import { RenderCancelled, type RenderSegment, type Renderer } from './types.js';
import { computeWatermarkStatus, runWatermarkCli, verifyCleaned, WatermarkError, type WatermarkStatus } from './watermark.js';

export type { Renderer, RenderRequest, RenderOutcome, RenderSegment } from './types.js';
export { RenderCancelled } from './types.js';
export { FfmpegRenderer, buildFfmpegArgs } from './ffmpeg-renderer.js';
export { ShotcutRenderer } from './shotcut-renderer.js';
export { McpClient, McpToolError } from './mcp-client.js';
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
export class FinalRenderService {
  private queue: { id: number; mode: 'full' | 'clean' }[] = [];
  private current: { id: number; abort: AbortController } | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;
  private statusCache: { at: number; value: RendererStatus } | null = null;
  private wmCache: { at: number; value: WatermarkStatus } | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: FinalRenderOptions = {},
  ) {}

  // ---------------------------------------------------------------- chọn renderer

  /** Trạng thái trình dựng cho `GET /api/meta` (có cache). */
  async status(force = false): Promise<RendererStatus> {
    const ttl = this.opts.checkTtlMs ?? 60_000;
    if (!force && this.statusCache && Date.now() - this.statusCache.at < ttl) return this.statusCache.value;
    const value = await this.computeStatus();
    this.statusCache = { at: Date.now(), value };
    return value;
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
    const value = await computeWatermarkStatus(this.ctx.config);
    this.wmCache = { at: Date.now(), value };
    return value;
  }

  private async pick(): Promise<{ renderer: Renderer | null; status: RendererStatus }> {
    const status = await this.status();
    if (this.opts.renderer) return { renderer: this.opts.renderer, status };
    if (status.active === 'shotcut') {
      return {
        renderer: new ShotcutRenderer({ python: this.ctx.config.shotcutMcpPython!, script: this.ctx.config.shotcutMcpServerScript!, ...this.opts.shotcut }),
        status,
      };
    }
    if (status.active === 'ffmpeg') return { renderer: new FfmpegRenderer(), status };
    return { renderer: null, status };
  }

  // ---------------------------------------------------------------- hàng đợi

  /** `full`: render rồi (nếu bật) xoá logo; `clean`: chỉ chạy lại bước xoá logo trên bản raw có sẵn. */
  enqueue(id: number, mode: 'full' | 'clean' = 'full'): void {
    if (this.closed || this.queue.some((j) => j.id === id) || this.current?.id === id) return;
    this.queue.push({ id, mode });
    this.pumping ??= this.pump().finally(() => {
      this.pumping = null;
      if (this.queue.length === 0 && !this.current) for (const w of this.idleWaiters.splice(0)) w();
    });
  }

  /** Hủy một bản đang render hoặc đang chờ trong hàng đợi (trạng thái DB do người gọi đặt). */
  cancel(id: number): void {
    const i = this.queue.findIndex((j) => j.id === id);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.current?.id === id) this.current.abort.abort();
  }

  /** Resolve khi hàng đợi rỗng và không còn render nào đang chạy (dùng trong test). */
  idle(): Promise<void> {
    if (this.queue.length === 0 && !this.current && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Tắt: hủy render đang chạy và chờ nó dừng (bản đó giữ `rendering` trong DB và sẽ được đánh dấu failed ở lần khởi động sau). */
  async close(): Promise<void> {
    this.closed = true;
    this.queue = [];
    this.current?.abort.abort();
    await this.pumping?.catch(() => undefined);
    for (const w of this.idleWaiters.splice(0)) w();
  }

  async openInShotcut(abs: string): Promise<void> {
    await (this.opts.opener ?? defaultOpener)(abs);
  }

  private async pump(): Promise<void> {
    while (!this.closed && this.queue.length) {
      const job = this.queue.shift()!;
      try {
        await this.runOne(job.id, job.mode);
      } catch (err) {
        console.error('[final-render] lỗi không lường trước:', err);
      }
    }
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

  private async runOne(id: number, mode: 'full' | 'clean'): Promise<void> {
    const ctx = this.ctx;
    const cut = ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(id) as ReturnType<typeof getFinalCutRow> | undefined;
    if (!cut || cut.status !== 'rendering') return;
    const project = getProject(ctx, cut.project_id);
    const root = ctx.config.rootDir;
    const rel = finalPaths(project.slug, cut.version);
    const relOf = (abs: string | null) => (abs ? path.relative(root, abs).split(path.sep).join('/') : null);

    if (mode === 'clean') {
      if (!cut.raw_video_path) {
        markFailed(ctx, id, 'Xoá logo Veo thất bại: không có bản gốc (raw) để xử lý', 'clean');
        return;
      }
      const abort = new AbortController();
      this.current = { id, abort };
      try {
        await this.cleanStep(cut, path.join(root, cut.raw_video_path), path.join(root, rel.video_path), abort, { cleanOnly: true });
      } finally {
        this.current = null;
      }
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
    if (this.closed) return;
    if (!renderer) {
      markFailed(ctx, id, `Không có trình dựng khả dụng: ${status.reason}`);
      return;
    }
    // Bật xoá logo: render ra bản raw (còn logo), bước clean tạo bản chính. Tắt: render thẳng ra tên chính.
    const wm = await this.watermarkStatus();
    if (this.closed) return;
    const cleaning = wm.active;

    const out = {
      videoAbs: path.join(root, cleaning ? rel.raw_video_path : rel.video_path),
      contactAbs: path.join(root, rel.contact_sheet_path),
      mltAbs: path.join(root, rel.project_file_path),
    };
    // Không bao giờ ghi đè: đường dẫn đã bị chiếm (hiếm) → báo lỗi rõ ràng thay vì đè bản cũ
    for (const taken of [rel.video_path, rel.raw_video_path]) {
      if (fs.existsSync(path.join(root, taken))) {
        markFailed(ctx, id, `File ${taken} đã tồn tại; không ghi đè. Hãy dựng lại để lấy số version mới`);
        return;
      }
    }

    const abort = new AbortController();
    this.current = { id, abort };
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
        await this.cleanStep(getFinalCutRow(ctx, id), outcome.videoAbs, path.join(root, rel.video_path), abort, { cleanOnly: false });
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
    } finally {
      this.current = null;
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
    o: { cleanOnly: boolean },
  ): Promise<void> {
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
        return;
      }
      const dur = verifyCleaned(ctx.config, rawAbs, tmpAbs);
      const cur = ctx.db.prepare('SELECT status FROM final_cuts WHERE id = ?').get(cut.id) as { status: string } | undefined;
      if (cur?.status !== 'rendering') {
        fs.rmSync(tmpAbs, { force: true });
        return;
      }
      fs.renameSync(tmpAbs, mainAbs); // nguyên tử: bản chính chỉ xuất hiện khi đã đầy đủ và hợp lệ
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
    } catch (err) {
      fs.rmSync(tmpAbs, { force: true });
      if (this.closed || abort.signal.aborted || err instanceof RenderCancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      markFailed(ctx, cut.id, `Xoá logo Veo thất bại: ${msg}`, 'clean');
    }
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
