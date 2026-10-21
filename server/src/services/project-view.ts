import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/types.js';
import { budgetNumbers } from './budget.js';
import { finalCutBlock, latestFinalCutBrief } from './final-cuts.js';
import { getProject } from './repo.js';

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
    slug: p.slug,
    name: p.name,
    brief: p.brief,
    style_lock: p.style_lock,
    max_attempts_per_scene: p.max_attempts_per_scene,
    credit_per_video: p.credit_per_video,
    status: p.status,
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
  };
}

/** Phát SSE `project.updated` sau commit (gộp trong cùng một transaction). */
export function emitProject(ctx: AppContext, projectId: number): void {
  ctx.publish('project.updated', projectId, () => ({ project: projectSummary(ctx, getProject(ctx, projectId)) }), `project:${projectId}`);
}
