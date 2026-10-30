import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import type { ProjectSource, RefRow, SceneRow } from '../db/types.js';
import { emitProject } from './project-view.js';
import { getProject, getRef, parseJson, projectRefs } from './repo.js';
import { emitScene } from './scene-view.js';

export type ImageType = 'png' | 'jpg' | 'webp';

/** sha256 (hex) nội dung file. */
export const hashBuffer = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Điền `content_hash` còn thiếu của project_refs bằng cách đọc file (bỏ qua file mất / ngoài refs/).
 * Chạy lúc khởi động app (sau migration) và trước khi liệt kê thư viện. Trả về số dòng đã điền.
 */
export function backfillRefHashes(ctx: AppContext): number {
  const rows = ctx.db
    .prepare('SELECT r.id, r.file_path FROM project_refs r JOIN projects p ON p.id = r.project_id WHERE r.content_hash IS NULL AND p.deleted_at IS NULL')
    .all() as { id: number; file_path: string }[];
  let filled = 0;
  for (const r of rows) {
    try {
      const rel = cleanRelPath(r.file_path, ['refs']);
      const abs = resolveInside(ctx.config.rootDir, rel, ['refs']);
      if (!abs) continue;
      ctx.db.prepare('UPDATE project_refs SET content_hash = ? WHERE id = ?').run(hashBuffer(fs.readFileSync(abs)), r.id);
      filled++;
    } catch {
      /* file lạ hoặc đọc lỗi: để NULL */
    }
  }
  return filled;
}

/** Nhận diện ảnh bằng magic bytes (không tin Content-Type/đuôi file). */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * Làm sạch tên file tải lên. Từ chối (400 INVALID_FILENAME) nếu có dấu phân cách đường dẫn, thành phần `..` hoặc NUL.
 * Trả về phần tên (không đuôi) chỉ gồm a-z A-Z 0-9 . _ -
 */
export function sanitizeBaseName(original: string): string {
  if (original.includes('\0') || /[\\/]/.test(original) || original.split(/[\\/]/).some((s) => s === '..')) {
    throw new AppError('INVALID_FILENAME', `Tên file không hợp lệ: ${original.replace(/[^\x20-\x7e]/g, '?').slice(0, 80)}`, 400);
  }
  const noExt = original.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  let base = noExt
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (base.length > 80) base = base.slice(0, 80);
  return base || 'image';
}

/** Ghi file ảnh vào refs/<projectId>/ (thêm hậu tố -2, -3… nếu trùng tên) và tạo bản ghi project_refs. */
export function storeRef(
  ctx: AppContext,
  projectId: number,
  original: string,
  buf: Buffer,
  type: ImageType,
  label?: string,
): RefRow {
  getProject(ctx, projectId);
  const base = sanitizeBaseName(original);
  const dir = path.join(ctx.config.rootDir, 'refs', String(projectId));
  fs.mkdirSync(dir, { recursive: true });
  let name = `${base}.${type}`;
  let fd: number | null = null;
  for (let i = 2; fd === null; i++) {
    try {
      fd = fs.openSync(path.join(dir, name), 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      name = `${base}-${i}.${type}`;
    }
  }
  try {
    fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  const rel = cleanRelPath(`refs/${projectId}/${name}`, ['refs']);
  const defaultLabel = original.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 100) || base;
  const finalLabel = (label ?? '').trim().slice(0, 100) || defaultLabel;
  return ctx.tx(() => {
    const next = (ctx.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM project_refs WHERE project_id = ?').get(projectId) as { n: number }).n;
    const info = ctx.db
      .prepare(
        'INSERT INTO project_refs (project_id, label, file_path, original_name, order_index, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(projectId, finalLabel, rel, original.slice(0, 200), next, hashBuffer(buf), ctx.now());
    emitProject(ctx, projectId);
    return getRef(ctx, Number(info.lastInsertRowid));
  });
}

export function setRefLabel(ctx: AppContext, id: number, label: string): RefRow {
  return ctx.tx(() => {
    const ref = getRef(ctx, id);
    ctx.db.prepare('UPDATE project_refs SET label = ? WHERE id = ?').run(label, id);
    emitProject(ctx, ref.project_id);
    return getRef(ctx, id);
  });
}

/** Xóa ảnh tham chiếu (bản ghi + file) và gỡ id khỏi upload_refs của các cảnh. */
export function deleteRef(ctx: AppContext, id: number): void {
  const ref = getRef(ctx, id);
  ctx.tx(() => {
    ctx.db.prepare('DELETE FROM project_refs WHERE id = ?').run(id);
    emitProject(ctx, ref.project_id);
    const scenes = ctx.db.prepare('SELECT * FROM scenes WHERE project_id = ?').all(ref.project_id) as SceneRow[];
    for (const s of scenes) {
      const refs = parseJson<number[]>(s.upload_refs, []);
      if (refs.includes(id)) {
        ctx.db.prepare('UPDATE scenes SET upload_refs = ? WHERE id = ?').run(JSON.stringify(refs.filter((r) => r !== id)), s.id);
        emitScene(ctx, s.id, s.project_id);
      }
    }
    ctx.afterCommit(() => {
      try {
        const rel = cleanRelPath(ref.file_path, ['refs']);
        fs.rmSync(path.join(ctx.config.rootDir, rel), { force: true });
      } catch {
        /* file lạ hoặc đã mất: bỏ qua */
      }
    });
  });
}

/** Sắp xếp lại ảnh tham chiếu: `ids` phải đúng bằng tập ảnh của dự án. */
export function reorderRefs(ctx: AppContext, projectId: number, ids: number[]): RefRow[] {
  return ctx.tx(() => {
    getProject(ctx, projectId);
    const current = projectRefs(ctx, projectId).map((r) => r.id);
    const same = ids.length === current.length && new Set(ids).size === ids.length && ids.every((i) => current.includes(i));
    if (!same) throw badRequest('INVALID_REFS', 'Danh sách ids phải gồm đúng tất cả ảnh tham chiếu của dự án');
    ids.forEach((id, idx) => ctx.db.prepare('UPDATE project_refs SET order_index = ? WHERE id = ?').run(idx, id));
    emitProject(ctx, projectId);
    return projectRefs(ctx, projectId);
  });
}

// ------------------------------------------------------------------ thư viện ảnh dùng lại giữa các dự án

export interface RefLibraryItem {
  ref_id: number;
  file_path: string;
  url: string;
  label: string;
  original_name: string | null;
  content_hash: string;
  created_at: string;
  projects: { id: number; name: string }[];
  in_project: boolean;
}

/**
 * Mỗi ảnh DUY NHẤT theo `content_hash` (gộp các bản ghi trùng nội dung ở nhiều dự án), mới nhất trước.
 * `ref_id`/`file_path`/`label` lấy từ bản ghi mới nhất còn file; ảnh mà mọi bản ghi đều mất file bị bỏ.
 * `in_project`: dự án `projectId` đã có ảnh cùng hash (false khi không truyền projectId).
 */
export function refLibrary(ctx: AppContext, projectId?: number, opts: { source?: ProjectSource } = {}): RefLibraryItem[] {
  if (projectId !== undefined) getProject(ctx, projectId);
  backfillRefHashes(ctx);
  // opts.source: chỉ ảnh của các dự án nguồn đó (trang LAN chỉ thấy thư viện của dự án 'lan', không thấy ảnh của app chính).
  const rows = ctx.db
    .prepare(
      `SELECT r.*, p.name AS project_name FROM project_refs r JOIN projects p ON p.id = r.project_id
       WHERE r.content_hash IS NOT NULL AND p.deleted_at IS NULL ${opts.source ? 'AND p.source = ?' : ''} ORDER BY r.created_at DESC, r.id DESC`,
    )
    .all(...(opts.source ? [opts.source] : [])) as (RefRow & { project_name: string })[];
  const mine = new Set<string>();
  if (projectId !== undefined) {
    for (const r of ctx.db.prepare('SELECT content_hash FROM project_refs WHERE project_id = ? AND content_hash IS NOT NULL').all(projectId) as {
      content_hash: string;
    }[]) {
      mine.add(r.content_hash);
    }
  }
  const groups = new Map<string, { chosen: RefRow | null; projects: Map<number, string> }>();
  for (const r of rows) {
    const hash = r.content_hash as string;
    let g = groups.get(hash);
    if (!g) {
      g = { chosen: null, projects: new Map() };
      groups.set(hash, g);
    }
    if (!g.projects.has(r.project_id)) g.projects.set(r.project_id, r.project_name);
    if (!g.chosen && refFileExists(ctx, r)) g.chosen = r; // rows đã sắp mới nhất trước
  }
  const items: RefLibraryItem[] = [];
  for (const [hash, g] of groups) {
    if (!g.chosen) continue;
    const c = g.chosen;
    items.push({
      ref_id: c.id,
      file_path: c.file_path,
      url: refFileUrl(c.file_path),
      label: c.label,
      original_name: c.original_name,
      content_hash: hash,
      created_at: c.created_at,
      projects: [...g.projects].map(([id, name]) => ({ id, name })),
      in_project: mine.has(hash),
    });
  }
  return items.sort((a, b) => (a.created_at === b.created_at ? b.ref_id - a.ref_id : a.created_at < b.created_at ? 1 : -1));
}

const refFileUrl = (filePath: string): string => '/files/' + filePath.split('/').map(encodeURIComponent).join('/');

function refSourceFile(ctx: AppContext, ref: RefRow): string | null {
  try {
    return resolveInside(ctx.config.rootDir, cleanRelPath(ref.file_path, ['refs']), ['refs']);
  } catch {
    return null;
  }
}
const refFileExists = (ctx: AppContext, ref: RefRow): boolean => refSourceFile(ctx, ref) !== null;

/**
 * Thêm ảnh từ thư viện (ref của dự án khác) vào dự án: CHÉP file qua `storeRef` (làm sạch tên, chống trùng tên),
 * giữ nhãn nguồn (hoặc `labels[ref_id]`), nối vào cuối theo thứ tự `refIds`. Dự án đã có ảnh cùng `content_hash` thì
 * không chép mà trả lại ref sẵn có. Tất-cả-hoặc-không về dữ liệu DB: ref nguồn không tồn tại → 404, file nguồn mất → 409 FILE_MISSING.
 */
export function addRefsFromLibrary(
  ctx: AppContext,
  projectId: number,
  refIds: number[],
  labels: Record<string, string> = {},
  opts: { sourceProjectSource?: ProjectSource; maxRefs?: number } = {},
): RefRow[] {
  return ctx.tx(() => {
    getProject(ctx, projectId);
    const sources = refIds.map((id) => getRef(ctx, id)); // 404 nếu có id không tồn tại
    if (opts.sourceProjectSource) {
      // Trang LAN chỉ được lấy ảnh từ dự án 'lan'; ảnh của dự án khác trả 404 như thể không tồn tại (không lộ id).
      for (const src of sources) {
        if (getProject(ctx, src.project_id).source !== opts.sourceProjectSource) throw notFound('ảnh tham chiếu');
      }
    }
    const have = new Map<string, RefRow>(); // content_hash -> ref sẵn có trong dự án
    for (const r of projectRefs(ctx, projectId)) if (r.content_hash && !have.has(r.content_hash)) have.set(r.content_hash, r);

    // Lượt 1: đọc và kiểm tra hết file nguồn trước khi ghi bất cứ thứ gì
    const plan = sources.map((src) => {
      const abs = refSourceFile(ctx, src);
      let buf: Buffer | null = null;
      let hash = src.content_hash;
      if (abs) {
        buf = fs.readFileSync(abs);
        hash = hashBuffer(buf);
      }
      if (!hash || !buf) {
        if (hash && have.has(hash)) return { src, buf: null, hash, type: null };
        throw conflict('FILE_MISSING', `File nguồn của ảnh "${src.label}" (#${src.id}) không còn tồn tại`);
      }
      const type = detectImageType(buf);
      if (!type) throw conflict('FILE_MISSING', `File nguồn của ảnh "${src.label}" (#${src.id}) không phải ảnh png/jpg/webp hợp lệ`);
      return { src, buf, hash, type };
    });

    if (opts.maxRefs !== undefined) {
      const fresh = new Set<string>();
      for (const p of plan) if (p.hash && !have.has(p.hash)) fresh.add(p.hash);
      if (projectRefs(ctx, projectId).length + fresh.size > opts.maxRefs) {
        throw new AppError('TOO_MANY_REFS', `Mỗi kế hoạch chỉ có tối đa ${opts.maxRefs} ảnh tham chiếu`, 409);
      }
    }

    // Lượt 2: chép (hoặc dùng lại ref đã có cùng hash)
    return plan.map(({ src, buf, hash, type }) => {
      const existing = hash ? have.get(hash) : undefined;
      if (existing) return existing;
      let name = src.original_name || path.basename(src.file_path);
      try {
        sanitizeBaseName(name);
      } catch {
        name = path.basename(src.file_path);
      }
      const label = (labels[String(src.id)] ?? '').trim() || src.label;
      const ref = storeRef(ctx, projectId, name, buf as Buffer, type as ImageType, label);
      have.set(hashBuffer(buf as Buffer), ref);
      return ref;
    });
  });
}
