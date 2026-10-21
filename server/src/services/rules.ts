import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { ACTIVE_JOB_STATUSES, SCENE_STATUS_LABEL, type JobRow, type ProjectRow, type SceneRow, type SceneStatus } from '../db/types.js';
import { attemptsUsed } from './budget.js';

/** Trạng thái cho phép bấm "tạo video" (duyệt video). */
export const VIDEO_APPROVABLE: SceneStatus[] = [
  'awaiting_approval',
  'storyboard_review',
  'video_review',
  'done',
  'failed',
  'blocked_budget',
];
/** Trạng thái cho phép bấm "tạo storyboard" (duyệt prompt / tạo lại storyboard). */
export const STORYBOARD_APPROVABLE: SceneStatus[] = [
  'awaiting_approval',
  'storyboard_review',
  'video_review',
  'done',
  'failed',
  'blocked_budget',
];
/** Trạng thái cho phép comment "sửa prompt rồi tạo lại". */
export const REVISABLE: SceneStatus[] = ['storyboard_review', 'video_review', 'done', 'awaiting_approval', 'failed'];
/** Trạng thái cho phép người dùng tự sửa prompt. */
export const PROMPT_EDITABLE: SceneStatus[] = [
  'draft',
  'prompt_ready',
  'awaiting_approval',
  'storyboard_review',
  'video_review',
  'done',
  'failed',
  'blocked_budget',
];

export const statusLabel = (s: SceneStatus): string => `"${SCENE_STATUS_LABEL[s]}" (${s})`;

export function activeJobOf(ctx: AppContext, sceneId: number): JobRow | undefined {
  return ctx.db
    .prepare(`SELECT * FROM jobs WHERE scene_id = ? AND status IN ('queued','claimed','running') ORDER BY id DESC LIMIT 1`)
    .get(sceneId) as JobRow | undefined;
}

export function hasAsset(ctx: AppContext, sceneId: number, kind: 'storyboard' | 'video'): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM assets WHERE scene_id = ? AND kind = ? LIMIT 1').get(sceneId, kind);
}

export const JOB_TYPE_LABEL: Record<string, string> = {
  analyze_brief: 'phân tích kịch bản',
  storyboard: 'storyboard',
  video: 'video',
  revise_prompt: 'sửa prompt',
  edit_plan: 'chọn điểm cắt bản hoàn chỉnh',
};

function activeJobError(scene: SceneRow, job: JobRow): AppError {
  return new AppError(
    'JOB_ACTIVE',
    `Cảnh ${scene.code} đang có job ${JOB_TYPE_LABEL[job.type] ?? job.type} (${job.status}); hãy đợi hoặc hủy job đó trước`,
    409,
  );
}

/**
 * Kiểm tra việc tạo job video cho cảnh (đường DUY NHẤT tạo job video).
 * Trả về lỗi (chưa ném) hoặc null nếu hợp lệ. Thứ tự: job đang chạy → trạng thái → có storyboard → số lượt. KHÔNG kiểm tra hạn mức credit (đã bỏ).
 */
export function videoApproveError(ctx: AppContext, scene: SceneRow, project: ProjectRow): AppError | null {
  const active = activeJobOf(ctx, scene.id);
  if (active) return activeJobError(scene, active);
  if (!VIDEO_APPROVABLE.includes(scene.status)) {
    return new AppError(
      'INVALID_STATE',
      `Cảnh ${scene.code} đang ở trạng thái ${statusLabel(scene.status)}; không thể tạo video ở trạng thái này`,
      409,
    );
  }
  if (!hasAsset(ctx, scene.id, 'storyboard')) {
    return new AppError('INVALID_STATE', `Cảnh ${scene.code} chưa có storyboard; hãy tạo storyboard trước khi tạo video`, 409);
  }
  const used = attemptsUsed(ctx, scene.id);
  if (used >= project.max_attempts_per_scene) {
    return new AppError('ATTEMPTS_EXCEEDED', `Cảnh ${scene.code} đã dùng ${used}/${project.max_attempts_per_scene} lượt`, 409);
  }
  return null;
}

export function storyboardApproveError(ctx: AppContext, scene: SceneRow): AppError | null {
  const active = activeJobOf(ctx, scene.id);
  if (active) return activeJobError(scene, active);
  if (!STORYBOARD_APPROVABLE.includes(scene.status)) {
    return new AppError(
      'INVALID_STATE',
      `Cảnh ${scene.code} đang ở trạng thái ${statusLabel(scene.status)}; không thể tạo storyboard ở trạng thái này`,
      409,
    );
  }
  return null;
}

/** Cảnh đầu tiên (order_index nhỏ nhất) của dự án. */
export function firstScene(ctx: AppContext, projectId: number): SceneRow | undefined {
  return ctx.db
    .prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY order_index, id LIMIT 1')
    .get(projectId) as SceneRow | undefined;
}

/**
 * Lý do một job `queued` chưa thể được claim (null = đủ điều kiện). Dùng chung cho `worker/next` và UI.
 * Không kiểm tra hàng đợi tạm dừng (kiểm tra riêng).
 */
export function claimBlockReason(ctx: AppContext, job: JobRow): string | null {
  if (job.requires_approval && !job.approved_at) return 'Chưa được người dùng duyệt';
  if (job.type === 'video') {
    const row = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'video' AND status IN ('claimed','running')")
      .get() as { n: number };
    if (row.n >= ctx.config.maxConcurrentVideoJobs) {
      return `Đã có ${row.n}/${ctx.config.maxConcurrentVideoJobs} video chạy cùng lúc`;
    }
  }
  if (job.scene_id !== null) {
    const other = ctx.db
      .prepare("SELECT id FROM jobs WHERE scene_id = ? AND id != ? AND status IN ('claimed','running') LIMIT 1")
      .get(job.scene_id, job.id);
    if (other) return 'Cảnh đang có job khác chạy';
    if (job.type === 'storyboard') {
      const scene = ctx.db.prepare('SELECT * FROM scenes WHERE id = ?').get(job.scene_id) as SceneRow | undefined;
      if (scene?.use_prev_storyboard) {
        const first = firstScene(ctx, scene.project_id);
        if (first && first.id !== scene.id && !hasAsset(ctx, first.id, 'storyboard')) {
          return `Đang chờ storyboard của ${first.code}`;
        }
      }
    }
  }
  return null;
}

export const isActiveStatus = (s: string): boolean => (ACTIVE_JOB_STATUSES as string[]).includes(s);
