import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

/**
 * Kiểm tra một đường dẫn tương đối (dùng posix `/`) nằm dưới một trong các prefix cho phép,
 * không có `..`, không tuyệt đối, không NUL/backslash. Trả về đường dẫn đã chuẩn hóa.
 */
export function cleanRelPath(rel: unknown, allowedPrefixes: string[], code = 'INVALID_PATH'): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) {
    throw new AppError(code, 'Đường dẫn file không hợp lệ', 400);
  }
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new AppError(code, `Đường dẫn file không hợp lệ: ${rel}`, 400);
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '..' || s === '')) {
    throw new AppError(code, `Đường dẫn file không hợp lệ: ${rel}`, 400);
  }
  const normalized = segments.filter((s) => s !== '.').join('/');
  if (!allowedPrefixes.some((p) => normalized.startsWith(`${p}/`))) {
    throw new AppError(code, `Đường dẫn phải nằm dưới ${allowedPrefixes.map((p) => p + '/').join(' hoặc ')}: ${rel}`, 400);
  }
  return normalized;
}

/**
 * Trả về đường dẫn tuyệt đối thật (realpath) của file nếu nó tồn tại, là file thường và
 * không trỏ ra ngoài thư mục `<root>/<prefix>` (chặn symlink). Trả null nếu không thỏa.
 */
export function resolveInside(rootDir: string, rel: string, allowedPrefixes: string[]): string | null {
  try {
    const abs = path.join(rootDir, rel);
    const real = fs.realpathSync(abs);
    if (!fs.statSync(real).isFile()) return null;
    for (const prefix of allowedPrefixes) {
      const base = path.join(rootDir, prefix);
      let realBase: string;
      try {
        realBase = fs.realpathSync(base);
      } catch {
        continue;
      }
      if (real.startsWith(realBase + path.sep)) return real;
    }
    return null;
  } catch {
    return null;
  }
}

/** Slug a-z0-9- từ tên (bỏ dấu tiếng Việt). */
export function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'project';
}
