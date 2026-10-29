/**
 * Phần riêng của trang LAN cho dự án cắt clip: tìm dự án, danh sách, giới hạn hiển thị, và danh sách file được phục vụ qua `/lan/files`.
 * KHÔNG BAO GIỜ phục vụ video nguồn gốc (chỉ bản xem thử 480p, poster, ảnh đại diện clip và clip đã dựng `ready` dạng mp4/srt).
 */
import type { AppContext } from '../../context.js';
import type { ProjectRow } from '../../db/types.js';
import { notFound } from '../../lib/errors.js';
import { getProject } from '../repo.js';
import { clipProjectSummary, type ViewOpts } from './view.js';
import { captionSupport } from './render.js';
import { sttConfigured } from './stt.js';

/** Dự án cắt clip của LAN; dự án app hoặc kế hoạch prompt → 404 như không tồn tại. */
export function lanClipProject(ctx: AppContext, id: number): ProjectRow {
  const p = getProject(ctx, id);
  if (p.source !== 'lan' || p.kind !== 'clips') throw notFound('dự án cắt clip');
  return p;
}

export function listLanClipProjects(ctx: AppContext, o: ViewOpts) {
  const rows = ctx.db.prepare("SELECT * FROM projects WHERE source = 'lan' AND kind = 'clips' AND deleted_at IS NULL ORDER BY id DESC LIMIT 200").all() as ProjectRow[];
  return rows.map((p) => clipProjectSummary(ctx, p, o));
}

/** `rel` có được phục vụ qua listener LAN như một file của dự án cắt clip LAN không. */
export function isLanClipServable(ctx: AppContext, rel: string): boolean {
  const m = /^output\/([^/]+)\/clips\/(.+)$/.exec(rel);
  if (!m) return false;
  const sub = m[2]!;
  const isPreview = sub === 'source/preview_480p.mp4';
  const isThumb = sub === 'thumbs/poster.jpg' || /^thumbs\/K\d+\.jpg$/.test(sub);
  const isCut = /^clips\/K\d+_v\d+\.(mp4|srt)$/.test(sub);
  const isFrame = /^frames\/K\d+_[a-z0-9]+\.jpg$/.test(sub); // khung xem thử phụ đề
  if (!isPreview && !isThumb && !isCut && !isFrame) return false;
  const proj = ctx.db.prepare("SELECT id FROM projects WHERE lower(slug) = lower(?) AND source = 'lan' AND kind = 'clips' AND deleted_at IS NULL").get(m[1]!) as { id: number } | undefined;
  if (!proj) return false;
  if (isCut) {
    return !!ctx.db.prepare("SELECT 1 FROM clip_cuts WHERE project_id = ? AND status = 'ready' AND (video_path = ? OR srt_path = ?) LIMIT 1").get(proj.id, rel, rel);
  }
  return true;
}

/** Giới hạn và khả năng hiển thị cho trang (app: `/api/clip-status`, LAN: `/lan/api/status` → `limits.clip` và `/lan/api/clip-status`). */
export function clipLimits(ctx: AppContext, lan: boolean) {
  const c = ctx.config;
  const cap = captionSupport(ctx);
  return {
    max_bytes: lan ? c.lanClipSourceMaxBytes : c.clipSourceMaxBytes,
    max_s: lan ? c.lanClipSourceMaxS : c.clipSourceMaxS,
    retention_days: lan ? c.lanClipSourceRetentionDays : null,
    stt: { configured: sttConfigured(ctx) },
    captions: { available: cap.available, reason: lan ? (cap.available ? null : 'Máy chủ chưa hỗ trợ phụ đề; hãy chọn "Không phụ đề" hoặc báo chủ máy') : cap.reason, font: c.clipCaptionFont },
    plan: { min_count: 1, max_count: 15 },
  };
}
