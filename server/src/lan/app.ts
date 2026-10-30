import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { assertLanConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { installBodyParsers } from '../lib/http.js';
import { registerErrorHandling } from '../routes/errors.js';
import { registerLanRoutes } from './routes.js';
import { registerLanSecurity } from './security.js';
import { LanSessions } from './session.js';

export interface BuildLanAppOptions {
  logger?: boolean;
  /** Test: nhận dòng log để kiểm tra không lộ mã truy cập/cookie. */
  logStream?: { write(line: string): void };
}

/**
 * Listener LAN: một Fastify instance THỨ HAI trong cùng tiến trình, dùng chung AppContext (DB, đồng hồ, SSE) với app chính.
 * Chỉ đăng ký route planner (`registerLanRoutes`), KHÔNG import hay đăng ký bất kỳ route nào của app chính (projects, scenes,
 * jobs, worker, ai, files, stream, final-cuts). App chính vẫn chỉ nghe 127.0.0.1 và kiểm tra Host/Origin như cũ.
 */
export async function buildLanApp(ctx: AppContext, opts: BuildLanAppOptions = {}): Promise<FastifyInstance> {
  assertLanConfig({ ...ctx.config, lanEnabled: true }); // cổng trùng app chính, hoặc LAN_REQUIRE_CODE=true mà mã yếu/trống: không bật
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
  const sessions = new LanSessions(() => ctx.clock.now());
  registerLanSecurity(app, sessions, ctx.config.lanAllowedHosts, ctx.config.lanRequireCode);
  await app.register(multipart, {
    preservePath: true,
    // mỗi ảnh ≤ maxUploadBytes (10 MB), tối đa 12 ảnh mỗi request
    limits: { fileSize: ctx.config.maxUploadBytes, files: 12, fields: 40, parts: 60 },
  });
  await registerLanRoutes(app, ctx, sessions);
  return app;
}
