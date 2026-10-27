import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { defaultConfig, type Config } from './config.js';
import { AppContext } from './context.js';
import { openDb, runMigrations } from './db/index.js';
import { type Clock, systemClock } from './lib/clock.js';
import { installBodyParsers } from './lib/http.js';
import { registerErrorHandling } from './routes/errors.js';
import { registerClipRoutes } from './routes/clips.js';
import { registerColorRefRoutes } from './routes/color-refs.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFinalCutRoutes } from './routes/final-cuts.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerLanInfoRoute } from './routes/lan-info.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSceneRoutes } from './routes/scenes.js';
import { registerSecurity } from './routes/security.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerWorkerRoutes } from './routes/worker.js';
import { sweepStaleJobs } from './services/jobs.js';
import { recoverClipCuts } from './services/clips/render.js';
import { expireClipSources } from './services/clips/source.js';
import { SttService, type SttServiceOptions } from './services/clips/stt.js';
import { emitPlanningQueueChanges, recoverRenderingCuts } from './services/final-cuts.js';
import { FinalRenderService, type FinalRenderOptions, type Renderer } from './services/final-render/index.js';
import { expireToolJobs, recoverToolJobs } from './services/lan-tools.js';
import { backfillRefHashes } from './services/refs.js';
import { SseHub } from './services/sse.js';
import { TRASH_SWEEP_INTERVAL_MS, trashMaintenance } from './services/trash.js';
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
  /** Tùy chọn của dịch vụ nhận dạng lời nói (test: fetch giả, sleep giả). */
  stt?: SttServiceOptions;
  /** true: bật timer quét job mất heartbeat (30s) và phát worker.status (10s). Test để false. */
  startTimers?: boolean;
}

export const SWEEP_INTERVAL_MS = 30_000;
export const WORKER_TICK_MS = 10_000;
/** Dọn việc công cụ LAN quá 7 ngày (xoá file, đánh dấu expired). */
export const TOOL_CLEANUP_INTERVAL_MS = 60 * 60_000;
/** Dọn video nguồn LAN quá hạn lưu và file tải dở của dự án cắt clip (mỗi giờ). */
export const CLIP_CLEANUP_INTERVAL_MS = 60 * 60_000;
/** Chu kỳ kiểm tra vị trí hàng đợi AI của các bản dựng đang `planning` để phát SSE `final_cut.updated` khi đổi. */
export const PLANNING_QUEUE_INTERVAL_MS = 3_000;

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
  ctx.stt = new SttService(ctx, opts.stt);
  recoverRenderingCuts(ctx); // bản đang `rendering` của tiến trình cũ (đã chết) → failed
  recoverClipCuts(ctx); // bản dựng clip đang `rendering` của tiến trình cũ → failed (dọn file dở)
  ctx.stt.recover(); // video đang nhận dạng của tiến trình cũ → xếp lại (thử lấy kết quả theo job id trước)
  recoverToolJobs(ctx); // việc công cụ LAN đang chờ/chạy của tiến trình cũ → failed (giữ input để thử lại)
  try {
    expireToolJobs(ctx);
  } catch (err) {
    console.error('[lan-tools] dọn việc hết hạn lỗi:', err);
  }

  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  }) as unknown as App;
  app.decorate('ctx', ctx);

  installBodyParsers(app); // JSON rỗng = {}, bỏ text/plain

  registerErrorHandling(app);
  registerSecurity(app, ctx);
  // preservePath: giữ nguyên filename gốc để tên có `..` / dấu phân cách bị từ chối (thay vì âm thầm cắt basename)
  await app.register(multipart, {
    preservePath: true,
    limits: { fileSize: config.maxUploadBytes, files: 20, fields: 40, parts: 80 },
  });
  registerProjectRoutes(app, ctx);
  registerTrashRoutes(app, ctx);
  registerSceneRoutes(app, ctx);
  registerFinalCutRoutes(app, ctx);
  registerClipRoutes(app, ctx);
  registerColorRefRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerWorkerRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerLanInfoRoute(app, ctx);
  registerStreamRoutes(app, ctx);
  await registerFileRoutes(app, ctx);

  const timers: NodeJS.Timeout[] = [];
  if (opts.startTimers) {
    // Thùng rác: lúc khởi động hoàn tất việc chuyển file dở (nếu có) và tự xoá vĩnh viễn dự án quá TRASH_RETENTION_DAYS; sau đó lặp mỗi giờ.
    const sweepTrash = (): void => {
      try {
        const r = trashMaintenance(ctx);
        if (r.moved || r.purged.length) app.log.info(`Thùng rác: hoàn tất chuyển ${r.moved} thư mục, xoá vĩnh viễn ${r.purged.length} dự án quá hạn`);
        for (const f of r.failed) app.log.error(`Thùng rác: không xoá vĩnh viễn được dự án #${f.id}: ${f.error}`);
      } catch (err) {
        app.log.error({ err }, 'Lỗi khi dọn thùng rác');
      }
    };
    sweepTrash();
    timers.push(
      setInterval(sweepTrash, TRASH_SWEEP_INTERVAL_MS),
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
      setInterval(() => {
        try {
          if (ctx.sse.size > 0) emitPlanningQueueChanges(ctx); // không ai nghe thì khỏi tính
        } catch (err) {
          app.log.error({ err }, 'Lỗi khi phát vị trí hàng đợi AI');
        }
      }, PLANNING_QUEUE_INTERVAL_MS),
      setInterval(() => {
        try {
          expireToolJobs(ctx);
        } catch (err) {
          app.log.error({ err }, 'Lỗi khi dọn việc công cụ LAN hết hạn');
        }
      }, TOOL_CLEANUP_INTERVAL_MS),
      setInterval(() => {
        try {
          const r = expireClipSources(ctx);
          if (r.expired || r.staleTmp) app.log.info(`Cắt clip: xoá ${r.expired} video nguồn LAN quá hạn, ${r.staleTmp} file tải dở`);
        } catch (err) {
          app.log.error({ err }, 'Lỗi khi dọn video nguồn cắt clip quá hạn');
        }
      }, CLIP_CLEANUP_INTERVAL_MS),
    );
    for (const t of timers) t.unref();
  }

  app.addHook('onClose', async () => {
    for (const t of timers) clearInterval(t);
    await ctx.stt?.close(); // dừng nhận dạng lời nói đang chạy (việc dở được khôi phục lúc khởi động lại)
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
