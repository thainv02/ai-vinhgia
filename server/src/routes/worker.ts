import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { intParam, parse } from '../lib/validate.js';
import { COMMENT_ACTIONS } from '../db/types.js';
import { createComment } from '../services/comments.js';
import { claimNext, completeBody, completeJob, failBody, failJob, heartbeat } from '../services/jobs.js';
import { commentJson, getComment, getJobJson, getScene } from '../services/repo.js';
import { listSceneSummaries } from '../services/scene-view.js';
import { upsertScenes, upsertScenesBody } from '../services/scenes.js';
import { touchWorker, workerStatus } from '../services/worker.js';

function tokenOk(expected: string, header: string | undefined): boolean {
  if (!expected || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]!).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b); // so sánh thời gian hằng số
}

const workerIdOf = (req: FastifyRequest): string | null => {
  const q = (req.query as { worker?: string } | undefined)?.worker;
  const h = req.headers['x-worker-id'];
  const body = (req.body as { worker?: unknown } | undefined)?.worker;
  const v = q ?? (Array.isArray(h) ? h[0] : h) ?? (typeof body === 'string' ? body : undefined);
  return v ? String(v).slice(0, 100) : null;
};

/** API cho worker (Claude Code). Mọi route yêu cầu `Authorization: Bearer <WORKER_TOKEN>`. */
export function registerWorkerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (w) => {
    w.addHook('preHandler', async (req) => {
      if (!tokenOk(ctx.config.workerToken, req.headers.authorization)) {
        throw new AppError('UNAUTHORIZED', 'Thiếu hoặc sai WORKER_TOKEN (header Authorization: Bearer <token>)', 401);
      }
      touchWorker(ctx, workerIdOf(req));
    });

    w.get('/api/worker/ping', async () => ({ ok: true, server_time: ctx.now(), ...workerStatus(ctx) }));

    // Nhận (claim) job tiếp theo: 200 + job | 204 không có việc | 503 QUEUE_PAUSED
    w.get('/api/worker/next', async (req, reply) => {
      const job = claimNext(ctx, workerIdOf(req));
      if (!job) return reply.code(204).send();
      return job;
    });

    w.get('/api/worker/jobs/:id', async (req) => getJobJson(ctx, intParam((req.params as { id: string }).id)));

    w.post('/api/worker/jobs/:id/heartbeat', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      return heartbeat(ctx, id, workerIdOf(req));
    });

    w.post('/api/worker/jobs/:id/complete', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      const body = parse(completeBody, req.body ?? {});
      return { job: completeJob(ctx, id, body) };
    });

    w.post('/api/worker/jobs/:id/fail', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      const body = parse(failBody, req.body ?? {});
      return { job: failJob(ctx, id, body), worker: workerStatus(ctx) };
    });

    // Tạo/cập nhật hàng loạt cảnh sau analyze_brief
    w.post('/api/worker/scenes', async (req) => {
      const body = parse(upsertScenesBody, req.body);
      const r = upsertScenes(ctx, body);
      return { created: r.created, updated: r.updated, skipped: r.skipped, scenes: listSceneSummaries(ctx, body.project_id) };
    });

    // Claude trả lời / ghi chú vào cảnh
    w.post('/api/worker/comments', async (req, reply) => {
      const body = parse(
        z.object({
          scene_id: z.number().int(),
          asset_id: z.number().int().nullable().optional(),
          body: z.string().trim().min(1).max(5000),
          action: z.enum(COMMENT_ACTIONS).optional(),
          timecode: z.number().min(0).nullable().optional(),
        }),
        req.body,
      );
      getScene(ctx, body.scene_id);
      const r = createComment(
        ctx,
        body.scene_id,
        { body: body.body, asset_id: body.asset_id ?? null, timecode: body.timecode ?? null, action: 'note' },
        'claude',
      );
      return reply.code(201).send({ comment: commentJson(getComment(ctx, r.commentId)) });
    });
  });
}
