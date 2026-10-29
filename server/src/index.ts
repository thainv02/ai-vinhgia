import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { DATA_DIR, ENV_FILE, loadConfig } from './config.js';
import { backupDb } from './db/index.js';
import { ensureWorkerToken, loadDotEnv } from './lib/env.js';
import { createRotatingLog, type RotatingLog } from './lib/log-file.js';
import { warmMediaBinaries } from './services/media.js';

const LOG_FILE = path.join(DATA_DIR, 'logs', 'server.log');
let fileLog: RotatingLog | null = null;

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  loadDotEnv(ENV_FILE);
  const generated = !process.env.WORKER_TOKEN;
  ensureWorkerToken(ENV_FILE);
  const config = loadConfig();

  // Production: mức warn, ghi file logs/server.log (xoay vòng ~5 file × 5MB), không in ra console. Dev: như cũ.
  const production = process.env.NODE_ENV === 'production';
  if (production) fileLog = createRotatingLog(LOG_FILE);

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

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: đang tắt server...`);
    await app.close();
    fileLog?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // kiểm tra trình dựng / xoá logo nền, không chặn việc mở cổng
  void app.ctx.finalRender!.status().then((fr) => app.log.info(`Trình dựng bản hoàn chỉnh: ${fr.active ?? 'không có'} — ${fr.reason}`));
  void app.ctx.finalRender!.watermarkStatus().then((wm) => app.log.info(`Xoá logo Veo: ${wm.active ? 'bật' : 'tắt'} — ${wm.reason}`));
  await app.listen({ port: config.port, host: config.host });
  void warmMediaBinaries(config); // tìm sẵn ffmpeg/ffprobe để lần dùng đầu không phải chờ
  app.log.info(`API sẵn sàng tại http://${config.host}:${config.port}${config.webDistDir ? ' (kèm giao diện web)' : ''}`);
  if (generated) app.log.info(`Đã tạo WORKER_TOKEN mới và ghi vào ${path.relative(DATA_DIR, ENV_FILE)}`);
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
