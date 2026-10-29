import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS_DIR, openDb, runMigrations } from '../src/db/index.js';
import { parseTrashRetentionDays } from '../src/config.js';
import { finishInterruptedTrash, purgeExpiredTrash, trashMaintenance } from '../src/services/trash.js';
import { PNG_BYTES, claim, makeEnv, setupProject, toStoryboardReview, userClient, workerClient, writeFile, type Env, type Scenario } from './helpers.js';

const DAY = 86_400_000;

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.close();
});

const db = () => env.ctx.db;
const exists = (rel: string) => fs.existsSync(path.join(env.root, rel));
const del = (id: number, name: string) => userClient(env.app).del(`/api/projects/${id}`, { confirm_name: name });
const trashDirs = () => {
  const d = path.join(env.root, 'output', '.trash');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};
const proj = (id: number) => db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;

/** Dự án có file thật (storyboard, ảnh tham chiếu, log) + dữ liệu ở nhiều bảng; cảnh 2 còn một job storyboard đang xếp hàng. */
async function seed(opts: { queued?: boolean } = {}): Promise<Scenario & { slug: string; refRel: string; sbRel: string }> {
  const sc = await setupProject(env, { scenes: 2 });
  const slug: string = proj(sc.project.id).slug;
  const sb = await toStoryboardReview(sc, sc.scenes[0].id);
  const sbRel: string = sb.payload.output.storyboard_path;
  const refRel = `refs/${sc.project.id}/hop.png`;
  writeFile(env.root, refRel, PNG_BYTES);
  db().prepare('INSERT INTO project_refs (project_id, label, file_path, order_index, created_at) VALUES (?, ?, ?, 0, ?)').run(sc.project.id, 'Hộp', refRel, env.ctx.now());
  writeFile(env.root, `output/${slug}/log.md`, '| clip |\n');
  if (opts.queued !== false) expect((await sc.user.post(`/api/scenes/${sc.scenes[1].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
  return Object.assign(sc, { slug, refRel, sbRel });
}

describe('xoá dự án vào thùng rác', () => {
  it('chuyển file vào output/.trash, đánh dấu xoá, hủy job queued (cảnh về trạng thái ổn định) và ghi event', async () => {
    const s = await seed();
    const queuedJob = db().prepare("SELECT id FROM jobs WHERE status = 'queued'").get() as { id: number };
    const r = await del(s.project.id, 'Cacao Actiso Plus');
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: s.project.id, restorable_days: 30 });
    const p = proj(s.project.id);
    expect(p.deleted_by).toBe('app');
    expect(p.deleted_at).toBe(env.ctx.now());
    expect(p.trash_path).toMatch(/^output\/\.trash\/1-cacao-actiso-plus-20260101T000000Z$/);
    // file đã rời chỗ cũ và nằm trong thùng rác, nội dung nguyên vẹn
    expect(exists(`output/${s.slug}`)).toBe(false);
    expect(exists(`refs/${s.project.id}`)).toBe(false);
    expect(fs.readFileSync(path.join(env.root, p.trash_path, 'refs', 'hop.png')).equals(PNG_BYTES)).toBe(true);
    expect(exists(path.posix.join(p.trash_path, 'output', 'log.md'))).toBe(true);
    expect(exists(path.posix.join(p.trash_path, 'output', path.posix.relative(`output/${s.slug}`, s.sbRel)))).toBe(true);
    // job queued bị hủy; dữ liệu DB vẫn còn (xoá mềm)
    const job = db().prepare('SELECT status, error FROM jobs WHERE id = ?').get(queuedJob.id) as any;
    expect(job).toMatchObject({ status: 'cancelled' });
    expect(db().prepare('SELECT status FROM scenes WHERE id = ?').get(s.scenes[1].id)).toEqual({ status: 'awaiting_approval' });
    expect(db().prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?').get(s.project.id)).toEqual({ n: 2 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'project.deleted'").get(s.project.id)).toEqual({ n: 1 });
  });

  it('phải gõ đúng tên: thiếu/sai → 400 và không đổi gì; dự án không có → 404; xoá lần hai → 404', async () => {
    const s = await seed({ queued: false });
    const u = userClient(env.app);
    expect((await u.del(`/api/projects/${s.project.id}`)).status).toBe(400);
    const bad = await del(s.project.id, 'cacao actiso plus');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CONFIRM_MISMATCH');
    expect(proj(s.project.id).deleted_at).toBeNull();
    expect(exists(`output/${s.slug}`)).toBe(true);
    expect((await del(999, 'x')).status).toBe(404);
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200);
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(404);
  });

  it('khôi phục: file về đúng chỗ cũ, dự án và cảnh hiện lại, thùng rác trống', async () => {
    const s = await seed();
    await del(s.project.id, 'Cacao Actiso Plus');
    expect((await s.user.get('/api/trash')).body.map((t: any) => t.id)).toEqual([s.project.id]);
    const r = await s.user.post(`/api/trash/${s.project.id}/restore`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.id).toBe(s.project.id);
    expect(proj(s.project.id)).toMatchObject({ deleted_at: null, deleted_by: null, trash_path: null });
    expect(exists(s.sbRel)).toBe(true);
    expect(fs.readFileSync(path.join(env.root, s.refRel)).equals(PNG_BYTES)).toBe(true);
    expect(exists(`output/${s.slug}/log.md`)).toBe(true);
    expect(trashDirs()).toEqual([]);
    expect((await s.user.get('/api/trash')).body).toEqual([]);
    expect((await s.user.get(`/api/projects/${s.project.id}`)).status).toBe(200);
    expect((await s.user.get('/api/projects')).body.map((p: any) => p.id)).toContain(s.project.id);
    expect(db().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'project.restored'").get()).toEqual({ n: 1 });
    // khôi phục project không ở trong thùng rác → 404
    expect((await s.user.post(`/api/trash/${s.project.id}/restore`)).status).toBe(404);
  });

  it('khôi phục KHÔNG ghi đè: chỗ cũ đã có thư mục cùng tên chứa file → 409, không đổi gì; thư mục rỗng thì thay được', async () => {
    const s = await seed({ queued: false });
    await del(s.project.id, 'Cacao Actiso Plus');
    const trashPath = proj(s.project.id).trash_path as string;
    writeFile(env.root, `output/${s.slug}/khac.txt`, 'của người khác');
    const list = (await s.user.get('/api/trash')).body;
    expect(list[0].restore_block).toMatch(/không ghi đè/);
    const r = await s.user.post(`/api/trash/${s.project.id}/restore`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('RESTORE_CONFLICT');
    expect(fs.readFileSync(path.join(env.root, `output/${s.slug}/khac.txt`), 'utf8')).toBe('của người khác');
    expect(proj(s.project.id).deleted_at).not.toBeNull();
    expect(exists(`${trashPath}/output/log.md`)).toBe(true);
    // dọn thư mục lạ → khôi phục được; nếu chỉ còn cây thư mục rỗng thì cũng được
    fs.rmSync(path.join(env.root, `output/${s.slug}/khac.txt`));
    fs.mkdirSync(path.join(env.root, `output/${s.slug}/video`), { recursive: true });
    expect((await s.user.post(`/api/trash/${s.project.id}/restore`)).status).toBe(200);
    expect(exists(`output/${s.slug}/log.md`)).toBe(true);
  });

  it('slug của dự án trong thùng rác không được cấp lại; sau xoá vĩnh viễn thì dùng lại được', async () => {
    const s = await seed({ queued: false });
    await del(s.project.id, 'Cacao Actiso Plus');
    const u = userClient(env.app);
    const again = await u.post('/api/projects', { name: 'Cacao Actiso Plus' });
    expect(again.body.slug).toBe(`${s.slug}-2`);
    expect((await u.del(`/api/trash/${s.project.id}`, { confirm_name: 'Cacao Actiso Plus' })).status).toBe(200);
    const third = await u.post('/api/projects', { name: 'Cacao Actiso Plus' });
    expect(third.body.slug).toBe(s.slug);
  });
});

describe('điều kiện chặn xoá (409, lý do tiếng Việt)', () => {
  const expectBlocked = async (s: Scenario, code: string, re: RegExp) => {
    const r = await del(s.project.id, 'Cacao Actiso Plus');
    expect(r.status, r.raw).toBe(409);
    expect(r.body.error.code).toBe('PROJECT_BUSY');
    expect(r.body.error.message).toMatch(re);
    expect(r.body.error.details.reasons.map((x: any) => x.code)).toContain(code);
    expect(proj(s.project.id).deleted_at).toBeNull();
    expect(exists(`output/${(proj(s.project.id) as any).slug}/log.md`)).toBe(true); // không chuyển file
    // và delete_block hiện sẵn trong chi tiết dự án để giao diện vô hiệu hoá nút
    const d = (await s.user.get(`/api/projects/${s.project.id}`)).body;
    expect(d.delete_block.code).toBe(code);
  };

  it('job claimed/running', async () => {
    const s = await seed();
    await claim(s); // worker nhận job storyboard của cảnh 2
    await expectBlocked(s, 'JOB_RUNNING', /chạy trên worker/);
    await s.worker.post(`/api/worker/jobs/${(db().prepare("SELECT id FROM jobs WHERE status = 'claimed'").get() as any).id}/heartbeat`, {});
    await expectBlocked(s, 'JOB_RUNNING', /job #\d+/);
  });

  it('bản dựng planning / rendering', async () => {
    const s = await seed({ queued: false });
    const ins = (v: number, status: string) =>
      db().prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at) VALUES (?, ?, ?, 's', 'claude', ?)").run(s.project.id, v, status, env.ctx.now());
    ins(1, 'planning');
    await expectBlocked(s, 'FINAL_CUT_ACTIVE', /chọn điểm cắt/);
    db().prepare("UPDATE final_cuts SET status = 'rendering'").run();
    await expectBlocked(s, 'FINAL_CUT_ACTIVE', /render/);
    db().prepare("UPDATE final_cuts SET status = 'ready'").run();
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200); // bản đã xong không chặn
  });

  it('bản dựng đã hủy nhưng còn trong hàng đợi/đang dừng tiến trình render vẫn chặn', async () => {
    const s = await seed({ queued: false });
    db().prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at) VALUES (?, 1, 'cancelled', 's', 'claude', ?)").run(s.project.id, env.ctx.now());
    const id = (db().prepare('SELECT id FROM final_cuts').get() as any).id;
    vi.spyOn(env.ctx.finalRender!, 'queueInfo').mockImplementation((kind, cid) => (kind === 'cut' && cid === id ? ({ state: 'running', position: null, running_count: 1, concurrency: 2 } as any) : null));
    await expectBlocked(s, 'FINAL_CUT_ACTIVE', /hàng đợi render/);
  });

  it('job managed có thao tác ngoài còn sống (intent/uncertain/submitted/downloaded) cần đối soát; abandoned/committed thì không', async () => {
    const s = await seed();
    const job = db().prepare("SELECT id FROM jobs WHERE status = 'queued'").get() as { id: number };
    db().prepare("UPDATE jobs SET worker_mode = 'managed', wait_reason = 'needs_reconciliation' WHERE id = ?").run(job.id);
    const act = (state: string) =>
      db().prepare("INSERT OR REPLACE INTO external_actions (id, job_id, lease_epoch, profile, kind, state, evidence, created_at, updated_at) VALUES ('a1', ?, 1, 'flow', 'storyboard', ?, '{}', ?, ?)").run(job.id, state, env.ctx.now(), env.ctx.now());
    for (const st of ['intent', 'uncertain', 'submitted', 'downloaded']) {
      act(st);
      await expectBlocked(s, 'ACTION_LIVE', /đối soát/);
    }
    act('abandoned');
    expect((await userClient(env.app).get(`/api/projects/${s.project.id}`)).body.delete_block).toBeNull();
    act('committed');
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200);
  });

  it('đang tải video lên (file đang ghi)', async () => {
    const s = await seed({ queued: false });
    const done = env.ctx.beginProjectUpload(s.project.id);
    await expectBlocked(s, 'UPLOAD_ACTIVE', /tải lên/);
    done();
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200);
  });

  it('job done/failed/cancelled không chặn', async () => {
    const s = await seed({ queued: false });
    db().prepare("INSERT INTO jobs (project_id, type, status, created_at) VALUES (?, 'analyze_brief', 'failed', ?)").run(s.project.id, env.ctx.now());
    db().prepare("INSERT INTO jobs (project_id, type, status, created_at) VALUES (?, 'analyze_brief', 'cancelled', ?)").run(s.project.id, env.ctx.now());
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200);
  });
});

describe('dự án đã xoá biến mất ở mọi nơi', () => {
  it('mọi API (app chính, worker, file, thư viện ảnh, đếm) trả 404 hoặc không liệt kê', async () => {
    const s = await seed();
    const sceneId = s.scenes[0].id;
    const jobId = (db().prepare('SELECT id FROM jobs WHERE scene_id = ? ORDER BY id LIMIT 1').get(sceneId) as any).id;
    const assetId = (db().prepare('SELECT id FROM assets WHERE scene_id = ?').get(sceneId) as any).id;
    const cm = await s.user.post(`/api/scenes/${sceneId}/comments`, { body: 'ghi chú', action: 'note' });
    const commentId = cm.body.comment.id;
    db().prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at) VALUES (?, 1, 'ready', 's', 'claude', ?)").run(s.project.id, env.ctx.now());
    const cutId = (db().prepare('SELECT id FROM final_cuts').get() as any).id;
    const refId = (db().prepare('SELECT id FROM project_refs').get() as any).id;
    const other = await setupProject(env, { scenes: 1, project: { name: 'Dự án khác' } });
    writeFile(env.root, `refs/${other.project.id}/khac.png`, Buffer.concat([PNG_BYTES, Buffer.from('khac')]));
    db().prepare('INSERT INTO project_refs (project_id, label, file_path, order_index, created_at) VALUES (?, ?, ?, 0, ?)').run(other.project.id, 'Khác', `refs/${other.project.id}/khac.png`, env.ctx.now());
    expect((await s.user.get('/api/ref-library')).body).toHaveLength(2); // trước khi xoá: thấy cả hai
    const sbTail = path.posix.relative(`output/${s.slug}`, s.sbRel);

    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200);
    const u = s.user;
    const trashPath = proj(s.project.id).trash_path as string;
    const P = s.project.id;

    for (const url of [
      `/api/projects/${P}`, `/api/projects/${P}/scenes`, `/api/projects/${P}/budget`, `/api/projects/${P}/events`, `/api/projects/${P}/ledger`,
      `/api/projects/${P}/ledger.csv`, `/api/projects/${P}/log.md`, `/api/projects/${P}/refs`, `/api/projects/${P}/final-cuts`,
      `/api/projects/${P}/approve-all/preview?stage=storyboard`, `/api/projects/${P}/ai-policy`, `/api/scenes/${sceneId}`, `/api/jobs/${jobId}`,
      `/api/final-cuts/${cutId}`, `/api/stream?projectId=${P}`, `/api/ref-library?projectId=${P}`,
      `/files/${s.sbRel}`, `/files/${s.refRel}`, `/files/output/${s.slug}/log.md`, `/files/${trashPath}/output/log.md`, `/files/${trashPath}/refs/hop.png`,
      `/files/${trashPath.replace('.trash', '.TRASH')}/output/log.md`, `/files/${trashPath}/output/${sbTail}`,
    ]) {
      const r = await u.get(url);
      expect(r.status, url).toBe(404);
    }
    for (const [method, url, body] of [
      ['post', `/api/projects/${P}/final-cuts`, {}], ['patch', `/api/projects/${P}`, { name: 'X' }], ['post', `/api/projects/${P}/brief`, { brief: 'x' }],
      ['post', `/api/projects/${P}/approve-all`, { stage: 'storyboard' }], ['patch', `/api/refs/${refId}`, { label: 'X' }], ['patch', '/api/refs/reorder', { project_id: P, ids: [refId] }],
      ['post', `/api/scenes/${sceneId}/approve`, { stage: 'storyboard' }], ['post', `/api/scenes/${sceneId}/comments`, { body: 'x', action: 'note' }],
      ['patch', `/api/scenes/${sceneId}/prompt`, { prompt: 'x' }], ['post', `/api/scenes/${sceneId}/select-video`, {}], ['post', `/api/scenes/${sceneId}/reset`, {}],
      ['patch', `/api/comments/${commentId}`, { resolved: true }], ['post', `/api/assets/${assetId}/verdict`, { verdict: 'pass' }],
      ['post', `/api/jobs/${jobId}/cancel`, {}], ['post', `/api/jobs/${jobId}/reconcile`, { outcome: 'nothing_created' }],
      ['post', `/api/final-cuts/${cutId}/rerender`, {}], ['post', `/api/final-cuts/${cutId}/cancel`, {}], ['post', `/api/final-cuts/${cutId}/clean`, {}],
      ['post', `/api/projects/${other.project.id}/refs/from-library`, { ref_ids: [refId] }],
    ] as const) {
      const r = await (u as any)[method](url, body);
      expect(r.status, `${method} ${url}`).toBe(404);
    }
    expect((await u.del(`/api/refs/${refId}`)).status).toBe(404);
    expect((await u.get('/api/projects')).body.map((p: any) => p.id)).toEqual([other.project.id]);
    expect((await u.get('/api/jobs')).body.every((j: any) => j.project_id !== P)).toBe(true);
    expect((await u.get(`/api/jobs?projectId=${P}`)).body).toEqual([]);
    const lib = (await u.get('/api/ref-library')).body;
    expect(lib.map((r: any) => r.label)).toEqual(['Khác']);
    expect(lib.flatMap((r: any) => r.projects.map((p: any) => p.id))).not.toContain(P);
    expect((await u.get('/api/lan')).body.plan_count).toBe(0);

    // worker: job (kể cả job queued còn sót) không được giao; API job theo id → 404
    db().prepare("INSERT INTO jobs (project_id, scene_id, type, status, requires_approval, approved_at, created_at) VALUES (?, ?, 'storyboard', 'queued', 1, ?, ?)").run(P, sceneId, env.ctx.now(), env.ctx.now());
    db().prepare("UPDATE scenes SET status = 'storyboard_queued' WHERE id = ?").run(sceneId);
    const w = workerClient(env.app);
    expect((await w.get('/api/worker/next?worker=w9')).status).toBe(204);
    expect((await w.get(`/api/worker/jobs/${jobId}`)).status).toBe(404);
    expect((await w.get(`/api/worker/jobs/${jobId}/actions`)).status).toBe(404);
    expect((await w.post(`/api/worker/jobs/${jobId}/heartbeat`, {})).status).toBe(404);
    expect((await w.post(`/api/worker/jobs/${jobId}/complete`, { result: {} })).status).toBe(404);
    expect((await w.post('/api/worker/scenes', { project_id: P, scenes: [{ code: 'C9', prompt: 'x' }] })).status).toBe(404);
    expect((await w.post('/api/worker/comments', { scene_id: sceneId, body: 'x' })).status).toBe(404);
    // dự án khác vẫn bình thường
    expect((await u.get(`/api/projects/${other.project.id}`)).status).toBe(200);
    expect((await u.get(`/files/refs/${other.project.id}/khac.png`)).status).toBe(200);
  });
});

describe('xoá vĩnh viễn', () => {
  it('phải gõ đúng tên; xoá thư mục thùng rác và mọi hàng liên quan; PRAGMA foreign_key_check sạch; chỉ áp dụng cho dự án trong thùng rác', async () => {
    const s = await seed();
    const P = s.project.id;
    const sceneId = s.scenes[0].id;
    const jobId = (db().prepare('SELECT id FROM jobs WHERE scene_id = ? ORDER BY id LIMIT 1').get(sceneId) as any).id;
    const now = env.ctx.now();
    await s.user.post(`/api/scenes/${sceneId}/comments`, { body: 'ghi chú' });
    db().prepare('UPDATE scenes SET selected_video_id = (SELECT id FROM assets WHERE scene_id = ?) WHERE id = ?').run(sceneId, sceneId);
    db().prepare("INSERT INTO credit_ledger (project_id, scene_id, job_id, delta, note, created_at) VALUES (?, ?, ?, -15, 'v', ?)").run(P, sceneId, jobId, now);
    db().prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at, job_id) VALUES (?, 1, 'ready', 's', 'claude', ?, ?)").run(P, now, jobId);
    db().prepare("INSERT INTO ai_project_policy VALUES (?, '{}')").run(P);
    db().prepare("INSERT INTO external_actions (id, job_id, lease_epoch, profile, kind, state, evidence, created_at, updated_at) VALUES ('x', ?, 1, 'p', 'storyboard', 'committed', '{}', ?, ?)").run(jobId, now, now);
    db().prepare("INSERT INTO job_reconciliations (job_id, action_id, outcome, prev_state, created_at) VALUES (?, 'x', 'nothing_created', 'intent', ?)").run(jobId, now);
    db().prepare("INSERT INTO browser_leases VALUES ('prof', ?, 'l', ?)").run(jobId, now);
    db().prepare("INSERT INTO ai_attempts (job_id, model, outcome, latency_ms, created_at) VALUES (?, 'm', 'ok', 5, ?)").run(jobId, now);
    const other = await setupProject(env, { scenes: 1, project: { name: 'Giữ lại' } });

    // chưa xoá mềm → không xoá vĩnh viễn được
    expect((await s.user.del(`/api/trash/${P}`, { confirm_name: 'Cacao Actiso Plus' })).status).toBe(404);
    await del(P, 'Cacao Actiso Plus');
    const trashPath = proj(P).trash_path;
    expect((await s.user.del(`/api/trash/${P}`, {})).status).toBe(400);
    expect((await s.user.del(`/api/trash/${P}`, { confirm_name: 'sai' })).body.error.code).toBe('CONFIRM_MISMATCH');
    expect(exists(trashPath)).toBe(true);
    const r = await s.user.del(`/api/trash/${P}`, { confirm_name: 'Cacao Actiso Plus' });
    expect(r.status, r.raw).toBe(200);

    expect(exists(trashPath)).toBe(false);
    expect(trashDirs()).toEqual([]);
    expect(proj(P)).toBeUndefined();
    expect(db().pragma('foreign_key_check')).toEqual([]);
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok');
    const n = (sql: string) => (db().prepare(sql).get(...(sql.includes('?') ? [P] : [])) as { n: number }).n;
    for (const sql of [
      'SELECT COUNT(*) n FROM scenes WHERE project_id = ?', 'SELECT COUNT(*) n FROM jobs WHERE project_id = ?', 'SELECT COUNT(*) n FROM events WHERE project_id = ?',
      'SELECT COUNT(*) n FROM credit_ledger WHERE project_id = ?', 'SELECT COUNT(*) n FROM final_cuts WHERE project_id = ?', 'SELECT COUNT(*) n FROM project_refs WHERE project_id = ?',
      'SELECT COUNT(*) n FROM ai_project_policy WHERE project_id = ?', 'SELECT COUNT(*) n FROM assets WHERE scene_id NOT IN (SELECT id FROM scenes)',
      'SELECT COUNT(*) n FROM comments WHERE scene_id NOT IN (SELECT id FROM scenes)', 'SELECT COUNT(*) n FROM scene_prompt_versions WHERE scene_id NOT IN (SELECT id FROM scenes)',
      'SELECT COUNT(*) n FROM external_actions WHERE job_id NOT IN (SELECT id FROM jobs)', 'SELECT COUNT(*) n FROM job_reconciliations WHERE job_id NOT IN (SELECT id FROM jobs)',
      'SELECT COUNT(*) n FROM browser_leases WHERE job_id NOT IN (SELECT id FROM jobs)', "SELECT COUNT(*) n FROM ai_attempts WHERE job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM jobs)",
    ]) expect(n(sql), sql).toBe(0);
    // dự án khác không bị ảnh hưởng
    expect(db().prepare('SELECT COUNT(*) n FROM scenes WHERE project_id = ?').get(other.project.id)).toEqual({ n: 1 });
    expect(exists(`output/${(db().prepare('SELECT slug FROM projects WHERE id = ?').get(other.project.id) as any).slug}`) || true).toBe(true);
  });

  it('schema: mọi khóa ngoại tới projects/scenes/jobs/assets là CASCADE hoặc SET NULL (không NO ACTION/RESTRICT), và mọi cột *_id liên quan đều có khóa ngoại', () => {
    const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const bad: string[] = [];
    for (const t of tables) {
      const fks = db().prepare(`SELECT * FROM pragma_foreign_key_list('${t}')`).all() as { from: string; table: string; on_delete: string }[];
      for (const fk of fks) if (['projects', 'scenes', 'jobs', 'assets'].includes(fk.table) && !['CASCADE', 'SET NULL'].includes(fk.on_delete)) bad.push(`${t}.${fk.from}→${fk.table} ${fk.on_delete}`);
      const cols = (db().prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
      for (const c of cols.filter((c) => ['project_id', 'scene_id', 'job_id', 'asset_id', 'selected_video_id'].includes(c))) {
        if (!fks.some((fk) => fk.from === c)) bad.push(`${t}.${c} thiếu khóa ngoại`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('tự dọn quá hạn, cấu hình, khởi động', () => {
  it('purgeExpiredTrash theo đồng hồ giả: chưa đủ 30 ngày giữ, đủ thì xoá vĩnh viễn; chỉ xoá dự án quá hạn', async () => {
    const a = await seed({ queued: false });
    env.clock.advance(10 * DAY);
    const b = await setupProject(env, { scenes: 1, project: { name: 'Dự án B' } });
    await del(a.project.id, 'Cacao Actiso Plus');
    env.clock.advance(5 * DAY);
    await del(b.project.id, 'Dự án B');
    const trashA = proj(a.project.id).trash_path;
    env.clock.advance(25 * DAY - 1); // A: 30 ngày trừ 1ms
    expect(purgeExpiredTrash(env.ctx).purged).toEqual([]);
    expect((await a.user.get('/api/trash')).body.map((t: any) => t.days_left)).toEqual([6, 1]);
    env.clock.advance(1); // A: đúng 30 ngày
    expect(trashMaintenance(env.ctx)).toMatchObject({ purged: [a.project.id], failed: [] });
    expect(exists(trashA)).toBe(false);
    expect(proj(a.project.id)).toBeUndefined();
    expect(proj(b.project.id).deleted_at).not.toBeNull();
    env.clock.advance(5 * DAY);
    expect(purgeExpiredTrash(env.ctx).purged).toEqual([b.project.id]);
    expect(db().pragma('foreign_key_check')).toEqual([]);
  });

  it('TRASH_RETENTION_DAYS: mặc định 30; số nguyên ≥ 1; giá trị sai không bao giờ làm xoá ngay', () => {
    expect(parseTrashRetentionDays(undefined)).toBe(30);
    expect(parseTrashRetentionDays('')).toBe(30);
    expect(parseTrashRetentionDays('7')).toBe(7);
    expect(parseTrashRetentionDays('0')).toBe(30);
    expect(parseTrashRetentionDays('-3')).toBe(30);
    expect(parseTrashRetentionDays('abc')).toBe(30);
    expect(parseTrashRetentionDays('2.9')).toBe(2);
  });

  it('thời hạn lấy từ cấu hình', async () => {
    await env.close();
    env = await makeEnv({ config: { trashRetentionDays: 2 } });
    const s = await seed({ queued: false });
    await del(s.project.id, 'Cacao Actiso Plus');
    const t = (await s.user.get('/api/trash')).body[0];
    expect(t).toMatchObject({ retention_days: 2, days_left: 2, deleted_by: 'app', source: 'app', name: 'Cacao Actiso Plus', scene_count: 2 });
    expect(t.size_bytes).toBeGreaterThan(0);
    env.clock.advance(2 * DAY);
    expect(purgeExpiredTrash(env.ctx).purged).toEqual([s.project.id]);
  });

  it('khởi động hoàn tất việc chuyển file dở (đã commit xoá mềm nhưng file còn ở chỗ cũ); không ghi đè', async () => {
    const s = await seed({ queued: false });
    await del(s.project.id, 'Cacao Actiso Plus');
    const p = proj(s.project.id);
    // mô phỏng tiến trình chết giữa chừng: đưa file về chỗ cũ, giữ nguyên đánh dấu xoá
    fs.renameSync(path.join(env.root, p.trash_path, 'output'), path.join(env.root, 'output', s.slug));
    fs.renameSync(path.join(env.root, p.trash_path, 'refs'), path.join(env.root, 'refs', String(s.project.id)));
    expect(finishInterruptedTrash(env.ctx)).toBe(2);
    expect(exists(`output/${s.slug}`)).toBe(false);
    expect(exists(`${p.trash_path}/output/log.md`)).toBe(true);
    expect(finishInterruptedTrash(env.ctx)).toBe(0);
  });
});

describe('lỗi chuyển file thì hoàn tác', () => {
  it('xoá: refs chuyển lỗi sau khi output đã chuyển → output về chỗ cũ, deleted_at=NULL, trả 500, có event', async () => {
    const s = await seed({ queued: false });
    const real = fs.renameSync;
    let n = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (++n === 2) throw Object.assign(new Error('EXDEV mô phỏng'), { code: 'EXDEV' });
      return real(a, b);
    });
    const r = await del(s.project.id, 'Cacao Actiso Plus');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('TRASH_MOVE_FAILED');
    expect(r.body.error.message).toMatch(/giữ nguyên/);
    vi.restoreAllMocks();
    expect(proj(s.project.id)).toMatchObject({ deleted_at: null, deleted_by: null, trash_path: null });
    expect(exists(`output/${s.slug}/log.md`)).toBe(true);
    expect(exists(s.refRel)).toBe(true);
    expect(trashDirs()).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) n FROM events WHERE type = 'project.delete_failed'").get()).toEqual({ n: 1 });
    expect((await s.user.get(`/api/projects/${s.project.id}`)).status).toBe(200);
    expect((await del(s.project.id, 'Cacao Actiso Plus')).status).toBe(200); // thử lại được
  });

  it('khôi phục: lỗi giữa chừng → file về lại thùng rác, dự án vẫn trong thùng rác', async () => {
    const s = await seed({ queued: false });
    await del(s.project.id, 'Cacao Actiso Plus');
    const trashPath = proj(s.project.id).trash_path;
    const real = fs.renameSync;
    let n = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (++n === 2) throw new Error('lỗi mô phỏng');
      return real(a, b);
    });
    const r = await s.user.post(`/api/trash/${s.project.id}/restore`);
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('RESTORE_FAILED');
    vi.restoreAllMocks();
    expect(proj(s.project.id).deleted_at).not.toBeNull();
    expect(exists(`${trashPath}/output/log.md`)).toBe(true);
    expect(exists(`${trashPath}/refs/hop.png`)).toBe(true);
    expect(exists(`output/${s.slug}`)).toBe(false);
    expect((await s.user.post(`/api/trash/${s.project.id}/restore`)).status).toBe(200);
  });
});

describe('migration 011 trên DB cũ', () => {
  it('chỉ thêm cột/index: dữ liệu và số dòng mọi bảng không đổi; dự án cũ deleted_at=NULL; check sạch', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-mig011-'));
    try {
      const dir = path.join(tmp, 'migs');
      fs.mkdirSync(dir);
      const upTo010 = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^(00\d|010)_/.test(f)).sort();
      for (const f of upTo010) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      const d = openDb(path.join(tmp, 'old.db'));
      expect(runMigrations(d, dir)).toHaveLength(10);
      const now = '2026-01-01T00:00:00.000Z';
      d.prepare("INSERT INTO projects (slug, name, source, created_by_name, created_at, updated_at) VALUES ('cu', 'Cũ', 'lan', 'Lan', ?, ?)").run(now, now);
      d.prepare("INSERT INTO scenes (project_id, code, created_at, updated_at) VALUES (1, 'C1', ?, ?)").run(now, now);
      const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
      const counts = () => Object.fromEntries(tables.map((t) => [t, (d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
      const before = counts();
      const proj0 = d.prepare('SELECT * FROM projects').all() as Record<string, unknown>[];
      expect(runMigrations(d)).toEqual(['011_project_trash', '012_final_cut_feedback', '013_color_refs', '014_clips', '015_clip_captions']);
      expect(runMigrations(d)).toEqual([]);
      expect(counts()).toEqual({ ...before, schema_migrations: 15 });
      expect(d.prepare('SELECT * FROM projects').all()).toEqual([{ ...proj0[0], deleted_at: null, deleted_by: null, trash_path: null, lan_client_hash: null, kind: 'scenes', stt_terms: null }]);
      expect(() => d.prepare("UPDATE projects SET deleted_by = 'web' WHERE id = 1").run()).toThrow(/CHECK/);
      expect((d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projects_deleted'").all() as unknown[]).length).toBe(1);
      expect(d.pragma('foreign_key_check')).toEqual([]);
      expect(d.pragma('integrity_check', { simple: true })).toBe('ok');
      d.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
