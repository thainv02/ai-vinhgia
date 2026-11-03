/** Truy vấn dùng chung của Video HTML: kiểu dòng DB và các getter (dự án kind='html', chưa vào thùng rác). */
import type { AppContext } from '../../context.js';
import type { ProjectRow } from '../../db/types.js';
import { notFound } from '../../lib/errors.js';
import type { HtmlAspect, HtmlQuality, HtmlVersionStatus } from './view.js';

export interface HtmlMetaRow {
  project_id: number;
  aspect: HtmlAspect;
  duration_s: number;
  quality: HtmlQuality;
  template_id: string | null;
  model_json: string;
  created_at: string;
}

export interface HtmlAssetRow {
  id: number;
  project_id: number;
  original_name: string;
  stored_path: string;
  content_hash: string;
  kind: 'image' | 'video' | 'audio';
  media_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  has_audio: 0 | 1 | null;
  description_json?: string | null;
  scan_error_code?: string | null;
  manual_label?: string | null;
  label_confirmed?: number;
  created_at: string;
}

export interface HtmlVersionRow {
  id: number;
  project_id: number;
  version: number;
  parent_id: number | null;
  compose_job_id: number | null;
  status: HtmlVersionStatus;
  prompt: string;
  feedback: string | null;
  summary: string | null;
  variables_json: string;
  manifest_json: string;
  files_dir: string | null;
  voice_json?: string | null;
  is_segmented?: number;
  segment_owner_id?: number | null;
  content_hash: string | null;
  lint_report_json: string | null;
  compose_policy_json: string;
  error: string | null;
  error_code: string | null;
  created_by: 'ai' | 'user';
  idempotency_key: string | null;
  created_at: string;
  published_at: string | null;
}

export interface HtmlVersionAssetRow {
  version_id: number;
  asset_id: number;
  stored_path: string;
  content_hash: string;
  snapshot_path: string | null;
}

/** Dự án Video HTML (kind='html', chưa xoá). Dự án loại khác → 404 như không tồn tại. */
export function getHtmlProject(ctx: AppContext, id: number): ProjectRow {
  const p = ctx.db.prepare("SELECT * FROM projects WHERE id = ? AND kind = 'html' AND deleted_at IS NULL").get(id) as ProjectRow | undefined;
  if (!p) throw notFound('dự án Video HTML');
  return p;
}

export function projectMeta(ctx: AppContext, projectId: number): HtmlMetaRow {
  const m = ctx.db.prepare('SELECT * FROM html_project_meta WHERE project_id = ?').get(projectId) as HtmlMetaRow | undefined;
  if (!m) throw notFound('cấu hình dự án Video HTML');
  return m;
}

export function projectAssets(ctx: AppContext, projectId: number): HtmlAssetRow[] {
  return ctx.db.prepare('SELECT * FROM html_assets WHERE project_id = ? ORDER BY id').all(projectId) as HtmlAssetRow[];
}

export function getHtmlAsset(ctx: AppContext, projectId: number, assetId: number): HtmlAssetRow {
  const a = ctx.db.prepare('SELECT * FROM html_assets WHERE id = ? AND project_id = ?').get(assetId, projectId) as HtmlAssetRow | undefined;
  if (!a) throw notFound('asset');
  return a;
}

export function getVersionById(ctx: AppContext, id: number): HtmlVersionRow {
  const v = ctx.db.prepare('SELECT * FROM html_versions WHERE id = ?').get(id) as HtmlVersionRow | undefined;
  if (!v) throw notFound('phiên bản');
  return v;
}

/** Phiên bản theo SỐ phiên bản trong dự án. */
export function getVersion(ctx: AppContext, projectId: number, n: number): HtmlVersionRow {
  const v = ctx.db.prepare('SELECT * FROM html_versions WHERE project_id = ? AND version = ? AND segment_owner_id IS NULL').get(projectId, n) as HtmlVersionRow | undefined;
  if (!v) throw notFound('phiên bản');
  return v;
}

export const versionNumber = (ctx: AppContext, id: number): number | null =>
  (ctx.db.prepare('SELECT version FROM html_versions WHERE id = ?').get(id) as { version: number } | undefined)?.version ?? null;

export const listVersionAssets = (ctx: AppContext, versionId: number): HtmlVersionAssetRow[] =>
  ctx.db.prepare('SELECT version_id, asset_ref AS asset_id, stored_path, content_hash, snapshot_path FROM html_version_assets WHERE version_id = ? ORDER BY asset_ref').all(versionId) as HtmlVersionAssetRow[];

/** Phiên bản của một job html_compose (null nếu không có). */
export const versionOfJob = (ctx: AppContext, jobId: number): HtmlVersionRow | undefined =>
  ctx.db.prepare('SELECT * FROM html_versions WHERE compose_job_id = ?').get(jobId) as HtmlVersionRow | undefined;

/** Id các asset gắn với phiên bản (để kiểm tra biến loại asset). */
export const versionAssetIds = (ctx: AppContext, versionId: number): Set<number> => new Set(listVersionAssets(ctx, versionId).map((a) => a.asset_id));
