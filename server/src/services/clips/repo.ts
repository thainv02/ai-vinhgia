/**
 * Truy cập dữ liệu dự án cắt clip: getter (404 nếu không có / dự án vào thùng rác / không phải dự án `clips`), đường dẫn file, đọc transcript (có cache).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import type { ClipCutRow, ClipRow, ProjectRow, SourceVideoRow } from '../../db/types.js';
import { notFound } from '../../lib/errors.js';
import { getProject, parseJson } from '../repo.js';
import type { Transcript } from './transcript.js';

// ---------------------------------------------------------------- đường dẫn

export const clipsDirRel = (slug: string): string => `output/${slug}/clips`;
export const sourceDirRel = (slug: string): string => `${clipsDirRel(slug)}/source`;
export const transcriptRel = (slug: string): string => `${clipsDirRel(slug)}/transcript.json`;
export const thumbsDirRel = (slug: string): string => `${clipsDirRel(slug)}/thumbs`;
export const cutsDirRel = (slug: string): string => `${clipsDirRel(slug)}/clips`;
export const previewRel = (slug: string): string => `${sourceDirRel(slug)}/preview_480p.mp4`;
export const posterRel = (slug: string): string => `${thumbsDirRel(slug)}/poster.jpg`;
export const thumbRel = (slug: string, code: string): string => `${thumbsDirRel(slug)}/${code}.jpg`;
export const abs = (ctx: AppContext, rel: string): string => path.join(ctx.config.rootDir, rel);
export const exists = (ctx: AppContext, rel: string | null | undefined): boolean => !!rel && fs.existsSync(abs(ctx, rel));

// ---------------------------------------------------------------- getter

/** Dự án cắt clip (kind='clips', chưa vào thùng rác). Dự án kind khác → 404 như không tồn tại. */
export function getClipProject(ctx: AppContext, id: number): ProjectRow {
  const p = getProject(ctx, id);
  if (p.kind !== 'clips') throw notFound('dự án cắt clip');
  return p;
}

export function getSourceRow(ctx: AppContext, id: number): SourceVideoRow {
  const row = ctx.db
    .prepare("SELECT s.* FROM source_videos s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.deleted_at IS NULL AND p.kind = 'clips'")
    .get(id) as SourceVideoRow | undefined;
  if (!row) throw notFound('video nguồn');
  return row;
}

export function projectSource(ctx: AppContext, projectId: number): SourceVideoRow | undefined {
  return ctx.db.prepare('SELECT * FROM source_videos WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId) as SourceVideoRow | undefined;
}

export function getClipRow(ctx: AppContext, id: number): ClipRow {
  const row = ctx.db
    .prepare("SELECT c.* FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL AND p.kind = 'clips'")
    .get(id) as ClipRow | undefined;
  if (!row) throw notFound('clip');
  return row;
}

export function getCutRow(ctx: AppContext, id: number): ClipCutRow {
  const row = ctx.db
    .prepare("SELECT c.* FROM clip_cuts c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.deleted_at IS NULL AND p.kind = 'clips'")
    .get(id) as ClipCutRow | undefined;
  if (!row) throw notFound('bản dựng clip');
  return row;
}

export function latestCut(ctx: AppContext, clipId: number): ClipCutRow | undefined {
  return ctx.db.prepare('SELECT * FROM clip_cuts WHERE clip_id = ? ORDER BY version DESC LIMIT 1').get(clipId) as ClipCutRow | undefined;
}

export function projectClips(ctx: AppContext, projectId: number): ClipRow[] {
  return ctx.db.prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY id').all(projectId) as ClipRow[];
}

// ---------------------------------------------------------------- transcript (cache theo đường dẫn + mtime)

const cache = new Map<string, { mtimeMs: number; size: number; data: Transcript }>();
const CACHE_MAX = 4;

/** Đọc `transcript.json` của video nguồn; null nếu chưa có/hỏng. Kết quả được nhớ lại theo (đường dẫn, mtime, kích thước). */
export function readTranscript(ctx: AppContext, source: Pick<SourceVideoRow, 'transcript_path'>): Transcript | null {
  if (!source.transcript_path) return null;
  const file = abs(ctx, source.transcript_path);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  const data = parseJson<Transcript | null>(fs.readFileSync(file, 'utf8'), null);
  if (!data || !Array.isArray(data.words) || !Array.isArray(data.sentences)) return null;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

/** Quên cache (khi ghi đè/xoá transcript). */
export function forgetTranscript(ctx: AppContext, rel: string | null): void {
  if (rel) cache.delete(abs(ctx, rel));
}
