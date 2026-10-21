import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { intParam, parse } from '../lib/validate.js';
import type { AssetRow, CommentRow, PromptVersionRow } from '../db/types.js';
import { approveStoryboard, approveVideo } from '../services/approvals.js';
import { setVerdict, verdictBody } from '../services/assets.js';
import { commentBody, createComment, setCommentResolved } from '../services/comments.js';
import {
  assetJson,
  commentJson,
  getAsset,
  getComment,
  getJobJson,
  getProject,
  getScene,
  listJobsJson,
  promptVersionJson,
} from '../services/repo.js';
import { buildSceneSummary, sceneSummaryById } from '../services/scene-view.js';
import { editPrompt, resetScene, selectVideo } from '../services/scenes.js';

export function registerSceneRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/scenes/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const scene = getScene(ctx, id);
    const project = getProject(ctx, scene.project_id);
    const summary = buildSceneSummary(ctx, scene, project);
    const assets = ctx.db.prepare('SELECT * FROM assets WHERE scene_id = ? ORDER BY id').all(id) as AssetRow[];
    const comments = ctx.db.prepare('SELECT * FROM comments WHERE scene_id = ? ORDER BY id').all(id) as CommentRow[];
    const versions = ctx.db
      .prepare('SELECT * FROM scene_prompt_versions WHERE scene_id = ? ORDER BY version')
      .all(id) as PromptVersionRow[];
    const neighbors = ctx.db
      .prepare('SELECT id FROM scenes WHERE project_id = ? ORDER BY order_index, id')
      .all(scene.project_id) as { id: number }[];
    const idx = neighbors.findIndex((n) => n.id === id);
    return {
      ...summary,
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        style_lock: project.style_lock,
        credit_per_video: project.credit_per_video,
        max_attempts_per_scene: project.max_attempts_per_scene,
      },
      assets: assets.map(assetJson),
      comments: comments.map(commentJson),
      prompt_versions: versions.map(promptVersionJson),
      jobs: listJobsJson(ctx, { sceneId: id, limit: 100 }),
      prev_scene_id: idx > 0 ? neighbors[idx - 1]!.id : null,
      next_scene_id: idx >= 0 && idx < neighbors.length - 1 ? neighbors[idx + 1]!.id : null,
    };
  });

  app.patch('/api/scenes/:id/prompt', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ prompt: z.string().min(1, 'prompt không được rỗng').max(50_000), reason: z.string().max(500).optional() }), req.body);
    editPrompt(ctx, id, body.prompt, body.reason);
    return { scene: sceneSummaryById(ctx, id) };
  });

  app.post('/api/scenes/:id/approve', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ stage: z.enum(['storyboard', 'video']) }), req.body);
    const r = body.stage === 'video' ? approveVideo(ctx, id) : approveStoryboard(ctx, id);
    return { scene: sceneSummaryById(ctx, id), job: getJobJson(ctx, r.jobId) };
  });

  app.post('/api/scenes/:id/comments', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(commentBody, req.body);
    const r = createComment(ctx, id, body, 'user');
    return reply.code(201).send({
      comment: commentJson(getComment(ctx, r.commentId)),
      job: r.jobId ? getJobJson(ctx, r.jobId) : null,
      scene: sceneSummaryById(ctx, id),
    });
  });

  app.post('/api/scenes/:id/select-video', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ asset_id: z.number().int().optional() }), req.body ?? {});
    selectVideo(ctx, id, body.asset_id);
    return { scene: sceneSummaryById(ctx, id) };
  });

  app.post('/api/scenes/:id/reset', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    resetScene(ctx, id);
    return { scene: sceneSummaryById(ctx, id) };
  });

  app.patch('/api/comments/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ resolved: z.boolean() }), req.body);
    return commentJson(setCommentResolved(ctx, id, body.resolved));
  });

  app.post('/api/assets/:id/verdict', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(verdictBody, req.body);
    const note = body.verdict_note !== undefined ? body.verdict_note : body.note;
    setVerdict(ctx, id, body.verdict, note);
    const asset = getAsset(ctx, id);
    return { asset: assetJson(asset), scene: sceneSummaryById(ctx, asset.scene_id) };
  });
}
