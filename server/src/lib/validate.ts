import type { ZodType } from 'zod';
import { AppError } from './errors.js';

/** Validate bằng zod, ném 400 VALIDATION_ERROR (thông báo tiếng Việt) nếu sai. */
export function parse<T>(schema: ZodType<T>, input: unknown, what = 'Dữ liệu'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const msg = result.error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(gốc)'}: ${i.message}`)
    .slice(0, 5)
    .join('; ');
  throw new AppError('VALIDATION_ERROR', `${what} không hợp lệ — ${msg}`, 400, result.error.issues);
};

/** Đọc id nguyên dương từ tham số đường dẫn/query; ném 400 nếu sai. */
export function intParam(value: unknown, name = 'id'): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError('VALIDATION_ERROR', `Tham số ${name} không hợp lệ`, 400);
  return n;
}

export function optionalIntParam(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  return intParam(value, name);
}
