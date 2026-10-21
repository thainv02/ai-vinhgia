import type { Config } from '../../config.js';

/** Một đoạn video giữ lại (theo thứ tự trên timeline); đường dẫn tuyệt đối. */
export interface RenderSegment {
  path: string;
  in_s: number;
  out_s: number;
  /** Caption trong Shotcut, vd "C1 v2 #1". */
  caption: string;
}

export interface RenderRequest {
  cutId: number;
  version: number;
  slug: string;
  name: string;
  segments: RenderSegment[];
  out: { videoAbs: string; contactAbs: string; mltAbs: string };
  config: Config;
  signal: AbortSignal;
  /** 0–100 */
  onProgress(pct: number): void;
  /** Gọi khi đã tạo file dự án .mlt (Shotcut). */
  onProjectFile(abs: string): void;
  /** Gọi khi có mã job render của Shotcut MCP. */
  onRenderRef(ref: string): void;
}

export interface RenderOutcome {
  renderer: 'shotcut' | 'ffmpeg';
  videoAbs: string;
  contactAbs: string | null;
  projectFileAbs: string | null;
}

export interface Renderer {
  readonly name: 'shotcut' | 'ffmpeg';
  render(req: RenderRequest): Promise<RenderOutcome>;
}

/** Ném khi render bị hủy (signal.abort). */
export class RenderCancelled extends Error {
  constructor(message = 'Render đã bị hủy') {
    super(message);
    this.name = 'RenderCancelled';
  }
}
