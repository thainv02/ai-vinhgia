import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { srgbToLab } from '../src/services/color-lut.js';
import { FFMPEG } from './final-helpers.js';

let dir: string | null = null;
const cache = new Map<string, Buffer>();

/** Ảnh PNG thật (dải màu mượt) cỡ 160x240 do ffmpeg tạo; `variant` khác nhau → byte khác nhau (thêm đuôi sau IEND, bộ giải mã bỏ qua) nên hash khác. */
export function colorPng(kind: 'warm' | 'cool' = 'warm', variant = 0): Buffer {
  let base = cache.get(kind);
  if (!base) {
    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-colorpng-'));
    const abs = path.join(dir, `${kind}.png`);
    const c = kind === 'warm' ? 'c0=0xf0b070:c1=0xc06020:c2=0xfbd9a0' : 'c0=0x4070c0:c1=0x103060:c2=0xa0c8f0';
    const r = spawnSync(FFMPEG!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `gradients=size=160x240:${c}:nb_colors=3:seed=7:x0=0:y0=0:x1=160:y1=240:speed=0:rate=1:duration=1`, '-frames:v', '1', abs], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    base = fs.readFileSync(abs);
    cache.set(kind, base);
  }
  return variant ? Buffer.concat([base, Buffer.from(`\nvariant-${variant}`)]) : base;
}

/** File .cube hợp lệ (đồng nhất, cỡ n; `swap` hoán đổi kênh R↔B). */
export function cubeText(n = 5, opts: { swap?: boolean; title?: string } = {}): string {
  const rows = [`TITLE "${opts.title ?? 'thử'}"`, `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const v = [r, g, b].map((x) => (x / (n - 1)).toFixed(6));
    rows.push(opts.swap ? `${v[2]} ${v[1]} ${v[0]}` : v.join(' '));
  }
  return `${rows.join('\n')}\n`;
}

export interface FrameMean {
  r: number;
  g: number;
  b: number;
  luma: number;
}

/** Trung bình R, G, B (0–255) và luma Rec.709 (trên mã gamma) của MỘT khung ở thời điểm t (giây), thu nhỏ còn 90px rộng. */
export function frameMean(abs: string, t: number): FrameMean {
  const r = spawnSync(FFMPEG!, ['-loglevel', 'error', ...(t > 0 ? ['-ss', String(t)] : []), '-i', abs, '-frames:v', '1', '-vf', 'scale=90:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 10_000_000 });
  const buf = r.stdout as Buffer;
  let sr = 0, sg = 0, sb = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    sr += buf[i]!;
    sg += buf[i + 1]!;
    sb += buf[i + 2]!;
  }
  const [R, G, B] = [sr / n, sg / n, sb / n];
  return { r: R, g: G, b: B, luma: 0.2126 * R + 0.7152 * G + 0.0722 * B };
}

/** Trung bình L* (độ sáng cảm nhận, CIELAB) của MỘT khung: đây mới là "L" mà chế độ color giữ nguyên (khác luma Y' của YUV trên mã gamma). */
export function frameLightness(abs: string, t: number): number {
  const r = spawnSync(FFMPEG!, ['-loglevel', 'error', ...(t > 0 ? ['-ss', String(t)] : []), '-i', abs, '-frames:v', '1', '-vf', 'scale=90:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 10_000_000 });
  const buf = r.stdout as Buffer;
  let sum = 0;
  for (let i = 0; i < buf.length; i += 3) sum += srgbToLab(buf[i]! / 255, buf[i + 1]! / 255, buf[i + 2]! / 255)[0];
  return sum / (buf.length / 3);
}
