import fs from 'node:fs';
import path from 'node:path';
import { probeMedia } from '../media.js';
import { McpClient } from './mcp-client.js';
import { RenderCancelled, type RenderOutcome, type RenderRequest, type Renderer } from './types.js';

export interface ShotcutRendererOptions {
  python: string;
  script: string;
  /** Chu kỳ hỏi render_status (mặc định 2 giây). */
  pollMs?: number;
  /** Quá thời gian này thì hủy render (mặc định 20 phút). */
  timeoutMs?: number;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Dựng bằng Shotcut qua MCP stdio: create_project (mỗi đoạn là một clip, cắt thẳng) → render_contact_sheet → start_render h264-high
 * → poll render_status. Mỗi lần render mở một tiến trình MCP riêng và đóng khi xong.
 */
export class ShotcutRenderer implements Renderer {
  readonly name = 'shotcut' as const;
  constructor(private readonly opts: ShotcutRendererOptions) {}

  async render(req: RenderRequest): Promise<RenderOutcome> {
    const { python, script, pollMs = 2000, timeoutMs = 20 * 60_000 } = this.opts;
    for (const dir of [path.dirname(req.out.videoAbs), path.dirname(req.out.mltAbs)]) fs.mkdirSync(dir, { recursive: true });
    const client = McpClient.start({
      command: python,
      args: [script],
      env: { SHOTCUT_MCP_ALLOWED_ROOTS: req.config.rootDir, SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS: '1' },
    });
    let renderRef: string | null = null;
    let cancelling: Promise<unknown> | null = null;
    const cancelRender = (): Promise<unknown> =>
      (cancelling ??= client.callTool('cancel_render', { job_id: renderRef }, 15_000).catch(() => undefined));
    let fallback: NodeJS.Timeout | null = null;
    const onAbort = () => {
      if (renderRef) void cancelRender(); // client được đóng ở `finally`, SAU khi cancel_render đã được xử lý
      else fallback = setTimeout(() => client.close(), 10_000); // đang chờ MCP trả lời; chốt chặn nếu nó treo
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    const checkAbort = () => {
      if (req.signal.aborted) throw new RenderCancelled();
    };
    try {
      await client.initialize();
      checkAbort();

      // Profile (kích thước, fps) lấy từ video đầu tiên
      const first = probeMedia(req.config, req.segments[0]!.path);
      const fpsNum = first?.fps_num ?? 24;
      const fpsDen = first?.fps_den ?? 1;
      await client.callTool('create_project', {
        project_path: req.out.mltAbs,
        width: first?.width ?? 720,
        height: first?.height ?? 1280,
        fps_num: fpsNum,
        fps_den: fpsDen,
        notes: `Autovideo: ${req.name} — bản hoàn chỉnh v${req.version} (cắt thẳng)`,
        clips: req.segments.map((s) => ({ path: s.path, in_seconds: s.in_s, out_seconds: s.out_s, caption: s.caption })),
      });
      req.onProjectFile(req.out.mltAbs);
      checkAbort();

      let contactAbs: string | null = null;
      try {
        await client.callTool('render_contact_sheet', { project_path: req.out.mltAbs, output_path: req.out.contactAbs, sample_count: 12, columns: 4, cell_width: 320 });
        if (fs.existsSync(req.out.contactAbs)) contactAbs = req.out.contactAbs;
      } catch {
        // contact sheet hỏng không làm hỏng bản dựng
        if (req.signal.aborted) throw new RenderCancelled();
      }
      checkAbort();

      const started = (await client.callTool('start_render', { project_path: req.out.mltAbs, output_path: req.out.videoAbs, preset: 'h264-high' })) as { job_id?: string };
      if (!started?.job_id) throw new Error('Shotcut MCP start_render không trả job_id');
      renderRef = String(started.job_id);
      req.onRenderRef(renderRef);
      if (req.signal.aborted) {
        await cancelRender(); // bị hủy ngay lúc start_render đang chạy: dừng job vừa tạo
        throw new RenderCancelled();
      }

      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        checkAbort();
        const st = (await client.callTool('render_status', { job_id: renderRef })) as {
          status?: string;
          progress_percent?: number | null;
          return_code?: number | null;
          error?: string;
          log_tail?: string | string[];
        };
        if (typeof st.progress_percent === 'number') req.onProgress(Math.max(0, Math.min(99, st.progress_percent)));
        if (st.status && TERMINAL.has(st.status)) {
          if (st.status === 'completed') break;
          if (st.status === 'cancelled' || req.signal.aborted) throw new RenderCancelled();
          const tail = Array.isArray(st.log_tail) ? st.log_tail.slice(-3).join(' | ') : String(st.log_tail ?? '').trim().split('\n').slice(-3).join(' | ');
          throw new Error(`Shotcut render lỗi (mã ${st.return_code ?? '?'})${st.error ? `: ${st.error}` : ''}${tail ? ` — ${tail}` : ''}`);
        }
        if (Date.now() - t0 > timeoutMs) {
          await client.callTool('cancel_render', { job_id: renderRef }, 15_000).catch(() => undefined);
          throw new Error(`Shotcut render quá thời gian (${Math.round(timeoutMs / 60_000)} phút)`);
        }
      }
      if (!fs.existsSync(req.out.videoAbs)) throw new Error('Shotcut báo render xong nhưng không thấy file video');
      return { renderer: 'shotcut', videoAbs: req.out.videoAbs, contactAbs, projectFileAbs: req.out.mltAbs };
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (fallback) clearTimeout(fallback);
      if (cancelling) await Promise.race([cancelling, new Promise((r) => setTimeout(r, 5000))]); // chờ cancel_render xong rồi mới đóng MCP
      client.close();
    }
  }
}
