import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { optionalIntParam } from '../lib/validate.js';
import { workerStatus } from '../services/worker.js';

/** `GET /api/stream?projectId=` — Server-Sent Events (không có projectId = nhận mọi dự án). */
export function registerStreamRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/stream', (req, reply) => {
    const projectId = optionalIntParam((req.query as { projectId?: string }).projectId, 'projectId') ?? null;
    // dự án trong thùng rác không có luồng sự kiện riêng (như mọi API: 404)
    if (projectId !== null && ctx.db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NOT NULL').get(projectId)) throw notFound('dự án');
    reply.hijack();
    ctx.sse.add(reply.raw, projectId, [{ event: 'worker.status', data: workerStatus(ctx) }]);
  });
}
