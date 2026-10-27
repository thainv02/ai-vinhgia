import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/types.js';
import { budgetNumbers } from './budget.js';
import { finalCutBlock, latestFinalCutBrief } from './final-cuts.js';
import { getProject } from './repo.js';

/** Dự án cắt clip: số clip và video nguồn (cho thẻ dự án trong danh sách). */
function clipsSummaryExtras(ctx: AppContext, p: ProjectRow) {
  const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE project_id = ?').get(p.id) as { n: number }).n;
  const s = ctx.db.prepare('SELECT duration_s, status FROM source_videos WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(p.id) as { duration_s: number | null; status: string } | undefined;
  return { stt_terms: p.stt_terms, clip_count: n, source_video: s ? { duration_s: s.duration_s, status: s.status } : null };
}

/** Thông tin tổng hợp của dự án cho danh sách / thẻ dự án / SSE `project.updated`. */
export function projectSummary(ctx: AppContext, p: ProjectRow) {
  const counts = ctx.db.prepare('SELECT status, COUNT(*) AS n FROM scenes WHERE project_id = ? GROUP BY status').all(p.id) as {
    status: string;
    n: number;
  }[];
  const statusCounts: Record<string, number> = {};
  let total = 0;
  for (const c of counts) {
    statusCounts[c.status] = c.n;
    total += c.n;
  }
  const nums = budgetNumbers(ctx, p);
  return {
    id: p.id,
    /** 'scenes' (video theo cảnh) | 'clips' (cắt clip từ video dài). */
    kind: p.kind,
    slug: p.slug,
    name: p.name,
    brief: p.brief,
    style_lock: p.style_lock,
    max_attempts_per_scene: p.max_attempts_per_scene,
    credit_per_video: p.credit_per_video,
    status: p.status,
    /** 'app' | 'lan' (dự án do người dùng LAN tạo qua trang planner). */
    source: p.source,
    created_by_name: p.created_by_name,
    created_at: p.created_at,
    updated_at: p.updated_at,
    scene_count: total,
    done_count: statusCounts.done ?? 0,
    status_counts: statusCounts,
    credits_used: nums.used,
    credits_reserved: nums.reserved,
    /** Bản dựng hoàn chỉnh mới nhất (gọn) hoặc null. */
    latest_final_cut: latestFinalCutBrief(ctx, p.id),
    /** Lý do chưa bấm được "Dựng bản mới" (null = được). */
    final_cut_block: finalCutBlock(ctx, p.id),
    ...(p.kind === 'clips' ? clipsSummaryExtras(ctx, p) : {}),
  };
}

/** Phát SSE `project.updated` sau commit (gộp trong cùng một transaction). */
export function emitProject(ctx: AppContext, projectId: number): void {
  ctx.publish('project.updated', projectId, () => ({ project: projectSummary(ctx, getProject(ctx, projectId)) }), `project:${projectId}`);
}
