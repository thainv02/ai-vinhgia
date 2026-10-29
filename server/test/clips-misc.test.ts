import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseClipConfig } from '../src/config.js';
import { MIGRATIONS_DIR, openDb, runMigrations, type DB } from '../src/db/index.js';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { purgeProject, restoreProject } from '../src/services/trash.js';
import { makeEnv, userClient, type Env } from './helpers.js';
import { seedClipProject, sttConfig, startFakeStt, waitFor } from './helpers-clips.js';
import { clip as videoClip } from './helpers-video.js';

describe('cấu hình STT_* / CLIP_*', () => {
  it('mặc định: không có STT_URL → provider none; có STT_URL → omnix; giới hạn mặc định theo đặc tả', () => {
    const none = loadConfig({} as never);
    expect(none).toMatchObject({
      sttProvider: 'none',
      sttUrl: '',
      sttTenantId: 's-omnix-studio',
      sttTimeoutMs: 3_600_000,
      sttMaxRetries: 3,
      clipSourceMaxBytes: 4 * 1024 ** 3,
      clipSourceMaxS: 10_800,
      lanClipSourceMaxBytes: 2 * 1024 ** 3,
      lanClipSourceMaxS: 10_800,
      clipMinFreeGb: 10,
      lanClipSourceRetentionDays: 7,
      clipCaptionFont: 'Arial',
      clipFontsDir: null,
      clipFfmpegPath: null,
      sttRetryDelaysMs: [10_000, 30_000, 90_000],
    });
    const url = 'http://10.0.3.214:18085/v1/audio/transcriptions';
    expect(loadConfig({ STT_URL: url } as never)).toMatchObject({ sttProvider: 'omnix', sttUrl: url });
    expect(loadConfig({ STT_URL: url, STT_PROVIDER: 'none' } as never).sttProvider).toBe('none');
    expect(loadConfig({ STT_PROVIDER: 'omnix' } as never).sttProvider).toBe('none'); // thiếu URL thì không thể bật
    expect(loadConfig({ STT_URL: url, STT_PROVIDER: 'lạ' } as never).sttProvider).toBe('none');
  });
  it('đọc từng biến; giá trị sai quay về mặc định', () => {
    const c = parseClipConfig({
      STT_URL: 'http://x/v1/audio/transcriptions',
      STT_TENANT_ID: 't-1',
      STT_TIMEOUT_MS: '5000',
      STT_MAX_RETRIES: '0',
      CLIP_SOURCE_MAX_BYTES: '1000',
      CLIP_SOURCE_MAX_S: '60',
      LAN_CLIP_SOURCE_MAX_BYTES: '500',
      LAN_CLIP_SOURCE_MAX_S: '30',
      CLIP_MIN_FREE_GB: '0',
      LAN_CLIP_SOURCE_RETENTION_DAYS: '3',
      CLIP_CAPTION_FONT: 'Verdana',
      CLIP_FONTS_DIR: '/tmp/fonts',
      CLIP_FFMPEG_PATH: '/opt/ffmpeg-full',
    } as never);
    expect(c).toMatchObject({ sttTenantId: 't-1', sttTimeoutMs: 5000, sttMaxRetries: 0, clipSourceMaxBytes: 1000, clipSourceMaxS: 60, lanClipSourceMaxBytes: 500, lanClipSourceMaxS: 30, clipMinFreeGb: 0, lanClipSourceRetentionDays: 3, clipCaptionFont: 'Verdana', clipFontsDir: '/tmp/fonts', clipFfmpegPath: '/opt/ffmpeg-full' });
    const bad = parseClipConfig({ STT_TIMEOUT_MS: 'abc', CLIP_MIN_FREE_GB: '-5', LAN_CLIP_SOURCE_RETENTION_DAYS: '0', CLIP_SOURCE_MAX_S: '-1' } as never);
    expect(bad).toMatchObject({ sttTimeoutMs: 3_600_000, clipMinFreeGb: 10, lanClipSourceRetentionDays: 7, clipSourceMaxS: 10_800 });
  });
  it('.env.example ghi đủ các biến mới', () => {
    const ex = fs.readFileSync(path.resolve(MIGRATIONS_DIR, '..', '..', '.env.example'), 'utf8');
    for (const k of ['STT_PROVIDER', 'STT_URL', 'STT_TENANT_ID', 'STT_TIMEOUT_MS', 'STT_MAX_RETRIES', 'CLIP_SOURCE_MAX_BYTES', 'CLIP_SOURCE_MAX_S', 'LAN_CLIP_SOURCE_MAX_BYTES', 'LAN_CLIP_SOURCE_MAX_S', 'CLIP_MIN_FREE_GB', 'LAN_CLIP_SOURCE_RETENTION_DAYS', 'CLIP_CAPTION_FONT', 'CLIP_FONTS_DIR', 'CLIP_FFMPEG_PATH']) expect(ex, k).toContain(k);
    expect(ex).toContain('http://10.0.3.214:18085/v1/audio/transcriptions');
  });
});

describe('migration 014_clips', () => {
  let tmp: string;
  let db: DB;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-mig14-'));
  });
  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* đã đóng */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function upTo013(): DB {
    const dir = path.join(tmp, 'migs');
    fs.mkdirSync(dir);
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => /^\d+_.+\.sql$/.test(x) && x < '014')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const d = openDb(path.join(tmp, 'old.db'));
    runMigrations(d, dir);
    return d;
  }

  it('dựng lại jobs: giữ nguyên mọi dòng/cột (kể cả cột managed), bộ đếm AUTOINCREMENT, index, khóa ngoại tới jobs(id) ở MỌI bảng; thêm clip_plan; check sạch', () => {
    db = upTo013();
    const now = '2026-01-01T00:00:00.000Z';
    db.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', ?, ?)").run(now, now);
    db.prepare("INSERT INTO scenes (project_id, code, status, created_at, updated_at) VALUES (1, 'C1', 'done', ?, ?)").run(now, now);
    const ins = db.prepare("INSERT INTO jobs (project_id, scene_id, type, status, payload, created_at, lease_id, lease_epoch, worker_mode, wait_reason, next_attempt_at, checkpoint, completion_key, completion_hash) VALUES (1, ?, ?, ?, '{\"a\":1}', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run(1, 'video', 'done', now, 'lease-1', 3, 'managed', null, null, '{"step":"x"}', 'complete-1', 'hash1');
    ins.run(null, 'edit_plan', 'queued', now, null, 0, 'legacy', 'ai_quota', now, null, null, null);
    ins.run(null, 'analyze_brief', 'cancelled', now, null, 0, 'legacy', null, null, null, null, null);
    db.prepare('DELETE FROM jobs WHERE id = 3').run(); // bộ đếm AUTOINCREMENT (3) > max(id) (2)
    db.prepare("INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, created_at) VALUES (1, 1, 'video', 'output/p/video/C1_v1.mp4', 1, ?)").run(now);
    db.prepare("INSERT INTO credit_ledger (project_id, scene_id, job_id, delta, note, created_at) VALUES (1, 1, 1, -15, 'v', ?)").run(now);
    db.prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, job_id, created_by, created_at) VALUES (1, 1, 'planning', 's', 2, 'agent', ?)").run(now);
    db.prepare("INSERT INTO ai_accounts (alias, provider, base_url, model, created_at) VALUES ('a', 'codex', 'http://x', 'm', ?)").run(now);
    db.prepare("INSERT INTO ai_attempts (account_id, job_id, model, outcome, latency_ms, created_at) VALUES (1, 1, 'm', 'ok', 5, ?)").run(now);
    db.prepare("INSERT INTO external_actions (id, job_id, lease_epoch, profile, kind, state, created_at, updated_at) VALUES ('act', 1, 1, 'p', 'video', 'committed', ?, ?)").run(now, now);
    db.prepare("INSERT INTO browser_leases (profile, job_id, lease_id, expires_at) VALUES ('p', 2, 'l', ?)").run(now);
    db.prepare("INSERT INTO job_reconciliations (job_id, action_id, outcome, prev_state, created_at) VALUES (1, 'act', 'retry_download', 'uncertain', ?)").run(now);

    const jobsBefore = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    const seqBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get() as { seq: number }).seq;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const refTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES jobs(%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const countsBefore = Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
    expect(refTables).toEqual(['ai_attempts', 'assets', 'browser_leases', 'credit_ledger', 'external_actions', 'final_cuts', 'job_reconciliations']);
    expect(seqBefore).toBe(3);

    expect(runMigrations(db)).toEqual(['014_clips', '015_clip_captions']);
    expect(runMigrations(db)).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get() as { seq: number }).seq).toBe(3);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES jobs(%' ORDER BY name").all() as { name: string }[]).map((t) => t.name)).toEqual([...refTables, 'clips'].sort());
    const countsAfter = Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
    expect({ ...countsAfter, schema_migrations: 0 }).toEqual({ ...countsBefore, schema_migrations: 0 });
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' ORDER BY name").all() as { name: string }[]).map((i) => i.name)).toEqual(['idx_jobs_project', 'idx_jobs_scene', 'idx_jobs_status', 'idx_jobs_type_status']);
    // id không được cấp lại; loại mới nhận được; CHECK vẫn chặn loại lạ
    const next = Number(db.prepare("INSERT INTO jobs (project_id, type, created_at) VALUES (1, 'clip_plan', ?)").run(now).lastInsertRowid);
    expect(next).toBe(4);
    expect(() => db.prepare("INSERT INTO jobs (project_id, type, created_at) VALUES (1, 'khong_co', ?)").run(now)).toThrow(/CHECK/);
    // khóa ngoại vẫn trỏ đúng sang bảng jobs MỚI: xoá job 1 → assets.job_id thành NULL (ON DELETE SET NULL), external_actions bị xoá (CASCADE)
    db.prepare('DELETE FROM jobs WHERE id = 1').run();
    expect(db.prepare('SELECT job_id FROM assets').get()).toEqual({ job_id: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM external_actions').get() as { n: number }).n).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('projects.kind/stt_terms: dự án cũ thành scenes; CHECK chặn kind lạ; bảng mới có CHECK/UNIQUE/CASCADE đúng', () => {
    db = upTo013();
    const now = 'x';
    db.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('cu', 'Cũ', ?, ?)").run(now, now);
    runMigrations(db);
    expect(db.prepare('SELECT kind, stt_terms FROM projects').get()).toEqual({ kind: 'scenes', stt_terms: null });
    expect(() => db.prepare("UPDATE projects SET kind = 'video' WHERE id = 1").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO projects (slug, name, kind, stt_terms, created_at, updated_at) VALUES ('c', 'Clip', 'clips', 'A, B', ?, ?)").run(now, now);
    const pid = 2;
    expect(() => db.prepare("INSERT INTO source_videos (project_id, original_name, bytes, status, content_hash, created_at) VALUES (?, 'a', 1, 'lạ', 'h', ?)").run(pid, now)).toThrow(/CHECK/);
    db.prepare("INSERT INTO source_videos (project_id, path, original_name, bytes, content_hash, created_at) VALUES (?, 'p', 'a', 1, 'h', ?)").run(pid, now);
    const clipSql = "INSERT INTO clips (project_id, source_id, code, start_sentence, end_sentence, start_word, end_word, start_s, end_s, created_by, created_at, updated_at) VALUES (?, 1, ?, 0, 0, 0, 1, 0, 5, ?, ?, ?)";
    db.prepare(clipSql).run(pid, 'K1', 'agent', now, now);
    expect(() => db.prepare(clipSql).run(pid, 'K1', 'agent', now, now)).toThrow(/UNIQUE/); // mã duy nhất trong dự án
    expect(() => db.prepare(clipSql).run(pid, 'K2', 'robot', now, now)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE clips SET status = 'ready' WHERE id = 1").run()).toThrow(/CHECK/);
    const cutSql = "INSERT INTO clip_cuts (clip_id, project_id, version, status, aspect, start_s, end_s, created_at) VALUES (1, ?, ?, ?, ?, 0, 5, ?)";
    db.prepare(cutSql).run(pid, 1, 'rendering', '9:16', now);
    expect(() => db.prepare(cutSql).run(pid, 1, 'rendering', '9:16', now)).toThrow(/UNIQUE/);
    expect(() => db.prepare(cutSql).run(pid, 2, 'xong', '9:16', now)).toThrow(/CHECK/);
    expect(() => db.prepare(cutSql).run(pid, 2, 'ready', '4:3', now)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE clip_cuts SET progress = 101 WHERE id = 1").run()).toThrow(/CHECK/);
    // xoá dự án (xoá vĩnh viễn) dọn sạch nguồn, clip, bản dựng
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    for (const t of ['source_videos', 'clips', 'clip_cuts']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('thùng rác với dự án cắt clip', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv({ config: { clipMinFreeGb: 0 } });
  });
  afterEach(async () => {
    await thumbsIdle(env.ctx);
    await env.close();
  });
  const exists = (rel: string) => fs.existsSync(path.join(env.root, rel));
  const user = () => userClient(env.app);

  it('xoá → cả thư mục output/<slug>/clips (nguồn, transcript, clip) vào thùng rác; /files không phục vụ; khôi phục đúng chỗ cũ; xoá vĩnh viễn dọn sạch dòng DB', async () => {
    const s = seedClipProject(env, { name: 'Live bán hàng', video: { seconds: 20 } });
    const clip = (await user().post(`/api/projects/${s.projectId}/clips`, { start_word: 0, end_word: 23, title: 'Đoạn' })).body.clip;
    await thumbsIdle(env.ctx);
    expect((await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' })).status).toBe(201);
    await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut, (c) => c?.status === 'ready', 60_000);
    const files = [s.sourceRel, `output/${s.slug}/clips/transcript.json`, `output/${s.slug}/clips/clips/K1_v1.mp4`, `output/${s.slug}/clips/clips/K1_v1.srt`, `output/${s.slug}/clips/thumbs/K1.jpg`];
    for (const f of files) expect(exists(f), f).toBe(true);
    expect((await user().get(`/files/${s.sourceRel}`)).status).toBe(200);

    const r = await user().del(`/api/projects/${s.projectId}`, { confirm_name: 'Live bán hàng' });
    expect(r.status, r.raw).toBe(200);
    const p = env.ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(s.projectId) as any;
    for (const f of files) {
      expect(exists(f), f).toBe(false);
      expect(exists(path.posix.join(p.trash_path, 'output', path.posix.relative(`output/${s.slug}`, f))), f).toBe(true);
    }
    expect((await user().get(`/files/${s.sourceRel}`)).status).toBe(404);
    expect((await user().get(`/api/clip-projects/${s.projectId}`)).status).toBe(404);
    expect((await user().get(`/api/clips/${clip.id}`)).status).toBe(404);
    expect(((await user().get('/api/projects')).body as any[]).map((x) => x.id)).not.toContain(s.projectId);
    // khôi phục: file về đúng chỗ cũ, dữ liệu đọc lại được
    restoreProject(env.ctx, s.projectId);
    for (const f of files) expect(exists(f), f).toBe(true);
    const d = (await user().get(`/api/clip-projects/${s.projectId}`)).body;
    expect(d.clips[0].latest_cut).toMatchObject({ status: 'ready', video_url: `/files/output/${s.slug}/clips/clips/K1_v1.mp4` });
    expect((await user().get(d.clips[0].latest_cut.video_url)).status).toBe(200);
    // xoá lại rồi xoá vĩnh viễn
    await user().del(`/api/projects/${s.projectId}`, { confirm_name: 'Live bán hàng' });
    purgeProject(env.ctx, s.projectId, { confirmName: 'Live bán hàng' });
    for (const t of ['projects', 'source_videos', 'clips', 'clip_cuts']) expect((env.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    expect(fs.existsSync(path.join(env.root, 'output', '.trash')) ? fs.readdirSync(path.join(env.root, 'output', '.trash')) : []).toEqual([]);
  }, 120_000);

  it('đang nhận dạng lời nói hoặc có job clip_plan đang chạy → không xoá được; job clip_plan còn xếp hàng bị hủy khi xoá', async () => {
    const fake = await startFakeStt();
    const e2 = await makeEnv({ config: sttConfig(fake) });
    try {
      const c = userClient(e2.app);
      const pid = (await c.post('/api/clip-projects', { name: 'Đang chạy' })).body.project.id;
      fake.hold();
      const { multipart } = await import('./helpers.js');
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: videoClip(3), type: 'video/mp4' }]);
      await e2.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      await waitFor(() => fake.calls.length, (n) => n >= 1, 10_000);
      const blocked = await c.del(`/api/projects/${pid}`, { confirm_name: 'Đang chạy' });
      expect([blocked.status, blocked.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
      expect(blocked.body.error.message).toMatch(/nhận dạng lời nói/);
      fake.release();
      await waitFor(async () => (await c.get(`/api/clip-projects/${pid}`)).body.source, (s) => s?.status === 'transcribed', 15_000);
      // job clip_plan xếp hàng: xoá được và job bị hủy
      const plan = await c.post(`/api/projects/${pid}/clip-plan`, {});
      expect(plan.status).toBe(201);
      expect((await c.del(`/api/projects/${pid}`, { confirm_name: 'Đang chạy' })).status).toBe(200);
      expect(e2.ctx.db.prepare('SELECT status FROM jobs WHERE id = ?').get(plan.body.job.id)).toEqual({ status: 'cancelled' });
      // job clip_plan đang chạy (claimed) chặn xoá
      restoreProject(e2.ctx, pid);
      const plan2 = await c.post(`/api/projects/${pid}/clip-plan`, {});
      const { workerClient } = await import('./helpers.js');
      expect((await workerClient(e2.app).get('/api/worker/next?worker=w1')).body.id).toBe(plan2.body.job.id);
      const b2 = await c.del(`/api/projects/${pid}`, { confirm_name: 'Đang chạy' });
      expect([b2.status, b2.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
      expect(b2.body.error.message).toMatch(/chọn đoạn clip từ video dài/);
    } finally {
      await e2.close();
      await fake.close();
    }
  });

  it('dự án đang tải video lên (tải dở) không xoá được', async () => {
    const s = seedClipProject(env, { video: false });
    const done = env.ctx.beginProjectUpload(s.projectId);
    const r = await user().del(`/api/projects/${s.projectId}`, { confirm_name: 'Phiên live cacao' });
    expect([r.status, r.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
    done();
    expect((await user().del(`/api/projects/${s.projectId}`, { confirm_name: 'Phiên live cacao' })).status).toBe(200);
  });
});
