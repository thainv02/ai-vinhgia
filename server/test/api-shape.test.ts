import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, setupProject, toStoryboardReview, toVideoReview, userClient, writeFile, bareScenario, type Env } from './helpers.js';
import { buildApp } from '../src/app.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const keys = (o: object) => Object.keys(o).sort();

describe('hình dạng JSON (API.md phải khớp các trường này)', () => {
  it('danh sách dự án có số cảnh, đếm theo trạng thái, credit đã dùng', async () => {
    const sc = await setupProject(env, { scenes: 3 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await toVideoReview(sc, sc.scenes[0].id);
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/select-video`, {});
    await setupProject(env, { scenes: 1, project: { name: 'Dự án hai' } });
    const list = (await sc.user.get('/api/projects')).body;
    expect(list.map((p: any) => p.name)).toEqual(['Dự án hai', 'Cacao Actiso Plus']);
    const p = list[1];
    expect(keys(p)).toEqual(
      [
        'brief', 'created_at', 'credit_per_video', 'credits_reserved', 'credits_used',
        'done_count', 'final_cut_block', 'id', 'latest_final_cut', 'max_attempts_per_scene', 'name', 'scene_count', 'slug', 'status', 'status_counts', 'style_lock', 'updated_at',
      ].sort(),
    );
    expect(p).toMatchObject({
      scene_count: 3,
      done_count: 1,
      status_counts: { done: 1, awaiting_approval: 2 },
      credits_used: 15,
      credits_reserved: 0,
    });
  });

  it('chi tiết dự án, danh sách cảnh (SceneSummary) và chi tiết cảnh', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    await toStoryboardReview(sc, sc.scenes[0].id);
    await toVideoReview(sc, sc.scenes[0].id);
    const proj = (await sc.user.get(`/api/projects/${sc.project.id}`)).body;
    expect(keys(proj)).toEqual(expect.arrayContaining(['refs', 'budget', 'requeued_jobs', 'scene_count', 'status_counts']));
    expect(keys(proj.budget)).toEqual(['credit_per_video', 'max_attempts', 'reserved', 'scenes', 'used']);

    const scenes = (await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body;
    expect(scenes.map((s: any) => s.code)).toEqual(['C1', 'C2']);
    const s = scenes[0];
    expect(keys(s)).toEqual(
      [
        'id', 'project_id', 'code', 'order_index', 'title', 'prompt', 'first_frame_desc', 'upload_refs', 'use_prev_storyboard',
        'status', 'selected_video_id', 'created_at', 'updated_at', 'prompt_version', 'attempts_used', 'max_attempts',
        'storyboard_count', 'video_count', 'storyboard', 'video', 'grid', 'active_job', 'waiting_reason', 'open_comments',
        'storyboard_block', 'video_block',
      ].sort(),
    );
    expect(s).toMatchObject({ status: 'video_review', attempts_used: 1, max_attempts: 2, video_count: 1, storyboard_count: 1, active_job: null, waiting_reason: null, upload_refs: [], use_prev_storyboard: false });
    expect(keys(s.video)).toEqual(['attempt', 'created_at', 'file_path', 'id', 'job_id', 'kind', 'meta', 'scene_id', 'url', 'verdict', 'verdict_note']);
    expect(s.video.meta).toMatchObject({ duration_s: 10, width: 720, height: 1280 });
    expect(s.video.url).toBe('/files/output/cacao-actiso-plus/video/C1_v1.mp4');
    expect(s.grid.url).toBe('/files/output/cacao-actiso-plus/video/C1_v1_grid.jpg');
    expect(s.video_block).toBeNull();
    // cảnh đang chờ duyệt không có storyboard_block, nhưng video_block giải thích vì sao chưa tạo video được
    expect(scenes[1].storyboard_block).toBeNull();
    expect(scenes[1].video_block).toMatchObject({ code: 'INVALID_STATE' });

    const d = (await sc.user.get(`/api/scenes/${sc.scenes[0].id}`)).body;
    expect(keys(d)).toEqual(
      [...keys(s), 'project', 'assets', 'comments', 'prompt_versions', 'jobs', 'prev_scene_id', 'next_scene_id'].sort(),
    );
    expect(d.project).toEqual({
      id: sc.project.id, slug: 'cacao-actiso-plus', name: 'Cacao Actiso Plus', style_lock: '', credit_per_video: 15, max_attempts_per_scene: 2,
    });
    expect(d.assets.map((a: any) => a.kind)).toEqual(['storyboard', 'video', 'grid']);
    expect(d.prev_scene_id).toBeNull();
    expect(d.next_scene_id).toBe(sc.scenes[1].id);
    expect(d.jobs.map((j: any) => [j.type, j.status])).toEqual([['video', 'done'], ['storyboard', 'done']]);
    expect(keys(d.jobs[0])).toEqual(
      [
        'approved_at', 'claimed_at', 'claimed_by', 'created_at', 'credits_cost', 'error', 'error_code', 'finished_at', 'heartbeat_at', 'id',
        'last_requeued_at', 'worker_mode', 'ai', 'lease_epoch', 'wait_reason', 'next_attempt_at', 'checkpoint', 'payload', 'project_id', 'project_name', 'requeue_count', 'requires_approval', 'result', 'scene_code', 'scene_id', 'status', 'type',
      ].sort(),
    );
    expect(d.jobs[0].credits_cost).toBe(15);
    expect((await sc.user.get(`/api/scenes/${sc.scenes[1].id}`)).body.prev_scene_id).toBe(sc.scenes[0].id);
    expect((await sc.user.get('/api/scenes/99999')).status).toBe(404);
  });

  it('GET /api/jobs lọc theo projectId, status (nhiều giá trị), type; mới nhất trước', async () => {
    const a = await setupProject(env, { scenes: 2 });
    const b = await setupProject(env, { scenes: 1, project: { name: 'B' } });
    await a.user.post(`/api/projects/${a.project.id}/approve-all`, { stage: 'storyboard', expectedCredits: 0 });
    await b.user.post(`/api/scenes/${b.scenes[0].id}/approve`, { stage: 'storyboard' });
    const all = (await a.user.get('/api/jobs')).body;
    expect(all).toHaveLength(3);
    expect(all.map((j: any) => j.id)).toEqual([...all.map((j: any) => j.id)].sort((x: number, y: number) => y - x));
    expect((await a.user.get(`/api/jobs?projectId=${a.project.id}`)).body).toHaveLength(2);
    expect((await a.user.get(`/api/jobs?projectId=${b.project.id}`)).body[0]).toMatchObject({ project_name: 'B', scene_code: 'C1', type: 'storyboard' });
    await a.worker.get('/api/worker/next');
    expect((await a.user.get('/api/jobs?status=claimed')).body).toHaveLength(1);
    expect((await a.user.get('/api/jobs?status=claimed,queued')).body).toHaveLength(3);
    expect((await a.user.get('/api/jobs?type=video')).body).toHaveLength(0);
    expect((await a.user.get('/api/jobs?status=nope')).status).toBe(400);
    expect((await a.user.get('/api/jobs?limit=1')).body).toHaveLength(1);
  });

  it('GET /events: mới nhất trước, lọc theo sceneId, phân trang bằng before', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    const ev = (await sc.user.get(`/api/projects/${sc.project.id}/events`)).body;
    expect(keys(ev[0])).toEqual(['created_at', 'id', 'message', 'project_id', 'scene_code', 'scene_id', 'type']);
    expect(ev[0].id).toBeGreaterThan(ev.at(-1).id);
    const c2 = (await sc.user.get(`/api/projects/${sc.project.id}/events?sceneId=${sc.scenes[1].id}`)).body;
    expect(c2.every((e: any) => e.scene_id === sc.scenes[1].id && e.scene_code === 'C2')).toBe(true);
    const page = (await sc.user.get(`/api/projects/${sc.project.id}/events?limit=2`)).body;
    expect(page).toHaveLength(2);
    const next = (await sc.user.get(`/api/projects/${sc.project.id}/events?limit=2&before=${page[1].id}`)).body;
    expect(next[0].id).toBeLessThan(page[1].id);
  });

  it('GET /api/meta và /api/health; worker status', async () => {
    const u = userClient(env.app);
    const meta = (await u.get('/api/meta')).body;
    expect(meta.config).toEqual({
      max_concurrent_video_jobs: 4, require_prompt_approval: true, heartbeat_stale_minutes: 5, worker_online_seconds: 90, max_upload_bytes: 10485760,
    });
    expect(meta.scene_statuses).toHaveLength(14);
    expect(meta.scene_statuses[0]).toEqual({ value: 'draft', label: 'Nháp' });
    expect(meta.scene_statuses.find((x: any) => x.value === 'blocked_budget')).toEqual({ value: 'blocked_budget', label: 'Flow hết credit' });
    expect(meta.verdicts).toEqual([{ value: 'pass', label: 'Đạt' }, { value: 'fix_in_edit', label: 'Sửa khi dựng' }, { value: 'redo', label: 'Tạo lại' }]);
    expect((await u.get('/api/health')).body.ok).toBe(true);
    expect(keys((await u.get('/api/worker/status')).body)).toEqual(['last_seen_at', 'online', 'pause_code', 'pause_reason', 'paused_at', 'queue_paused', 'server_time', 'worker_id']);
  });

  it('tạo dự án: mặc định hợp lý; slug bỏ dấu và duy nhất', async () => {
    const u = userClient(env.app);
    const a = (await u.post('/api/projects', { name: 'Sinh tố Cacao Đặc Biệt!' })).body;
    expect(a).not.toHaveProperty('credit_budget');
    expect(a).toMatchObject({ slug: 'sinh-to-cacao-dac-biet', max_attempts_per_scene: 2, credit_per_video: 15, status: 'draft', brief: '', style_lock: '', scene_count: 0 });
    expect((await u.post('/api/projects', { name: 'Sinh tố Cacao Đặc Biệt!' })).body.slug).toBe('sinh-to-cacao-dac-biet-2');
    expect((await u.post('/api/projects', { name: '!!!' })).body.slug).toBe('project');
    expect((await u.post('/api/projects', { name: 'x', credit_budget: 1.5 })).status).toBe(201); // credit_budget bị bỏ qua
    expect((await u.post('/api/projects', { name: 'x', credit_per_video: 1.5 })).status).toBe(400);
    expect((await u.post(`/api/projects/${a.id}/brief`, {})).body.error.code).toBe('VALIDATION_ERROR'); // brief rỗng
    const b = await u.post(`/api/projects/${a.id}/brief`, { brief: 'Kịch bản' });
    expect(b.status).toBe(201);
    expect(b.body.project).toMatchObject({ brief: 'Kịch bản', status: 'analyzing' });
  });

  it('hủy job analyze_brief trả dự án về draft / active', async () => {
    const sc = bareScenario(env);
    const p = (await sc.user.post('/api/projects', { name: 'P', brief: 'b' })).body;
    const j = (await sc.user.post(`/api/projects/${p.id}/brief`, {})).body.job;
    expect((await sc.user.post(`/api/jobs/${j.id}/cancel`, {})).body.scene).toBeNull();
    expect((await sc.user.get(`/api/projects/${p.id}`)).body.status).toBe('draft');
  });
});

describe('production: phục vụ web/dist với SPA fallback', () => {
  it('phục vụ index.html, asset tĩnh, fallback cho đường dẫn trang; /api và /files không bị ảnh hưởng', async () => {
    const dist = path.join(env.root, 'web-dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>autovideo</title><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFile(env.root, 'output/a.txt', 'ok');
    const app = await buildApp({ rootDir: env.root, dbPath: path.join(env.root, 'data', 'prod.db'), logger: false, config: { webDistDir: dist, workerToken: 't' } });
    const get = (url: string, accept = 'text/html') => app.inject({ method: 'GET', url, headers: { host: 'localhost', accept } });
    expect((await get('/')).body).toContain('<div id="root">');
    const asset = await get('/assets/app-abc123.js', '*/*');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');
    for (const url of ['/projects/1', '/projects/1/scenes/2', '/queue', '/projects/new']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain('<div id="root">');
    }
    const api404 = await get('/api/khong-co', 'application/json');
    expect(api404.statusCode).toBe(404);
    expect(JSON.parse(api404.body).error.code).toBe('NOT_FOUND');
    expect((await get('/api/health', 'application/json')).statusCode).toBe(200);
    expect((await get('/files/output/a.txt', '*/*')).body).toBe('ok');
    expect((await get('/files/output/nope.txt')).statusCode).toBe(404);
    expect(JSON.parse((await get('/files/output/nope.txt')).body).error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
