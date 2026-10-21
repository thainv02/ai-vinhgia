import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';

const MESSAGES: Record<string, [number, string, string]> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type không được hỗ trợ'],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'BODY_TOO_LARGE', 'Nội dung gửi lên quá lớn'],
  FST_REQ_FILE_TOO_LARGE: [413, 'FILE_TOO_LARGE', 'Ảnh vượt quá dung lượng cho phép (10MB)'],
  FST_FILES_LIMIT: [413, 'TOO_MANY_FILES', 'Gửi quá nhiều file trong một lần'],
  FST_PARTS_LIMIT: [413, 'TOO_MANY_FILES', 'Gửi quá nhiều phần trong một lần'],
  FST_INVALID_MULTIPART_CONTENT_TYPE: [400, 'BAD_REQUEST', 'Cần gửi multipart/form-data'],
};

/** Định dạng lỗi chung: { error: { code, message, details? } } với message tiếng Việt. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
    }
    const known = err.code ? MESSAGES[err.code] : undefined;
    if (known) return reply.code(known[0]).send({ error: { code: known[1], message: known[2] } });
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: `Yêu cầu không hợp lệ: ${err.message}` } });
    }
    req.log.error({ err }, 'Lỗi không xác định');
    if (process.env.DEBUG_ERRORS) console.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Lỗi máy chủ nội bộ' } });
  });
}
