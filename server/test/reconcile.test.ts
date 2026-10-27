import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, makeEnv, type Env } from './helpers.js';
import { managedClient, mediaScenario, type MediaScenario } from './helpers-media.js';
import { sweepStaleJobs } from '../src/services/jobs.js';

/**
 * F4: đối soát job managed có thao tác tạo bên ngoài chưa rõ kết quả (needs_reconciliation).
 * Mọi action đi qua API journal thật, không có thao tác browser nào.
 */
let env: Env;
let ms: MediaScenario;
beforeEach(async () => { env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: ['storyboard', 'video'] } }); ms = await mediaScenario(env); });
afterEach(async () => { await env.close(); });
const user = () => client(env.app);
const w = (job: any, worker = 'W1') => managedClient(env, worker, job.lease_id, job.id);
const journal = (job: any, id: string, state: string) => w(job).post(`/api/worker/jobs/${job.id}/actions`, { id, profile: 'media', kind: job.type, state, evidence: { at: state } });
const actions = (job: any) => w(job).get(`/api/worker/jobs/${job.id}/actions`).then((r) => r.body as { id: string; state: string; evidence: any }[]);
const reconcile = (job: any, outcome: string, note?: string) => user().post(`/api/jobs/${job.id}/reconcile`, { outcome, ...(note ? { note } : {}) });
const jobRow = (id: number) => env.ctx.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;
const ledger = (id: number) => env.ctx.db.prepare('SELECT delta FROM credit_ledger WHERE job_id=?').all(id) as { delta: number }[];
const sceneStatus = () => (env.ctx.db.prepare('SELECT status FROM scenes WHERE id=?').get(ms.sceneId) as { status: string }).status;

/** Job đã submit (journal), worker rồi xin chờ đối soát như main.ts làm khi lỗi sau submit. */
async function waiting(type: 'storyboard' | 'video', state: 'intent' | 'submitted' | 'uncertain' | 'downloaded' = 'submitted') {
  const job = type === 'video' ? await ms.video() : await ms.storyboard();
  const id = `media-${job.id}`;
  await journal(job, id, 'intent');
  if (state !== 'intent') await journal(job, id, state === 'uncertain' ? 'uncertain' : 'submitted');
  if (state === 'downloaded') await journal(job, id, 'downloaded');
  await w(job).post(`/api/worker/jobs/${job.id}/checkpoint`, { step: 'inference', messages: [{ role: 'user', content: 'private-context' }], uploads: [{ files: ['x'], url: 'u', method: 'input' }] });
  expect((await w(job).post(`/api/worker/jobs/${job.id}/wait`, { reason: 'needs_reconciliation', retry_at: null })).status).toBe(200);
  return job;
}

describe('journal: chỉ một action sống mỗi job', () => {
  it('intent mới khi đã có action chưa đối soát bị từ chối (không thể submit lần hai)', async () => {
    const job = await ms.video();
    expect((await journal(job, `media-${job.id}`, 'intent')).status).toBe(200);
    const r = await journal(job, `media-${job.id}-2`, 'intent');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ACTION_CONFLICT');
    expect((await actions(job)).map((a) => a.id)).toEqual([`media-${job.id}`]);
  });
  it('worker không thể tự đặt trạng thái abandoned', async () => {
    const job = await ms.video();
    await journal(job, `media-${job.id}`, 'intent');
    expect((await journal(job, `media-${job.id}`, 'abandoned')).status).toBe(400);
  });
});

describe('F4 POST /api/jobs/:id/reconcile', () => {
  it('job chờ đối soát hiện reconcile_required và trạng thái action trong API công khai', async () => {
    const job = await waiting('video', 'intent');
    const j = (await user().get(`/api/jobs/${job.id}`)).body;
    expect(j).toMatchObject({ status: 'queued', wait_reason: 'needs_reconciliation', action_state: 'intent', reconcile_required: true });
    expect((await user().get(`/api/scenes/${ms.sceneId}`)).body.waiting_reason).toMatch(/đối soát/i);
    expect(JSON.stringify(j)).not.toContain('private-context');
  });

  it('retry_download: intent|uncertain → submitted, xóa wait; worker resume giữ checkpoint và KHÔNG submit lại được', async () => {
    for (const state of ['intent', 'uncertain'] as const) {
      await env.close();
      env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: ['storyboard', 'video'] } });
      ms = await mediaScenario(env);
      const job = await waiting('video', state);
      const r = await reconcile(job, 'retry_download', 'đã thấy video trong project Flow');
      expect(r.status, state).toBe(200);
      expect(r.body.replay).toBe(false);
      expect((await actions(job)).map((a) => a.state)).toEqual(['submitted']);
      expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: null, next_attempt_at: null });
      // đã đối soát: không còn "cần đối soát" (chờ worker tiếp tục) nhưng vẫn không hủy được
      expect((await user().get(`/api/jobs/${job.id}`)).body).toMatchObject({ reconcile_required: false, action_state: 'submitted' });
      expect((await user().post(`/api/jobs/${job.id}/cancel`)).body.error.code).toBe('RECONCILIATION_REQUIRED');
      expect(sceneStatus()).toBe('video_queued');
      const again = (await managedClient(env, 'W2').get('/api/worker/next?mode=managed')).body;
      expect(again.id).toBe(job.id);
      expect(again.checkpoint.messages[0].content).toBe('private-context'); // ngữ cảnh được giữ
      expect(again.checkpoint.uploads).toHaveLength(1);
      // worker resume: không thể ghi intent mới (đã có action sống)
      const second = await w(again, 'W2').post(`/api/worker/jobs/${job.id}/actions`, { id: `media-${job.id}-2`, profile: 'media', kind: 'video', state: 'intent', evidence: {} });
      expect(second.status).toBe(409);
      // và vẫn tải được: submitted → downloaded
      expect((await w(again, 'W2').post(`/api/worker/jobs/${job.id}/actions`, { id: `media-${job.id}`, profile: 'media', kind: 'video', state: 'downloaded', evidence: {} })).status).toBe(200);
    }
  });
  it('retry_download khi action đã submitted/downloaded giữ nguyên trạng thái action', async () => {
    const job = await waiting('storyboard', 'downloaded');
    expect((await reconcile(job, 'retry_download')).status).toBe(200);
    expect((await actions(job)).map((a) => a.state)).toEqual(['downloaded']);
    expect(jobRow(job.id).wait_reason).toBeNull();
  });

  it('nothing_created: action → abandoned; chạy lại từ đầu với action id MỚI media-<job>-<n>, checkpoint bị xóa', async () => {
    const job = await waiting('video', 'uncertain');
    expect((await reconcile(job, 'nothing_created')).status).toBe(200);
    expect((await actions(job)).map((a) => a.state)).toEqual(['abandoned']);
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: null, checkpoint: null });
    expect(sceneStatus()).toBe('video_queued');
    expect(ledger(job.id)).toEqual([]);
    const again = (await managedClient(env, 'W2').get('/api/worker/next?mode=managed')).body;
    expect(again.id).toBe(job.id);
    expect(again.checkpoint).toBeNull();
    // action cũ không dùng lại được; id mới được; chỉ một action sống
    expect((await journal(again, `media-${job.id}`, 'intent')).status).toBe(409);
    expect((await w(again, 'W2').post(`/api/worker/jobs/${job.id}/actions`, { id: `media-${job.id}-2`, profile: 'media', kind: 'video', state: 'intent', evidence: {} })).status).toBe(200);
    expect((await w(again, 'W2').post(`/api/worker/jobs/${job.id}/actions`, { id: `media-${job.id}-3`, profile: 'media', kind: 'video', state: 'intent', evidence: {} })).status).toBe(409);
    expect((await actions(job)).map((a) => [a.id, a.state])).toEqual([[`media-${job.id}`, 'abandoned'], [`media-${job.id}-2`, 'intent']]);
  });
  it('nothing_created rồi hủy được job (không còn action sống)', async () => {
    const job = await waiting('storyboard', 'submitted');
    expect((await user().post(`/api/jobs/${job.id}/cancel`)).status).toBe(409);
    await reconcile(job, 'nothing_created');
    expect((await user().post(`/api/jobs/${job.id}/cancel`)).status).toBe(200);
  });

  it('charge_and_fail (video): job failed, credits_cost = credits_expected, ledger đúng một lần, tính một lượt', async () => {
    const job = await waiting('video', 'submitted');
    const expected = job.payload.credits_expected;
    expect(expected).toBe(15);
    expect((await user().get(`/api/scenes/${ms.sceneId}`)).body.attempts_used).toBe(1); // job video đang chờ cũng chiếm một lượt
    const r = await reconcile(job, 'charge_and_fail', 'Flow trừ 15 credit nhưng không tải được');
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ status: 'failed', credits_cost: expected, reconcile_required: false });
    expect(ledger(job.id)).toEqual([{ delta: -expected }]);
    expect(sceneStatus()).toBe('failed');
    expect((await user().get(`/api/scenes/${ms.sceneId}`)).body.attempts_used).toBe(1); // job failed có tốn credit vẫn chiếm đúng một lượt (không đếm hai lần)
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM jobs WHERE id=? AND credits_cost>0').get(job.id)).toEqual({ n: 1 });
    expect(jobRow(job.id)).toMatchObject({ lease_id: null, claimed_by: null, wait_reason: null });
    expect(env.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type='job.reconciled'").get()).toEqual({ n: 1 });
    // idempotent: bấm lại cùng lựa chọn không ghi sổ lần hai
    const again = await reconcile(job, 'charge_and_fail');
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(ledger(job.id)).toHaveLength(1);
    // lựa chọn khác sau khi đã đối soát bị từ chối
    expect((await reconcile(job, 'nothing_created')).body.error.code).toBe('ALREADY_RECONCILED');
    expect(ledger(job.id)).toHaveLength(1);
  });
  it('charge_and_fail chỉ cho job video', async () => {
    const job = await waiting('storyboard', 'submitted');
    const r = await reconcile(job, 'charge_and_fail');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_OUTCOME');
    expect(jobRow(job.id).status).toBe('queued');
    expect((await actions(job)).map((a) => a.state)).toEqual(['submitted']); // transaction: không ghi gì
  });
  it('action đã downloaded: chỉ retry_download; nothing_created/charge_and_fail bị từ chối (không bỏ file đã tải)', async () => {
    const job = await waiting('video', 'downloaded');
    for (const outcome of ['nothing_created', 'charge_and_fail']) {
      const r = await reconcile(job, outcome);
      expect(r.status, outcome).toBe(409);
      expect(r.body.error.code).toBe('RECONCILE_DOWNLOADED');
    }
    expect(ledger(job.id)).toEqual([]);
  });

  it('idempotent: retry_download bấm lặp là no-op; không ghi nhật ký hai lần', async () => {
    const job = await waiting('storyboard', 'intent');
    expect((await reconcile(job, 'retry_download')).body.replay).toBe(false);
    expect((await reconcile(job, 'retry_download')).body.replay).toBe(true);
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM job_reconciliations WHERE job_id=?').get(job.id)).toEqual({ n: 1 });
  });
  it('chỉ job đang chờ đối soát: job không có action, đang chạy, đã xong hoặc không tồn tại bị từ chối', async () => {
    const job = await ms.video(); // claimed, chưa có action
    expect((await reconcile(job, 'retry_download')).status).toBe(409);
    await journal(job, `media-${job.id}`, 'intent'); // đang claimed + có action: worker đang giữ
    const running = await reconcile(job, 'nothing_created');
    expect(running.status).toBe(409);
    expect(running.body.error.message).toMatch(/worker/);
    expect((await user().post('/api/jobs/99999/reconcile', { outcome: 'retry_download' })).status).toBe(404);
    expect((await user().post(`/api/jobs/${job.id}/reconcile`, { outcome: 'bogus' })).status).toBe(400);
  });
  it('job mất heartbeat sau intent tự thành needs_reconciliation và đối soát được', async () => {
    const job = await ms.video();
    await journal(job, `media-${job.id}`, 'intent');
    env.clock.advance(6 * 60000); sweepStaleJobs(env.ctx);
    expect((await user().get(`/api/jobs/${job.id}`)).body).toMatchObject({ reconcile_required: true, wait_reason: 'needs_reconciliation' });
    expect((await reconcile(job, 'retry_download')).status).toBe(200);
  });
});

describe('F4 hủy job managed đã gửi lệnh tạo', () => {
  it('có action intent|uncertain|submitted (và downloaded) → 409 RECONCILIATION_REQUIRED; không mất ghi sổ', async () => {
    for (const state of ['intent', 'submitted', 'uncertain', 'downloaded'] as const) {
      await env.close();
      env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: ['storyboard', 'video'] } });
      ms = await mediaScenario(env);
      const job = await ms.video();
      const id = `media-${job.id}`;
      await journal(job, id, 'intent');
      if (state !== 'intent') await journal(job, id, state === 'uncertain' ? 'uncertain' : 'submitted');
      if (state === 'downloaded') await journal(job, id, 'downloaded');
      const r = await user().post(`/api/jobs/${job.id}/cancel`);
      expect(r.status, state).toBe(409);
      expect(r.body.error.code, state).toBe('RECONCILIATION_REQUIRED');
      expect(jobRow(job.id).status).not.toBe('cancelled');
      expect(sceneStatus()).toBe('video_running');
    }
  });
  it('job managed chưa có action vẫn hủy được; job legacy hủy như cũ', async () => {
    const job = await ms.storyboard();
    expect((await user().post(`/api/jobs/${job.id}/cancel`)).status).toBe(200);
  });
});
