import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { assertLanConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { installBodyParsers } from '../lib/http.js';
import { registerErrorHandling } from '../routes/errors.js';
import { htmlPreviewOrigin } from '../services/html/preview.js';
import { registerLanRoutes } from './routes.js';
import { registerLanSecurity } from './security.js';

export interface BuildLanAppOptions {
  logger?: boolean;
  /** Test: nhận dòng log để kiểm tra không lộ cookie. */
  logStream?: { write(line: string): void };
}

/**
 * Listener giao diện (tên lịch sử "LAN"): một Fastify instance THỨ HAI trong cùng tiến trình, dùng chung AppContext (DB, đồng hồ, SSE)
 * với API chính, chỉ nghe 127.0.0.1. Chỉ đăng ký route planner (`registerLanRoutes`), KHÔNG import hay đăng ký bất kỳ route nào của
 * API chính (projects, scenes, jobs, worker, ai, files, stream, final-cuts).
 */
export async function buildLanApp(ctx: AppContext, opts: BuildLanAppOptions = {}): Promise<FastifyInstance> {
  assertLanConfig(ctx.config); // cổng trùng API chính: không bật
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'], ...(opts.logStream ? { stream: opts.logStream } : {}) },
    bodyLimit: 2 * 1024 * 1024, // JSON ≤ 2 MB
    trustProxy: false,
  });
  installBodyParsers(app);
  registerErrorHandling(app);
  registerLanSecurity(app, () => htmlPreviewOrigin(ctx));
  await app.register(multipart, {
    preservePath: true,
    // mỗi ảnh ≤ maxUploadBytes (10 MB), tối đa 12 ảnh mỗi request
    limits: { fileSize: ctx.config.maxUploadBytes, files: 12, fields: 40, parts: 60 },
  });
  await registerLanRoutes(app, ctx);
  return app;
}
