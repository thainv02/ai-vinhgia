import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

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
 * Chạy các file migrations/NNN_*.sql chưa áp dụng (ghi vào schema_migrations). Mỗi migration chạy trong MỘT transaction
 * `BEGIN IMMEDIATE` (kiểm tra "đã áp dụng chưa" cũng nằm trong transaction nên hai tiến trình khởi động cùng lúc không chạy trùng).
 *
 * Directive đặt ở các dòng comment đầu file:
 *   `-- migrate:foreign-keys-off`  tắt `PRAGMA foreign_keys` (PRAGMA này không đổi được trong transaction nên runner tắt TRƯỚC khi mở
 *   transaction) để dựng lại bảng theo quy trình 12 bước của SQLite (tạo bảng mới → chép → DROP → RENAME → tạo lại index).
 *   Trước khi commit runner chạy `PRAGMA foreign_key_check`; có vi phạm thì rollback toàn bộ. Luôn bật lại foreign_keys sau đó.
 */
export function runMigrations(db: DB, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
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
    .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.db'))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
  return dest;
}
