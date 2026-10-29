import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

/** Thư mục migrations của mã nguồn (chỉ dùng khi chạy dev/test; bản build nhúng sẵn qua `__EMBEDDED_MIGRATIONS__`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface Migration {
  /** Tên file bỏ đuôi, vd `001_init`. */
  version: string;
  sql: string;
}

/** Danh sách migration nhúng lúc build (esbuild `define`); không có khi chạy từ mã nguồn. */
declare const __EMBEDDED_MIGRATIONS__: Migration[] | undefined;

/** Đọc các file NNN_*.sql trong thư mục, sắp theo tên. */
export function loadMigrationsFromDir(dir: string): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/** Migration mặc định: bản nhúng trong bundle, nếu không thì đọc từ `server/migrations/`. */
export function defaultMigrations(): Migration[] {
  return typeof __EMBEDDED_MIGRATIONS__ !== 'undefined' ? __EMBEDDED_MIGRATIONS__ : loadMigrationsFromDir(MIGRATIONS_DIR);
}

const asMigrations = (m: Migration[] | string): Migration[] => (typeof m === 'string' ? loadMigrationsFromDir(m) : m);

/** Các version chưa áp dụng (bảng schema_migrations chưa có = chưa áp dụng cái nào). */
export function pendingMigrations(db: DB, migrations: Migration[] | string = defaultMigrations()): string[] {
  const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const done = new Set(hasTable ? (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version) : []);
  return asMigrations(migrations)
    .map((m) => m.version)
    .filter((v) => !done.has(v));
}

/** DB rỗng = chưa có bảng nào ngoài schema_migrations (DB mới tạo). */
export function isDbEmpty(db: DB): boolean {
  return !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' LIMIT 1").get();
}

/** Số bản sao lưu trước migration được giữ lại. */
export const PRE_MIGRATION_KEEP = 3;

/**
 * Sao lưu TRƯỚC khi migrate: chỉ khi có migration đang chờ và DB không rỗng. Chờ backup xong rồi mới trả về;
 * thất bại thì ném lỗi (người gọi không được migrate). Trả về đường dẫn bản sao lưu, hoặc null nếu không cần.
 * File: <thư mục DB>/backup/<tên DB>-pre-<version>-<timestamp>.db (version = migration mới nhất đang chờ).
 * Không bị xoay vòng của `backupDb`; giữ `PRE_MIGRATION_KEEP` bản mới nhất.
 */
export async function backupBeforeMigrate(db: DB, dbPath: string, migrations: Migration[] | string = defaultMigrations(), now = new Date()): Promise<string | null> {
  if (dbPath === ':memory:') return null;
  const pending = pendingMigrations(db, migrations);
  if (!pending.length || isDbEmpty(db)) return null;
  const dir = path.join(path.dirname(dbPath), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(dbPath).replace(/\.db$/, '');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${base}-pre-${pending[pending.length - 1]}-${stamp}.db`);
  await db.backup(dest);
  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}-pre-`) && f.endsWith('.db'))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - PRE_MIGRATION_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
  return dest;
}

/** Mở SQLite với WAL, foreign_keys, busy_timeout 5000. */
export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/**
 * Chạy các migration (`{version, sql}`, hoặc đường dẫn thư mục chứa NNN_*.sql) chưa áp dụng (ghi vào schema_migrations). Mỗi migration chạy trong MỘT transaction
 * `BEGIN IMMEDIATE` (kiểm tra "đã áp dụng chưa" cũng nằm trong transaction nên hai tiến trình khởi động cùng lúc không chạy trùng).
 *
 * Directive đặt ở các dòng comment đầu file:
 *   `-- migrate:foreign-keys-off`  tắt `PRAGMA foreign_keys` (PRAGMA này không đổi được trong transaction nên runner tắt TRƯỚC khi mở
 *   transaction) để dựng lại bảng theo quy trình 12 bước của SQLite (tạo bảng mới → chép → DROP → RENAME → tạo lại index).
 *   Trước khi commit runner chạy `PRAGMA foreign_key_check`; có vi phạm thì rollback toàn bộ. Luôn bật lại foreign_keys sau đó.
 */
export function runMigrations(db: DB, migrations: Migration[] | string = defaultMigrations()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const ran: string[] = [];
  for (const { version, sql } of asMigrations(migrations)) {
    const fkOff = /^--\s*migrate:foreign-keys-off\b/m.test(sql.split('\n').slice(0, 8).join('\n'));
    if (fkOff) db.pragma('foreign_keys = OFF');
    try {
      const applied = db
        .transaction((): boolean => {
          if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) return false;
          db.exec(sql);
          if (fkOff) {
            const bad = db.pragma('foreign_key_check') as { table: string; rowid: number; parent: string }[];
            if (bad.length) {
              throw new Error(`Migration ${version}: vi phạm khóa ngoại sau khi dựng lại bảng (${bad.slice(0, 3).map((b) => `${b.table}#${b.rowid}→${b.parent}`).join(', ')})`);
            }
          }
          db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
          return true;
        })
        .immediate();
      if (applied) ran.push(version);
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
  }
  return ran;
}

/** Sao lưu DB vào <thư mục DB>/backup/<tên>-<timestamp>.db, giữ `keep` bản mới nhất. */
export async function backupDb(db: DB, dbPath: string, keep = 20, now = new Date()): Promise<string> {
  const dir = path.join(path.dirname(dbPath), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(dbPath).replace(/\.db$/, '');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${base}-${stamp}.db`);
  await db.backup(dest);
  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}-`) && !f.startsWith(`${base}-pre-`) && f.endsWith('.db'))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
  return dest;
}
