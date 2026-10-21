import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDb, runMigrations } from '../src/db/index.js';
import { claim, finish, makeEnv, setupProject, toStoryboardReview, toVideoReview, userClient, writeFile, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const logPath = (slug = 'cacao-actiso-plus') => path.join(env.root, 'output', slug, 'log.md');

describe('log.md', () => {
  it('mỗi asset storyboard/video mới từ worker thêm một dòng đúng bảng cũ; grid không có dòng riêng; header chỉ một lần', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    expect(fs.existsSync(logPath())).toBe(false);
    await toStoryboardReview(sc, id);
    expect(fs.readFileSync(logPath(), 'utf8')).toBe(
      '| clip | lần | loại | lỗi thấy được | kết luận |\n|---|---|---|---|---|\n| C1 | 1 | storyboard | ok | Chưa đánh giá |\n',
    );
    await toVideoReview(sc, id, { verdict: 'fix_in_edit', verdict_note: 'Chữ bị méo | xuống dòng\nthứ hai' });
    const lines = fs.readFileSync(logPath(), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('| C1 | 1 | video (Flow; 9:16, 10s, x1, 720p) | Chữ bị méo / xuống dòng thứ hai | Sửa khi dựng |');
    expect(lines.filter((l) => l.startsWith('| clip'))).toHaveLength(1);
    // lượt 2 của video
    await sc.user.post(`/api/scenes/${id}/comments`, { body: 'lại', action: 'regenerate_same' });
    await finish(sc, await claim(sc), { verdict: 'pass', verdict_note: 'tốt hơn' });
    const after = fs.readFileSync(logPath(), 'utf8').trimEnd().split('\n');
    expect(after.at(-1)).toBe('| C1 | 2 | video (Flow; 9:16, 10s, x1, 720p) | tốt hơn | Đạt |');
  });

  it('không ghi đè log.md có sẵn (dữ liệu cũ); chỉ nối thêm; log của dự án khác tách biệt theo slug', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const legacy = '| clip | lần | loại | lỗi thấy được | kết luận |\n|---|---|---|---|---|\n| C1 | 1 | storyboard | cũ | Đạt |';
    writeFile(env.root, 'output/cacao-actiso-plus/log.md', legacy); // không có newline cuối
    await toStoryboardReview(sc, sc.scenes[0].id);
    const text = fs.readFileSync(logPath(), 'utf8');
    expect(text.startsWith(legacy + '\n| C1 | 1 | storyboard | ok |')).toBe(true);
    const other = await setupProject(env, { scenes: 1, project: { name: 'Dự án khác' } });
    await toStoryboardReview(other, other.scenes[0].id);
    expect(fs.existsSync(logPath('du-an-khac'))).toBe(true);
    expect(fs.readFileSync(logPath('du-an-khac'), 'utf8').split('\n').filter((l) => l.startsWith('| C1')).length).toBe(1);
  });

  it('GET /api/projects/:id/log.md sinh từ assets (tải về, markdown)', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await toVideoReview(sc, sc.scenes[0].id, { verdict_note: 'ổn' });
    const r = await userClient(env.app).get(`/api/projects/${sc.project.id}/log.md`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/markdown');
    expect(r.headers['content-disposition']).toBe('attachment; filename="log-cacao-actiso-plus.md"');
    expect(r.raw).toBe(
      '| clip | lần | loại | lỗi thấy được | kết luận |\n|---|---|---|---|---|\n' +
        '| C1 | 1 | storyboard | ok | Chưa đánh giá |\n' +
        '| C1 | 1 | video (Flow; 9:16, 10s, x1, 720p) | ổn | Đạt |\n',
    );
  });
});

describe('sổ cái credit', () => {
  it('ledger.csv: UTF-8 có BOM, header tiếng Việt, escape đúng dấu phẩy/ngoặc kép; lũy kế đã dùng khớp', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await toVideoReview(sc, sc.scenes[0].id);
    env.ctx.db
      .prepare('INSERT INTO credit_ledger (project_id, scene_id, delta, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sc.project.id, sc.scenes[1].id, -5, 'có "ngoặc kép", dấu phẩy\nvà xuống dòng', env.ctx.now());
    const r = await userClient(env.app).get(`/api/projects/${sc.project.id}/ledger.csv`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="ledger-cacao-actiso-plus.csv"');
    expect(r.raw.charCodeAt(0)).toBe(0xfeff);
    const lines = r.raw.slice(1).split('\r\n');
    expect(lines[0]).toBe('STT,Thời gian,Cảnh,Job,Credit,Lũy kế đã dùng,Ghi chú');
    expect(lines[1]).toMatch(/^1,2026-01-01T00:00:00\.000Z,C1,\d+,-15,15,Video C1 lượt 1 \(job #\d+\)$/);
    expect(lines[2]).toBe('2,2026-01-01T00:00:00.000Z,C2,,-5,20,"có ""ngoặc kép"", dấu phẩy\nvà xuống dòng"');
    expect(lines.at(-1)).toBe('');
  });

  it('GET /ledger: tổng hợp và danh sách có số dư chạy', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video' });
    const l = (await sc.user.get(`/api/projects/${sc.project.id}/ledger`)).body;
    expect(l.totals).toEqual({ used: 0, reserved: 15 });
    expect(l.entries).toEqual([]);
  });
});

describe('DB: migration, ràng buộc, sao lưu', () => {
  it('migration chạy lặp lại không đổi gì và ghi schema_migrations', async () => {
    expect(runMigrations(env.ctx.db)).toEqual([]);
    const rows = env.ctx.db.prepare('SELECT version FROM schema_migrations').all();
    expect(rows).toEqual([{ version: '001_init' }, { version: '002_ref_library' }, { version: '003_final_cuts' }, { version: '004_watermark' }, { version: '005_managed_workers' }, { version: '006_account_identity' }]);
    const pragma = env.ctx.db.pragma('journal_mode', { simple: true });
    expect(pragma).toBe('wal');
    expect(env.ctx.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(env.ctx.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM worker_state').get()).toEqual({ n: 1 });
  });

  it('CHECK constraint chặn giá trị enum sai; ext_key UNIQUE (nhiều NULL vẫn được)', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const db = env.ctx.db;
    expect(() => db.prepare("UPDATE scenes SET status = 'bay_mau' WHERE id = ?").run(sc.scenes[0].id)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO jobs (project_id, type, status, created_at) VALUES (?, 'x', 'queued', 'now')").run(sc.project.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE projects SET status = 'zzz' WHERE id = ?").run(sc.project.id)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO worker_state (id) VALUES (2)").run()).toThrow();
    const ins = (k: string | null) =>
      db.prepare("INSERT INTO credit_ledger (project_id, delta, note, created_at, ext_key) VALUES (?, -1, 'x', 'now', ?)").run(sc.project.id, k);
    ins(null);
    ins(null);
    ins('k1');
    expect(() => ins('k1')).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO scenes (project_id, code, status, created_at, updated_at) VALUES (?, 'C1', 'draft', 'a', 'b')").run(sc.project.id)).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('cacao-actiso-plus', 'x', 'a', 'b')").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO scenes (project_id, code, created_at, updated_at) VALUES (999, 'Z', 'a', 'b')").run()).toThrow(/FOREIGN KEY/);
  });

  it('sao lưu db.backup() vào <thư mục DB>/backup, giữ 20 bản mới nhất', async () => {
    await setupProject(env, { scenes: 1 });
    const t0 = Date.parse('2026-02-01T00:00:00Z');
    let last = '';
    for (let i = 0; i < 23; i++) last = await backupDb(env.ctx.db, env.dbPath, 20, new Date(t0 + i * 1000));
    const dir = path.join(path.dirname(env.dbPath), 'backup');
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(20);
    expect(files[0]).toMatch(/^test-2026-02-01T00-00-03/);
    expect(path.basename(last)).toBe(files.at(-1));
    // bản sao lưu mở được và có dữ liệu
    const { default: Database } = await import('better-sqlite3');
    const copy = new Database(last, { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM scenes').get() as { n: number }).n).toBe(1);
    copy.close();
  });
});
