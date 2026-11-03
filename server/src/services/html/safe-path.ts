/**
 * Kiểm tra bộ file do AI sinh ra (plan Video HTML mục 6.2) TRƯỚC khi ghi xuống đĩa, và ghi vào thư mục staging mới một cách an toàn.
 * Chỉ cho: `index.html`, `compositions/<tên>.html`, `assets/css/<tên>.css`, `assets/js/<tên>.js`. Chặn đường dẫn tuyệt đối/UNC/ổ đĩa tương đối,
 * `..`, backslash, ADS (`:`), tên thiết bị Windows (CON, NUL, COM1…), dấu chấm/khoảng trắng cuối, ký tự điều khiển, trùng tên không phân biệt hoa thường,
 * và (khi ghi) symlink/junction. Không bao giờ chạy npm/script do AI tạo.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../lib/errors.js';

export const MANIFEST_LIMITS = {
  maxFiles: 40,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1_572_864, // 1,5 MiB
  /** Số thư mục lồng nhau tối đa dưới gốc (assets/css/x.css = 2). */
  maxDepth: 2,
  maxSegmentLength: 64,
} as const;

/** Thư mục được phép (tương đối từ gốc phiên bản) → đuôi file bắt buộc (chữ thường). Gốc `''` chỉ có `index.html`. */
export const ALLOWED_DIRS: Readonly<Record<string, string>> = {
  compositions: '.html',
  'assets/css': '.css',
  'assets/js': '.js',
};
export const ENTRY_FILE = 'index.html';
/** Thư mục của asset người dùng được chụp vào phiên bản (do server ghi, AI không được ghi vào đây). */
export const USER_ASSET_DIR = 'assets/u';

export interface ManifestFile {
  path: string;
  content: string;
}
export interface CheckedFile extends ManifestFile {
  bytes: number;
  sha256: string;
}
export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const RESERVED = /^(con|prn|aux|nul|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Chữ/số Unicode (tiếng Việt có dấu được phép), '-', '_', '.' ở giữa. Không khoảng trắng để tên dùng được trong thuộc tính HTML/URL.
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

const bad = (message: string, details?: unknown): AppError => new AppError('INVALID_MANIFEST', message, 400, details);

/** Chuẩn hoá và kiểm tra cú pháp một đường dẫn tương đối (posix). Trả về dạng NFC. Ném INVALID_MANIFEST. */
export function normalizeRelPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw bad('Đường dẫn file rỗng hoặc không phải chuỗi');
  if (raw.length > 200) throw bad(`Đường dẫn file quá dài: ${raw.slice(0, 40)}…`);
  const show = raw.replace(CONTROL, '?');
  if (CONTROL.test(raw)) throw bad(`Đường dẫn chứa ký tự điều khiển: ${show}`);
  if (raw.includes('\\')) throw bad(`Đường dẫn không được dùng dấu gạch ngược: ${show}`);
  if (raw.includes(':')) throw bad(`Đường dẫn không được chứa ":" (ổ đĩa/luồng dữ liệu phụ): ${show}`);
  if (raw.startsWith('/')) throw bad(`Đường dẫn không được là tuyệt đối/UNC: ${show}`);
  const norm = raw.normalize('NFC');
  const segs = norm.split('/');
  if (segs.length > MANIFEST_LIMITS.maxDepth + 1) throw bad(`Đường dẫn quá sâu (tối đa ${MANIFEST_LIMITS.maxDepth} cấp thư mục): ${show}`);
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw bad(`Đường dẫn có thành phần rỗng, "." hoặc "..": ${show}`);
    if (s.length > MANIFEST_LIMITS.maxSegmentLength) throw bad(`Tên file/thư mục quá dài: ${show}`);
    if (/[. ]$/.test(s)) throw bad(`Tên không được kết thúc bằng dấu chấm hoặc khoảng trắng: ${show}`);
    if (!SEGMENT.test(s)) throw bad(`Tên file/thư mục chứa ký tự không cho phép: ${show}`);
    if (RESERVED.test(s.split('.')[0]!)) throw bad(`Tên dành riêng của Windows (CON, NUL, COM1…): ${show}`);
  }
  return norm;
}

/** Đường dẫn đã chuẩn hoá có nằm trong danh sách cho phép không (ném INVALID_MANIFEST nếu không). */
export function assertAllowedPath(p: string): void {
  if (p === ENTRY_FILE) return;
  const i = p.lastIndexOf('/');
  const dir = i < 0 ? '' : p.slice(0, i);
  const name = i < 0 ? p : p.slice(i + 1);
  const ext = ALLOWED_DIRS[dir];
  if (ext === undefined || !name.endsWith(ext) || name.length <= ext.length) {
    throw bad(`File không nằm trong danh sách cho phép (index.html, compositions/*.html, assets/css/*.css, assets/js/*.js): ${p}`);
  }
}

const sha256 = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Kiểm tra toàn bộ bộ file AI trả về: số file/dung lượng, cú pháp đường dẫn, trùng tên không phân biệt hoa thường (Windows/NTFS), danh sách cho phép,
 * có `index.html`. Trả về file đã chuẩn hoá (đường dẫn NFC, kích thước UTF-8, sha256). Ném 400 INVALID_MANIFEST.
 */
export function validateManifest(files: unknown): CheckedFile[] {
  if (!Array.isArray(files) || files.length === 0) throw bad('Danh sách file rỗng');
  if (files.length > MANIFEST_LIMITS.maxFiles) throw bad(`Quá nhiều file (${files.length} > ${MANIFEST_LIMITS.maxFiles})`);
  const seen = new Map<string, string>();
  const out: CheckedFile[] = [];
  let total = 0;
  for (const f of files as unknown[]) {
    if (!f || typeof f !== 'object' || typeof (f as ManifestFile).content !== 'string') throw bad('Mỗi file cần {path, content} với content là chuỗi');
    const p = normalizeRelPath((f as ManifestFile).path);
    const content = (f as ManifestFile).content;
    if (content.includes('\0')) throw bad(`Nội dung file chứa byte NUL: ${p}`);
    const key = p.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) throw bad(`Trùng tên file (không phân biệt hoa thường): ${prev} và ${p}`);
    seen.set(key, p);
    assertAllowedPath(p);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MANIFEST_LIMITS.maxFileBytes) throw bad(`File quá lớn (${bytes} > ${MANIFEST_LIMITS.maxFileBytes} byte): ${p}`);
    total += bytes;
    if (total > MANIFEST_LIMITS.maxTotalBytes) throw bad(`Tổng dung lượng file vượt ${MANIFEST_LIMITS.maxTotalBytes} byte`);
    out.push({ path: p, content, bytes, sha256: sha256(content) });
  }
  if (!seen.has(ENTRY_FILE)) throw bad('Thiếu index.html');
  // index.html phải đúng chữ thường (đã qua assertAllowedPath so khớp chính xác) → tên khác hoa/thường đã bị loại ở trên
  return out;
}

const insideOf = (root: string, abs: string): boolean => {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  return a === r || a.startsWith(r + path.sep);
};

/**
 * Ghi file đã kiểm tra vào thư mục staging MỚI (phải chưa tồn tại). Mỗi file ghi bằng cờ `wx` (không ghi đè, không đi theo symlink có sẵn);
 * sau khi ghi `lstat` từng thư mục cha và file: không symlink/junction, đúng là file thường, nằm trong staging, kích thước khớp. Lỗi → xoá staging.
 */
export function writeStaging(dir: string, files: CheckedFile[]): ManifestEntry[] {
  const root = path.resolve(dir);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root); // EEXIST nếu staging đã có: không bao giờ chồng lên thư mục cũ (và không xoá thư mục không phải của lần ghi này)
  try {
    const entries: ManifestEntry[] = [];
    for (const f of files) {
      const abs = path.resolve(root, ...f.path.split('/'));
      if (!insideOf(root, abs) || abs === root) throw bad(`Đường dẫn thoát khỏi thư mục staging: ${f.path}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      entries.push({ path: f.path, bytes: f.bytes, sha256: f.sha256 });
    }
    verifyTree(root, entries);
    return entries;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Quét lại cây thư mục (staging hoặc phiên bản đã công bố): mọi mục là thư mục/file thường (KHÔNG symlink/junction/thiết bị), file AI khớp manifest
 * (kích thước + sha256), không có file lạ ngoài manifest và thư mục asset người dùng `assets/u/`. Ném INVALID_MANIFEST.
 */
export function verifyTree(dir: string, manifest: ManifestEntry[]): void {
  const root = path.resolve(dir);
  const expected = new Map(manifest.map((m) => [m.path, m]));
  const seen = new Set<string>();
  const walk = (abs: string, rel: string): void => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw bad(`Phát hiện liên kết tượng trưng/junction: ${rel || '.'}`);
    if (st.isDirectory()) {
      if (!insideOf(root, abs)) throw bad(`Thư mục nằm ngoài staging: ${rel}`);
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      return;
    }
    if (!st.isFile()) throw bad(`Không phải file thường: ${rel}`);
    if (rel === USER_ASSET_DIR || rel.startsWith(`${USER_ASSET_DIR}/`)) return; // asset người dùng do server chụp
    const m = expected.get(rel);
    if (!m) throw bad(`File ngoài manifest: ${rel}`);
    if (st.size !== m.bytes) throw bad(`Kích thước file không khớp manifest: ${rel}`);
    if (sha256(fs.readFileSync(abs)) !== m.sha256) throw bad(`Nội dung file không khớp manifest: ${rel}`);
    seen.add(rel);
  };
  walk(root, '');
  for (const p of expected.keys()) if (!seen.has(p)) throw bad(`Thiếu file theo manifest: ${p}`);
}
