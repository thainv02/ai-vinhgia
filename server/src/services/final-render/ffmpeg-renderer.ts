import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ffmpegOf, probeMedia } from '../media.js';
import { RenderCancelled, type RenderOutcome, type RenderRequest, type RenderSegment, type Renderer } from './types.js';

export interface FfmpegProfile {
  width: number;
  height: number;
  /** Biểu thức fps cho bộ lọc fps=..., vd "24" hoặc "30000/1001". */
  fps: string;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
const f3 = (x: number): string => (Math.round(x * 1000) / 1000).toFixed(3);
/** Thời gian mờ âm thanh ở mỗi chỗ nối, tránh bụp tiếng khi cắt thẳng. */
export const JOIN_FADE_S = 0.02;

/**
 * Dựng tham số ffmpeg: trim + concat (cắt thẳng, giữ âm thanh), thêm afade 20ms ở mỗi chỗ nối.
 * `hasAudio[i]` = nguồn của đoạn i có âm thanh (không có thì chèn im lặng đúng độ dài).
 */
export function buildFfmpegArgs(segments: RenderSegment[], hasAudio: boolean[], profile: FfmpegProfile, outAbs: string): string[] {
  const args: string[] = ['-n', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  for (const s of segments) args.push('-i', s.path);
  const n = segments.length;
  const parts: string[] = [];
  segments.forEach((s, k) => {
    const len = s.out_s - s.in_s;
    parts.push(
      `[${k}:v]trim=start=${f3(s.in_s)}:end=${f3(s.out_s)},setpts=PTS-STARTPTS,` +
        `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,` +
        `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${profile.fps},format=yuv420p[v${k}]`,
    );
    const fades: string[] = [];
    if (k > 0) fades.push(`afade=t=in:st=0:d=${JOIN_FADE_S}`);
    if (k < n - 1) fades.push(`afade=t=out:st=${f3(Math.max(0, len - JOIN_FADE_S))}:d=${JOIN_FADE_S}`);
    const tail = fades.length ? ',' + fades.join(',') : '';
    if (hasAudio[k]) {
      parts.push(
        `[${k}:a]atrim=start=${f3(s.in_s)}:end=${f3(s.out_s)},asetpts=PTS-STARTPTS,aresample=48000,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo${tail}[a${k}]`,
      );
    } else {
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${f3(len)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp${tail}[a${k}]`);
    }
  });
  parts.push(`${segments.map((_, k) => `[v${k}][a${k}]`).join('')}concat=n=${n}:v=1:a=1[v][a]`);
  args.push(
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outAbs,
  );
  return args;
}

function run(bin: string, args: string[], signal: AbortSignal, onStdoutLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RenderCancelled());
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      if (!onStdoutLine) return;
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onStdoutLine(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new RenderCancelled());
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg thoát với mã ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

/** Trình dựng dự phòng bằng ffmpeg: không có file .mlt. */
export class FfmpegRenderer implements Renderer {
  readonly name = 'ffmpeg' as const;

  async render(req: RenderRequest): Promise<RenderOutcome> {
    const bin = ffmpegOf(req.config);
    if (!bin) throw new Error('Không tìm thấy ffmpeg (đặt FFMPEG_PATH hoặc cài ffmpeg)');
    if (req.segments.length === 0) throw new Error('EDL không có đoạn nào để dựng');
    // Không bao giờ ghi đè (ffmpeg 8 với -n vẫn thoát mã 0 khi file đã có): kiểm tra trước, TRƯỚC khối try/dọn dẹp bên dưới
    if (fs.existsSync(req.out.videoAbs)) throw new Error(`File ${path.basename(req.out.videoAbs)} đã tồn tại; không ghi đè`);
    fs.mkdirSync(path.dirname(req.out.videoAbs), { recursive: true });

    const infos = req.segments.map((s) => probeMedia(req.config, s.path));
    const first = infos[0];
    const profile: FfmpegProfile = {
      width: even(first?.width ?? 720),
      height: even(first?.height ?? 1280),
      fps: first?.fps_num ? (first.fps_den && first.fps_den !== 1 ? `${first.fps_num}/${first.fps_den}` : String(first.fps_num)) : '24',
    };
    const total = req.segments.reduce((a, s) => a + (s.out_s - s.in_s), 0);
    const args = buildFfmpegArgs(
      req.segments,
      infos.map((i) => i?.has_audio ?? true),
      profile,
      req.out.videoAbs,
    );
    let best = 0;
    try {
      await run(bin, args, req.signal, (line) => {
        const m = /^out_time(?:_us|_ms)?=(\d+)/.exec(line);
        if (!m) return;
        best = Math.max(best, Math.min(99, Math.round((Number(m[1]) / 1e6 / total) * 100))); // chỉ tăng
        req.onProgress(best);
      });
    } catch (err) {
      fs.rmSync(req.out.videoAbs, { force: true });
      throw err;
    }

    // Contact sheet: 12 khung đều nhau của bản đã dựng, 4 cột (không có/không ghi đè thì bỏ qua, không làm hỏng bản dựng)
    let contactAbs: string | null = null;
    if (!fs.existsSync(req.out.contactAbs)) {
      try {
        const dur = probeMedia(req.config, req.out.videoAbs)?.duration_s ?? total;
        const vf = `fps=12/${f3(Math.max(dur, 1))},scale=240:-2,tile=4x3:padding=2:margin=2`;
        await run(bin, ['-n', '-hide_banner', '-loglevel', 'error', '-i', req.out.videoAbs, '-vf', vf, '-frames:v', '1', req.out.contactAbs], req.signal);
        contactAbs = req.out.contactAbs;
      } catch (err) {
        fs.rmSync(req.out.contactAbs, { force: true });
        if (err instanceof RenderCancelled) {
          fs.rmSync(req.out.videoAbs, { force: true });
          throw err;
        }
      }
    }
    return { renderer: 'ffmpeg', videoAbs: req.out.videoAbs, contactAbs, projectFileAbs: null };
  }
}
