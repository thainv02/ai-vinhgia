/**
 * Lấy mẫu pixel bằng ffmpeg cho chức năng "màu theo ảnh mẫu": ảnh mẫu (1 khung) và N khung của video, thu nhỏ về ~256px cạnh dài rồi tính thống kê Lab.
 * Khung được xuất dạng BMP 24-bit qua pipe (đọc kích thước thật từ header, không phụ thuộc xoay EXIF/SAR) rồi giải mã thành RGB24.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { Config } from '../config.js';
import { DEFAULT_SPACE, LabAccumulator, contentBox, spaceOf, type LabStats, type MatchSpace } from './color-lut.js';
import { ffmpegOf, probeMedia } from './media.js';

export const SAMPLE_EDGE = 256;
/** Số khung lấy từ video cho thống kê chung. */
export const GLOBAL_FRAMES = 12;
/** Số khung lấy trong MỖI cảnh khi khớp riêng từng cảnh. */
export const SCENE_FRAMES = 4;

export class SampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleError';
  }
}

export interface RgbFrame {
  width: number;
  height: number;
  /** RGB24 thô, hàng trên cùng trước. */
  rgb: Uint8Array;
}

/** Giải mã BMP 24-bit (BI_RGB) do ffmpeg tạo ra thành RGB24. */
export function decodeBmp24(buf: Buffer): RgbFrame {
  if (buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') throw new SampleError('ffmpeg không trả về ảnh BMP hợp lệ');
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const hRaw = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const height = Math.abs(hRaw);
  if (bpp !== 24 || compression !== 0 || width <= 0 || height <= 0 || width > 4096 || height > 4096) throw new SampleError('ảnh BMP của ffmpeg có định dạng không mong đợi');
  const stride = Math.ceil((width * 3) / 4) * 4;
  if (buf.length < offset + stride * height) throw new SampleError('ảnh BMP của ffmpeg bị cắt cụt');
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const srcRow = offset + (hRaw > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3;
      const d = (y * width + x) * 3;
      rgb[d] = buf[s + 2]!;
      rgb[d + 1] = buf[s + 1]!;
      rgb[d + 2] = buf[s]!;
    }
  }
  return { width, height, rgb };
}

function grabFrame(bin: string, inputAbs: string, t: number | null, signal?: AbortSignal): Promise<RgbFrame> {
  const vf = `scale=${SAMPLE_EDGE}:${SAMPLE_EDGE}:force_original_aspect_ratio=decrease:flags=area,format=bgr24`;
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', ...(t !== null ? ['-ss', String(t)] : []), '-i', inputAbs, '-an', '-sn', '-vf', vf, '-frames:v', '1', '-c:v', 'bmp', '-f', 'image2pipe', 'pipe:1'];
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, signal }, (err, stdout, stderr) => {
      if (err) {
        if (signal?.aborted) return reject(new SampleError('đã hủy'));
        return reject(new SampleError(`ffmpeg không đọc được khung hình (${String(stderr).trim().split('\n').slice(-2).join(' | ') || err.message})`));
      }
      try {
        resolve(decodeBmp24(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function needFfmpeg(config: Pick<Config, 'ffmpegPath'>): string {
  const bin = ffmpegOf(config);
  if (!bin) throw new SampleError('Không tìm thấy ffmpeg (đặt FFMPEG_PATH hoặc cài ffmpeg)');
  return bin;
}

function statsOf(frames: RgbFrame[], what: string, space: MatchSpace): LabStats {
  const acc = new LabAccumulator(spaceOf(space));
  for (const f of frames) acc.addRgb24(f.rgb, f.width, f.height, contentBox(f.rgb, f.width, f.height));
  const s = acc.stats();
  if (!s) throw new SampleError(`${what} gần như toàn đen hoặc toàn trắng, không đủ pixel để lấy màu`);
  return s;
}

/** Thống kê (trong không gian chuyển, mặc định lαβ) của ảnh mẫu (jpg/png/webp). */
export async function imageStats(config: Pick<Config, 'ffmpegPath'>, imageAbs: string, signal?: AbortSignal, space: MatchSpace = DEFAULT_SPACE): Promise<LabStats> {
  const frame = await grabFrame(needFfmpeg(config), imageAbs, null, signal);
  return statsOf([frame], 'Ảnh mẫu', space);
}

/** `n` mốc thời gian rải đều (giữa các đoạn bằng nhau) trong [from, to). */
export function sampleTimes(from: number, to: number, n: number): number[] {
  const len = Math.max(0, to - from);
  if (len <= 0) return [Math.max(0, from)];
  return Array.from({ length: n }, (_, i) => Math.round((from + (len * (i + 0.5)) / n) * 1000) / 1000);
}

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Thống kê Lab của một đoạn [from, to) giây của video (n khung rải đều). */
export async function videoRangeStats(config: Pick<Config, 'ffmpegPath' | 'ffprobePath'>, videoAbs: string, from: number, to: number, n: number, signal?: AbortSignal, space: MatchSpace = DEFAULT_SPACE): Promise<LabStats> {
  const bin = needFfmpeg(config);
  const dur = probeMedia(config, videoAbs)?.duration_s ?? null;
  if (dur === null) throw new SampleError('không đọc được thời lượng video để lấy mẫu màu');
  const hi = Math.min(to, Math.max(0, dur - 0.05));
  const times = sampleTimes(Math.min(from, hi), hi, n);
  const frames = await pool(times, 4, (t) => grabFrame(bin, videoAbs, t, signal));
  return statsOf(frames, 'Video', space);
}

// Bộ nhớ đệm thống kê (ảnh mẫu theo hash nội dung; video theo đường dẫn + size + mtime + đoạn): kéo thanh cường độ khi xem trước không phải lấy mẫu lại.
const cache = new Map<string, LabStats>();
const CACHE_MAX = 200;

export async function cachedStats(key: string, make: () => Promise<LabStats>): Promise<LabStats> {
  const hit = cache.get(key);
  if (hit) return hit;
  const s = await make();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, s);
  return s;
}

/** Khoá bộ nhớ đệm của một file (đổi file → đổi khoá). */
export function fileKey(abs: string): string {
  const st = fs.statSync(abs);
  return `${abs}|${st.size}|${Math.round(st.mtimeMs)}`;
}
