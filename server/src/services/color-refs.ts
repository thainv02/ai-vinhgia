/**
 * Ảnh mẫu / file LUT của dự án (bảng `color_refs`, migration 013) cho "màu theo ảnh mẫu" (`Grade.match`).
 * File nằm ở `output/<slug>/final/color-refs/` (đi theo thư mục dự án vào/ra thùng rác; xoá vĩnh viễn dự án xoá luôn dòng nhờ ON DELETE CASCADE).
 * Dùng chung cho app chính và LAN (LAN chỉ thêm giới hạn tốc độ, URL qua `/lan/files` và allowlist file). Quy tắc:
 * - ảnh: nhận bằng magic bytes (png/jpg/webp), ffprobe phải đọc được, ≤ 15 MB; sinh thumb jpg 256px;
 * - .cube: đọc chặt (`parseCube`), server GHI LẠI bản chuẩn hoá, không lưu và không bao giờ phục vụ file gốc;
 * - chống trùng theo `content_hash` trong dự án (tải lại cùng nội dung → trả dòng cũ);
 * - xoá: chỉ khi chưa phiên bản nào dùng (`409 COLOR_REF_IN_USE`).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { AssetRow, ColorRefRow, ProjectRow, RefRow } from '../db/types.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { parseCube, writeCube } from './color-lut.js';
import { LAN_UPLOAD_SOURCE } from './lan-common.js';
import { ffmpegOf, probeMedia } from './media.js';
import { detectImageType, hashBuffer, type ImageType } from './refs.js';
import { getProject, logEvent, parseJson, projectRefs } from './repo.js';

export const THUMB_EDGE = 256;
/** Cạnh dài tối đa của ảnh mẫu (ảnh khổng lồ chỉ tốn thời gian giải mã). */
export const COLOR_IMAGE_MAX_EDGE = 16384;

/** Thân `POST .../color-refs/from-asset`: đúng một trong `asset_id` (storyboard) hoặc `ref_id` (ảnh tham chiếu). */
export const fromSourceBody = z
  .object({ asset_id: z.number().int().positive().optional(), ref_id: z.number().int().positive().optional() })
  .refine((b) => (b.asset_id === undefined) !== (b.ref_id === undefined), { message: 'cần đúng một trong asset_id hoặc ref_id' });

export const colorRefsDir = (slug: string): string => `output/${slug}/final/color-refs`;

export function getColorRef(ctx: AppContext, project: ProjectRow, id: number): ColorRefRow {
  const row = ctx.db.prepare('SELECT * FROM color_refs WHERE id = ? AND project_id = ?').get(id, project.id) as ColorRefRow | undefined;
  if (!row) throw notFound('ảnh mẫu / file LUT');
  return row;
}

export function listColorRefRows(ctx: AppContext, projectId: number): ColorRefRow[] {
  return ctx.db.prepare('SELECT * FROM color_refs WHERE project_id = ? ORDER BY id DESC').all(projectId) as ColorRefRow[];
}

/** id → loại của mọi ảnh mẫu/LUT của dự án (để `normalizeGrade` kiểm tra `match.ref_id` thuộc dự án). */
export function colorRefKinds(ctx: AppContext, projectId: number): Map<number, 'image' | 'lut'> {
  const m = new Map<number, 'image' | 'lut'>();
  for (const r of ctx.db.prepare('SELECT id, kind FROM color_refs WHERE project_id = ?').all(projectId) as { id: number; kind: 'image' | 'lut' }[]) m.set(r.id, r.kind);
  return m;
}

/** Số phiên bản (version) của dự án có `grade.match.ref_id` = id, theo thứ tự tăng dần. */
export function versionsUsingColorRef(ctx: AppContext, projectId: number, refId: number): number[] {
  return (
    ctx.db
      .prepare("SELECT version FROM final_cuts WHERE project_id = ? AND grade IS NOT NULL AND json_valid(grade) AND json_extract(grade, '$.match.ref_id') = ? ORDER BY version")
      .all(projectId, refId) as { version: number }[]
  ).map((r) => r.version);
}

export interface ColorRefJson {
  id: number;
  kind: 'image' | 'lut';
  original_name: string | null;
  /** Ảnh thu nhỏ và ảnh gốc (chỉ loại `image`; LUT không có URL nào). */
  thumb_url: string | null;
  image_url: string | null;
  width: number | null;
  height: number | null;
  lut_size: number | null;
  created_by_name: string | null;
  created_at: string;
  /** Các version của bản dựng đang dùng (có thì không xoá được). */
  used_by: number[];
}

export function colorRefJson(ctx: AppContext, r: ColorRefRow, urlOf: (rel: string) => string): ColorRefJson {
  const image = r.kind === 'image';
  return {
    id: r.id,
    kind: r.kind,
    original_name: r.original_name,
    thumb_url: image && r.thumb_path ? urlOf(r.thumb_path) : null,
    image_url: image ? urlOf(r.file_path) : null,
    width: r.width,
    height: r.height,
    lut_size: r.lut_size,
    created_by_name: r.created_by_name,
    created_at: r.created_at,
    used_by: versionsUsingColorRef(ctx, r.project_id, r.id),
  };
}

/** Rút gọn cho bản dựng: ảnh mẫu đang dùng (để lịch sử hiện chip có thumbnail). */
export function colorRefOfGrade(ctx: AppContext, projectId: number, refId: number | undefined, urlOf: (rel: string) => string): { id: number; kind: 'image' | 'lut'; original_name: string | null; thumb_url: string | null } | null {
  if (!refId) return null;
  const r = ctx.db.prepare('SELECT * FROM color_refs WHERE id = ? AND project_id = ?').get(refId, projectId) as ColorRefRow | undefined;
  if (!r) return null;
  return { id: r.id, kind: r.kind, original_name: r.original_name, thumb_url: r.kind === 'image' && r.thumb_path ? urlOf(r.thumb_path) : null };
}

// ------------------------------------------------------------------ nguồn có sẵn trong dự án (để chép sang color_refs)

export interface ColorRefSources {
  refs: { id: number; label: string; url: string }[];
  assets: { id: number; scene_code: string; url: string }[];
}

/**
 * Ảnh có sẵn của dự án có thể dùng làm ảnh mẫu: ảnh tham chiếu (`project_refs`) và storyboard (mỗi cảnh một ảnh mới nhất).
 * `lanOnly`: trang LAN chỉ thấy storyboard do CHÍNH người dùng LAN tải lên (khớp allowlist `/lan/files`).
 */
export function colorRefSources(ctx: AppContext, project: ProjectRow, urlOf: (rel: string) => string, opts: { lanOnly?: boolean } = {}): ColorRefSources {
  const refs = projectRefs(ctx, project.id)
    .filter((r) => fs.existsSync(path.join(ctx.config.rootDir, r.file_path)))
    .map((r) => ({ id: r.id, label: r.label, url: urlOf(r.file_path) }));
  const rows = ctx.db
    .prepare(
      `SELECT a.*, s.code AS scene_code FROM assets a JOIN scenes s ON s.id = a.scene_id
       WHERE s.project_id = ? AND a.kind = 'storyboard' ORDER BY s.order_index, a.attempt DESC, a.id DESC`,
    )
    .all(project.id) as (AssetRow & { scene_code: string })[];
  const seen = new Set<number>();
  const assets: ColorRefSources['assets'] = [];
  for (const a of rows) {
    if (seen.has(a.scene_id)) continue;
    if (opts.lanOnly && parseJson<{ source?: string }>(a.meta, {}).source !== LAN_UPLOAD_SOURCE) continue;
    if (!fs.existsSync(path.join(ctx.config.rootDir, a.file_path))) continue;
    seen.add(a.scene_id);
    assets.push({ id: a.id, scene_code: a.scene_code, url: urlOf(a.file_path) });
  }
  return { refs, assets };
}

// ------------------------------------------------------------------ thêm

function execFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, _o, stderr) => {
      if (err) return reject(new Error(String(stderr).trim().split('\n').slice(-2).join(' | ') || err.message));
      resolve();
    });
  });
}

/** Ghi file mới (tên theo nội dung) KHÔNG ghi đè: có sẵn rồi thì giữ nguyên. Ghi tạm rồi đổi tên nguyên tử. */
function writeOnce(abs: string, data: Buffer | string): void {
  if (fs.existsSync(abs)) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'w' });
  try {
    fs.linkSync(tmp, abs); // link thất bại (đã có) → giữ bản có sẵn
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  fs.rmSync(tmp, { force: true });
}

export interface AddColorRefResult {
  row: ColorRefRow;
  /** false = dự án đã có đúng nội dung này (không tạo mới). */
  created: boolean;
}

/**
 * Thêm ảnh mẫu (`type` png/jpg/webp) hoặc file LUT (`type='cube'`) vào dự án. Kiểm tra ĐỦ trước khi ghi gì (ảnh: ffprobe đọc được và tạo được thumb;
 * LUT: `parseCube` chặt), ghi file theo hash nội dung, rồi thêm dòng. Trùng nội dung trong dự án → trả dòng cũ (`created=false`).
 */
export async function addColorRef(
  ctx: AppContext,
  project: ProjectRow,
  input: { originalName: string; buf: Buffer; type: ImageType | 'cube'; createdByName?: string | null },
): Promise<AddColorRefResult> {
  const done = ctx.beginProjectUpload(project.id); // đang ghi file vào output/<slug>/: không cho chuyển thư mục vào thùng rác
  const written: string[] = [];
  try {
    getProject(ctx, project.id);
    const existingBy = (hash: string) => ctx.db.prepare('SELECT * FROM color_refs WHERE project_id = ? AND content_hash = ?').get(project.id, hash) as ColorRefRow | undefined;
    const dirRel = colorRefsDir(project.slug);
    const name = input.originalName.slice(0, 200) || null;
    let row: Omit<ColorRefRow, 'id' | 'created_at'>;
    if (input.type === 'cube') {
      const lut = parseCube(input.buf.toString('utf8')); // 400 INVALID_LUT nếu sai
      const text = writeCube(lut, 'autovideo LUT'); // tiêu đề cố định: hash chỉ phụ thuộc DỮ LIỆU LUT (tên file gốc nằm ở original_name)
      const hash = hashBuffer(Buffer.from(text));
      const dup = existingBy(hash);
      if (dup) return { row: dup, created: false };
      const rel = `${dirRel}/${hash.slice(0, 16)}.cube`;
      if (!fs.existsSync(path.join(ctx.config.rootDir, rel))) written.push(path.join(ctx.config.rootDir, rel));
      writeOnce(path.join(ctx.config.rootDir, rel), text);
      row = { project_id: project.id, kind: 'lut', file_path: rel, thumb_path: null, original_name: name, content_hash: hash, width: null, height: null, lut_size: lut.size, created_by_name: input.createdByName ?? null };
    } else {
      const hash = hashBuffer(input.buf);
      const dup = existingBy(hash);
      if (dup) return { row: dup, created: false };
      const bin = ffmpegOf(ctx.config);
      if (!bin) throw conflict('FFMPEG_UNAVAILABLE', 'Không tìm thấy ffmpeg để xử lý ảnh mẫu');
      const rel = `${dirRel}/${hash.slice(0, 16)}.${input.type}`;
      const thumbRel = `${dirRel}/${hash.slice(0, 16)}_thumb.jpg`;
      const abs = path.join(ctx.config.rootDir, rel);
      const thumbAbs = path.join(ctx.config.rootDir, thumbRel);
      if (!fs.existsSync(abs)) written.push(abs);
      writeOnce(abs, input.buf);
      const info = probeMedia(ctx.config, abs);
      if (!info?.width || !info.height) throw new AppError('INVALID_IMAGE', 'ffprobe không đọc được ảnh này (file hỏng hoặc không phải ảnh hợp lệ)', 400);
      if (Math.max(info.width, info.height) > COLOR_IMAGE_MAX_EDGE) throw new AppError('INVALID_IMAGE', `Ảnh quá lớn (cạnh dài tối đa ${COLOR_IMAGE_MAX_EDGE}px)`, 400);
      if (!fs.existsSync(thumbAbs)) {
        written.push(thumbAbs);
        const tmp = `${thumbAbs}.${process.pid}.tmp.jpg`;
        try {
          await execFfmpeg(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-vf', `scale=${THUMB_EDGE}:${THUMB_EDGE}:force_original_aspect_ratio=decrease:flags=area`, '-frames:v', '1', '-q:v', '4', '-f', 'image2', tmp]);
          fs.renameSync(tmp, thumbAbs);
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          throw new AppError('INVALID_IMAGE', `Không tạo được ảnh thu nhỏ (${err instanceof Error ? err.message.slice(0, 120) : 'lỗi ffmpeg'})`, 400);
        }
      }
      row = { project_id: project.id, kind: 'image', file_path: rel, thumb_path: thumbRel, original_name: name, content_hash: hash, width: info.width, height: info.height, lut_size: null, created_by_name: input.createdByName ?? null };
    }
    const created = ctx.tx(() => {
      getProject(ctx, project.id);
      const dup = existingBy(row.content_hash);
      if (dup) return { row: dup, created: false };
      const info = ctx.db
        .prepare(
          `INSERT INTO color_refs (project_id, kind, file_path, thumb_path, original_name, content_hash, width, height, lut_size, created_by_name, created_at)
           VALUES (@project_id, @kind, @file_path, @thumb_path, @original_name, @content_hash, @width, @height, @lut_size, @created_by_name, @created_at)`,
        )
        .run({ ...row, created_at: ctx.now() });
      logEvent(ctx, { project_id: project.id, type: 'color_ref.added', message: `Thêm ${row.kind === 'lut' ? 'file LUT' : 'ảnh mẫu màu'} «${(row.original_name ?? '').slice(0, 60)}»` });
      return { row: ctx.db.prepare('SELECT * FROM color_refs WHERE id = ?').get(Number(info.lastInsertRowid)) as ColorRefRow, created: true };
    });
    return created;
  } catch (err) {
    for (const f of written) fs.rmSync(f, { force: true });
    throw err;
  } finally {
    done();
  }
}

/** Đọc file của `project_refs` hoặc storyboard của dự án và thêm vào `color_refs` (chép, không dùng chung đường dẫn). */
export async function addColorRefFromSource(
  ctx: AppContext,
  project: ProjectRow,
  src: { ref_id?: number; asset_id?: number },
  opts: { lanOnly?: boolean; createdByName?: string | null } = {},
): Promise<AddColorRefResult> {
  let rel: string;
  let name: string;
  if (src.ref_id !== undefined) {
    const ref = ctx.db.prepare('SELECT * FROM project_refs WHERE id = ? AND project_id = ?').get(src.ref_id, project.id) as RefRow | undefined;
    if (!ref) throw notFound('ảnh tham chiếu');
    rel = ref.file_path;
    name = ref.original_name || path.basename(ref.file_path);
  } else if (src.asset_id !== undefined) {
    const a = ctx.db
      .prepare("SELECT a.* FROM assets a JOIN scenes s ON s.id = a.scene_id WHERE a.id = ? AND s.project_id = ? AND a.kind = 'storyboard'")
      .get(src.asset_id, project.id) as AssetRow | undefined;
    if (!a || (opts.lanOnly && parseJson<{ source?: string }>(a.meta, {}).source !== LAN_UPLOAD_SOURCE)) throw notFound('ảnh storyboard');
    rel = a.file_path;
    name = path.basename(a.file_path);
  } else {
    throw badRequest('VALIDATION_ERROR', 'Cần ref_id hoặc asset_id');
  }
  let abs: string | null = null;
  try {
    abs = resolveInside(ctx.config.rootDir, cleanRelPath(rel, ['refs', 'output']), ['refs', 'output']);
  } catch {
    abs = null;
  }
  if (!abs) throw conflict('FILE_MISSING', 'File ảnh nguồn không còn tồn tại');
  const buf = fs.readFileSync(abs);
  const type = detectImageType(buf);
  if (!type) throw conflict('FILE_MISSING', 'File nguồn không phải ảnh png/jpg/webp hợp lệ');
  return addColorRef(ctx, project, { originalName: name, buf, type, createdByName: opts.createdByName });
}

// ------------------------------------------------------------------ xoá

/** Xoá ảnh mẫu/LUT (dòng + file + thumb) khi chưa phiên bản nào dùng; đang dùng → 409 COLOR_REF_IN_USE. LUT sinh ra trong `luts/` tự dọn theo hash, không cần xoá ở đây. */
export function deleteColorRef(ctx: AppContext, project: ProjectRow, id: number): void {
  ctx.tx(() => {
    const row = getColorRef(ctx, project, id);
    const used = versionsUsingColorRef(ctx, project.id, id);
    if (used.length) {
      throw conflict('COLOR_REF_IN_USE', `Đang được dùng bởi ${used.map((v) => `v${v}`).join(', ')} nên chưa xoá được`);
    }
    ctx.db.prepare('DELETE FROM color_refs WHERE id = ?').run(id);
    logEvent(ctx, { project_id: project.id, type: 'color_ref.deleted', message: `Xoá ${row.kind === 'lut' ? 'file LUT' : 'ảnh mẫu màu'} «${(row.original_name ?? '').slice(0, 60)}»` });
    ctx.afterCommit(() => {
      for (const rel of [row.file_path, row.thumb_path]) {
        if (!rel) continue;
        try {
          fs.rmSync(path.join(ctx.config.rootDir, cleanRelPath(rel, ['output'])), { force: true });
        } catch {
          /* file lạ hoặc đã mất */
        }
      }
    });
  });
}

/** `GET .../color-refs`: ảnh mẫu / LUT đã tải (mới nhất trước) và các ảnh có sẵn của dự án để chọn làm ảnh mẫu. */
export function colorRefsListJson(ctx: AppContext, project: ProjectRow, urlOf: (rel: string) => string, opts: { lanOnly?: boolean } = {}) {
  return {
    items: listColorRefRows(ctx, project.id).map((r) => colorRefJson(ctx, r, urlOf)),
    sources: colorRefSources(ctx, project, urlOf, opts),
  };
}
