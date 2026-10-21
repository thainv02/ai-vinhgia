/** Lỗi nghiệp vụ: trả về dưới dạng { error: { code, message } }. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `Không tìm thấy ${what}`, 404);
export const conflict = (code: string, message: string) => new AppError(code, message, 409);
export const badRequest = (code: string, message: string) => new AppError(code, message, 400);
