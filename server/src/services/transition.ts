import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { SCENE_STATUS_LABEL, type SceneRow, type SceneStatus } from '../db/types.js';
import { getScene, logEvent } from './repo.js';
import { emitScene } from './scene-view.js';

/**
 * Bảng chuyển trạng thái hợp lệ của cảnh (decisions §C). Ngoài bảng → INVALID_TRANSITION.
 * `X → cancelled` luôn hợp lệ (dành sẵn, chưa có API).
 */
export const ALLOWED_TRANSITIONS: Record<SceneStatus, SceneStatus[]> = {
  draft: ['prompt_ready'],
  // tự động → awaiting_approval (hoặc → storyboard_queued khi REQUIRE_PROMPT_APPROVAL=false)
  prompt_ready: ['awaiting_approval', 'storyboard_queued'],
  awaiting_approval: ['storyboard_queued', 'video_queued', 'needs_revision'],
  // claim → running; hủy job → storyboard_review (đã có storyboard) | awaiting_approval; fail → failed
  storyboard_queued: ['storyboard_running', 'storyboard_review', 'awaiting_approval', 'failed'],
  storyboard_running: ['storyboard_queued', 'storyboard_review', 'awaiting_approval', 'failed'],
  storyboard_review: ['storyboard_queued', 'video_queued', 'needs_revision'],
  // claim → running; hủy job → video_review (đã có video) | storyboard_review; fail → failed | blocked_budget
  video_queued: ['video_running', 'video_review', 'storyboard_review', 'failed', 'blocked_budget'],
  video_running: ['video_queued', 'video_review', 'storyboard_review', 'failed', 'blocked_budget'],
  video_review: ['done', 'video_queued', 'storyboard_queued', 'needs_revision'],
  done: ['video_queued', 'storyboard_queued', 'video_review', 'needs_revision'],
  needs_revision: ['awaiting_approval', 'failed'],
  failed: ['storyboard_queued', 'video_queued', 'awaiting_approval', 'needs_revision'],
  blocked_budget: ['storyboard_queued', 'video_queued', 'awaiting_approval'],
  cancelled: [],
};

export function isTransitionAllowed(from: SceneStatus, to: SceneStatus): boolean {
  if (from === to) return false;
  if (to === 'cancelled') return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionOpts {
  /** Chỉ dùng cho lệnh import: bỏ qua kiểm tra bảng chuyển nhưng vẫn ghi event. */
  force?: boolean;
}

/**
 * Hàm DUY NHẤT được đổi `scenes.status`. Kiểm tra hợp lệ, cập nhật updated_at,
 * ghi `events` (type `scene.status`) và phát SSE `scene.updated` sau commit.
 */
export function transition(
  ctx: AppContext,
  sceneOrId: SceneRow | number,
  to: SceneStatus,
  reason: string,
  opts: TransitionOpts = {},
): SceneRow {
  return ctx.tx(() => {
    const scene = getScene(ctx, typeof sceneOrId === 'number' ? sceneOrId : sceneOrId.id);
    const from = scene.status;
    if (!opts.force && !isTransitionAllowed(from, to)) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Không thể chuyển cảnh ${scene.code} từ "${SCENE_STATUS_LABEL[from]}" (${from}) sang "${SCENE_STATUS_LABEL[to]}" (${to})`,
        409,
        { from, to },
      );
    }
    ctx.db.prepare('UPDATE scenes SET status = ?, updated_at = ? WHERE id = ?').run(to, ctx.now(), scene.id);
    logEvent(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'scene.status',
      message: `${scene.code}: ${from} → ${to}${reason ? ` (${reason})` : ''}`,
    });
    emitScene(ctx, scene.id, scene.project_id);
    return getScene(ctx, scene.id);
  });
}
