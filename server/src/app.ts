import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { defaultConfig, type Config } from './config.js';
import { AppContext } from './context.js';
import { openDb, runMigrations } from './db/index.js';
import { type Clock, systemClock } from './lib/clock.js';
import { AppError } from './lib/errors.js';
import { registerErrorHandling } from './routes/errors.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFinalCutRoutes } from './routes/final-cuts.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSceneRoutes } from './routes/scenes.js';
import { registerSecurity } from './routes/security.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerWorkerRoutes } from './routes/worker.js';
import { sweepStaleJobs } from './services/jobs.js';
import { recoverRenderingCuts } from './services/final-cuts.js';
import { FinalRenderService, type FinalRenderOptions, type Renderer } from './services/final-render/index.js';
import { backfillRefHashes } from './services/refs.js';
import { SseHub } from './services/sse.js';
import { workerStatusTick } from './services/worker.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildAppOptions {
  /** Đường dẫn file SQLite (mặc định <rootDir>/data/app.db). */
  dbPath?: string;
  /** Thư mục gốc chứa output/ và refs/ (mặc định thư mục hiện tại). */
  rootDir?: string;
  config?: Partial<Config>;
  clock?: Clock;
  logger?: boolean;
  /** Ép trình dựng bản hoàn chỉnh (test): bỏ qua FINAL_RENDERER / Shotcut / ffmpeg. */
  finalRenderer?: Renderer;
  /** Tùy chọn khác của dịch vụ render bản hoàn chỉnh (opener Shotcut, throttle progress, thời gian poll…). */
  finalRender?: Omit<FinalRenderOptions, 'renderer'>;
  /** true: bật timer quét job mất heartbeat (30s) và phát worker.status (10s). Test để false. */
  startTimers?: boolean;
}

export const SWEEP_INTERVAL_MS = 30_000;
export const WORKER_TICK_MS = 10_000;

export type App = FastifyInstance & { ctx: AppContext };

/** Dựng ứng dụng (mỗi lần gọi là một instance độc lập, test dùng DB/ROOT tạm). */
export async function buildApp(opts: BuildAppOptions = {}): Promise<App> {
  const rootDir = path.resolve(opts.config?.rootDir ?? opts.rootDir ?? process.cwd());
  const dbPath = path.resolve(opts.config?.dbPath ?? opts.dbPath ?? path.join(rootDir, 'data', 'app.db'));
  const config: Config = { ...defaultConfig(rootDir, dbPath), ...opts.config, rootDir, dbPath };
  fs.mkdirSync(rootDir, { recursive: true });

  const db = openDb(dbPath);
  runMigrations(db);
  const ctx = new AppContext(db, config, opts.clock ?? systemClock, new SseHub());
  backfillRefHashes(ctx); // migration 002: điền content_hash còn thiếu của ảnh tham chiếu
  ctx.finalRender = new FinalRenderService(ctx, { ...opts.finalRender, renderer: opts.finalRenderer });
  recoverRenderingCuts(ctx); // bản đang `rendering` của tiến trình cũ (đã chết) → failed

  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  }) as unknown as App;
  app.decorate('ctx', ctx);

  // JSON body rỗng (vd. POST không có thân nhưng vẫn gửi Content-Type: application/json) được coi là {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('INVALID_JSON', 'Nội dung JSON không hợp lệ', 400), undefined);
    }
  });

  // Chỉ nhận JSON (và multipart cho upload): bỏ parser text/plain mặc định để form chéo trang không gửi được "JSON giả".
  app.removeContentTypeParser('text/plain');

  registerErrorHandling(app);
  registerSecurity(app, ctx);
  // preservePath: giữ nguyên filename gốc để tên có `..` / dấu phân cách bị từ chối (thay vì âm thầm cắt basename)
  await app.register(multipart, {
    preservePath: true,
    limits: { fileSize: config.maxUploadBytes, files: 20, fields: 40, parts: 80 },
  });
  registerProjectRoutes(app, ctx);
  registerSceneRoutes(app, ctx);
  registerFinalCutRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerWorkerRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  await registerFileRoutes(app, ctx);

  const timers: NodeJS.Timeout[] = [];
  if (opts.startTimers) {
    timers.push(
      setInterval(() => {
        try {
          sweepStaleJobs(ctx);
        } catch (err) {
          app.log.error({ err }, 'Lỗi khi quét job mất heartbeat');
        }
      }, SWEEP_INTERVAL_MS),
      setInterval(() => {
        try {
          workerStatusTick(ctx);
        } catch (err) {
          app.log.error({ err }, 'Lỗi khi phát worker.status');
        }
      }, WORKER_TICK_MS),
    );
    for (const t of timers) t.unref();
  }

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    await ctx.finalRender?.close(); // dừng render đang chạy trước khi đóng DB
    ctx.sse.closeAll();
    try {
      db.close();
    } catch {
      /* đã đóng */
    }
  });

  return app;
}
