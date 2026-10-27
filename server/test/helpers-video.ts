import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestVideo } from './final-helpers.js';

const cache = new Map<string, Buffer>();
let dir: string | null = null;

/** Video mp4 thật (ffmpeg testsrc2 + âm thanh), nhớ lại theo cấu hình để mỗi test không phải mã hóa lại. */
export function clip(seconds = 3, opts: { audio?: boolean; size?: string } = {}): Buffer {
  const key = `${seconds}|${opts.audio ?? true}|${opts.size ?? ''}`;
  let buf = cache.get(key);
  if (!buf) {
    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-clip-'));
    const abs = path.join(dir, `clip-${cache.size}.mp4`);
    makeTestVideo(abs, seconds, opts);
    buf = fs.readFileSync(abs);
    cache.set(key, buf);
  }
  return buf;
}

/** Bản đổi tên container thành QuickTime (.mov): brand `qt  ` thay cho brand mp4, vẫn hợp lệ với ftyp + ffprobe. */
export function movOf(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  if (out.subarray(4, 8).toString('latin1') === 'ftyp') out.write('qt  ', 8, 'latin1');
  return out;
}

/** Dọn thư mục clip tạm (gọi ở afterAll nếu muốn). */
export function cleanupClips(): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
  cache.clear();
}
