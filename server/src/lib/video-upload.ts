import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { AppError, badRequest } from './errors.js';
import { sanitizeBaseName } from '../services/refs.js';

/** Video LAN tải lên: mp4/mov (ISO BMFF, có `ftyp` ở byte 4..8), tối đa 200 MB. */
export const LAN_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** `ftyp` ở byte 4..8 của file mp4/mov (QuickTime cũng dùng ISO BMFF). Đủ để loại file không phải video trước khi ffprobe. */
export function hasFtypMagic(head: Buffer): boolean {
  return head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp';
}

/** Container nhận diện từ byte đầu: mp4/mov (`ftyp`), mkv/webm (EBML), avi (RIFF…AVI). null = không phải video được hỗ trợ. */
export function detectVideoContainer(head: Buffer): 'mp4' | 'mov' | 'mkv' | 'avi' | null {
  if (head.length < 12) return null;
  if (hasFtypMagic(head)) return head.subarray(8, 12).toString('latin1') === 'qt  ' ? 'mov' : 'mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'mkv';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'AVI ') return 'avi';
  return null;
}

export interface StreamedUpload {
  /** Chỉ khi `StreamOptions.hash`: sha256 hex của nội dung file. */
  sha256?: string;
  /** Container theo byte đầu (chỉ khi `StreamOptions.magic = 'video'`). */
  container?: 'mp4' | 'mov' | 'mkv' | 'avi';
  /** File tạm (tuyệt đối) đã ghi đủ; người gọi PHẢI đổi tên hoặc xoá. */
  tmpAbs: string;
  bytes: number;
  /** Tên file người dùng chọn, đã bỏ ký tự điều khiển/dấu phân cách và cắt ≤ 200 ký tự (chỉ để hiển thị). */
  originalName: string;
  /** Các trường văn bản (nằm trong `fieldNames`), đã cắt ≤ 200 ký tự. */
  fields: Record<string, string>;
}

export interface StreamOptions {
  /** Thư mục chứa file tạm (cùng ổ đĩa với nơi đổi tên cuối cùng để đổi tên nguyên tử). Được tạo nếu chưa có. */
  tmpDir: string;
  maxBytes: number;
  fieldNames?: readonly string[];
  /** Thông báo khi vượt dung lượng. */
  tooLargeMessage: string;
  /** `mp4` (mặc định): chỉ mp4/mov; `video`: thêm mkv/webm/avi (video nguồn của dự án cắt clip). */
  magic?: 'mp4' | 'video';
  /** Tính sha256 trong lúc nhận (không đọc lại file). */
  hash?: boolean;
}

/**
 * Transform "cổng kiểm tra" giữa luồng multipart và file: đếm byte (vượt `maxBytes` → lỗi 413 NGAY, không nhận nốt phần còn lại) và
 * kiểm tra `ftyp` từ 12 byte đầu (sai → 415 ngay khi chunk đầu tới, không chờ nhận hết file). Không giữ gì ngoài 12 byte đầu trong bộ nhớ.
 */
class VideoGate extends Transform {
  bytes = 0;
  private head = Buffer.alloc(0);
  private readonly hasher: crypto.Hash | null;
  sha256: string | undefined;

  constructor(
    private readonly maxBytes: number,
    private readonly tooLarge: string,
    private readonly magic: 'mp4' | 'video' = 'mp4',
    hash = false,
  ) {
    super();
    this.hasher = hash ? crypto.createHash('sha256') : null;
  }

  get container(): 'mp4' | 'mov' | 'mkv' | 'avi' | null {
    return this.magic === 'video' ? detectVideoContainer(this.head) : hasFtypMagic(this.head) ? 'mp4' : null;
  }

  private notVideo(): AppError {
    return new AppError('UNSUPPORTED_FILE_TYPE', this.magic === 'video' ? 'File không phải video (mp4, mov, mkv, webm hoặc avi)' : 'File không phải video mp4 hoặc mov', 415);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) return cb(new AppError('FILE_TOO_LARGE', this.tooLarge, 413));
    if (this.head.length < 12) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, 12 - this.head.length)]);
      if (this.head.length >= 12 && !this.container) return cb(this.notVideo());
    }
    this.hasher?.update(chunk);
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    if (!this.container) return cb(this.notVideo());
    this.sha256 = this.hasher?.digest('hex');
    cb();
  }
}

const cleanText = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, '_')
    .trim()
    .slice(0, max);

/**
 * Nhận MỘT file video từ multipart và GHI THẲNG XUỐNG ĐĨA theo luồng (pipeline có backpressure): bộ nhớ không bao giờ giữ cả file.
 * Từ chối sớm theo Content-Length, đếm byte khi nhận, kiểm tra magic bytes ở chunk đầu. Mọi lỗi đều xoá file tạm.
 * Thông tin ffprobe/giới hạn thời lượng do người gọi kiểm tra tiếp trên `tmpAbs`.
 */
export async function streamVideoToDisk(req: FastifyRequest, o: StreamOptions): Promise<StreamedUpload> {
  if (!req.isMultipart()) throw badRequest('BAD_REQUEST', 'Cần gửi multipart/form-data với trường "file"');
  const declared = Number(req.headers['content-length']);
  // Phần khung multipart rất nhỏ so với file; chừa 256 KB. Client nói dối Content-Length vẫn bị chặn bởi VideoGate.
  if (Number.isFinite(declared) && declared > o.maxBytes + 256 * 1024) throw new AppError('FILE_TOO_LARGE', o.tooLargeMessage, 413);
  fs.mkdirSync(o.tmpDir, { recursive: true });
  const tmpAbs = path.join(o.tmpDir, `.lan-upload-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const fields: Record<string, string> = {};
  const names = new Set(o.fieldNames ?? []);
  let result: { bytes: number; originalName: string; sha256?: string; container?: StreamedUpload['container'] } | null = null;
  try {
    const parts = req.parts({ limits: { fileSize: o.maxBytes, files: 1, fields: 6, fieldSize: 4096, parts: 10 } });
    for await (const part of parts) {
      if (part.type === 'field') {
        if (names.has(part.fieldname)) fields[part.fieldname] = cleanText(String(part.value ?? ''), 200);
        continue;
      }
      if (result) throw badRequest('VALIDATION_ERROR', 'Mỗi lần chỉ tải lên một video');
      const filename = part.filename ?? '';
      sanitizeBaseName(filename); // ném INVALID_FILENAME nếu có `..`/dấu phân cách đường dẫn
      const gate = new VideoGate(o.maxBytes, o.tooLargeMessage, o.magic ?? 'mp4', !!o.hash);
      try {
        await pipeline(part.file, gate, fs.createWriteStream(tmpAbs, { flags: 'wx', mode: 0o600 }));
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError('FILE_TOO_LARGE', o.tooLargeMessage, 413);
        throw err;
      }
      if (part.file.truncated) throw new AppError('FILE_TOO_LARGE', o.tooLargeMessage, 413);
      result = { bytes: gate.bytes, originalName: cleanText(filename, 200) || 'video.mp4', sha256: gate.sha256, container: gate.container ?? undefined };
    }
    if (!result) throw badRequest('NO_FILE', 'Không có file video nào được gửi lên');
    return { tmpAbs, bytes: result.bytes, originalName: result.originalName, fields, sha256: result.sha256, container: result.container };
  } catch (err) {
    fs.rmSync(tmpAbs, { force: true });
    drainRequest(req);
    throw err;
  }
}

/** Sau khi từ chối giữa chừng, phần thân còn lại của request phải được xả bỏ: nếu không, busboy dừng đọc và kết nối kẹt mãi. */
const DRAIN_CAP_BYTES = 32 * 1024 * 1024;
function drainRequest(req: FastifyRequest): void {
  const raw = req.raw;
  if (raw.complete || raw.destroyed) return;
  let seen = 0;
  raw.unpipe();
  raw.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    // client cứ gửi tiếp hàng trăm MB sau khi đã bị từ chối: cắt kết nối thay vì đọc hết (không ghi gì xuống đĩa trong lúc xả)
    if (seen > DRAIN_CAP_BYTES) raw.destroy();
  });
  raw.on('error', () => undefined);
  raw.resume();
}
