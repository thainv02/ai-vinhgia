import type { AppContext } from '../context.js';
import type { AssetRow, ProjectRow, SceneRow } from '../db/types.js';
import { attemptsUsed } from './budget.js';
import { assetJson, getJobJson, getProject, getScene, parseJson } from './repo.js';
import { activeJobOf, claimBlockReason, storyboardApproveError, videoApproveError } from './rules.js';

export interface BlockInfo {
  code: string;
  message: string;
}

/** Cảnh kèm dữ liệu tổng hợp cho bảng cảnh (`GET /projects/:id/scenes`, SSE `scene.updated`). */
export function buildSceneSummary(ctx: AppContext, scene: SceneRow, project?: ProjectRow) {
  const proj = project ?? getProject(ctx, scene.project_id);
  const assets = ctx.db.prepare('SELECT * FROM assets WHERE scene_id = ? ORDER BY id').all(scene.id) as AssetRow[];
  const storyboards = assets.filter((a) => a.kind === 'storyboard');
  const videos = assets.filter((a) => a.kind === 'video');
  const storyboard = storyboards.length ? storyboards[storyboards.length - 1] : null;
  const video =
    (scene.selected_video_id ? videos.find((v) => v.id === scene.selected_video_id) : undefined) ??
    (videos.length ? videos[videos.length - 1] : null);
  const grid = video ? [...assets].reverse().find((a) => a.kind === 'grid' && a.attempt === video.attempt) ?? null : null;

  const activeRow = activeJobOf(ctx, scene.id);
  let activeJob: ReturnType<typeof getJobJson> | null = null;
  let waiting: string | null = null;
  if (activeRow) {
    activeJob = getJobJson(ctx, activeRow.id);
    if (activeRow.status === 'queued') {
      const paused = ctx.db.prepare('SELECT queue_paused FROM worker_state WHERE id = 1').get() as { queue_paused: number };
      waiting = paused.queue_paused ? 'Hàng đợi đang tạm dừng' : claimBlockReason(ctx, activeRow);
    }
  }
  const openComments = (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE scene_id = ? AND resolved = 0').get(scene.id) as { n: number }
  ).n;
  const version = (
    ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(scene.id) as {
      v: number;
    }
  ).v;
  const vErr = videoApproveError(ctx, scene, proj);
  const sErr = storyboardApproveError(ctx, scene);
  const toBlock = (e: { code: string; message: string } | null): BlockInfo | null => (e ? { code: e.code, message: e.message } : null);

  return {
    id: scene.id,
    project_id: scene.project_id,
    code: scene.code,
    order_index: scene.order_index,
    title: scene.title,
    prompt: scene.prompt,
    first_frame_desc: scene.first_frame_desc,
    upload_refs: parseJson<number[]>(scene.upload_refs, []),
    use_prev_storyboard: !!scene.use_prev_storyboard,
    status: scene.status,
    selected_video_id: scene.selected_video_id,
    created_at: scene.created_at,
    updated_at: scene.updated_at,
    prompt_version: version,
    attempts_used: attemptsUsed(ctx, scene.id),
    max_attempts: proj.max_attempts_per_scene,
    storyboard_count: storyboards.length,
    video_count: videos.length,
    storyboard: storyboard ? assetJson(storyboard) : null,
    video: video ? assetJson(video) : null,
    grid: grid ? assetJson(grid) : null,
    active_job: activeJob,
    waiting_reason: waiting,
    open_comments: openComments,
    storyboard_block: toBlock(sErr),
    video_block: toBlock(vErr),
  };
}
export type SceneSummary = ReturnType<typeof buildSceneSummary>;

export function sceneSummaryById(ctx: AppContext, id: number): SceneSummary {
  return buildSceneSummary(ctx, getScene(ctx, id));
}

export function listSceneSummaries(ctx: AppContext, projectId: number): SceneSummary[] {
  const project = getProject(ctx, projectId);
  const rows = ctx.db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY order_index, id').all(projectId) as SceneRow[];
  return rows.map((r) => buildSceneSummary(ctx, r, project));
}

/** Phát SSE `scene.updated` sau commit (gộp nhiều lần gọi trong cùng một transaction). */
export function emitScene(ctx: AppContext, sceneId: number, projectId?: number): void {
  const pid = projectId ?? getScene(ctx, sceneId).project_id;
  ctx.publish('scene.updated', pid, () => ({ scene: sceneSummaryById(ctx, sceneId) }), `scene:${sceneId}`);
}
