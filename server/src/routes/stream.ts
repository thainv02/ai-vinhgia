import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { optionalIntParam } from '../lib/validate.js';
import { workerStatus } from '../services/worker.js';

/** `GET /api/stream?projectId=` — Server-Sent Events (không có projectId = nhận mọi dự án). */
export function registerStreamRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/stream', (req, reply) => {
    const projectId = optionalIntParam((req.query as { projectId?: string }).projectId, 'projectId') ?? null;
    reply.hijack();
    ctx.sse.add(reply.raw, projectId, [{ event: 'worker.status', data: workerStatus(ctx) }]);
  });
}
