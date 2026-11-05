import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { MediaFail, runMediaJob, type MediaDeps } from '../../worker/src/media/media.js';
import { FFMPEG, FFPROBE } from './final-helpers.js';
import { makeEnv, setupProject, toStoryboardReview, type Env, type Scenario } from './helpers.js';

/**
 * Worker nền ảnh/video (worker/src/media) chạy với server autovideo thật (inject), Muse2API/Flow2API GIẢ (fetch giả) và ffmpeg thật.
 * Không gọi dịch vụ thật nào.
 */
const W = 'media-api-1';
const GWR = path.join(REPO_ROOT, 'gemini-watermark-remover', 'bin', 'gwr.mjs');
const LOGO_PNG = path.join(REPO_ROOT, 'gemini-watermark-remover', 'tests', 'fixtures', 'gemini-v2-36-small-watermark.png');
const gwrReady = fs.existsSync(GWR) && fs.existsSync(path.join(REPO_ROOT, 'gemini-watermark-remover', 'node_modules', 'sharp')) && fs.existsSync(LOGO_PNG);

let env: Env;
afterEach(async () => {
  await env?.close();
});

const MUSE = 'http://muse.test';
const FLOW = 'http://flow.test';

function media(dir: string) {
  const png = path.join(dir, 'img.png');
  const mp4 = path.join(dir, 'vid.mp4');
  execFileSync(FFMPEG!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=576x1024', '-frames:v', '1', png]);
  execFileSync(FFMPEG!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', mp4]);
  return { png: fs.readFileSync(png), mp4: fs.readFileSync(mp4) };
}

type Call = { method: string; url: string; headers: Record<string, string>; body: any };
type Handler = (c: Call) => Response | Promise<Response>;

function makeDeps(sc: Scenario, handler: Handler, calls: Call[]): MediaDeps {
  const stateDir = path.join(env.root, 'data', 'media-worker');
  return {
    root: env.root,
    stateDir,
    async api(method, url, body) {
      const u = `${url}${url.includes('?') ? '&' : '?'}worker=${W}`;
      const r = method === 'GET' ? await sc.worker.get(u) : await sc.worker.post(u, body);
      if (r.status >= 400) throw Object.assign(new Error(r.body?.error?.message ?? r.raw), { code: r.body?.error?.code });
      return r.body;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      let body: any = init?.body;
      try {
        body = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        /* giữ chuỗi */
      }
      const c = { method: init?.method ?? 'GET', url, headers, body };
      calls.push(c);
      return handler(c);
    }) as typeof fetch,
    muse: { url: MUSE, key: 'mk' },
    flow: { url: FLOW, key: 'fk' },
    ffmpeg: FFMPEG!,
    ffprobe: FFPROBE!,
    sleep: async () => undefined,
    log: () => undefined,
    pollMs: 1,
    heartbeatMs: 60_000,
  };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });

async function claimJob(sc: Scenario) {
  const r = await sc.worker.get(`/api/worker/next?worker=${W}&types=storyboard,video`);
  expect(r.status).toBe(200);
  return r.body;
}

async function sceneDetail(sc: Scenario) {
  return (await sc.user.get(`/api/scenes/${sc.scenes[0].id}`)).body;
}

/** Cảnh 1 có 1 ảnh tham chiếu thật (PNG) để worker mã hoá data URL. */
async function setup(opts: { config?: Record<string, unknown> } = {}) {
  env = await makeEnv(opts.config ? ({ config: opts.config } as never) : {});
  const sc = await setupProject(env, { scenes: 1 });
  const m = media(env.root);
  // Ghi một ref thẳng vào DB (đường dẫn trong refs/) để không phụ thuộc API upload.
  const rel = `refs/${sc.project.id}/box.png`;
  fs.mkdirSync(path.join(env.root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(env.root, rel), m.png);
  const refId = Number(
    env.ctx.db.prepare('INSERT INTO project_refs (project_id, label, file_path, created_at) VALUES (?, ?, ?, ?)').run(sc.project.id, 'hộp', rel, new Date().toISOString()).lastInsertRowid,
  );
  env.ctx.db.prepare('UPDATE scenes SET upload_refs = ? WHERE id = ?').run(JSON.stringify([refId]), sc.scenes[0].id);
  return { sc, m };
}

describe('worker nền ảnh/video qua API', () => {
  it('Muse storyboard: gửi async kèm ảnh, ghi comment task, tải /v1/media kèm key, lưu PNG; không kết luận', async () => {
    const { sc, m } = await setup();
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const job = await claimJob(sc);
    const calls: Call[] = [];
    await runMediaJob(job, makeDeps(sc, (c) => {
      if (c.method === 'POST' && c.url === `${MUSE}/v1/images/generations`) return json({ id: 'task_img1', status: 'queued' });
      if (c.url === `${MUSE}/v1/images/generations/task_img1`) return json({ id: 'task_img1', status: 'succeeded', result: { data: [{ url: `${MUSE}/v1/media/img_1.webp?expires=1&signature=s` }] } });
      if (c.url === `${MUSE}/v1/media/img_1.webp`) return new Response(m.png);
      return json({ error: { message: 'không mong đợi' } }, 500);
    }, calls));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ model: 'muse-image', async: true, size: '9:16', n: 1 });
    expect(post.body.image).toHaveLength(1);
    expect(post.body.image[0]).toMatch(/^data:image\/png;base64,/);
    expect(calls.find((c) => c.url.endsWith('/v1/media/img_1.webp'))!.headers.Authorization).toBe('Bearer mk');
    const s = await sceneDetail(sc);
    expect(s.status).toBe('storyboard_review');
    const sb = s.assets.find((a: { kind: string }) => a.kind === 'storyboard');
    expect(sb.meta).toMatchObject({ width: 576, height: 1024 });
    expect(sb.verdict).toBeNull();
    expect(s.comments.some((c: { body: string }) => c.body.includes('task_img1'))).toBe(true);
    expect(fs.existsSync(path.join(env.root, 'data', 'media-worker', `job-${job.id}.json`))).toBe(false);
  });

  it('Muse video: idempotency key theo job, ảnh sản phẩm + storyboard, tải video, dựng lưới', async () => {
    const { sc, m } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    // storyboard do helper ghi là PNG 1×1: thay bằng ảnh thật cho ffmpeg/encode
    const sbAsset = (await sceneDetail(sc)).assets.find((a: { kind: string }) => a.kind === 'storyboard');
    fs.writeFileSync(path.join(env.root, sbAsset.file_path), m.png);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'muse' })).status).toBe(200);
    const job = await claimJob(sc);
    const calls: Call[] = [];
    await runMediaJob(job, makeDeps(sc, (c) => {
      if (c.method === 'POST' && c.url === `${MUSE}/v1/videos`) return json({ id: 'task_v1', status: 'queued' });
      if (c.url === `${MUSE}/v1/videos/task_v1`) return json({ id: 'task_v1', status: 'succeeded', requested: { reference_image_count: 2 }, result: { media_name: 'vid_1.mp4', synthetic: false } });
      if (c.url === `${MUSE}/v1/media/vid_1.mp4`) return new Response(m.mp4);
      return json({ error: { message: 'không mong đợi' } }, 500);
    }, calls));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.headers['Idempotency-Key']).toBe(`autovideo-video-${job.id}`);
    expect(post.body).toMatchObject({ model: 'muse-video', size: '9:16', duration: 10 });
    expect(post.body.image).toHaveLength(2);
    expect(Object.keys(post.body)).toEqual([...Object.keys(post.body)].sort());
    const s = await sceneDetail(sc);
    expect(s.status).toBe('video_review');
    const v = s.assets.find((a: { kind: string }) => a.kind === 'video');
    expect(v.meta).toMatchObject({ width: 360, height: 640, generator: 'Muse' });
    expect(v.verdict).toBeNull();
    expect(v.verdict_note).toMatch(/Worker nền tạo qua Muse/);
    expect(s.assets.some((a: { kind: string }) => a.kind === 'grid')).toBe(true);
  });

  it('Muse: lỗi đính ảnh → OTHER + nghỉ vòng lặp; hết phiên → LOGIN_REQUIRED', async () => {
    const { sc } = await setup();
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const job = await claimJob(sc);
    const err = await runMediaJob(job, makeDeps(sc, (c) => {
      if (c.method === 'POST') return json({ id: 'task_x' });
      return json({ id: 'task_x', status: 'failed', error: { code: 'upstream_error', message: 'failed to attach all reference images' } });
    }, [])).catch((e) => e);
    expect(err).toBeInstanceOf(MediaFail);
    expect(err).toMatchObject({ code: 'OTHER', stopLoop: true });
  });

  it('Muse storyboard: lần gửi trước không rõ kết quả (nhật ký "posting") → báo lỗi, KHÔNG gửi lại', async () => {
    const { sc } = await setup();
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const job = await claimJob(sc);
    const dir = path.join(env.root, 'data', 'media-worker');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `job-${job.id}.json`), JSON.stringify({ muse_image: { phase: 'posting' } }));
    const calls: Call[] = [];
    const err = await runMediaJob(job, makeDeps(sc, () => json({}), calls)).catch((e) => e);
    expect(err).toBeInstanceOf(MediaFail);
    expect(err.message).toMatch(/không rõ kết quả/);
    expect(calls).toHaveLength(0);
  });

  (gwrReady ? it : it.skip)('Flow storyboard: stream trả ảnh markdown; không gửi key cho link ngoài; server xoá logo Gemini', async () => {
    const { sc } = await setup({ config: { gwrCli: GWR } });
    expect((await sc.user.patch(`/api/projects/${sc.project.id}`, { storyboard_generator: 'flow-image' })).status).toBe(200);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const job = await claimJob(sc);
    const calls: Call[] = [];
    await runMediaJob(job, makeDeps(sc, (c) => {
      if (c.method === 'POST' && c.url === `${FLOW}/v1/chat/completions`) {
        return sse([{ choices: [{ delta: { content: 'Đang tạo 50%\n' } }] }, { choices: [{ delta: { content: '![Generated Image](https://img.google.test/a.png?x=1)' } }] }]);
      }
      if (c.url === 'https://img.google.test/a.png?x=1') return new Response(fs.readFileSync(LOGO_PNG));
      return json({ error: { message: 'không mong đợi' } }, 500);
    }, calls));
    const post = calls[0]!;
    expect(post.body.model).toBe('gemini-3.1-flash-image-portrait');
    expect(post.body.messages[0].content.map((p: { type: string }) => p.type)).toEqual(['text', 'image_url']);
    expect(calls[1]!.headers.Authorization).toBeUndefined();
    const s = await sceneDetail(sc);
    const sb = s.assets.find((a: { kind: string }) => a.kind === 'storyboard');
    expect(sb.meta.logo.status).toBe('removed');
    expect(s.comments.some((c: { body: string }) => c.body.startsWith(`[flow] storyboard job ${job.id}`))).toBe(true);
  }, 60_000);

  it('Flow video: stream trả <video src>, tải về, dựng lưới', async () => {
    const { sc, m } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    const sbAsset = (await sceneDetail(sc)).assets.find((a: { kind: string }) => a.kind === 'storyboard');
    fs.writeFileSync(path.join(env.root, sbAsset.file_path), m.png);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'flow-veo-fast' })).status).toBe(200);
    const job = await claimJob(sc);
    const calls: Call[] = [];
    await runMediaJob(job, makeDeps(sc, (c) => {
      if (c.method === 'POST') return sse([{ choices: [{ delta: { content: "<video src='https://flow-content.google.test/v.mp4?a=1&amp;b=2' controls></video>" } }] }]);
      if (c.url === 'https://flow-content.google.test/v.mp4?a=1&b=2') return new Response(m.mp4);
      return json({}, 500);
    }, calls));
    expect(calls[0]!.body.model).toBe('veo-3.1-fast-r2v-8s-portrait');
    const s = await sceneDetail(sc);
    expect(s.status).toBe('video_review');
    expect(s.assets.find((a: { kind: string }) => a.kind === 'video').verdict_note).toMatch(/Google Flow · Veo 3.1 Fast/);
  });

  it('Flow video: tải kết quả lỗi mạng 2 lần thì thử lại, không tạo lại video', async () => {
    const { sc, m } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    const sbAsset = (await sceneDetail(sc)).assets.find((a: { kind: string }) => a.kind === 'storyboard');
    fs.writeFileSync(path.join(env.root, sbAsset.file_path), m.png);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'flow-veo-fast' })).status).toBe(200);
    const job = await claimJob(sc);
    const calls: Call[] = [];
    let downloads = 0;
    await runMediaJob(job, makeDeps(sc, (c) => {
      if (c.method === 'POST') return sse([{ choices: [{ delta: { content: "<video src='https://flow-content.google.test/v.mp4'></video>" } }] }]);
      downloads++;
      if (downloads <= 2) throw new TypeError('fetch failed');
      return new Response(m.mp4);
    }, calls));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(downloads).toBe(3);
    expect((await sceneDetail(sc)).status).toBe('video_review');
  });

  it('Flow: sự kiện lỗi hết token → LOGIN_REQUIRED; lần gửi trước không rõ kết quả → không gửi lại', async () => {
    const { sc, m } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    const sbAsset = (await sceneDetail(sc)).assets.find((a: { kind: string }) => a.kind === 'storyboard');
    fs.writeFileSync(path.join(env.root, sbAsset.file_path), m.png);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'flow-veo-lite' })).status).toBe(200);
    const job = await claimJob(sc);
    const err = await runMediaJob(job, makeDeps(sc, () => sse([{ error: { message: '没有可用的Token', status_code: 503 } }]), [])).catch((e) => e);
    expect(err).toMatchObject({ code: 'LOGIN_REQUIRED' });

    // Mô phỏng worker chết giữa stream: nhật ký có sent_at, chưa có url.
    const dir = path.join(env.root, 'data', 'media-worker');
    fs.writeFileSync(path.join(dir, `job-${job.id}.json`), JSON.stringify({ flow: { sent_at: '2026-11-05T00:00:00Z' } }));
    const calls: Call[] = [];
    const err2 = await runMediaJob(job, makeDeps(sc, () => json({}), calls)).catch((e) => e);
    expect(err2).toMatchObject({ code: 'OTHER' });
    expect(err2.message).toMatch(/không rõ kết quả/);
    expect(calls).toHaveLength(0);
  });
  it('Flow: lỗi tài khoản TRƯỚC khi Flow nhận lệnh (hết token, cookie 401 ở maseQ) → tự gửi lại rồi thành công; có tiến độ rồi thì không gửi lại', async () => {
    const { sc, m } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    const sbAsset = (await sceneDetail(sc)).assets.find((a: { kind: string }) => a.kind === 'storyboard');
    fs.writeFileSync(path.join(env.root, sbAsset.file_path), m.png);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'flow-omni-10s' })).status).toBe(200);
    const job = await claimJob(sc);
    const calls: Call[] = [];
    let posts = 0;
    const errors = [
      { message: '没有可用的Token进行视频生成。所有Token都处于禁用、冷却、配额耗尽或已过期状态。', status_code: 503 },
      { message: '生成失败: Flow 登录认证失败：Google Cookie 已失效 (rpc=maseQ, code=401)' },
    ];
    await runMediaJob(job, { ...makeDeps(sc, (c) => {
      if (c.method === 'POST') {
        const e = errors[posts++];
        return e ? sse([{ error: e }]) : sse([{ choices: [{ delta: { content: "<video src='https://flow-content.google.test/v.mp4'></video>" } }] }]);
      }
      return new Response(m.mp4);
    }, calls), flowRetryDelaysMs: [0, 0, 0] });
    expect(posts).toBe(3);
    expect((await sceneDetail(sc)).status).toBe('video_review');
  });

  it('Flow: 401 sau khi đã có tiến độ (Flow đã tạo) → không gửi lại, không đánh dấu tạo lại được', async () => {
    const { sc, m } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    const sbAsset = (await sceneDetail(sc)).assets.find((a: { kind: string }) => a.kind === 'storyboard');
    fs.writeFileSync(path.join(env.root, sbAsset.file_path), m.png);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'flow-omni-10s' })).status).toBe(200);
    const job = await claimJob(sc);
    let posts = 0;
    const err = await runMediaJob(job, { ...makeDeps(sc, () => {
      posts++;
      return sse([{ choices: [{ delta: { content: 'Đang tạo 40%' } }] }, { error: { message: 'Flow 登录认证失败 (rpc=maseQ, code=401)' } }]);
    }, []), flowRetryDelaysMs: [0, 0] }).catch((e) => e);
    expect(posts).toBe(1);
    expect(err).toMatchObject({ code: 'LOGIN_REQUIRED', retryable: false });
    // hết số lần gửi lại với lỗi trước khi gửi → ném lỗi cuối, kèm retryable
    const dir = path.join(env.root, 'data', 'media-worker');
    fs.rmSync(path.join(dir, `job-${job.id}.json`), { force: true });
    posts = 0;
    const err2 = await runMediaJob(job, { ...makeDeps(sc, () => {
      posts++;
      return sse([{ error: { message: '没有可用的Token进行视频生成', status_code: 503 } }]);
    }, []), flowRetryDelaysMs: [0, 0] }).catch((e) => e);
    expect(posts).toBe(3);
    expect(err2).toMatchObject({ code: 'LOGIN_REQUIRED', retryable: true });
  });

  it('auto-resume: chỉ bật lại hàng đợi dừng vì LOGIN_REQUIRED và tạo lại job lỗi trước khi gửi (đúng dịch vụ)', async () => {
    const { sc } = await setup();
    await toStoryboardReview(sc, sc.scenes[0].id);
    expect((await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'video', generator: 'flow-omni-10s' })).status).toBe(200);
    const job = await claimJob(sc);
    const f = await sc.worker.post(`/api/worker/jobs/${job.id}/fail?worker=${W}`, { error: 'Tài khoản Flow2API không khả dụng', code: 'LOGIN_REQUIRED', retryable: true });
    expect(f.status, f.raw).toBe(200);
    expect((await sceneDetail(sc)).status).toBe('failed');
    const r = await sc.worker.post(`/api/worker/queue/auto-resume?worker=${W}`, {});
    expect(r.status, r.raw).toBe(200);
    expect(r.body.resumed).toBe(true);
    expect(r.body.requeued).toHaveLength(1);
    expect(r.body.worker.queue_paused).toBe(false);
    const again = await claimJob(sc);
    expect(again.id).toBe(r.body.requeued[0]);
    expect(again.payload.generator.id).toBe('flow-omni-10s');
    // lần thứ hai không tạo lại job cũ; dừng vì lý do khác thì không tự bật
    await sc.worker.post(`/api/worker/jobs/${again.id}/fail?worker=${W}`, { error: 'captcha', code: 'CAPTCHA', retryable: true });
    const r2 = await sc.worker.post(`/api/worker/queue/auto-resume?worker=${W}`, {});
    expect(r2.body).toMatchObject({ resumed: false, requeued: [] });
    expect(r2.body.worker.queue_paused).toBe(true);
  });
});
