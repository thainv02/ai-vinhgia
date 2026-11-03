/**
 * Kiểu dữ liệu trả ra cho API Video HTML (desktop) — xem server/API.md mục 15. Mọi thời gian là ISO 8601 UTC.
 */
import type { AppContext } from '../../context.js';
import { aiQueueInfoById, type AiQueueInfo } from '../job-queue.js';
import type { JobRow, ProjectRow } from '../../db/types.js';
import { parseJson } from '../repo.js';
import type { HtmlAssetRow, HtmlMetaRow, HtmlVersionRow } from './repo.js';
import { listVersionAssets, projectMeta, versionNumber } from './repo.js';
import { aspectSize } from './config.js';
import { latestRenders, type HtmlRenderView } from './render.js';
import { listSegments } from './segments.js';

export type HtmlAspect = '9:16' | '1:1' | '16:9';
export type HtmlQuality = '720p' | '1080p';
export type HtmlVersionStatus = 'composing' | 'validating' | 'ready' | 'failed' | 'cancelled';
export type HtmlVariableType = 'text' | 'color' | 'asset';

export interface HtmlModelChoice {
  /** ID model cụ thể hoặc 'auto' (Tự chọn phù hợp). */
  compose: string;
  vision: string;
}

export interface HtmlVariable {
  /** Định danh ổn định (a-z, 0-9, `_`, `-`); là giá trị của `data-hf-var` trong HTML và đuôi của biến CSS `--hf-<id>`. */
  id: string;
  type: HtmlVariableType;
  label: string;
  /** text: chuỗi; color: `#rrggbb`; asset: id asset (số, dạng chuỗi). */
  value: string;
  /** `data-hf-var` của phần tử bị thay đổi (thường trùng `id`). Với `color` chỉ để hiển thị. */
  target: string;
  maxLength?: number;
}

export interface LintIssue {
  code: string;
  message: string;
  file?: string;
}
export interface LintReport {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
  /** Tên các bước đã chạy (vd 'manifest', 'paths', 'lint', 'capture', 'vision'). */
  checks: string[];
}

export interface HtmlAssetView {
  id: number;
  name: string;
  kind: 'image' | 'video' | 'audio';
  media_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  has_audio: boolean | null;
  /** Đường dẫn AI/HTML dùng trong phiên bản: `assets/u/<id>.<ext>`. */
  path: string;
  /** URL tải/xem asset gốc (cùng listener). */
  url: string;
  created_at: string;
  description?: { summary: string; text: string; details: string; uncertain: boolean } | null;
  scan_error_code?: string | null;
  manual_label?: string | null;
  label_confirmed?: boolean;
}

export interface HtmlFileView {
  path: string;
  bytes: number;
  sha256: string;
}

export interface HtmlJobBrief {
  id: number;
  status: JobRow['status'];
  error: string | null;
  error_code: string | null;
  queue: AiQueueInfo | null;
}

export interface HtmlVersionView {
  segments?: {idx:number;start_s:number;end_s:number;status:string;error:string|null;summary:string|null;variables:HtmlVariable[]}[];
  segments_ready?:number;
  id: number;
  project_id: number;
  /** Số phiên bản trong dự án (1, 2, …), không bao giờ tái sử dụng. */
  version: number;
  parent_version: number | null;
  status: HtmlVersionStatus;
  created_by: 'ai' | 'user';
  prompt: string;
  feedback: string | null;
  summary: string | null;
  variables: HtmlVariable[];
  files: HtmlFileView[];
  assets: { asset_id: number; path: string; content_hash: string }[];
  content_hash: string | null;
  lint_report: LintReport | null;
  policy: { compose: string; vision: string };
  error: string | null;
  error_code: string | null;
  job: HtmlJobBrief | null;
  /** Bản dựng MP4 mới nhất của từng chất lượng. */
  renders?: HtmlRenderView[];
  created_at: string;
  published_at: string | null;
}

export interface HtmlVersionBrief {
  id: number;
  version: number;
  status: HtmlVersionStatus;
  created_by: 'ai' | 'user';
  summary: string | null;
  created_at: string;
  published_at: string | null;
}

export interface HtmlProjectView {
  id: number;
  kind: 'html';
  slug: string;
  name: string;
  brief: string;
  aspect: HtmlAspect;
  width: number;
  height: number;
  fps: 30;
  duration_s: number;
  quality: HtmlQuality;
  template_id: string | null;
  model: HtmlModelChoice;
  asset_count: number;
  asset_bytes: number;
  version_count: number;
  latest_version: HtmlVersionBrief | null;
  /** Số phiên bản đang composing/validating. */
  active_versions: number;
  /** Lý do chưa xoá được (null = xoá được). */
  delete_block: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
}

export const assetPathOf = (a: { id: number; stored_path: string }): string => `assets/u/${a.id}${extOf(a.stored_path)}`;
export const extOf = (p: string): string => {
  const m = /\.[A-Za-z0-9]+$/.exec(p);
  return m ? m[0].toLowerCase() : '';
};

export function assetView(a: HtmlAssetRow): HtmlAssetView {
  return {
    id: a.id,
    name: a.original_name,
    description: parseJson(a.description_json ?? null, null),
    scan_error_code: a.scan_error_code ?? null,
    manual_label: a.manual_label ?? null,
    label_confirmed: !!a.label_confirmed,
    kind: a.kind,
    media_type: a.media_type,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    duration_s: a.duration_s,
    has_audio: a.has_audio === null ? null : a.has_audio === 1,
    path: assetPathOf(a),
    url: `/lan/api/html-projects/${a.project_id}/assets/${a.id}/file`,
    created_at: a.created_at,
  };
}

export function versionBrief(v: HtmlVersionRow): HtmlVersionBrief {
  return { id: v.id, version: v.version, status: v.status, created_by: v.created_by, summary: v.summary, created_at: v.created_at, published_at: v.published_at };
}

export function versionView(ctx: AppContext, v: HtmlVersionRow): HtmlVersionView {
  const policy = parseJson<{ compose?: string; vision?: string }>(v.compose_policy_json, {});
  const segments=v.is_segmented?listSegments(ctx,v.id):[];
  const active=segments.find(s=>s.status==='composing')??segments.find(s=>s.status==='queued'&&s.job_id);
  const jobId=v.compose_job_id??active?.job_id;
  const job = jobId ? (ctx.db.prepare('SELECT id, status, error, error_code FROM jobs WHERE id = ?').get(jobId) as Pick<JobRow, 'id' | 'status' | 'error' | 'error_code'> | undefined) : undefined;
  return {
    id: v.id,
    ...(v.is_segmented?{segments:segments.map(s=>({idx:s.idx,start_s:s.start_s,end_s:s.end_s,status:s.status,error:s.error,summary:s.summary,variables:parseJson<HtmlVariable[]>(s.variables_json,[])})),segments_ready:segments.filter(s=>s.status==='ready').length}:{}),
    project_id: v.project_id,
    version: v.version,
    parent_version: v.parent_id ? versionNumber(ctx, v.parent_id) : null,
    status: v.status,
    created_by: v.created_by,
    prompt: v.prompt,
    feedback: v.feedback,
    summary: v.summary,
    variables: parseJson<HtmlVariable[]>(v.variables_json, []),
    files: parseJson<HtmlFileView[]>(v.manifest_json, []),
    assets: listVersionAssets(ctx, v.id).map((a) => ({ asset_id: a.asset_id, path: `assets/u/${a.asset_id}${extOf(a.stored_path)}`, content_hash: a.content_hash })),
    content_hash: v.content_hash,
    lint_report: parseJson<LintReport | null>(v.lint_report_json, null),
    policy: { compose: policy.compose ?? 'auto', vision: policy.vision ?? 'auto' },
    error: v.error,
    error_code: v.error_code,
    job: job ? { id: job.id, status: job.status, error: job.error, error_code: job.error_code, queue: aiQueueInfoById(ctx, job.id) } : null,
    renders: latestRenders(ctx, v.id),
    created_at: v.created_at,
    published_at: v.published_at,
  };
}

export function projectView(ctx: AppContext, p: ProjectRow, deleteBlock: HtmlProjectView['delete_block']): HtmlProjectView {
  const m = projectMeta(ctx, p.id) as HtmlMetaRow;
  const size = aspectSize(m.aspect, m.quality);
  const agg = ctx.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM html_assets WHERE project_id = ?').get(p.id) as { n: number; b: number };
  const versions = ctx.db.prepare('SELECT * FROM html_versions WHERE project_id = ? AND segment_owner_id IS NULL ORDER BY version DESC').all(p.id) as HtmlVersionRow[];
  const model = parseJson<{ compose?: string; vision?: string }>(m.model_json, {});
  return {
    id: p.id,
    kind: 'html',
    slug: p.slug,
    name: p.name,
    brief: p.brief,
    aspect: m.aspect,
    width: size.width,
    height: size.height,
    fps: 30,
    duration_s: m.duration_s,
    quality: m.quality,
    template_id: m.template_id,
    model: { compose: model.compose ?? 'auto', vision: model.vision ?? 'auto' },
    asset_count: agg.n,
    asset_bytes: agg.b,
    version_count: versions.length,
    latest_version: versions[0] ? versionBrief(versions[0]) : null,
    active_versions: versions.filter((v) => v.status === 'composing' || v.status === 'validating').length,
    delete_block: deleteBlock,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
