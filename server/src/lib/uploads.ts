import type { FastifyRequest } from 'fastify';
import { AppError, badRequest } from './errors.js';
import { detectImageType, sanitizeBaseName, type ImageType } from '../services/refs.js';

export interface ImageUpload {
  name: string;
  buf: Buffer;
  type: ImageType;
  label?: string;
}

/**
 * Đọc mọi file ảnh trong request multipart (trường `file`, có thể kèm trường `label` đứng ngay trước file mà nó gắn nhãn).
 * Kiểm tra: tên file không có `..`/dấu phân cách, không bị cắt vì quá dung lượng, đúng png/jpg/webp theo magic bytes.
 * Dùng chung cho API chính và listener LAN để hai nơi có cùng luật kiểm tra.
 */
export async function readImageUploads(req: FastifyRequest, maxBytesMessage = 'Ảnh vượt quá dung lượng cho phép (10MB)'): Promise<ImageUpload[]> {
  if (!req.isMultipart()) throw badRequest('BAD_REQUEST', 'Cần gửi multipart/form-data với trường "file"');
  const items: ImageUpload[] = [];
  let pendingLabel: string | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'field') {
      if (part.fieldname === 'label') pendingLabel = String(part.value ?? '');
      continue;
    }
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new AppError('FILE_TOO_LARGE', maxBytesMessage, 413);
    const filename = part.filename ?? '';
    sanitizeBaseName(filename); // ném INVALID_FILENAME nếu có `..` hoặc dấu phân cách đường dẫn
    const type = detectImageType(buf);
    if (!type) throw new AppError('UNSUPPORTED_FILE_TYPE', `File "${filename.slice(0, 60)}" không phải ảnh png, jpg hoặc webp`, 415);
    items.push({ name: filename, buf, type, label: pendingLabel });
    pendingLabel = undefined;
  }
  if (items.length === 0) throw badRequest('NO_FILE', 'Không có file ảnh nào được gửi lên');
  return items;
}
