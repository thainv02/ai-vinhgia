import type { FastifyRequest } from 'fastify';
import { AppError, badRequest } from './errors.js';
import { CUBE_MAX_BYTES } from '../services/color-lut.js';
import { detectImageType, sanitizeBaseName, type ImageType } from '../services/refs.js';

/** Ảnh mẫu tối đa 15 MB; file .cube tối đa 5 MB. */
export const COLOR_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

export interface ColorRefUpload {
  name: string;
  buf: Buffer;
  /** Ảnh theo magic bytes, hoặc 'cube' (văn bản; việc đọc chặt .cube làm ở dịch vụ). */
  type: ImageType | 'cube';
  createdByName: string | null;
}

/**
 * Đọc MỘT file từ multipart (trường `file`; trường `created_by_name` tuỳ chọn, đứng trước hoặc sau). Dùng chung cho app chính và LAN.
 * Giới hạn dung lượng đặt riêng cho request này (15 MB; .cube ≤ 5 MB kiểm tra sau khi nhận), tên file không có `..`/dấu phân cách,
 * ảnh nhận bằng MAGIC BYTES (không tin Content-Type/đuôi); file không phải ảnh phải có đuôi .cube.
 */
export async function readColorRefUpload(req: FastifyRequest): Promise<ColorRefUpload> {
  if (!req.isMultipart()) throw badRequest('BAD_REQUEST', 'Cần gửi multipart/form-data với trường "file"');
  let found: { name: string; buf: Buffer } | null = null;
  let createdByName: string | null = null;
  const tooLarge = (): AppError => new AppError('FILE_TOO_LARGE', 'Ảnh mẫu vượt quá 15MB (file .cube tối đa 5MB)', 413);
  try {
    for await (const part of req.parts({ limits: { fileSize: COLOR_IMAGE_MAX_BYTES, files: 1, fields: 8, parts: 12 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'created_by_name') createdByName = String(part.value ?? '').trim().slice(0, 60) || null;
        continue;
      }
      if (found) throw badRequest('VALIDATION_ERROR', 'Mỗi lần chỉ tải lên một file');
      const buf = await part.toBuffer();
      if (part.file.truncated) throw tooLarge();
      const name = part.filename ?? '';
      sanitizeBaseName(name); // ném INVALID_FILENAME nếu có `..` hoặc dấu phân cách đường dẫn
      found = { name, buf };
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
    throw err;
  }
  if (!found) throw badRequest('NO_FILE', 'Không có file nào được gửi lên');
  const img = detectImageType(found.buf);
  if (img) return { ...found, type: img, createdByName };
  if (/\.cube$/i.test(found.name)) {
    if (found.buf.length > CUBE_MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'File .cube vượt quá 5MB', 413);
    return { ...found, type: 'cube', createdByName };
  }
  throw new AppError('UNSUPPORTED_FILE_TYPE', `File "${found.name.slice(0, 60)}" không phải ảnh png, jpg, webp hoặc file LUT .cube`, 415);
}
