import { expect } from 'vitest';
import { PNG_BYTES, client, multipart, setupProject, writeFile, type Env, type Scenario } from './helpers.js';

/** Client worker managed (có lease/X-Job-Id nếu truyền). */
export const managedClient = (env: Env, worker = 'W1', lease?: string, jobId?: number) =>
  client(env.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': worker, ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}) });

export interface MediaScenario {
  sc: Scenario;
  refs: { stick: string; box: string };
  sceneId: number;
  /** Claim job storyboard bằng managed worker. */
  storyboard(): Promise<any>;
  /** Hoàn thành storyboard (managed) rồi claim job video bằng managed worker. */
  video(): Promise<any>;
}

/**
 * Dự án 1 cảnh có 2 ảnh tham chiếu. Server cấu hình `managedJobTypes` chỉ chứa storyboard/video (analyze_brief legacy)
 * nên `setupProject` vẫn tạo cảnh qua đường legacy.
 */
export async function mediaScenario(env: Env): Promise<MediaScenario> {
  const sc = await setupProject(env, { scenes: 1 });
  const m = multipart([
    { name: 'label', value: 'Hộp' }, { name: 'file', filename: 'box.png', data: PNG_BYTES, type: 'image/png' },
    { name: 'label', value: 'Stick' }, { name: 'file', filename: 'stick.png', data: PNG_BYTES, type: 'image/png' },
  ]);
  const up = await env.app.inject({ method: 'POST', url: `/api/projects/${sc.project.id}/refs`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
  const [box, stick] = JSON.parse(up.body);
  const r = await sc.worker.post('/api/worker/scenes', { project_id: sc.project.id, scenes: [{ code: 'C1', title: 'x', prompt: 'Style: warm kitchen.  Shot 1: hand opens the box.', upload_refs: [stick.id, box.id], use_prev_storyboard: false }] });
  expect(r.status).toBe(200);
  const sceneId = r.body.scenes[0].id as number;
  const refs = { stick: stick.file_path as string, box: box.file_path as string };
  const storyboard = async () => {
    expect((await sc.user.post(`/api/scenes/${sceneId}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const job = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    expect(job.type).toBe('storyboard');
    return job;
  };
  const video = async () => {
    const sb = await storyboard();
    writeFile(env.root, sb.payload.output.storyboard_path, PNG_BYTES);
    const done = await managedClient(env, 'W1', sb.lease_id, sb.id).post(`/api/worker/jobs/${sb.id}/complete`, { assets: [{ kind: 'storyboard', file_path: sb.payload.output.storyboard_path }] }, { 'idempotency-key': 'sb' });
    expect(done.status).toBe(200);
    expect((await sc.user.post(`/api/scenes/${sceneId}/approve`, { stage: 'video' })).status).toBe(200);
    const job = (await managedClient(env).get('/api/worker/next?mode=managed')).body;
    expect(job.type).toBe('video');
    return job;
  };
  return { sc, refs, sceneId, storyboard, video };
}
