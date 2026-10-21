import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openDb, runMigrations, type DB } from '../src/db/index.js';

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-mig-'));
});
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* đã đóng */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Thư mục migrations chỉ gồm các file đã cho (copy từ migrations thật). */
function migDir(files: string[], extra: Record<string, string> = {}): string {
  const dir = path.join(tmp, 'migs-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(dir);
  for (const f of files) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  for (const [name, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

function seedOldDb(file: string): DB {
  const d = openDb(file);
  runMigrations(d, migDir(['001_init.sql', '002_ref_library.sql']));
  const now = '2026-01-01T00:00:00.000Z';
  d.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', ?, ?)").run(now, now);
  d.prepare("INSERT INTO scenes (project_id, code, status, created_at, updated_at) VALUES (1, 'C1', 'done', ?, ?)").run(now, now);
  const job = d.prepare(
    `INSERT INTO jobs (project_id, scene_id, type, status, payload, result, error, error_code, claimed_by, claimed_at, heartbeat_at, created_at, finished_at,
                       credits_cost, requires_approval, approved_at, requeue_count, last_requeued_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  job.run(1, 'storyboard', 'done', '{"a":1}', '{"ok":true}', null, null, 'w1', now, now, now, now, 0, 1, now, 0, null);
  job.run(1, 'video', 'done', '{"attempt":1}', '{"verdict":"pass"}', null, null, 'w1', now, now, now, now, 15, 1, now, 2, now);
  job.run(null, 'analyze_brief', 'failed', '{}', null, 'lỗi', 'OTHER', null, null, null, now, now, 0, 0, null, 0, null);
  job.run(1, 'revise_prompt', 'queued', '{}', null, null, null, null, null, null, now, null, 0, 0, null, 0, null);
  job.run(1, 'video', 'cancelled', '{}', null, null, null, null, null, null, now, now, 0, 1, now, 0, null); // id 5, sẽ xóa để bộ đếm > max(id)
  d.prepare('DELETE FROM jobs WHERE id = 5').run();
  d.prepare("INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, created_at) VALUES (1, 1, 'storyboard', 'output/p/storyboard/C1_storyboard.png', 1, ?)").run(now);
  d.prepare("INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, created_at) VALUES (1, 2, 'video', 'output/p/video/C1_v1.mp4', 1, ?)").run(now);
  d.prepare("INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, created_at) VALUES (1, NULL, 'grid', 'output/p/video/C1_v1_grid.jpg', 1, ?)").run(now);
  d.prepare("INSERT INTO credit_ledger (project_id, scene_id, job_id, delta, note, created_at) VALUES (1, 1, 2, -15, 'v1', ?)").run(now);
  d.prepare("INSERT INTO events (project_id, scene_id, type, message, created_at) VALUES (1, 1, 'x', 'y', ?)").run(now);
  return d;
}

describe('runner migration', () => {
  it('003 dựng lại bảng jobs: giữ nguyên dữ liệu, id, bộ đếm AUTOINCREMENT, index, khóa ngoại tới jobs(id); foreign_key_check và integrity_check sạch', () => {
    const file = path.join(tmp, 'old.db');
    db = seedOldDb(file);
    const jobsBefore = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    const assetsBefore = db.prepare('SELECT id, job_id FROM assets ORDER BY id').all();
    const ledgerBefore = db.prepare('SELECT id, job_id, delta FROM credit_ledger ORDER BY id').all();
    const seqBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get() as { seq: number }).seq;
    expect(seqBefore).toBe(5);
    expect(jobsBefore).toHaveLength(4);
    const otherBefore = {
      projects: db.prepare('SELECT * FROM projects').all(),
      scenes: db.prepare('SELECT * FROM scenes').all(),
      events: db.prepare('SELECT * FROM events').all(),
    };

    expect(runMigrations(db)).toEqual(['003_final_cuts', '004_watermark']);
    expect(runMigrations(db)).toEqual([]);

    expect(db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(db.prepare('SELECT id, job_id FROM assets ORDER BY id').all()).toEqual(assetsBefore); // job_id KHÔNG bị SET NULL
    expect(db.prepare('SELECT id, job_id, delta FROM credit_ledger ORDER BY id').all()).toEqual(ledgerBefore);
    expect(db.prepare('SELECT * FROM projects').all()).toEqual(otherBefore.projects);
    expect(db.prepare('SELECT * FROM scenes').all()).toEqual(otherBefore.scenes);
    expect(db.prepare('SELECT * FROM events').all()).toEqual(otherBefore.events);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // đã bật lại
    // bộ đếm AUTOINCREMENT giữ nguyên: job mới nhận id 6 (không tái dùng id 5 đã xóa)
    const now = '2026-01-02T00:00:00.000Z';
    const info = db.prepare("INSERT INTO jobs (project_id, type, created_at) VALUES (1, 'edit_plan', ?)").run(now);
    expect(Number(info.lastInsertRowid)).toBe(6);
    // CHECK mới: có edit_plan, vẫn chặn giá trị lạ
    expect(() => db.prepare("INSERT INTO jobs (project_id, type, created_at) VALUES (1, 'khong_co', ?)").run(now)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE jobs SET status = 'zzz' WHERE id = 1").run()).toThrow(/CHECK/);
    // index được dựng lại
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_jobs_status', 'idx_jobs_project', 'idx_jobs_scene', 'idx_jobs_type_status']));
    // khóa ngoại tới jobs vẫn hoạt động: xóa job → assets.job_id về NULL (ON DELETE SET NULL), ledger cũng vậy
    db.prepare('DELETE FROM jobs WHERE id = 2').run();
    expect(db.prepare('SELECT job_id FROM assets WHERE id = 2').get()).toEqual({ job_id: null });
    expect(db.prepare('SELECT job_id FROM credit_ledger WHERE id = 1').get()).toEqual({ job_id: null });
    // ON DELETE CASCADE từ scenes/projects vẫn có
    expect(() => db.prepare("INSERT INTO jobs (project_id, scene_id, type, created_at) VALUES (1, 999, 'video', ?)").run(now)).toThrow(/FOREIGN KEY/);
  });

  it('bảng final_cuts: CHECK enum, UNIQUE (project, version), UNIQUE ext_key (nhiều NULL ok), tiến độ 0–100, ON DELETE SET NULL với job', () => {
    db = openDb(path.join(tmp, 'new.db'));
    runMigrations(db);
    const now = 'now';
    db.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', ?, ?)").run(now, now);
    db.prepare("INSERT INTO jobs (project_id, type, created_at) VALUES (1, 'edit_plan', ?)").run(now);
    const ins = (v: Record<string, unknown> = {}) => {
      const row = { project_id: 1, version: 1, status: 'planning', selection_signature: 'sig', created_by: 'claude', created_at: now, ext_key: null, progress: null, renderer: null, job_id: null, ...v };
      return db
        .prepare('INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at, ext_key, progress, renderer, job_id) VALUES (@project_id, @version, @status, @selection_signature, @created_by, @created_at, @ext_key, @progress, @renderer, @job_id)')
        .run(row);
    };
    ins({ job_id: 1 });
    expect(() => ins({ version: 1 })).toThrow(/UNIQUE/);
    expect(() => ins({ version: 2, status: 'lạ' })).toThrow(/CHECK/);
    expect(() => ins({ version: 2, created_by: 'ai' })).toThrow(/CHECK/);
    expect(() => ins({ version: 2, renderer: 'melt' })).toThrow(/CHECK/);
    expect(() => ins({ version: 2, progress: 101 })).toThrow(/CHECK/);
    expect(() => ins({ version: 2, progress: -1 })).toThrow(/CHECK/);
    ins({ version: 2, ext_key: 'k', progress: 100, renderer: 'shotcut' });
    ins({ version: 3 }); // ext_key NULL nhiều lần
    ins({ version: 4 });
    expect(() => ins({ version: 5, ext_key: 'k' })).toThrow(/UNIQUE/);
    expect(() => ins({ version: 5, project_id: 99 })).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM jobs WHERE id = 1').run();
    expect(db.prepare('SELECT job_id FROM final_cuts WHERE version = 1').get()).toEqual({ job_id: null });
    db.prepare('DELETE FROM projects WHERE id = 1').run(); // cascade
    expect(db.prepare('SELECT COUNT(*) AS n FROM final_cuts').get()).toEqual({ n: 0 });
  });

  it('directive foreign-keys-off: vi phạm khóa ngoại sau migration → ROLLBACK toàn bộ, foreign_keys bật lại, không ghi schema_migrations', () => {
    db = seedOldDb(path.join(tmp, 'bad.db'));
    const dir = migDir(['001_init.sql', '002_ref_library.sql'], {
      '003_bad.sql': `-- migrate:foreign-keys-off
CREATE TABLE marker (id INTEGER);
UPDATE assets SET scene_id = 999 WHERE id = 1;
`,
    });
    expect(() => runMigrations(db, dir)).toThrow(/vi phạm khóa ngoại/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'marker'").all()).toEqual([]); // DDL cũng rollback
    expect(db.prepare('SELECT scene_id FROM assets WHERE id = 1').get()).toEqual({ scene_id: 1 });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = '003_bad'").all()).toEqual([]);
  });

  it('migration không có directive chạy với foreign_keys BẬT và lỗi giữa chừng thì rollback toàn bộ', () => {
    db = openDb(path.join(tmp, 'x.db'));
    const dir = migDir(['001_init.sql'], { '002_oops.sql': 'CREATE TABLE t1 (id INTEGER);\nINSERT INTO khong_co VALUES (1);\n' });
    expect(() => runMigrations(db, dir)).toThrow(/no such table/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't1'").all()).toEqual([]);
    expect(runMigrations(db, migDir(['001_init.sql']))).toEqual([]);
  });

  it('hai kết nối khởi động cùng lúc trên một file: migration chỉ áp dụng một lần (kiểm tra "đã áp dụng" nằm trong transaction)', () => {
    const file = path.join(tmp, 'race.db');
    db = openDb(file);
    const db2 = openDb(file);
    try {
      expect(runMigrations(db)).toEqual(['001_init', '002_ref_library', '003_final_cuts', '004_watermark']);
      expect(runMigrations(db2)).toEqual([]);
      expect((db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(4);
    } finally {
      db2.close();
    }
  });
});
