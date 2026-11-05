import type { AppContext } from '../context.js';
import { getProject } from './repo.js';

/**
 * Điều kiện SQL (trên bảng `jobs`) cho job video failed vẫn tính là một lượt đã dùng:
 *  - đánh dấu mới: `result.attempt_used = true` (worker fail với `attempt_used: true`, hoặc đối soát `charge_and_fail`);
 *  - dữ liệu cũ (thời còn ghi credit): `credits_cost > 0`.
 */
export const FAILED_ATTEMPT_USED_SQL = `(credits_cost > 0 OR COALESCE(CASE WHEN json_valid(result) THEN json_extract(result, '$.attempt_used') END, 0) = 1)`;

/**
 * Lượt đã dùng = asset video + job video đang queued/claimed/running + job video failed vẫn tính lượt.
 * Video người dùng LAN tự tải lên (`meta.source='lan_upload'`) không tốn lượt của chủ máy nên không tính.
 */
export function attemptsUsed(ctx: AppContext, sceneId: number): number {
  const row = ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM assets WHERE scene_id = @id AND kind = 'video' AND COALESCE(CASE WHEN json_valid(meta) THEN json_extract(meta, '$.source') END, '') <> 'lan_upload')
       + (SELECT COUNT(*) FROM jobs WHERE scene_id = @id AND type = 'video' AND status IN ('queued','claimed','running'))
       + (SELECT COUNT(*) FROM jobs WHERE scene_id = @id AND type = 'video' AND status = 'failed' AND ${FAILED_ATTEMPT_USED_SQL}) AS n`,
    )
    .get({ id: sceneId }) as { n: number };
  return row.n;
}

export function activeVideoJobCount(ctx: AppContext, projectId: number): number {
  const row = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND type = 'video' AND status IN ('queued','claimed','running')")
    .get(projectId) as { n: number };
  return row.n;
}

/** Số lượt đã dùng theo cảnh (`GET /api/projects/:id/budget`). Không còn credit. */
export function budgetSummary(ctx: AppContext, projectId: number) {
  const project = getProject(ctx, projectId);
  const scenes = ctx.db
    .prepare('SELECT id, code FROM scenes WHERE project_id = ? ORDER BY order_index, id')
    .all(projectId) as { id: number; code: string }[];
  return {
    max_attempts: project.max_attempts_per_scene,
    scenes: scenes.map((s) => ({
      scene_id: s.id,
      code: s.code,
      attempts_used: attemptsUsed(ctx, s.id),
      max_attempts: project.max_attempts_per_scene,
    })),
  };
}
