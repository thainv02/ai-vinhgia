import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import { DATA_DIR, ENV_FILE, assertLanConfig, loadConfig } from './config.js';
import { backupDb } from './db/index.js';
import { ensureLanAccessCode, ensureWorkerToken, loadDotEnv } from './lib/env.js';
import { createRotatingLog, type RotatingLog } from './lib/log-file.js';
import { buildLanApp } from './lan/app.js';
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
  // LAN bật + LAN_REQUIRE_CODE=true mà chưa có mã truy cập: sinh ngẫu nhiên và ghi vào .env (giống WORKER_TOKEN).
  // LAN tắt, hoặc không đòi mã (mặc định): không sinh mã, không động vào .env.
  let lanCodeGenerated = false;
  const early = loadConfig();
  if (early.lanEnabled && early.lanRequireCode && !(process.env.LAN_ACCESS_CODE ?? '').trim()) {
    ensureLanAccessCode(envFile);
    lanCodeGenerated = true;
  }
  const config = loadConfig();
  assertLanConfig(config);

  // Production: mức warn, ghi file logs/server.log (xoay vòng ~5 file × 5MB), không in ra console. Dev: như cũ.
  // Sao lưu trước migration nằm trong buildApp (chỉ khi có migration đang chờ).
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

  let lan: FastifyInstance | null = null;
  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: đang tắt server...`);
    await lan?.close(); // đóng listener LAN trước khi app chính đóng DB
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
  if (config.lanEnabled) {
    // Listener LAN riêng (chỉ route planner). Lỗi mở cổng LAN không được làm sập app chính đang chạy.
    try {
      lan = await buildLanApp(app.ctx);
      await lan.listen({ port: config.lanPort, host: config.lanHost });
      app.ctx.lan = { listening: true, host: config.lanHost, port: config.lanPort, error: null };
      app.log.info(`Trang planner LAN sẵn sàng tại http://${config.lanHost}:${config.lanPort} (${config.lanRequireCode ? 'cần mã truy cập: xem trong app chính hoặc .env' : 'không cần mã truy cập'})`);
      if (lanCodeGenerated) app.log.info(`Đã tạo LAN_ACCESS_CODE mới và ghi vào ${path.relative(DATA_DIR, envFile)}`);
    } catch (err) {
      app.ctx.lan = { listening: false, host: config.lanHost, port: config.lanPort, error: (err as Error).message };
      app.log.error({ err }, 'Không bật được listener LAN; app chính vẫn chạy');
      await lan?.close().catch(() => undefined);
      lan = null;
    }
  }
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
