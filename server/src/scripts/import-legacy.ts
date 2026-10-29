/**
 * `npm run import:legacy [-- --dir output/cacao-smoothie --db data/app.db]`
 * Nhập dữ liệu lần chạy tay đầu tiên (decisions §H). Chạy lặp lại an toàn (không tạo bản ghi trùng).
 * Đường dẫn tương đối của --dir/--db tính từ ROOT_DIR (giống DB_PATH), không phải thư mục hiện tại.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE, defaultConfig, loadConfig } from '../config.js';
import { AppContext } from '../context.js';
import { backupDb, openDb, runMigrations } from '../db/index.js';
import { systemClock } from '../lib/clock.js';
import { loadDotEnv } from '../lib/env.js';
import { DEFAULT_LEGACY_DIR, formatSummary, importLegacy } from '../services/legacy-import.js';
import { SseHub } from '../services/sse.js';

const USAGE = `Cách dùng: npm run import:legacy -- [--dir <thư mục>] [--db <file.db>]
  --dir     thư mục dữ liệu cũ, con trực tiếp của output/ (mặc định ${DEFAULT_LEGACY_DIR})
  --budget  (không còn dùng) hạn mức credit đã bị bỏ; nếu truyền sẽ in cảnh báo rồi bỏ qua
  --db      file SQLite (mặc định lấy từ DB_PATH trong .env, thường data/app.db); đường dẫn tương đối tính từ ROOT_DIR`;

function parseArgs(argv: string[]): { dir?: string; db?: string; help: boolean; budgetIgnored: boolean } {
  const out: { dir?: string; db?: string; help: boolean; budgetIgnored: boolean } = { help: false, budgetIgnored: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg !== '--dir' && arg !== '--budget' && arg !== '--db') throw new Error(`Tham số lạ: ${arg}\n${USAGE}`);
    value ??= argv[++i];
    if (value === undefined || value === '') throw new Error(`Thiếu giá trị cho ${arg}`);
    if (arg === '--dir') out.dir = value;
    else if (arg === '--db') out.db = value;
    else out.budgetIgnored = true; // --budget: bỏ qua giá trị (kể cả giá trị không hợp lệ)
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.budgetIgnored) console.warn('Cảnh báo: --budget không còn dùng (đã bỏ hạn mức credit), bỏ qua.');
  loadDotEnv(ENV_FILE);
  const loaded = loadConfig();
  const rootDir = loaded.rootDir;
  const dbPath = args.db ? path.resolve(rootDir, args.db) : loaded.dbPath;
  const config = { ...defaultConfig(rootDir, dbPath), workerToken: loaded.workerToken };

  const existed = dbPath !== ':memory:' && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    if (existed) {
      const dest = await backupDb(db, dbPath);
      console.log(`Đã sao lưu DB trước khi nhập: ${path.relative(rootDir, dest)}`);
    }
    const ctx = new AppContext(db, config, systemClock, new SseHub());
    const summary = importLegacy(ctx, { dir: args.dir });
    console.log(formatSummary(summary, path.relative(rootDir, dbPath) || dbPath));
    console.log('Nếu web đang mở, hãy tải lại trang để thấy dự án (lệnh này chạy ngoài server nên không đẩy SSE).');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`Lỗi: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
