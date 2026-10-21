import path from 'node:path';
import fs from 'node:fs';
import { buildApp } from './app.js';
import { REPO_ROOT, loadConfig } from './config.js';
import { openDb, backupDb } from './db/index.js';
import { ensureWorkerToken, loadDotEnv } from './lib/env.js';

async function main(): Promise<void> {
  const envFile = path.join(REPO_ROOT, '.env');
  loadDotEnv(envFile);
  const generated = !process.env.WORKER_TOKEN;
  ensureWorkerToken(envFile);
  const config = loadConfig();

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

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: đang tắt server...`);
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
  if (generated) app.log.info(`Đã tạo WORKER_TOKEN mới và ghi vào ${path.relative(REPO_ROOT, envFile)}`);
  app.log.info(`ROOT_DIR=${config.rootDir} | DB=${path.relative(REPO_ROOT, config.dbPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
