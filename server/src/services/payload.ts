import type { AppContext } from '../context.js';
import type { AssetRow, CommentRow, JobRow, ProjectRow, SceneRow } from '../db/types.js';
import { commentJson, getProject, getScene, parseJson, projectRefs } from './repo.js';
import { clipPlanPayloadFor } from './clips/plan.js';
import { editPlanPayloadFor } from './final-revisions.js';
import { buildStoryboardMessage, VIDEO_SETTINGS } from './plan.js';
import { firstScene } from './rules.js';

export const RULES_FILE = 'video-production-rules.md';
export { VIDEO_SETTINGS };

function latestAsset(ctx: AppContext, sceneId: number, kind: 'storyboard' | 'video'): AssetRow | undefined {
  return ctx.db
    .prepare('SELECT * FROM assets WHERE scene_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(sceneId, kind) as AssetRow | undefined;
}

/** Số lượt (attempt) cho job video tiếp theo của cảnh: video đã có + job video failed có tốn credit + 1. */
export function nextVideoAttempt(ctx: AppContext, sceneId: number): number {
  const row = ctx.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM assets WHERE scene_id = @id AND kind = 'video')
            + (SELECT COUNT(*) FROM jobs WHERE scene_id = @id AND type = 'video' AND status = 'failed' AND credits_cost > 0) AS n`,
    )
    .get({ id: sceneId }) as { n: number };
  return row.n + 1;
}

export function nextStoryboardAttempt(ctx: AppContext, sceneId: number): number {
  const row = ctx.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE scene_id = ? AND kind = 'storyboard'").get(sceneId) as { n: number };
  return row.n + 1;
}

export const storyboardPath = (slug: string, code: string, attempt: number): string =>
  `output/${slug}/storyboard/${code}_storyboard${attempt > 1 ? `_v${attempt}` : ''}.png`;
export const videoPath = (slug: string, code: string, attempt: number): string => `output/${slug}/video/${code}_v${attempt}.mp4`;
export const gridPath = (slug: string, code: string, attempt: number): string => `output/${slug}/video/${code}_v${attempt}_grid.jpg`;

const projectBrief = (p: ProjectRow) => ({ id: p.id, slug: p.slug, name: p.name, style_lock: p.style_lock });
const sceneBrief = (s: SceneRow) => ({
  id: s.id,
  code: s.code,
  title: s.title,
  prompt: s.prompt,
  first_frame_desc: s.first_frame_desc,
});

function refRows(ctx: AppContext, scene: SceneRow): { label: string; file_path: string }[] {
  const ids = parseJson<number[]>(scene.upload_refs, []);
  const out: { label: string; file_path: string }[] = [];
  for (const id of ids) {
    const ref = ctx.db.prepare('SELECT label, file_path FROM project_refs WHERE id = ?').get(id) as { label: string; file_path: string } | undefined;
    if (ref) out.push(ref);
  }
  return out;
}

function refFiles(ctx: AppContext, scene: SceneRow): string[] {
  return refRows(ctx, scene).map((r) => r.file_path);
}

/**
 * Tính payload của job TẠI THỜI ĐIỂM CLAIM (ghi đè cột payload) để worker không phải đoán.
 * Cấu trúc theo decisions §E.
 */
export function computePayload(ctx: AppContext, job: JobRow): Record<string, unknown> {
  const project = getProject(ctx, job.project_id);
  const requeued = job.requeue_count > 0;

  if (job.type === 'analyze_brief') {
    return {
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        brief: project.brief,
        style_lock: project.style_lock,
        credit_per_video: project.credit_per_video,
        max_attempts_per_scene: project.max_attempts_per_scene,
      },
      refs: projectRefs(ctx, project.id).map((r) => ({ id: r.id, label: r.label, file_path: r.file_path })),
      rules_file: RULES_FILE,
      requeued,
    };
  }

  if (job.type === 'edit_plan') return editPlanPayloadFor(ctx, job);
  if (job.type === 'clip_plan') return clipPlanPayloadFor(ctx, job);

  const scene = getScene(ctx, job.scene_id as number);

  if (job.type === 'storyboard') {
    const attempt = nextStoryboardAttempt(ctx, scene.id);
    const refs = refRows(ctx, scene);
    const upload = refs.map((r) => r.file_path);
    let prevCode: string | null = null;
    if (scene.use_prev_storyboard) {
      const first = firstScene(ctx, project.id);
      if (first && first.id !== scene.id) {
        const sb = latestAsset(ctx, first.id, 'storyboard');
        if (sb) {
          upload.push(sb.file_path);
          prevCode = first.code;
        }
      }
    }
    return {
      project: projectBrief(project),
      scene: sceneBrief(scene),
      upload_files: upload,
      // Tin nhắn gửi ChatGPT dựng sẵn từ template dùng chung với trang planner LAN (services/plan.ts): gửi NGUYÊN VĂN.
      chatgpt_message: buildStoryboardMessage({
        sceneCode: scene.code,
        firstFrameDesc: scene.first_frame_desc,
        prompt: scene.prompt,
        refLabels: refs.map((r) => r.label),
        prevStoryboardCode: prevCode,
      }),
      attempt,
      output: { storyboard_path: storyboardPath(project.slug, scene.code, attempt) },
      requeued,
    };
  }

  if (job.type === 'video') {
    const attempt = nextVideoAttempt(ctx, scene.id);
    const sb = latestAsset(ctx, scene.id, 'storyboard');
    const upload = refFiles(ctx, scene);
    if (sb) upload.push(sb.file_path);
    return {
      project: projectBrief(project),
      scene: sceneBrief(scene),
      upload_files: upload,
      storyboard_path: sb?.file_path ?? null,
      attempt,
      output: {
        video_path: videoPath(project.slug, scene.code, attempt),
        grid_path: gridPath(project.slug, scene.code, attempt),
      },
      settings: { ...VIDEO_SETTINGS },
      credits_expected: project.credit_per_video,
      requeued,
    };
  }

  // revise_prompt
  const version = (
    ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(scene.id) as { v: number }
  ).v;
  const comments = ctx.db
    .prepare('SELECT * FROM comments WHERE scene_id = ? AND resolved = 0 ORDER BY id')
    .all(scene.id) as CommentRow[];
  return {
    project: projectBrief(project),
    scene: { ...sceneBrief(scene), version },
    comments: comments.map(commentJson),
    requeued,
  };
}
