import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/**
 * Parser body dùng chung cho app chính và listener LAN:
 * - JSON rỗng (POST không có thân nhưng vẫn gửi Content-Type: application/json) được coi là `{}`; JSON hỏng → 400 INVALID_JSON;
 * - bỏ parser text/plain mặc định: form chéo trang không gửi được "JSON giả" (chỉ nhận JSON và multipart).
 */
export function installBodyParsers(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('INVALID_JSON', 'Nội dung JSON không hợp lệ', 400), undefined);
    }
  });
  app.removeContentTypeParser('text/plain');
}
