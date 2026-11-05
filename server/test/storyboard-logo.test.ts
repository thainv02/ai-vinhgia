import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { claim, finish, makeEnv, setupProject, writeFile, type Env, type Scenario } from './helpers.js';

/**
 * Storyboard tạo bằng Google Flow: server xoá logo Gemini khi worker nộp ảnh (services/storyboard-logo.ts).
 * Phần chạy tool thật dùng ảnh mẫu có logo trong test của gemini-watermark-remover (chỉ đọc).
 */
const CLI = path.join(REPO_ROOT, 'gemini-watermark-remover', 'bin', 'gwr.mjs');
const FIXTURE = path.join(REPO_ROOT, 'gemini-watermark-remover', 'tests', 'fixtures', 'gemini-v2-36-small-watermark.png');
const toolReady = fs.existsSync(CLI) && fs.existsSync(path.join(REPO_ROOT, 'gemini-watermark-remover', 'node_modules', 'sharp')) && fs.existsSync(FIXTURE);

let env: Env;
afterEach(async () => {
  await env?.close();
});

async function flowProject(gwrCli: string | null): Promise<Scenario> {
  env = await makeEnv({ config: { gwrCli } } as never);
  const sc = await setupProject(env, { scenes: 1 });
  const p = await sc.user.patch(`/api/projects/${sc.project.id}`, { storyboard_generator: 'flow-image' });
  expect(p.status).toBe(200);
  expect(p.body.storyboard_generator).toBe('flow-image');
  return sc;
}

async function submitStoryboard(sc: Scenario, image: Buffer) {
  const id = sc.scenes[0].id;
  expect((await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' })).status).toBe(200);
  const job = await claim(sc);
  expect(job.payload.generator).toMatchObject({ id: 'flow-image', provider: 'flow', model: 'gemini-3.1-flash-image-portrait', remove_logo: true });
  const rel = job.payload.output.storyboard_path;
  writeFile(env.root, rel, image);
  const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, {
    result: { note: 'ok', provider: 'flow2api' },
    assets: [{ kind: 'storyboard', file_path: rel, meta: { width: 1, height: 1 } }],
  });
  expect(r.status).toBe(200);
  const scene = await sc.user.get(`/api/scenes/${id}`);
  const asset = scene.body.assets.find((a: { kind: string }) => a.kind === 'storyboard');
  return { job, rel, asset };
}

describe('xoá logo trên storyboard Google Flow', () => {
  it('dự án mặc định dùng Muse: storyboard không qua bước xoá logo', async () => {
    env = await makeEnv();
    const sc = await setupProject(env, { scenes: 1 });
    expect(sc.project.storyboard_generator).toBe('muse');
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const job = await claim(sc);
    expect(job.payload.generator).toMatchObject({ id: 'muse', remove_logo: false });
    expect((await finish(sc, job)).status).toBe(200);
    const scene = await sc.user.get(`/api/scenes/${sc.scenes[0].id}`);
    expect(scene.body.assets[0].meta.logo).toBeUndefined();
  });

  it('từ chối dịch vụ storyboard không tồn tại', async () => {
    env = await makeEnv();
    const sc = await setupProject(env, { scenes: 1 });
    expect((await sc.user.patch(`/api/projects/${sc.project.id}`, { storyboard_generator: 'dalle' })).status).toBe(400);
  });

  it('chưa có tool: giữ ảnh gốc, ghi skipped, «thử lại» cũng báo skipped', async () => {
    const sc = await flowProject(null);
    const img = Buffer.from('ảnh-flow');
    const { job, rel, asset } = await submitStoryboard(sc, img);
    expect(asset.meta.logo).toMatchObject({ status: 'skipped', raw_path: rel.replace(/\.png$/, `_raw_j${job.id}.png`) });
    expect(fs.readFileSync(path.join(env.root, rel))).toEqual(img);
    expect(fs.readFileSync(path.join(env.root, asset.meta.logo.raw_path))).toEqual(img);
    const again = await sc.user.post(`/api/assets/${asset.id}/remove-logo`, {});
    expect(again.status).toBe(200);
    expect(again.body.asset.meta.logo.status).toBe('skipped');
  });

  (toolReady ? it : it.skip)('tool thật: xoá logo trên ảnh có logo, giữ ảnh gốc; ảnh không logo giữ nguyên byte', async () => {
    const sc = await flowProject(CLI);
    const img = fs.readFileSync(FIXTURE);
    const { rel, asset } = await submitStoryboard(sc, img);
    expect(asset.meta.logo.status).toBe('removed');
    const cleaned = fs.readFileSync(path.join(env.root, rel));
    expect(cleaned.equals(img)).toBe(false);
    expect(fs.readFileSync(path.join(env.root, asset.meta.logo.raw_path))).toEqual(img);

    // Thử lại từ ảnh gốc cho cùng kết quả, file storyboard vẫn là bản đã xoá logo.
    const again = await sc.user.post(`/api/assets/${asset.id}/remove-logo`, {});
    expect(again.status).toBe(200);
    expect(again.body.asset.meta.logo.status).toBe('removed');
    expect(fs.readFileSync(path.join(env.root, rel)).equals(img)).toBe(false);
  }, 60_000);

  (toolReady ? it : it.skip)('tool thật: ảnh không có logo giữ nguyên byte', async () => {
    const sc = await flowProject(CLI);
    const plain = fs.readFileSync(path.join(REPO_ROOT, 'gemini-watermark-remover', 'tests', 'fixtures', 'issue120-plane-super.png'));
    const { rel, asset } = await submitStoryboard(sc, plain);
    expect(asset.meta.logo.status).toBe('none');
    expect(fs.readFileSync(path.join(env.root, rel))).toEqual(plain);
  }, 60_000);

  it('ảnh không phải PNG hợp lệ với tool thật: báo failed nhưng vẫn nhận storyboard với ảnh gốc', async () => {
    if (!toolReady) return;
    const sc = await flowProject(CLI);
    const bad = Buffer.from('không phải ảnh');
    const { rel, asset } = await submitStoryboard(sc, bad);
    expect(asset.meta.logo.status).toBe('failed');
    expect(fs.readFileSync(path.join(env.root, rel))).toEqual(bad);
    const scene = await sc.user.get(`/api/scenes/${sc.scenes[0].id}`);
    expect(scene.body.status).toBe('storyboard_review');
  }, 60_000);
});
