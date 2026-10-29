import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepStaleJobs } from '../src/services/jobs.js';
import { workerStatusTick } from '../src/services/worker.js';
import {
  CAN_SYMLINK,
  PNG_BYTES,
  bareScenario,
  claim,
  client,
  finish,
  makeEnv,
  scene,
  setupProject,
  toStoryboardReview,
  toVideoReview,
  workerClient,
  writeFile,
  type Env,
  type Scenario,
} from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

describe('xác thực worker', () => {
  it('từ chối khi thiếu / sai token; chấp nhận token đúng; /api/worker/status không cần token', async () => {
    const none = client(env.app);
    const wrong = workerClient(env.app, 'sai-token');
    const ok = workerClient(env.app);
    for (const c of [none, wrong]) {
      for (const [m, url] of [
        ['get', '/api/worker/next'],
        ['get', '/api/worker/ping'],
        ['post', '/api/worker/jobs/1/heartbeat'],
        ['post', '/api/worker/jobs/1/complete'],
        ['post', '/api/worker/jobs/1/fail'],
        ['post', '/api/worker/scenes'],
        ['post', '/api/worker/comments'],
      ] as const) {
        const r = await (c as any)[m](url);
        expect(r.status, `${m} ${url}`).toBe(401);
        expect(r.body.error.code).toBe('UNAUTHORIZED');
      }
    }
    // sai kiểu header
    expect((await client(env.app, { authorization: 'Basic abc' }).get('/api/worker/ping')).status).toBe(401);
    expect((await client(env.app, { authorization: `Bearer ${'x'.repeat(500)}` }).get('/api/worker/ping')).status).toBe(401);
    expect((await ok.get('/api/worker/ping')).status).toBe(200);
    expect((await ok.get('/api/worker/next')).status).toBe(204);
    expect((await none.get('/api/worker/status')).status).toBe(200);
  });

  it('token rỗng trong cấu hình không bao giờ khớp', async () => {
    await env.close();
    env = await makeEnv({ config: { workerToken: '' } });
    expect((await client(env.app, { authorization: 'Bearer ' }).get('/api/worker/ping')).status).toBe(401);
    expect((await client(env.app, { authorization: 'Bearer x' }).get('/api/worker/ping')).status).toBe(401);
  });

  it('request worker không hợp lệ không làm worker online', async () => {
    await workerClient(env.app, 'sai').get('/api/worker/ping');
    expect((await client(env.app).get('/api/worker/status')).body).toMatchObject({ online: false, last_seen_at: null });
  });
});

describe('trạng thái online của worker', () => {
  it('online trong WORKER_ONLINE_SECONDS sau request hợp lệ, offline sau đó; tick phát worker.status', async () => {
    const sc = bareScenario(env);
    const events: any[] = [];
    const orig = env.ctx.sse.publish.bind(env.ctx.sse);
    env.ctx.sse.publish = (e: string, d: unknown, p: number | null) => {
      if (e === 'worker.status') events.push(d);
      orig(e, d, p);
    };
    expect((await sc.user.get('/api/worker/status')).body.online).toBe(false);
    await sc.worker.get('/api/worker/ping?worker=abc');
    let st = (await sc.user.get('/api/worker/status')).body;
    expect(st).toMatchObject({ online: true, worker_id: 'abc', queue_paused: false });
    expect(events.at(-1).online).toBe(true);
    env.clock.advance(89_000);
    expect((await sc.user.get('/api/worker/status')).body.online).toBe(true);
    env.clock.advance(2_000);
    expect((await sc.user.get('/api/worker/status')).body.online).toBe(false);
    workerStatusTick(env.ctx);
    expect(events.at(-1).online).toBe(false);
    const n = events.length;
    workerStatusTick(env.ctx); // không đổi → không phát lại
    expect(events.length).toBe(n);
  });
});

describe('claim nguyên tử', () => {
  async function queueStoryboards(n: number) {
    const sc = await setupProject(env, { scenes: n });
    await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'storyboard', expectedCredits: 0 });
    return sc;
  }

  it('hai instance trên cùng file DB gọi next đồng thời: không bao giờ nhận trùng job', async () => {
    const sc = await queueStoryboards(6);
    const app2 = await env.second();
    const c1 = workerClient(env.app);
    const c2 = workerClient(app2);
    const calls = Array.from({ length: 16 }, (_, i) => (i % 2 ? c1 : c2).get(`/api/worker/next?worker=w${i}`));
    const results = await Promise.all(calls);
    const got = results.filter((r) => r.status === 200).map((r) => r.body.id);
    expect(got).toHaveLength(6);
    expect(new Set(got).size).toBe(6);
    expect(results.filter((r) => r.status === 204)).toHaveLength(10);
    const jobs = (await sc.user.get('/api/jobs?status=claimed')).body;
    expect(jobs).toHaveLength(6);
    expect(new Set(jobs.map((j: any) => j.claimed_by)).size).toBe(6);
  });

  it('nhiều TIẾN TRÌNH song song claim trên cùng file DB: mỗi job chỉ được nhận đúng một lần', async () => {
    await queueStoryboards(24);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const child = (who: string) =>
      new Promise<number[]>((resolve, reject) => {
        const p = spawn(process.execPath, [tsxCli, path.join(here, 'fixtures', 'claim-child.ts'), env.dbPath, env.root, who], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => {
          if (code !== 0) return reject(new Error(`child ${who} exit ${code}: ${err}`));
          resolve(JSON.parse(out.trim().split('\n').at(-1)!));
        });
      });
    const lists = await Promise.all(['a', 'b', 'c', 'd'].map(child));
    const all = lists.flat();
    expect(all).toHaveLength(24);
    expect(new Set(all).size).toBe(24);
  }, 60_000);

  it('một job queued duy nhất, nhiều worker cùng gọi: đúng một nhận được', async () => {
    await setupProject(env, { scenes: 1 }).then((sc) => sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' }));
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => workerClient(env.app).get(`/api/worker/next?worker=x${i}`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 204)).toHaveLength(4);
  });

  it('job cần duyệt mà chưa được duyệt thì không bao giờ được claim (kể cả chèn trực tiếp vào DB)', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    env.ctx.db
      .prepare(
        `INSERT INTO jobs (project_id, scene_id, type, status, payload, created_at, requires_approval, approved_at)
         VALUES (?, ?, 'storyboard', 'queued', '{}', ?, 1, NULL)`,
      )
      .run(sc.project.id, sc.scenes[0].id, env.ctx.now());
    expect((await sc.worker.get('/api/worker/next')).status).toBe(204);
  });

  it('job cũ không còn khớp trạng thái cảnh bị hủy thay vì được giao', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    env.ctx.db.prepare("UPDATE scenes SET status = 'awaiting_approval' WHERE id = ?").run(sc.scenes[0].id);
    expect((await sc.worker.get('/api/worker/next')).status).toBe(204);
    const jobs = (await sc.user.get('/api/jobs')).body;
    expect(jobs[0].status).toBe('cancelled');
  });

  it('payload được tính lại lúc claim (ghi đè cột payload)', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    await sc.user.patch(`/api/scenes/${sc.scenes[0].id}/prompt`, { prompt: 'x' }).catch(() => null); // bị từ chối khi đang queued
    const j = await claim(sc);
    expect(j.payload.scene.prompt).toBe('Prompt gốc của cảnh 1');
    const stored = (await sc.user.get(`/api/jobs/${j.id}`)).body;
    expect(stored.payload).toEqual(j.payload);
    expect(stored).toMatchObject({ status: 'claimed', claimed_by: 'w1' });
  });
});

describe('MAX_CONCURRENT_VIDEO_JOBS', () => {
  it('không claim quá số job video chạy cùng lúc; xong một cái thì claim tiếp được', async () => {
    await env.close();
    env = await makeEnv({ config: { maxConcurrentVideoJobs: 2 } });
    const sc = await setupProject(env, { scenes: 4 });
    for (const s of sc.scenes) await toStoryboardReview(sc, s.id);
    await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'video', expectedCredits: 60 });
    const j1 = await claim(sc, 'a');
    const j2 = await claim(sc, 'b');
    expect([j1.type, j2.type]).toEqual(['video', 'video']);
    expect((await sc.worker.get('/api/worker/next')).status).toBe(204);
    const queued = (await sc.user.get('/api/scenes/' + sc.scenes[2].id)).body;
    expect(queued.waiting_reason).toBe('Đã có 2/2 video chạy cùng lúc');
    expect((await finish(sc, j1)).status).toBe(200);
    const j3 = await claim(sc, 'c');
    expect(j3.type).toBe('video');
    expect((await sc.worker.get('/api/worker/next')).status).toBe(204);
    // job storyboard không bị giới hạn bởi số video đang chạy
    const sc2 = await setupProject(env, { scenes: 1, project: { name: 'Dự án phụ' } });
    await sc2.user.post(`/api/scenes/${sc2.scenes[0].id}/approve`, { stage: 'storyboard' });
    expect((await claim(sc2)).type).toBe('storyboard');
  });
});

describe('use_prev_storyboard', () => {
  it('storyboard C2 chờ tới khi C1 có storyboard, rồi upload kèm storyboard C1', async () => {
    const sc = await setupProject(env, { scenes: 2, usePrev: true });
    const [c1, c2] = sc.scenes.map((s: any) => s.id);
    // duyệt C2 trước
    await sc.user.post(`/api/scenes/${c2}/approve`, { stage: 'storyboard' });
    expect((await sc.worker.get('/api/worker/next')).status).toBe(204);
    expect((await scene(sc, c2)).waiting_reason).toBe('Đang chờ storyboard của C1');
    // duyệt C1, xong storyboard C1
    await toStoryboardReview(sc, c1);
    const j = await claim(sc);
    expect(j.scene_id).toBe(c2);
    expect(j.payload.upload_files).toEqual(['output/cacao-actiso-plus/storyboard/C1_storyboard.png']);
    expect((await scene(sc, c2)).waiting_reason).toBeNull();
  });

  it('upload_refs theo thứ tự rồi mới tới storyboard cảnh đầu; cảnh đầu không phụ thuộc chính nó', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    // tải 2 ảnh tham chiếu
    const { multipart } = await import('./helpers.js');
    const m = multipart([
      { name: 'label', value: 'Hộp 3/4' },
      { name: 'file', filename: 'box.png', data: PNG_BYTES, type: 'image/png' },
      { name: 'label', value: 'Stick' },
      { name: 'file', filename: 'stick.png', data: PNG_BYTES, type: 'image/png' },
    ]);
    const up = await env.app.inject({ method: 'POST', url: `/api/projects/${sc.project.id}/refs`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
    expect(up.statusCode).toBe(201);
    const refs = JSON.parse(up.body);
    expect(refs.map((r: any) => r.label)).toEqual(['Hộp 3/4', 'Stick']);
    const [box, stick] = refs;
    const r = await sc.worker.post('/api/worker/scenes', {
      project_id: sc.project.id,
      scenes: [
        { code: 'C1', title: 'x', prompt: 'p1', upload_refs: [stick.id, box.id], use_prev_storyboard: true },
        { code: 'C2', title: 'y', prompt: 'p2', upload_refs: [box.id], use_prev_storyboard: true },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual(['C1']);
    expect(r.body.created).toEqual(['C2']);
    const [c1, c2] = r.body.scenes.map((s: any) => s.id);
    await sc.user.post(`/api/scenes/${c1}/approve`, { stage: 'storyboard' });
    const j1 = await claim(sc);
    expect(j1.payload.upload_files).toEqual([stick.file_path, box.file_path]); // C1 là cảnh đầu: không tự nối chính nó
    await finish(sc, j1);
    await sc.user.post(`/api/scenes/${c2}/approve`, { stage: 'storyboard' });
    const j2 = await claim(sc);
    expect(j2.payload.upload_files).toEqual([box.file_path, 'output/cacao-actiso-plus/storyboard/C1_storyboard.png']);
    await finish(sc, j2);
    await sc.user.post(`/api/scenes/${c2}/approve`, { stage: 'video' });
    const vj = await claim(sc);
    expect(vj.payload.upload_files).toEqual([box.file_path, 'output/cacao-actiso-plus/storyboard/C1_storyboard.png'.replace('C1', 'C2')]);
  });
});

describe('job mất heartbeat', () => {
  it('quá HEARTBEAT_STALE_MINUTES: job về queued, requeue_count+1, cảnh về *_queued; lần claim sau payload.requeued=true', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j = await claim(sc, 'w1');
    expect(j.payload.requeued).toBe(false);
    expect((await scene(sc, id)).status).toBe('video_running');
    await sc.worker.post(`/api/worker/jobs/${j.id}/heartbeat`, {});

    env.clock.advanceMinutes(4.9);
    expect(sweepStaleJobs(env.ctx)).toEqual([]);
    expect((await scene(sc, id)).status).toBe('video_running');

    env.clock.advanceMinutes(0.2); // tổng 5,1 phút kể từ heartbeat
    expect(sweepStaleJobs(env.ctx)).toEqual([j.id]);
    const requeued = (await sc.user.get(`/api/jobs/${j.id}`)).body;
    expect(requeued).toMatchObject({ status: 'queued', requeue_count: 1, claimed_by: null, heartbeat_at: null });
    expect(requeued.last_requeued_at).toBe(env.ctx.now());
    const s = await scene(sc, id);
    expect(s.status).toBe('video_queued');
    // credit vẫn được đặt trước (job còn trong hàng đợi) và có cảnh báo trong dòng thời gian + project detail
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body.reserved).toBe(15);
    const events = (await sc.user.get(`/api/projects/${sc.project.id}/events?sceneId=${id}`)).body;
    expect(events.find((e: any) => e.type === 'job.requeued').message).toContain('mất heartbeat');
    expect((await sc.user.get(`/api/projects/${sc.project.id}`)).body.requeued_jobs.map((x: any) => x.id)).toEqual([j.id]);

    // worker cũ vẫn gọi heartbeat/complete → 409
    expect((await sc.worker.post(`/api/worker/jobs/${j.id}/heartbeat`, {})).status).toBe(409);
    expect((await finish(sc, j)).status).toBe(409);

    const j2 = await claim(sc, 'w2');
    expect(j2.id).toBe(j.id);
    expect(j2.payload.requeued).toBe(true);
    expect(j2.claimed_by).toBe('w2');
    expect((await scene(sc, id)).status).toBe('video_running');
    expect((await finish(sc, j2)).status).toBe(200);
    expect((await scene(sc, id)).status).toBe('video_review');
    // chỉ một video được tạo, một khoản credit bị trừ
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body).toMatchObject({ used: 15, reserved: 0 });
  });

  it('heartbeat đều đặn giữ job không bị trả về; heartbeat đầu tiên đổi claimed → running', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const j = await claim(sc);
    expect((await sc.user.get(`/api/jobs/${j.id}`)).body.status).toBe('claimed');
    for (let i = 0; i < 4; i++) {
      env.clock.advanceMinutes(3);
      expect((await sc.worker.post(`/api/worker/jobs/${j.id}/heartbeat?worker=w1`, {})).status).toBe(200);
      expect(sweepStaleJobs(env.ctx)).toEqual([]);
    }
    expect((await sc.user.get(`/api/jobs/${j.id}`)).body.status).toBe('running');
  });

  it('job claimed nhưng chưa heartbeat lần nào cũng bị quét; heartbeat của worker khác bị từ chối', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const j = await claim(sc, 'w1');
    const other = await sc.worker.post(`/api/worker/jobs/${j.id}/heartbeat?worker=w2`, {});
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('JOB_CANCELLED');
    env.clock.advanceMinutes(6);
    expect(sweepStaleJobs(env.ctx)).toEqual([j.id]);
    expect((await scene(sc, sc.scenes[0].id)).status).toBe('storyboard_queued');
  });
});

describe('hủy job', () => {
  it('hủy job đang running: heartbeat/complete/fail → 409 JOB_CANCELLED; cảnh về trạng thái ổn định', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    const j = await claim(sc);
    await sc.worker.post(`/api/worker/jobs/${j.id}/heartbeat`, {});
    const c = await sc.user.post(`/api/jobs/${j.id}/cancel`, {});
    expect(c.status).toBe(200);
    expect(c.body.job.status).toBe('cancelled');
    expect(c.body.scene.status).toBe('awaiting_approval'); // chưa có storyboard
    for (const url of ['heartbeat', 'complete', 'fail']) {
      const r = await sc.worker.post(`/api/worker/jobs/${j.id}/${url}`, url === 'fail' ? { error: 'x' } : {});
      expect(r.status, url).toBe(409);
      expect(r.body.error.code, url).toBe('JOB_CANCELLED');
    }
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body.reserved).toBe(0);
    // không có asset nào được tạo
    expect((await scene(sc, id)).assets).toHaveLength(0);
  });

  it('hủy job video: về video_review nếu đã có video, ngược lại storyboard_review', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j = await claim(sc);
    expect((await sc.user.post(`/api/jobs/${j.id}/cancel`, {})).body.scene.status).toBe('storyboard_review');
    await toVideoReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const j2 = (await sc.user.get('/api/jobs?status=queued')).body[0];
    expect((await sc.user.post(`/api/jobs/${j2.id}/cancel`, {})).body.scene.status).toBe('video_review');
  });

  it('hủy job storyboard khi đã có storyboard → storyboard_review; hủy revise_prompt → awaiting_approval', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    const r = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'tạo lại', action: 'regenerate_storyboard' });
    expect((await sc.user.post(`/api/jobs/${r.body.job.id}/cancel`, {})).body.scene.status).toBe('storyboard_review');
    const r2 = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'sửa prompt', action: 'revise_and_regenerate' });
    expect(r2.body.scene.status).toBe('needs_revision');
    expect((await sc.user.post(`/api/jobs/${r2.body.job.id}/cancel`, {})).body.scene.status).toBe('awaiting_approval');
  });
});

describe('fail và tạm dừng hàng đợi', () => {
  it('CAPTCHA tạm dừng hàng đợi: next trả 503 QUEUE_PAUSED cho tới khi resume', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    await sc.user.post(`/api/projects/${sc.project.id}/approve-all`, { stage: 'storyboard', expectedCredits: 0 });
    const j = await claim(sc);
    const f = await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'Gặp CAPTCHA', code: 'CAPTCHA' });
    expect(f.status).toBe(200);
    expect(f.body.worker).toMatchObject({ queue_paused: true, pause_code: 'CAPTCHA' });
    expect(f.body.worker.pause_reason).toContain('CAPTCHA');
    const st = (await sc.user.get('/api/worker/status')).body;
    expect(st.queue_paused).toBe(true);
    const n = await sc.worker.get('/api/worker/next');
    expect(n.status).toBe(503);
    expect(n.body.error.code).toBe('QUEUE_PAUSED');
    // còn job queued nhưng không được giao
    expect((await sc.user.get('/api/jobs?status=queued')).body).toHaveLength(1);
    expect((await scene(sc, j.scene_id)).status).toBe('failed');
    // trạng thái hiển thị lý do chờ
    const other = (await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body.find((s: any) => s.id !== j.scene_id);
    expect(other.waiting_reason).toBe('Hàng đợi đang tạm dừng');

    const rs = await sc.user.post('/api/queue/resume', {});
    expect(rs.body).toMatchObject({ queue_paused: false, pause_reason: null });
    expect((await sc.worker.get('/api/worker/next')).status).toBe(200);
  });

  it.each(['LOGIN_REQUIRED', 'FLOW_OUT_OF_CREDIT', 'UI_CHANGED'])('%s cũng tạm dừng; OTHER thì không', async (code) => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const j = await claim(sc);
    await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'lỗi', code });
    expect((await sc.user.get('/api/worker/status')).body.queue_paused).toBe(true);
  });

  it('mã lỗi không hợp lệ / thiếu error → 400; fail job chưa claim → 409', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const queued = (await sc.user.get('/api/jobs')).body[0];
    expect((await sc.worker.post(`/api/worker/jobs/${queued.id}/fail`, { error: 'x' })).status).toBe(409);
    const j = await claim(sc);
    expect((await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'x', code: 'LẠ' })).status).toBe(400);
    expect((await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, {})).status).toBe(400);
    // job đã fail rồi không complete được
    await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'x' });
    const again = await finish(sc, j);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });
});

describe('complete: kiểm tra file và kết quả', () => {
  async function runningStoryboard(): Promise<{ sc: Scenario; job: any }> {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    return { sc, job: await claim(sc) };
  }
  const complete = (sc: Scenario, job: any, assets: any[]) => sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: {}, assets });

  it('từ chối file không tồn tại / đường dẫn ngoài output/ / có .. / tuyệt đối / sai loại asset / thiếu asset', async () => {
    const { sc, job } = await runningStoryboard();
    const p = job.payload.output.storyboard_path;
    expect((await complete(sc, job, [{ kind: 'storyboard', file_path: p }])).body.error.code).toBe('FILE_NOT_FOUND');
    writeFile(env.root, p, PNG_BYTES);
    writeFile(env.root, 'refs/1/x.png', PNG_BYTES);
    for (const bad of ['refs/1/x.png', '../outside.png', 'output/../refs/1/x.png', '/etc/passwd', 'output\\a.png', 'output/']) {
      const r = await complete(sc, job, [{ kind: 'storyboard', file_path: bad }]);
      expect(r.status, bad).toBe(400);
      expect(['INVALID_PATH', 'FILE_NOT_FOUND']).toContain(r.body.error.code);
    }
    expect((await complete(sc, job, [{ kind: 'video', file_path: p }])).body.error.code).toBe('INVALID_ASSET_KIND');
    expect((await complete(sc, job, [])).body.error.code).toBe('ASSET_REQUIRED');
    // thư mục không phải file
    expect((await complete(sc, job, [{ kind: 'storyboard', file_path: 'output/cacao-actiso-plus/storyboard' }])).status).toBe(400);
    // job vẫn đang chạy, chưa có asset
    expect((await sc.user.get(`/api/jobs/${job.id}`)).body.status).toBe('claimed');
    expect((await complete(sc, job, [{ kind: 'storyboard', file_path: p }])).status).toBe(200);
  });

  it.skipIf(!CAN_SYMLINK)('file là symlink trỏ ra ngoài output/ bị từ chối', async () => {
    const { sc, job } = await runningStoryboard();
    const fs = await import('node:fs');
    const outside = path.join(env.root, 'secret.png');
    fs.writeFileSync(outside, PNG_BYTES);
    const link = path.join(env.root, job.payload.output.storyboard_path);
    fs.symlinkSync(outside, link);
    expect((await complete(sc, job, [{ kind: 'storyboard', file_path: job.payload.output.storyboard_path }])).status).toBe(400);
  });

  it('video: verdict không hợp lệ → 400; không có asset video → 400; credits_cost=0 không ghi sổ cái', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const job = await claim(sc);
    const v = job.payload.output.video_path;
    writeFile(env.root, v, 'mp4');
    const bad = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { verdict: 'tuyệt' }, assets: [{ kind: 'video', file_path: v }] });
    expect(bad.status).toBe(400);
    const only = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: {}, assets: [{ kind: 'grid', file_path: v }] });
    expect(only.body.error.code).toBe('ASSET_REQUIRED');
    const ok = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: {}, assets: [{ kind: 'video', file_path: v }], credits_cost: 0 });
    expect(ok.status).toBe(200);
    expect((await sc.user.get(`/api/projects/${sc.project.id}/ledger`)).body.entries).toHaveLength(0);
    expect((await scene(sc, id)).video.verdict).toBeNull();
  });

  it('revise_prompt: thiếu reason/prompt → 400', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await sc.user.post(`/api/scenes/${id}/comments`, { body: 'sửa', action: 'revise_and_regenerate' });
    const job = await claim(sc);
    expect((await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { prompt: 'abc' } })).status).toBe(400);
    expect((await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { reason: 'abc' } })).status).toBe(400);
    expect((await scene(sc, id)).status).toBe('needs_revision');
  });
});

describe('worker/scenes (upsert)', () => {
  it('chạy lại với prompt đổi → version mới của Claude; không đổi → không version; cảnh đang xử lý giữ nguyên prompt', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    const [c1, c2] = sc.scenes.map((s: any) => s.id);
    await sc.user.post(`/api/scenes/${c2}/approve`, { stage: 'storyboard' });
    const body = {
      project_id: sc.project.id,
      scenes: [
        { code: 'C1', title: 'Tiêu đề mới', prompt: 'Prompt C1 mới', order_index: 5 },
        { code: 'C2', title: 'y', prompt: 'Prompt C2 mới' },
      ],
    };
    const r = await sc.worker.post('/api/worker/scenes', body);
    expect(r.body.updated).toEqual(['C1', 'C2']);
    expect(r.body.skipped).toEqual([expect.objectContaining({ code: 'C2' })]);
    const s1 = await scene(sc, c1);
    expect(s1).toMatchObject({ title: 'Tiêu đề mới', prompt: 'Prompt C1 mới', order_index: 5, status: 'awaiting_approval' });
    expect(s1.prompt_versions).toHaveLength(2);
    expect((await scene(sc, c2)).prompt).toBe('Prompt gốc của cảnh 2');
    await sc.worker.post('/api/worker/scenes', body);
    expect((await scene(sc, c1)).prompt_versions).toHaveLength(2);
  });

  it('upload_refs không thuộc dự án / mã cảnh lặp / dự án không có → lỗi', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const mk = (scenes: any[], project_id = sc.project.id) => sc.worker.post('/api/worker/scenes', { project_id, scenes });
    expect((await mk([{ code: 'C9', prompt: 'p', upload_refs: [12345] }])).body.error.code).toBe('INVALID_REFS');
    expect((await mk([{ code: 'C9', prompt: 'p' }, { code: 'C9', prompt: 'q' }])).status).toBe(400);
    expect((await mk([{ code: 'C9', prompt: 'p' }], 999)).status).toBe(404);
    expect((await mk([{ code: '../x', prompt: 'p' }])).status).toBe(400);
    expect((await mk([])).status).toBe(400);
    // không cảnh nào được tạo khi cả lô bị từ chối
    expect((await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body).toHaveLength(1);
  });
});
