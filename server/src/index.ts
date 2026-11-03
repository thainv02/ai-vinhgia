import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import { DATA_DIR, ENV_FILE, assertLanConfig, loadConfig } from './config.js';
import { backupDb } from './db/index.js';
import { ensureWorkerToken, loadDotEnv } from './lib/env.js';
import { createRotatingLog, type RotatingLog } from './lib/log-file.js';
import { buildLanApp } from './lan/app.js';
import { startEmbeddedWorker, type EmbeddedWorker } from './services/embedded-worker.js';
import { stopHtmlPreview, startHtmlPreview } from './services/html/preview.js';
import { installHtmlValidator } from './services/html/engine/index.js';
import { warmMediaBinaries } from './services/media.js';

const LOG_FILE = path.join(DATA_DIR, 'logs', 'server.log');
let fileLog: RotatingLog | null = null;

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // AUTOVIDEO_ENV_FILE: dùng file .env khác (chạy thử với cấu hình tạm, không đụng .env thật).
  const envFile = process.env.AUTOVIDEO_ENV_FILE ? path.resolve(process.env.AUTOVIDEO_ENV_FILE) : ENV_FILE;
  loadDotEnv(envFile);
  const generated = !process.env.WORKER_TOKEN;
  ensureWorkerToken(envFile);
  const config = { ...loadConfig(), envFile };
  assertLanConfig(config);

  // Production: mức warn, ghi file logs/server.log (xoay vòng ~5 file × 5MB), không in ra console. Dev: như cũ.
  // Sao lưu trước migration nằm trong buildApp (chỉ khi có migration đang chờ).
  const production = process.env.NODE_ENV === 'production';
  if (production) fileLog = createRotatingLog(LOG_FILE);

  installHtmlValidator(); // lint thật (HyperFrames + bảo mật) cho phiên bản Video HTML; test tự gọi nếu cần
  const app = await buildApp({
    config,
    startTimers: true,
    ...(production ? { logLevel: process.env.LOG_LEVEL ?? 'warn', logStream: fileLog!.stream } : {}),
  });
  try {
    const dest = await backupDb(app.ctx.db, config.dbPath);
    app.log.info(`Đã sao lưu DB: ${path.relative(DATA_DIR, dest)}`);
  } catch (err) {
    app.log.error({ err }, 'Sao lưu DB thất bại');
  }

  let lan: FastifyInstance | null = null;
  let worker: EmbeddedWorker | null = null;
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal}: đang tắt server...`);
    await worker?.stop(); // dừng worker nhúng trước khi đóng API nó đang gọi
    await lan?.close(); // đóng listener LAN trước khi app chính đóng DB
    await stopHtmlPreview(app.ctx).catch(() => undefined);
    await app.close();
    fileLog?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Vỏ app desktop (Tauri) giữ pipe stdin: đóng cửa sổ thì pipe đóng → tắt gọn (Windows không gửi được SIGTERM cho tiến trình con).
  if (process.argv.includes('--exit-on-stdin-close')) {
    process.stdin.on('error', () => undefined);
    process.stdin.once('close', () => void shutdown('stdin đóng'));
    process.stdin.resume();
  }

  // kiểm tra trình dựng / xoá logo nền, không chặn việc mở cổng
  void app.ctx.finalRender!.status().then((fr) => app.log.info(`Trình dựng bản hoàn chỉnh: ${fr.active ?? 'không có'} — ${fr.reason}`));
  void app.ctx.finalRender!.watermarkStatus().then((wm) => app.log.info(`Xoá logo Veo: ${wm.active ? 'bật' : 'tắt'} — ${wm.reason}`));
  await app.listen({ port: config.port, host: config.host });
  void warmMediaBinaries(config); // tìm sẵn ffmpeg/ffprobe để lần dùng đầu không phải chờ
  app.log.info(`API nội bộ sẵn sàng tại http://${config.host}:${config.port}`);
  // Listener preview Video HTML (127.0.0.1) mở TRƯỚC listener giao diện để trang có sẵn origin cho frame-src. Lỗi không làm sập app.
  try {
    const pv = await startHtmlPreview(app.ctx);
    app.log.info(`Preview Video HTML sẵn sàng tại ${pv.origin}`);
  } catch (err) {
    app.log.error({ err }, 'Không bật được listener preview Video HTML; tab Video HTML sẽ không xem trước được');
  }
  // Listener giao diện (trang planner, chỉ 127.0.0.1). Vỏ Tauri chờ cổng này trả 200 rồi mới hiện trang.
  try {
    lan = await buildLanApp(app.ctx);
    await lan.listen({ port: config.lanPort, host: config.lanHost });
    app.ctx.lan = { listening: true, host: config.lanHost, port: config.lanPort, error: null };
    app.log.info(`Giao diện sẵn sàng tại http://${config.lanHost}:${config.lanPort}`);
  } catch (err) {
    app.ctx.lan = { listening: false, host: config.lanHost, port: config.lanPort, error: (err as Error).message };
    app.log.error({ err }, 'Không bật được listener giao diện');
    await lan?.close().catch(() => undefined);
    lan = null;
  }
  if (!config.aiApiKey) app.log.warn('Chưa có API key của máy chủ AI: các việc AI sẽ chờ tới khi nhập key trong Cài đặt');
  worker = await startEmbeddedWorker({ config, log: (level, msg) => app.log[level](msg) });
  app.log.info(`Worker AI nhúng đã chạy (AI: ${config.aiApiUrl}, model ${config.aiModel})`);
  if (generated) app.log.info(`Đã tạo WORKER_TOKEN mới và ghi vào ${path.relative(DATA_DIR, envFile)}`);
  app.log.info(`ROOT_DIR=${config.rootDir} | DB=${path.relative(DATA_DIR, config.dbPath)}`);
}

main().catch((err) => {
  console.error(err);
  // Production không có console: ghi thêm vào file log để người dùng/Tauri chỉ được vị trí lỗi
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ level: 60, time: Date.now(), msg: 'Server không khởi động được', err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) })}\n`);
  } catch {
    /* bỏ qua */
  }
  process.exit(1);
});
