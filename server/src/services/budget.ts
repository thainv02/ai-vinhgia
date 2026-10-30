import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/types.js';
import { getProject } from './repo.js';

/**
 * Lượt đã dùng = asset video + job video đang queued/claimed/running + job video failed có tốn credit.
 * Video người dùng LAN tự tải lên (`meta.source='lan_upload'`) không tốn credit/lượt của chủ máy nên không tính.
 */
export function attemptsUsed(ctx: AppContext, sceneId: number): number {
  const row = ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM assets WHERE scene_id = @id AND kind = 'video' AND COALESCE(CASE WHEN json_valid(meta) THEN json_extract(meta, '$.source') END, '') <> 'lan_upload')
       + (SELECT COUNT(*) FROM jobs WHERE scene_id = @id AND type = 'video' AND status IN ('queued','claimed','running'))
       + (SELECT COUNT(*) FROM jobs WHERE scene_id = @id AND type = 'video' AND status = 'failed' AND credits_cost > 0) AS n`,
    )
    .get({ id: sceneId }) as { n: number };
  return row.n;
}

/** Đã dùng = -SUM(credit_ledger.delta). */
export function creditsUsed(ctx: AppContext, projectId: number): number {
  const row = ctx.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM credit_ledger WHERE project_id = ?').get(projectId) as {
    s: number;
  };
  return -row.s;
}

export function activeVideoJobCount(ctx: AppContext, projectId: number): number {
  const row = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND type = 'video' AND status IN ('queued','claimed','running')")
    .get(projectId) as { n: number };
  return row.n;
}

/** Đặt trước = credit_per_video × số job video đang queued/claimed/running. */
export function creditsReserved(ctx: AppContext, project: ProjectRow): number {
  return project.credit_per_video * activeVideoJobCount(ctx, project.id);
}

export interface BudgetNumbers {
  used: number;
  reserved: number;
}

/** Số credit đã tiêu và đang đặt trước. Không còn hạn mức: không có "còn lại". */
export function budgetNumbers(ctx: AppContext, project: ProjectRow): BudgetNumbers {
  return { used: creditsUsed(ctx, project.id), reserved: creditsReserved(ctx, project) };
}

export function budgetSummary(ctx: AppContext, projectId: number) {
  const project = getProject(ctx, projectId);
  const nums = budgetNumbers(ctx, project);
  const scenes = ctx.db
    .prepare('SELECT id, code FROM scenes WHERE project_id = ? ORDER BY order_index, id')
    .all(projectId) as { id: number; code: string }[];
  return {
    ...nums,
    credit_per_video: project.credit_per_video,
    max_attempts: project.max_attempts_per_scene,
    scenes: scenes.map((s) => ({
      scene_id: s.id,
      code: s.code,
      attempts_used: attemptsUsed(ctx, s.id),
      max_attempts: project.max_attempts_per_scene,
    })),
  };
}
