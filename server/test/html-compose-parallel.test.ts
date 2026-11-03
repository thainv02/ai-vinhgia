import { expect, it } from 'vitest';
import { makeEnv } from './helpers.js';
import { composeParallel, composeRateLimited } from '../src/services/html/compose-parallel.js';
import { FinalRenderService } from '../src/services/final-render/index.js';
it('429 giảm còn một compose trong đúng 5 phút, cấu hình giới hạn 1–3', async () => {
  const env = await makeEnv({ config: { htmlComposeParallel: 3 } });
  try {
    const ctx = env.ctx;
    expect(composeParallel(ctx, 1000)).toBe(3);
    composeRateLimited(ctx, { status: 429 }, 1000);
    expect(composeParallel(ctx, 300999)).toBe(1);
    expect(composeParallel(ctx, 301000)).toBe(3);
    ctx.config.htmlComposeParallel = 10;
    expect(composeParallel(ctx, 301000)).toBe(3);
    ctx.config.htmlComposeParallel = 0;
    expect(composeParallel(ctx, 301000)).toBe(1);
  } finally {
    await env.close();
  }
});
it('RAM thấp không mở slot thứ hai nhưng vẫn chạy một việc; thiếu RAM tiếp tục tuần tự', async () => {
  const env = await makeEnv();
  const queue = new FinalRenderService(env.ctx, { freeMemBytes: () => 1024 ** 3, queueNotifyMs: 0 });
  env.ctx.config.renderConcurrency = 4;
  const starts: number[] = [],
    gates: (() => void)[] = [];
  try {
    for (let i = 0; i < 3; i++)
      queue.enqueueHtmlTask('html', i, true, async () => {
        starts.push(i);
        await new Promise<void>((r) => gates.push(r));
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(starts).toEqual([0]);
    expect(queue.summary().waiting_count).toBe(2);
    gates[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(starts).toEqual([0, 1]);
    gates[1]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(starts).toEqual([0, 1, 2]);
    gates[2]!();
    await queue.idle();
  } finally {
    for (const g of gates) g();
    await queue.idle();
    await env.close();
  }
});
