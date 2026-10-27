import path from 'node:path';
import fs from 'node:fs';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import { REPO_ROOT, assertLanConfig, loadConfig } from './config.js';
import { openDb, backupDb } from './db/index.js';
import { ensureLanAccessCode, ensureWorkerToken, loadDotEnv } from './lib/env.js';
import { buildLanApp } from './lan/app.js';

async function main(): Promise<void> {
  // AUTOVIDEO_ENV_FILE: dùng file .env khác (chạy thử với cấu hình tạm, không đụng .env thật).
  const envFile = process.env.AUTOVIDEO_ENV_FILE ? path.resolve(process.env.AUTOVIDEO_ENV_FILE) : path.join(REPO_ROOT, '.env');
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

  // Snapshot the previous schema before buildApp applies migrations.
  if (fs.existsSync(config.dbPath)) {
    const before = openDb(config.dbPath);
    try { await backupDb(before, config.dbPath); } finally { before.close(); }
  }
  const app = await buildApp({ config, startTimers: true });
  try {
    const dest = await backupDb(app.ctx.db, config.dbPath);
    app.log.info(`Đã sao lưu DB: ${path.relative(REPO_ROOT, dest)}`);
  } catch (err) {
    app.log.error({ err }, 'Sao lưu DB thất bại');
  }

  let lan: FastifyInstance | null = null;
  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: đang tắt server...`);
    await lan?.close(); // đóng listener LAN trước khi app chính đóng DB
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // kiểm tra trình dựng (có thể mất vài giây vì chạy `--check` của Shotcut MCP) nhưng không chặn việc mở cổng
  void app.ctx.finalRender!.status().then((fr) => app.log.info(`Trình dựng bản hoàn chỉnh: ${fr.active ?? 'không có'} — ${fr.reason}`));
  void app.ctx.finalRender!.watermarkStatus().then((wm) => app.log.info(`Xoá logo Veo: ${wm.active ? 'bật' : 'tắt'} — ${wm.reason}`));
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`API sẵn sàng tại http://${config.host}:${config.port}${config.webDistDir ? ' (kèm giao diện web)' : ''}`);
  if (config.lanEnabled) {
    // Listener LAN riêng (chỉ route planner). Lỗi mở cổng LAN không được làm sập app chính đang chạy.
    try {
      lan = await buildLanApp(app.ctx);
      await lan.listen({ port: config.lanPort, host: config.lanHost });
      app.ctx.lan = { listening: true, host: config.lanHost, port: config.lanPort, error: null };
      app.log.info(`Trang planner LAN sẵn sàng tại http://${config.lanHost}:${config.lanPort} (${config.lanRequireCode ? 'cần mã truy cập: xem trong app chính hoặc .env' : 'không cần mã truy cập'})`);
      if (lanCodeGenerated) app.log.info(`Đã tạo LAN_ACCESS_CODE mới và ghi vào ${path.relative(REPO_ROOT, envFile)}`);
    } catch (err) {
      app.ctx.lan = { listening: false, host: config.lanHost, port: config.lanPort, error: (err as Error).message };
      app.log.error({ err }, 'Không bật được listener LAN; app chính vẫn chạy');
      await lan?.close().catch(() => undefined);
      lan = null;
    }
  }
  if (generated) app.log.info(`Đã tạo WORKER_TOKEN mới và ghi vào ${path.relative(REPO_ROOT, envFile)}`);
  app.log.info(`ROOT_DIR=${config.rootDir} | DB=${path.relative(REPO_ROOT, config.dbPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
