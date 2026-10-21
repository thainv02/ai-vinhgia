import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim, finish, makeEnv, scene, setupProject, type Env } from './helpers.js';

describe('smoke', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  it('đi qua luồng cơ bản', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    expect(sc.scenes.map((s: any) => s.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
    const a = await sc.user.post(`/api/scenes/${sc.scenes[0].id}/approve`, { stage: 'storyboard' });
    expect(a.status).toBe(200);
    const job = await claim(sc);
    expect(job.type).toBe('storyboard');
    const f = await finish(sc, job);
    expect(f.status).toBe(200);
    const s = await scene(sc, sc.scenes[0].id);
    expect(s.status).toBe('storyboard_review');
  });
});
