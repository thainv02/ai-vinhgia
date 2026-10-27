// Lỗi API dùng chung. Tách khỏi client.ts để trang planner LAN (bundle riêng) không kéo theo toàn bộ API của app chính.
/** Lỗi API: giữ nguyên `{error:{code,message,details}}` của server. */
export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Đã xảy ra lỗi không xác định';
}
