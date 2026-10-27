import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config.js';
import { ffmpegOf, probeMedia } from '../media.js';
import { buildGradeArgs } from '../grade.js';
import { run } from './ffmpeg-renderer.js';
import { RenderCancelled } from './types.js';

/** Lỗi của bước chỉnh màu (thông báo tiếng Việt hiển thị cho người dùng). */
export class GradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GradeError';
  }
}

/**
 * Tạo file mới `dstAbs` từ `srcAbs` mà KHÔNG ghi đè: hard link (cùng ổ đĩa, tức thì, không tốn thêm dung lượng; file nguồn không bao giờ bị sửa
 * tại chỗ nên an toàn) rồi dự phòng sao chép. Mỗi phiên bản có tên file riêng nên xoá/di chuyển một bản không ảnh hưởng bản kia.
 */
export function linkOrCopy(srcAbs: string, dstAbs: string): 'link' | 'copy' {
  if (fs.existsSync(dstAbs)) throw new GradeError(`File ${path.basename(dstAbs)} đã tồn tại; không ghi đè`);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  try {
    fs.linkSync(srcAbs, dstAbs);
    return 'link';
  } catch {
    fs.copyFileSync(srcAbs, dstAbs, fs.constants.COPYFILE_EXCL);
    return 'copy';
  }
}

/**
 * Chạy ffmpeg chỉnh màu `inAbs` → `tmpAbs` (không ghi đè; người gọi đổi tên nguyên tử sau khi kiểm tra). `onProgress` nhận 0–100.
 * Bị hủy (signal) → RenderCancelled; ffmpeg lỗi → Error có đoạn cuối stderr.
 */
export async function encodeGraded(req: {
  config: Pick<Config, 'ffmpegPath' | 'ffprobePath'>;
  inAbs: string;
  tmpAbs: string;
  filter: string;
  signal: AbortSignal;
  onProgress: (pct: number) => void;
}): Promise<void> {
  const bin = ffmpegOf(req.config);
  if (!bin) throw new GradeError('Không tìm thấy ffmpeg (đặt FFMPEG_PATH hoặc cài ffmpeg)');
  if (fs.existsSync(req.tmpAbs)) fs.rmSync(req.tmpAbs, { force: true });
  const total = probeMedia(req.config, req.inAbs)?.duration_s ?? null;
  let best = 0;
  try {
    await run(bin, buildGradeArgs({ inAbs: req.inAbs, outAbs: req.tmpAbs, filter: req.filter }), req.signal, (line) => {
      const m = /^out_time(?:_us|_ms)?=(\d+)/.exec(line);
      if (!m || !total) return;
      best = Math.max(best, Math.min(99, Math.round((Number(m[1]) / 1e6 / total) * 100))); // chỉ tăng
      req.onProgress(best);
    });
  } catch (err) {
    fs.rmSync(req.tmpAbs, { force: true });
    if (err instanceof RenderCancelled) throw err;
    throw err;
  }
}

/** Kiểm tra file đã chỉnh màu: đọc được, cùng độ phân giải, thời lượng lệch ≤ 0,25 giây so với bản sạch, còn âm thanh nếu bản sạch có. Trả thời lượng. */
export function verifyGraded(config: Pick<Config, 'ffprobePath'>, baseAbs: string, outAbs: string): number | null {
  if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size === 0) throw new GradeError('ffmpeg không tạo ra file kết quả');
  const out = probeMedia(config, outAbs);
  if (!out || !out.width) throw new GradeError('file kết quả không đọc được hoặc không có luồng video');
  const base = probeMedia(config, baseAbs);
  if (base?.width && base.height && (out.width !== base.width || out.height !== base.height)) throw new GradeError('file kết quả đổi độ phân giải so với bản sạch');
  if (base?.duration_s != null && out.duration_s != null && Math.abs(out.duration_s - base.duration_s) > 0.25) {
    throw new GradeError(`file kết quả dài ${out.duration_s.toFixed(2)}s, lệch quá 0,25s so với bản sạch (${base.duration_s.toFixed(2)}s)`);
  }
  if (base?.has_audio && !out.has_audio) throw new GradeError('file kết quả mất âm thanh');
  return out.duration_s;
}
