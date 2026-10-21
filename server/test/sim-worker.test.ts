import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_TOKEN, makeEnv, userClient, type Env } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const script = path.resolve(here, '..', 'src', 'scripts', 'sim-worker.ts');

let env: Env;
let base = '';
beforeEach(async () => {
  env = await makeEnv();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await env.close();
});

function sim(...extra: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tsxCli, script, '--once', '--delay', '100', '--api', base, '--root', env.root, '--token', WORKER_TOKEN, ...extra], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

describe('npm run sim:worker (--once) chạy qua toàn bộ luồng với server thật', () => {
  it('analyze_brief → storyboard → video → revise_prompt; không bao giờ tự tạo job video', async () => {
    const u = userClient(env.app);
    // chưa có job: thoát sạch
    const idle = await sim();
    expect(idle.code).toBe(0);
    expect(idle.out).toContain('Không có job');

    const p = (await u.post('/api/projects', { name: 'Sim', brief: 'Quảng cáo sinh tố', style_lock: 'ấm' })).body;
    await u.post(`/api/projects/${p.id}/brief`, {});
    const r1 = await sim();
    expect(r1.code, r1.out).toBe(0);
    const scenes = (await u.get(`/api/projects/${p.id}/scenes`)).body;
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    expect(scenes.length).toBeLessThanOrEqual(4);
    expect(scenes.every((s: any) => s.status === 'awaiting_approval')).toBe(true);
    expect((await u.get(`/api/projects/${p.id}`)).body.status).toBe('active');
    // hàng đợi trống: worker không tự tạo job nào
    expect((await u.get('/api/jobs?status=queued')).body).toHaveLength(0);

    // storyboard
    const c1 = scenes[0].id;
    await u.post(`/api/scenes/${c1}/approve`, { stage: 'storyboard' });
    const r2 = await sim();
    expect(r2.code, r2.out).toBe(0);
    let s1 = (await u.get(`/api/scenes/${c1}`)).body;
    expect(s1.status).toBe('storyboard_review');
    const png = fs.readFileSync(path.join(env.root, s1.storyboard.file_path));
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect((await u.get(s1.storyboard.url)).status).toBe(200);
    expect((await u.get('/api/jobs?type=video')).body).toHaveLength(0);

    // video (người dùng duyệt mới có)
    await u.post(`/api/scenes/${c1}/approve`, { stage: 'video' });
    const r3 = await sim();
    expect(r3.code, r3.out).toBe(0);
    s1 = (await u.get(`/api/scenes/${c1}`)).body;
    expect(s1.status).toBe('video_review');
    expect(s1.video.verdict).toBe('pass');
    expect(fs.existsSync(path.join(env.root, s1.video.file_path))).toBe(true);
    expect(fs.existsSync(path.join(env.root, s1.grid.file_path))).toBe(true);
    expect((await u.get(`/api/projects/${p.id}/budget`)).body).toMatchObject({ used: 15, reserved: 0 });
    expect((await u.get('/api/jobs?type=video')).body).toHaveLength(1); // chỉ job do người dùng duyệt

    // revise_prompt: thêm một dòng vào prompt kèm lý do
    const c = await u.post(`/api/scenes/${c1}/comments`, { body: 'Thêm kéo', action: 'revise_and_regenerate' });
    expect(c.body.scene.status).toBe('needs_revision');
    const r4 = await sim();
    expect(r4.code, r4.out).toBe(0);
    s1 = (await u.get(`/api/scenes/${c1}`)).body;
    expect(s1.status).toBe('awaiting_approval');
    expect(s1.prompt_versions).toHaveLength(2);
    expect(s1.prompt).toContain('[Mô phỏng chỉnh sửa] Theo nhận xét: Thêm kéo');
    expect(s1.prompt_versions[1].created_by).toBe('claude');
    expect((await u.get('/api/jobs?type=video')).body).toHaveLength(1); // vẫn chỉ 1 job video
  }, 60_000);

  it('--fail-rate 1 báo lỗi giả; hàng đợi tạm dừng thì thoát với thông báo; token sai thoát mã 2', async () => {
    const u = userClient(env.app);
    const p = (await u.post('/api/projects', { name: 'Sim2', brief: 'b' })).body;
    await env.app.inject({
      method: 'POST',
      url: '/api/worker/scenes',
      headers: { host: 'localhost', authorization: `Bearer ${WORKER_TOKEN}` },
      payload: { project_id: p.id, scenes: [{ code: 'C1', prompt: 'p' }] },
    });
    const sceneId = (await u.get(`/api/projects/${p.id}/scenes`)).body[0].id;
    await u.post(`/api/scenes/${sceneId}/approve`, { stage: 'storyboard' });
    const f = await sim('--fail-rate', '1', '--fail-code', 'CAPTCHA');
    expect(f.code, f.out).toBe(0);
    expect(f.out).toContain('báo lỗi giả [CAPTCHA]');
    expect((await u.get(`/api/scenes/${sceneId}`)).body.status).toBe('failed');
    const paused = await sim();
    expect(paused.out).toContain('tạm dừng');
    const bad = await sim('--token', 'sai');
    expect(bad.code).toBe(2);
  }, 60_000);
});
