import fs from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import type { Config } from '../config.js';

export const SHOTCUT_BIN_DIR = '/Applications/Shotcut.app/Contents/MacOS';

const binCache = new Map<string, string | null>();

/**
 * Tìm ffmpeg/ffprobe: đường dẫn cấu hình → PATH → /Applications/Shotcut.app/Contents/MacOS/ → Homebrew.
 * Kết quả được nhớ lại (kể cả "không có").
 */
export function resolveBinary(name: 'ffmpeg' | 'ffprobe', configured: string | null | undefined): string | null {
  const key = `${name}|${configured ?? ''}`;
  if (binCache.has(key)) return binCache.get(key) ?? null;
  const candidates = [configured, name, `${SHOTCUT_BIN_DIR}/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].filter(
    (c): c is string => !!c,
  );
  let found: string | null = null;
  for (const c of candidates) {
    if (c.includes('/') && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 8000 });
    if (r.status === 0) {
      found = c;
      break;
    }
  }
  binCache.set(key, found);
  return found;
}

export const ffmpegOf = (config: Pick<Config, 'ffmpegPath'>): string | null => resolveBinary('ffmpeg', config.ffmpegPath);
export const ffprobeOf = (config: Pick<Config, 'ffprobePath'>): string | null => resolveBinary('ffprobe', config.ffprobePath);

export interface MediaInfo {
  duration_s: number | null;
  width: number | null;
  height: number | null;
  /** fps dạng số thực và phân số (vd 24/1, 30000/1001). */
  fps: number | null;
  fps_num: number | null;
  fps_den: number | null;
  has_audio: boolean;
}

const probeCache = new Map<string, MediaInfo | null>();

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

interface ProbeJson {
  format?: { duration?: string; format_name?: string };
  streams?: Record<string, unknown>[];
}

/** Rút MediaInfo từ JSON của ffprobe (`-show_format -show_streams`); null nếu không có luồng video. */
function infoFromProbeJson(j: ProbeJson): MediaInfo | null {
  const v = j.streams?.find((s) => s.codec_type === 'video');
  if (!v) return null;
  const [n, d] = String(v.r_frame_rate ?? '').split('/').map(Number);
  const fpsNum = n && Number.isFinite(n) ? n : null;
  const fpsDen = d && Number.isFinite(d) ? d : 1;
  return {
    duration_s: num(j.format?.duration) ?? num(v.duration),
    width: num(v.width),
    height: num(v.height),
    fps: fpsNum ? fpsNum / fpsDen : null,
    fps_num: fpsNum,
    fps_den: fpsNum ? fpsDen : null,
    has_audio: !!j.streams?.some((s) => s.codec_type === 'audio'),
  };
}

/** Đọc thông tin media bằng ffprobe (có cache theo đường dẫn + size + mtime). null nếu không đọc được. */
export function probeMedia(config: Pick<Config, 'ffprobePath'>, abs: string): MediaInfo | null {
  let key: string;
  try {
    const st = fs.statSync(abs);
    key = `${abs}|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }
  if (probeCache.has(key)) return probeCache.get(key) ?? null;
  const bin = ffprobeOf(config);
  let info: MediaInfo | null = null;
  if (bin) {
    const r = spawnSync(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status === 0) {
      try {
        info = infoFromProbeJson(JSON.parse(r.stdout) as ProbeJson);
      } catch {
        info = null;
      }
    }
  }
  if (probeCache.size > 500) probeCache.clear();
  probeCache.set(key, info);
  return info;
}

/** Kết quả kiểm tra video người dùng tải lên: thông tin chính + vài trường ffprobe để lưu vào `assets.meta`. */
export interface UploadedVideoProbe {
  info: MediaInfo;
  format_name: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  /** Số luồng video (ảnh bìa nhúng cũng tính là luồng video, nên chỉ để ghi nhận). */
  video_streams: number;
}

/**
 * ffprobe KHÔNG chặn event loop (execFile, hết 20 giây thì dừng) cho video người dùng LAN tải lên: file lạ không được làm treo
 * cả server đang phục vụ app chính. null nếu ffprobe không chạy được, file hỏng hoặc không có luồng video.
 */
export function probeUploadedVideo(config: Pick<Config, 'ffprobePath'>, abs: string): Promise<UploadedVideoProbe | null> {
  const bin = ffprobeOf(config);
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout) as ProbeJson;
        const info = infoFromProbeJson(j);
        if (!info) return resolve(null);
        const codec = (type: string) => {
          const s = j.streams?.find((x) => x.codec_type === type);
          return typeof s?.codec_name === 'string' ? s.codec_name : null;
        };
        resolve({
          info,
          format_name: typeof j.format?.format_name === 'string' ? j.format.format_name : null,
          video_codec: codec('video'),
          audio_codec: codec('audio'),
          video_streams: j.streams?.filter((x) => x.codec_type === 'video').length ?? 0,
        });
      } catch {
        resolve(null);
      }
    });
  });
}
