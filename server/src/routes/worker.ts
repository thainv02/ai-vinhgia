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
import { assertLease, assertManagedLease, saveCheckpoint, waitJob, actionJournal, actions, browserLease, completionHash, stampProvenance } from '../services/managed.js';
import { infer } from '../services/ai/router.js';
import { JOB_TYPES } from '../db/types.js';

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
const ownerOf = (req: FastifyRequest) => ({ worker: workerIdOf(req), lease: typeof req.headers['x-job-lease'] === 'string' ? req.headers['x-job-lease'] : null });

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
      const query = req.query as { mode?: string; types?: string };
      const managed = query.mode === 'managed';
      if (managed !== (ctx.config.workerMode === 'managed')) throw new AppError('WORKER_MODE', 'WORKER_MODE của server không khớp worker', 409);
      const types = query.types ? parse(z.array(z.enum(JOB_TYPES)), query.types.split(',')) : undefined;
      if (managed && !workerIdOf(req)) throw new AppError('WORKER_REQUIRED', 'Managed worker phải có worker ID');
      const job = claimNext(ctx, workerIdOf(req), { managed, types });
      if (!job) return reply.code(204).send();
      return job;
    });

    w.get('/api/worker/jobs/:id', async (req) => getJobJson(ctx, intParam((req.params as { id: string }).id)));

    w.post('/api/worker/jobs/:id/heartbeat', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      return ctx.tx(() => { assertLease(ctx, id, ownerOf(req)); return heartbeat(ctx, id, workerIdOf(req)); });
    });

    w.post('/api/worker/jobs/:id/complete', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      const body = parse(completeBody, req.body ?? {});
      return ctx.tx(() => {
        const job = assertLease(ctx, id, ownerOf(req), true);
        const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
        const hash = completionHash(body);
        if (job.status === 'done') {
          if (key && job.completion_key === key && job.completion_hash === hash) return { job: getJobJson(ctx, id) };
          throw new AppError('ALREADY_COMPLETED', 'Job đã hoàn thành', 409);
        }
        if (job.worker_mode === 'managed' && !key) throw new AppError('IDEMPOTENCY_REQUIRED', 'Managed complete cần Idempotency-Key');
        completeJob(ctx, id, body, job.worker_mode === 'managed' ? 'agent' : 'claude');
        if (job.worker_mode === 'managed') stampProvenance(ctx, id, job.scene_id ? [job.scene_id] : []);
        ctx.db.prepare('UPDATE jobs SET completion_key=?,completion_hash=? WHERE id=?').run(key, hash, id);
        ctx.db.prepare("UPDATE external_actions SET state='committed',updated_at=? WHERE job_id=? AND state='downloaded'").run(ctx.now(), id);
        ctx.db.prepare('DELETE FROM browser_leases WHERE job_id=?').run(id);
        return { job: getJobJson(ctx, id) };
      });
    });

    w.post('/api/worker/jobs/:id/fail', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      const body = parse(failBody, req.body ?? {});
      return ctx.tx(() => { assertLease(ctx, id, ownerOf(req)); return { job: failJob(ctx, id, body), worker: workerStatus(ctx) }; });
    });

    // Tạo/cập nhật hàng loạt cảnh sau analyze_brief
    w.post('/api/worker/scenes', async (req) => {
      const body = parse(upsertScenesBody, req.body);
      return ctx.tx(() => {
        if (ctx.config.workerMode === 'managed') {
          const job = assertManagedLease(ctx, Number(req.headers['x-job-id']), ownerOf(req));
          if (job.type !== 'analyze_brief' || job.project_id !== body.project_id) throw new AppError('JOB_SCOPE', 'Không được ghi cảnh của job khác', 409);
        }
        const r = upsertScenes(ctx, body, ctx.config.workerMode === 'managed' ? 'agent' : 'claude');
        if (ctx.config.workerMode === 'managed') stampProvenance(ctx, Number(req.headers['x-job-id']), r.sceneIds);
        return { created: r.created, updated: r.updated, skipped: r.skipped, scenes: listSceneSummaries(ctx, body.project_id) };
      });
    });

    // Worker trả lời / ghi chú vào cảnh
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
      const result = ctx.tx(() => {
        const scene = getScene(ctx, body.scene_id);
        if (ctx.config.workerMode === 'managed') {
          const job = assertManagedLease(ctx, Number(req.headers['x-job-id']), ownerOf(req));
          if (job.project_id !== scene.project_id || (job.scene_id && job.scene_id !== scene.id)) throw new AppError('JOB_SCOPE', 'Comment không thuộc phạm vi job', 409);
        }
        const r = createComment(
          ctx,
          body.scene_id,
          { body: body.body, asset_id: body.asset_id ?? null, timecode: body.timecode ?? null, action: 'note' },
          ctx.config.workerMode === 'managed' ? 'agent' : 'claude',
        );
        if (ctx.config.workerMode === 'managed') stampProvenance(ctx, Number(req.headers['x-job-id']), [], r.commentId);
        return { comment: commentJson(getComment(ctx, r.commentId)) };
      });
      return reply.code(201).send(result);
    });

    w.post('/api/worker/jobs/:id/checkpoint', async (req) => saveCheckpoint(ctx, intParam((req.params as { id: string }).id), ownerOf(req),
      parse(z.record(z.string(), z.unknown()), req.body)));
    w.post('/api/worker/jobs/:id/wait', async (req) => {
      const b = parse(z.object({ reason: z.enum(['ai_quota', 'needs_reconciliation', 'browser_offline']), retry_at: z.string().datetime().nullable() }), req.body);
      if (b.reason === 'ai_quota' && (!b.retry_at || Date.parse(b.retry_at) <= ctx.clock.now())) throw new AppError('INVALID_WAIT', 'Quota wait cần thời điểm thử lại trong tương lai');
      return waitJob(ctx, intParam((req.params as { id: string }).id), ownerOf(req), b.reason, b.retry_at);
    });
    w.get('/api/worker/jobs/:id/actions', async (req) => actions(ctx, intParam((req.params as { id: string }).id)));
    w.post('/api/worker/jobs/:id/actions', async (req) => actionJournal(ctx, intParam((req.params as { id: string }).id), ownerOf(req), parse(z.object({
      id: z.string().min(1).max(150), profile: z.string().min(1).max(100), kind: z.enum(['storyboard', 'video']),
      state: z.enum(['intent', 'submitted', 'uncertain', 'downloaded', 'committed']), evidence: z.record(z.string(), z.unknown()),
    }), req.body)));
    w.post('/api/worker/jobs/:id/browser-lease', async (req) => browserLease(ctx, intParam((req.params as { id: string }).id), ownerOf(req), parse(z.object({ profile: z.string().min(1).max(100) }), req.body).profile));
    w.post('/api/worker/jobs/:id/infer', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
      const id = intParam((req.params as { id: string }).id);
      const job = assertManagedLease(ctx, id, ownerOf(req));
      const body = parse(z.object({ messages: z.array(z.record(z.string(), z.unknown())).min(1).max(100), tools: z.array(z.record(z.string(), z.unknown())).max(20).default([]), capabilities: z.array(z.enum(['text', 'vision', 'tools'])).min(1).default(['text']) }), req.body);
      const response = await infer(ctx, id, job.project_id, body.messages, body.tools, body.capabilities);
      assertLease(ctx, id, ownerOf(req));
      return response;
    });
  });
}
