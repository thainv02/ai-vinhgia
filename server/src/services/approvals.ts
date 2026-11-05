import type { AppContext } from '../context.js';
import { conflict } from '../lib/errors.js';
import type { SceneRow } from '../db/types.js';
import { insertJob } from './jobs.js';
import { getGenerator, getStoryboardGenerator, lastGeneratorOfScene } from './generators.js';
import { nextStoryboardAttempt, nextVideoAttempt } from './payload.js';
import { getProject, getScene } from './repo.js';
import { storyboardApproveError, videoApproveError } from './rules.js';
import { transition } from './transition.js';

export interface ApprovalResult {
  sceneId: number;
  jobId: number;
}

/** Duyệt prompt / tạo (lại) storyboard. Tạo job storyboard (requires_approval=1, approved_at=now). */
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
      payload: { attempt: nextStoryboardAttempt(ctx, scene.id), generator: getStoryboardGenerator(getProject(ctx, scene.project_id).storyboard_generator).id },
    });
    transition(ctx, scene.id, 'storyboard_queued', reason);
    return { sceneId: scene.id, jobId };
  });
}

/**
 * ĐƯỜNG DUY NHẤT tạo job video. Kiểm tra (trong BEGIN IMMEDIATE): không có job đang chạy, trạng thái hợp lệ,
 * đã có storyboard, lượt < max_attempts_per_scene, số ảnh không vượt giới hạn của dịch vụ.
 * `generatorId` bỏ trống: dùng lại dịch vụ của job video gần nhất của cảnh (mặc định Muse).
 */
export function approveVideo(ctx: AppContext, sceneId: number, generatorId?: string): ApprovalResult {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    const project = getProject(ctx, scene.project_id);
    const generator = getGenerator(generatorId ?? lastGeneratorOfScene(ctx, scene.id)).id;
    const err = videoApproveError(ctx, scene, project, generator);
    if (err) throw err;
    const jobId = insertJob(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'video',
      requires_approval: true,
      approved: true,
      payload: { attempt: nextVideoAttempt(ctx, scene.id), generator },
    });
    transition(ctx, scene.id, 'video_queued', 'người dùng duyệt tạo video');
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

/** Danh sách cảnh sẽ được duyệt hàng loạt. `stage=video`: cảnh storyboard_review; `stage=storyboard`: cảnh awaiting_approval. */
export function previewApproveAll(ctx: AppContext, projectId: number, stage: ApproveStage, generatorId?: string) {
  const project = getProject(ctx, projectId);
  const wanted = stage === 'video' ? 'storyboard_review' : 'awaiting_approval';
  const rows = ctx.db
    .prepare('SELECT * FROM scenes WHERE project_id = ? AND status = ? ORDER BY order_index, id')
    .all(projectId, wanted) as SceneRow[];
  const scenes: { scene_id: number; code: string; title: string; status: string }[] = [];
  const skipped: SkippedScene[] = [];
  for (const s of rows) {
    const err = stage === 'video' ? videoApproveError(ctx, s, project, getGenerator(generatorId ?? lastGeneratorOfScene(ctx, s.id)).id) : storyboardApproveError(ctx, s);
    if (err) skipped.push({ scene_id: s.id, code: s.code, reason_code: err.code, message: err.message });
    else scenes.push({ scene_id: s.id, code: s.code, title: s.title, status: s.status });
  }
  return { stage, count: scenes.length, scenes, skipped };
}

/** Duyệt tất cả cảnh đủ điều kiện, tất-cả-hoặc-không (một transaction). Không còn xác nhận tổng credit. */
export function approveAll(ctx: AppContext, projectId: number, stage: ApproveStage, generatorId?: string) {
  return ctx.tx(() => {
    const preview = previewApproveAll(ctx, projectId, stage, generatorId);
    if (preview.count === 0) {
      throw conflict('NOTHING_TO_APPROVE', 'Không có cảnh nào đủ điều kiện để duyệt');
    }
    const jobs: { scene_id: number; code: string; job_id: number }[] = [];
    for (const s of preview.scenes) {
      const r = stage === 'video' ? approveVideo(ctx, s.scene_id, generatorId) : approveStoryboard(ctx, s.scene_id);
      jobs.push({ scene_id: s.scene_id, code: s.code, job_id: r.jobId });
    }
    return { stage, count: jobs.length, jobs };
  });
}
