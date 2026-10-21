import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_PING_MS, SseHub } from '../src/services/sse.js';
import { claim, finish, makeEnv, setupProject, userClient, type Env } from './helpers.js';

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

interface Ev {
  event: string;
  data: any;
}

/** Mở kết nối SSE thật và gom các sự kiện. */
async function openStream(query = '') {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream${query}`, { signal: ctrl.signal });
  const events: Ev[] = [];
  let raw = '';
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = raw.indexOf('\n\n')) >= 0) {
          const block = raw.slice(0, idx);
          raw = raw.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (ev && data) events.push({ event: ev[1]!, data: JSON.parse(data[1]!) });
        }
      }
    } catch {
      /* đã đóng */
    }
  })();
  const waitFor = async (pred: (e: Ev) => boolean, ms = 2000): Promise<Ev> => {
    const t0 = Date.now();
    for (;;) {
      const found = events.find(pred);
      if (found) return found;
      if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ SSE; đã nhận: ' + events.map((e) => e.event).join(','));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { res, events, waitFor, close: () => ctrl.abort() };
}

describe('SSE /api/stream', () => {
  it('trả header SSE, gửi worker.status ngay khi kết nối', async () => {
    const s = await openStream();
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('cache-control')).toContain('no-cache');
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');
    const ev = await s.waitFor((e) => e.event === 'worker.status');
    expect(ev.data).toMatchObject({ online: false, queue_paused: false });
    expect(env.ctx.sse.size).toBe(1);
    s.close();
    await vi.waitFor(() => expect(env.ctx.sse.size).toBe(0));
  });

  it('phát scene.updated / job.updated / asset.created / comment.created / budget.updated / event.created theo luồng công việc', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const s = await openStream(`?projectId=${sc.project.id}`);
    await s.waitFor((e) => e.event === 'worker.status');
    const id = sc.scenes[0].id;

    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    const su = await s.waitFor((e) => e.event === 'scene.updated' && e.data.scene.status === 'storyboard_queued');
    expect(su.data.scene).toMatchObject({ id, code: 'C1', project_id: sc.project.id, active_job: { type: 'storyboard', status: 'queued' } });
    const ju = await s.waitFor((e) => e.event === 'job.updated' && e.data.job.type === 'storyboard');
    expect(ju.data.job).toMatchObject({ status: 'queued', scene_code: 'C1' });
    await s.waitFor((e) => e.event === 'budget.updated');
    const ec = await s.waitFor((e) => e.event === 'event.created' && /storyboard_queued/.test(e.data.event.message));
    expect(ec.data.event).toMatchObject({ scene_id: id, scene_code: 'C1', type: 'scene.status' });

    const job = await claim(sc);
    await s.waitFor((e) => e.event === 'scene.updated' && e.data.scene.status === 'storyboard_running');
    await s.waitFor((e) => e.event === 'job.updated' && e.data.job.status === 'claimed');
    await finish(sc, job);
    const ac = await s.waitFor((e) => e.event === 'asset.created');
    expect(ac.data.asset).toMatchObject({ kind: 'storyboard', scene_id: id, attempt: 1 });
    expect(ac.data.asset.url).toContain('/files/output/');
    await s.waitFor((e) => e.event === 'scene.updated' && e.data.scene.status === 'storyboard_review');
    await s.waitFor((e) => e.event === 'job.updated' && e.data.job.status === 'done');

    await userClient(env.app).post(`/api/scenes/${id}/comments`, { body: 'ghi chú', timecode: 2 });
    const cc = await s.waitFor((e) => e.event === 'comment.created');
    expect(cc.data.comment).toMatchObject({ body: 'ghi chú', timecode: 2, author: 'user' });

    // đổi kết luận → asset.updated + scene.updated
    const sb = ac.data.asset.id;
    await userClient(env.app).post(`/api/assets/${sb}/verdict`, { verdict: 'pass', verdict_note: 'tốt' });
    const au = await s.waitFor((e) => e.event === 'asset.updated');
    expect(au.data.asset).toMatchObject({ id: sb, verdict: 'pass' });
    // worker.status khi worker online
    await s.waitFor((e) => e.event === 'worker.status' && e.data.online === true);
    s.close();
  });

  it('project.updated khi gửi kịch bản, phân tích xong và sửa dự án', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const s = await openStream(`?projectId=${sc.project.id}`);
    await s.waitFor((e) => e.event === 'worker.status');
    await sc.user.patch(`/api/projects/${sc.project.id}`, { name: 'Tên mới SSE' });
    const pu = await s.waitFor((e) => e.event === 'project.updated' && e.data.project.name === 'Tên mới SSE');
    expect(pu.data.project).toMatchObject({ id: sc.project.id, scene_count: 1, credits_used: 0, credits_reserved: 0 });
    expect(pu.data.project).not.toHaveProperty('credits_remaining');
    await sc.user.post(`/api/projects/${sc.project.id}/brief`, {});
    await s.waitFor((e) => e.event === 'project.updated' && e.data.project.status === 'analyzing');
    const job = await claim(sc);
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: {} });
    await s.waitFor((e) => e.event === 'project.updated' && e.data.project.status === 'active');
    s.close();
  });

  it('lọc theo projectId: không nhận sự kiện dự án khác nhưng vẫn nhận worker.status; không có projectId thì nhận tất cả', async () => {
    const a = await setupProject(env, { scenes: 1 });
    const b = await setupProject(env, { scenes: 1, project: { name: 'Dự án B' } });
    const sa = await openStream(`?projectId=${a.project.id}`);
    const sall = await openStream();
    await sa.waitFor((e) => e.event === 'worker.status');
    await sall.waitFor((e) => e.event === 'worker.status');
    await b.user.post(`/api/scenes/${b.scenes[0].id}/approve`, { stage: 'storyboard' });
    await sall.waitFor((e) => e.event === 'scene.updated' && e.data.scene.project_id === b.project.id);
    await a.user.post(`/api/scenes/${a.scenes[0].id}/approve`, { stage: 'storyboard' });
    await sa.waitFor((e) => e.event === 'scene.updated' && e.data.scene.project_id === a.project.id);
    expect(sa.events.some((e) => e.event === 'scene.updated' && e.data.scene.project_id === b.project.id)).toBe(false);
    expect(sall.events.filter((e) => e.event === 'scene.updated').map((e) => e.data.scene.project_id)).toEqual(
      expect.arrayContaining([a.project.id, b.project.id]),
    );
    // projectId sai → 400
    const bad = await fetch(`${base}/api/stream?projectId=abc`);
    expect(bad.status).toBe(400);
    sa.close();
    sall.close();
  });

  it('chỉ phát sau khi commit: thao tác bị từ chối (rollback) không phát sự kiện nào', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const s = await openStream(`?projectId=${sc.project.id}`);
    await s.waitFor((e) => e.event === 'worker.status');
    const n = s.events.length;
    // comment regenerate_same bị từ chối (chưa có storyboard): comment đã INSERT trong transaction rồi bị rollback
    const r = await sc.user.post(`/api/scenes/${sc.scenes[0].id}/comments`, { body: 'x', action: 'regenerate_same' });
    expect(r.status).toBe(409);
    await new Promise((res) => setTimeout(res, 100));
    expect(s.events.length).toBe(n);
    s.close();
  });

  it('khi job mất heartbeat và bị trả về: phát job.updated + scene.updated + event.created cảnh báo', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    await claim(sc);
    const s = await openStream(`?projectId=${sc.project.id}`);
    await s.waitFor((e) => e.event === 'worker.status');
    env.clock.advanceMinutes(6);
    const { sweepStaleJobs } = await import('../src/services/jobs.js');
    sweepStaleJobs(env.ctx);
    const ju = await s.waitFor((e) => e.event === 'job.updated');
    expect(ju.data.job).toMatchObject({ status: 'queued', requeue_count: 1 });
    await s.waitFor((e) => e.event === 'scene.updated' && e.data.scene.status === 'storyboard_queued');
    await s.waitFor((e) => e.event === 'event.created' && e.data.event.type === 'job.requeued');
    s.close();
  });

  it('CAPTCHA phát worker.status với queue_paused=true cho mọi người nghe', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    const job = await claim(sc);
    const s = await openStream(`?projectId=999`); // dự án khác vẫn nhận sự kiện toàn cục
    await s.waitFor((e) => e.event === 'worker.status');
    await sc.worker.post(`/api/worker/jobs/${job.id}/fail`, { error: 'CAPTCHA!', code: 'CAPTCHA' });
    const ev = await s.waitFor((e) => e.event === 'worker.status' && e.data.queue_paused === true);
    expect(ev.data).toMatchObject({ pause_code: 'CAPTCHA', online: true });
    await userClient(env.app).post('/api/queue/resume', {});
    await s.waitFor((e) => e.event === 'worker.status' && e.data.queue_paused === false);
    s.close();
  });
});

describe('SseHub', () => {
  it(`gửi ": ping" mỗi ${SSE_PING_MS / 1000} giây và dọn khi đóng`, () => {
    vi.useFakeTimers();
    try {
      const hub = new SseHub();
      const writes: string[] = [];
      const res: any = new EventEmitter();
      res.writeHead = vi.fn();
      res.write = (t: string) => writes.push(t);
      res.end = vi.fn();
      hub.add(res, null, [{ event: 'worker.status', data: { online: false } }]);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/event-stream; charset=utf-8' }));
      expect(writes.join('')).toContain('event: worker.status\ndata: {"online":false}\n\n');
      expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(0);
      vi.advanceTimersByTime(SSE_PING_MS);
      expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(1);
      vi.advanceTimersByTime(SSE_PING_MS * 2);
      expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(3);
      res.emit('close');
      expect(hub.size).toBe(0);
      vi.advanceTimersByTime(SSE_PING_MS * 2);
      expect(writes.filter((w) => w === ': ping\n\n')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
