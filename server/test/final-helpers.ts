import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBinary } from '../src/services/media.js';
import type { RenderOutcome, RenderRequest, Renderer } from '../src/services/final-render/index.js';
import { PNG_BYTES } from './helpers.js';

export const FFMPEG = resolveBinary('ffmpeg', null);
export const FFPROBE = resolveBinary('ffprobe', null);

/** Tạo video thử thật bằng ffmpeg (testsrc2 + sine, 160x284, 24fps). */
export function makeTestVideo(abs: string, seconds = 3, opts: { audio?: boolean; size?: string; fps?: number } = {}): void {
  if (!FFMPEG) throw new Error('Không có ffmpeg');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const size = opts.size ?? '160x284';
  const fps = opts.fps ?? 24;
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`];
  if (opts.audio !== false) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac', '-shortest');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', abs);
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg tạo video thử lỗi: ' + r.stderr);
}

export function ffprobeJson(abs: string): any {
  const r = spawnSync(FFPROBE!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

/** Renderer giả: ghi file giả, báo tiến độ, có thể giữ lại (gate) / lỗi / ghi .mlt như Shotcut. */
export class FakeRenderer implements Renderer {
  calls: RenderRequest[] = [];
  aborted: number[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  failWith: string | null = null;
  progress: number[] = [25, 50, 90];
  /** Khi đặt, render chờ cho tới khi gọi release() (hoặc bị hủy). */
  private gate: { promise: Promise<void>; release: () => void } | null = null;

  /** Đặt để ghi video THẬT (ffmpeg testsrc) thay vì chữ giả — cần cho bước xoá logo (ffprobe kiểm tra). */
  realVideo: { seconds: number; audio?: boolean } | null = null;

  constructor(public name: 'shotcut' | 'ffmpeg' = 'ffmpeg') {}

  hold(): void {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.gate = { promise, release };
  }
  release(): void {
    this.gate?.release();
    this.gate = null;
  }

  async render(req: RenderRequest): Promise<RenderOutcome> {
    this.calls.push(req);
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      if (this.name === 'shotcut') {
        fs.mkdirSync(path.dirname(req.out.mltAbs), { recursive: true });
        fs.writeFileSync(req.out.mltAbs, '<mlt/>');
        req.onProjectFile(req.out.mltAbs);
        req.onRenderRef(`fake-render-${req.cutId}`);
      }
      if (this.gate) {
        const gate = this.gate;
        await new Promise<void>((resolve) => {
          gate.promise.then(resolve);
          req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (req.signal.aborted) {
          this.aborted.push(req.cutId);
          throw new Error('aborted');
        }
      }
      for (const p of this.progress) req.onProgress(p);
      if (this.failWith) throw new Error(this.failWith);
      fs.mkdirSync(path.dirname(req.out.videoAbs), { recursive: true });
      if (this.realVideo) makeTestVideo(req.out.videoAbs, this.realVideo.seconds, { audio: this.realVideo.audio });
      else fs.writeFileSync(req.out.videoAbs, `fake-final-v${req.version}`);
      fs.writeFileSync(req.out.contactAbs, PNG_BYTES);
      return {
        renderer: this.name,
        videoAbs: req.out.videoAbs,
        contactAbs: req.out.contactAbs,
        projectFileAbs: this.name === 'shotcut' ? req.out.mltAbs : null,
      };
    } finally {
      this.concurrent--;
    }
  }
}
