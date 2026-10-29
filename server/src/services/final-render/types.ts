import type { Config } from '../../config.js';

/** Một đoạn video giữ lại (theo thứ tự trên timeline); đường dẫn tuyệt đối. */
export interface RenderSegment {
  path: string;
  in_s: number;
  out_s: number;
  /** Nhãn đoạn (chỉ để log/debug), vd "C1 v2 #1". Không vẽ lên video. */
  caption?: string;
}

export interface RenderRequest {
  cutId: number;
  version: number;
  slug: string;
  name: string;
  segments: RenderSegment[];
  out: { videoAbs: string; contactAbs: string };
  config: Config;
  signal: AbortSignal;
  /** 0–100 */
  onProgress(pct: number): void;
}

export interface RenderOutcome {
  renderer: 'ffmpeg';
  videoAbs: string;
  contactAbs: string | null;
}

export interface Renderer {
  readonly name: 'ffmpeg';
  render(req: RenderRequest): Promise<RenderOutcome>;
}

/** Ném khi render bị hủy (signal.abort). */
export class RenderCancelled extends Error {
  constructor(message = 'Render đã bị hủy') {
    super(message);
    this.name = 'RenderCancelled';
  }
}
