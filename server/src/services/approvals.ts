import type { AppContext } from '../context.js';
import { AppError, conflict } from '../lib/errors.js';
import type { SceneRow } from '../db/types.js';
import { insertJob } from './jobs.js';
import { nextStoryboardAttempt, nextVideoAttempt } from './payload.js';
import { getProject, getScene } from './repo.js';
import { storyboardApproveError, videoApproveError } from './rules.js';
import { transition } from './transition.js';

export interface ApprovalResult {
  sceneId: number;
  jobId: number;
}

/** Duyệt prompt / tạo (lại) storyboard. Không tốn credit. Tạo job storyboard (requires_approval=1, approved_at=now). */
export function approveStoryboard(ctx: AppContext, sceneId: number): ApprovalResult {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    const err = storyboardApproveError(ctx, scene);
    if (err) throw err;
    const reason = scene.status === 'awaiting_approval' ? 'người dùng duyệt prompt, tạo storyboard' : 'tạo lại storyboard';
    const jobId = insertJob(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'storyboard',
      requires_approval: true,
      approved: true,
      payload: { attempt: nextStoryboardAttempt(ctx, scene.id) },
    });
    transition(ctx, scene.id, 'storyboard_queued', reason);
    return { sceneId: scene.id, jobId };
  });
}

/**
 * ĐƯỜNG DUY NHẤT tạo job video. Kiểm tra (trong BEGIN IMMEDIATE): không có job đang chạy, trạng thái hợp lệ,
 * đã có storyboard, lượt < max_attempts_per_scene, credit còn lại >= credit_per_video.
 */
export function approveVideo(ctx: AppContext, sceneId: number): ApprovalResult {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    const project = getProject(ctx, scene.project_id);
    const err = videoApproveError(ctx, scene, project);
    if (err) throw err;
    const jobId = insertJob(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'video',
      requires_approval: true,
      approved: true,
      payload: { attempt: nextVideoAttempt(ctx, scene.id), credits_expected: project.credit_per_video },
    });
    transition(ctx, scene.id, 'video_queued', `người dùng duyệt tạo video (${project.credit_per_video} credit)`);
    return { sceneId: scene.id, jobId };
  });
}

export type ApproveStage = 'storyboard' | 'video';

export interface SkippedScene {
  scene_id: number;
  code: string;
  reason_code: string;
  message: string;
}

/** Danh sách cảnh sẽ được duyệt hàng loạt + tổng credit. `stage=video`: cảnh storyboard_review; `stage=storyboard`: cảnh awaiting_approval. */
export function previewApproveAll(ctx: AppContext, projectId: number, stage: ApproveStage) {
  const project = getProject(ctx, projectId);
  const wanted = stage === 'video' ? 'storyboard_review' : 'awaiting_approval';
  const rows = ctx.db
    .prepare('SELECT * FROM scenes WHERE project_id = ? AND status = ? ORDER BY order_index, id')
    .all(projectId, wanted) as SceneRow[];
  const scenes: { scene_id: number; code: string; title: string; status: string; credits: number }[] = [];
  const skipped: SkippedScene[] = [];
  for (const s of rows) {
    const err = stage === 'video' ? videoApproveError(ctx, s, project) : storyboardApproveError(ctx, s);
    if (err) skipped.push({ scene_id: s.id, code: s.code, reason_code: err.code, message: err.message });
    else scenes.push({ scene_id: s.id, code: s.code, title: s.title, status: s.status, credits: stage === 'video' ? project.credit_per_video : 0 });
  }
  const total = scenes.reduce((a, s) => a + s.credits, 0);
  return { stage, count: scenes.length, scenes, skipped, total_credits: total, credit_per_video: project.credit_per_video };
}

/** Duyệt tất cả cảnh đủ điều kiện, tất-cả-hoặc-không (một transaction). */
export function approveAll(ctx: AppContext, projectId: number, stage: ApproveStage, expectedCredits: number | undefined) {
  return ctx.tx(() => {
    const preview = previewApproveAll(ctx, projectId, stage);
    if (preview.count === 0) {
      throw conflict('NOTHING_TO_APPROVE', 'Không có cảnh nào đủ điều kiện để duyệt');
    }
    const expected = expectedCredits ?? 0;
    if (expected !== preview.total_credits) {
      throw new AppError(
        'CREDITS_CHANGED',
        `Tổng credit đã thay đổi: bạn xác nhận ${expected}, hiện tại là ${preview.total_credits}. Hãy xem lại rồi duyệt lại`,
        409,
        { expected, actual: preview.total_credits },
      );
    }
    const jobs: { scene_id: number; code: string; job_id: number }[] = [];
    for (const s of preview.scenes) {
      const r = stage === 'video' ? approveVideo(ctx, s.scene_id) : approveStoryboard(ctx, s.scene_id);
      jobs.push({ scene_id: s.scene_id, code: s.code, job_id: r.jobId });
    }
    return { stage, count: jobs.length, total_credits: preview.total_credits, jobs };
  });
}
