import { expect } from 'vitest';
import { workerClient } from './helpers.js';
import type { LanClient, LanEnv } from './helpers-lan.js';

export const sceneInput = (n: number, extra: Record<string, unknown> = {}) => ({
  code: `C${n}`,
  order_index: n - 1,
  title: `Cảnh ${n}`,
  prompt: `Style: soft morning light, vertical 9:16\n\nA hand holds the box from image 1, scene ${n}\n\nAction: opens it\nShot 1: 0-10 s, close-up: opens.\nNo dialogue.`,
  first_frame_desc: `Khung đầu cảnh ${n}`,
  upload_refs: [] as number[],
  use_prev_storyboard: n > 1,
  ...extra,
});

export interface LanPlanFixture {
  plan: { id: number };
  scenes: { id: number; code: string }[];
  slug: string;
}

/** Tạo kế hoạch LAN, chạy worker giả (analyze_brief) ghi `n` cảnh C1..Cn rồi hoàn tất job. Không gọi AI thật. */
export async function makeLanPlan(L: LanEnv, c: LanClient, n = 2, name = 'Cacao Actiso'): Promise<LanPlanFixture> {
  const r = await c.post('/lan/api/plans', { name, created_by_name: 'Lan', brief: 'Quảng cáo sinh tố cacao', style_lock: 'Ánh sáng ấm' });
  expect(r.status, r.raw).toBe(201);
  const planId = r.body.plan.id as number;
  const sub = await c.post(`/lan/api/plans/${planId}/analyze`, {});
  expect(sub.status, sub.raw).toBe(201);
  const w = workerClient(L.env.app);
  const job = await w.get('/api/worker/next?worker=w1');
  expect(job.status, job.raw).toBe(200);
  expect(job.body.type).toBe('analyze_brief');
  const sc = await w.post('/api/worker/scenes', { project_id: planId, scenes: Array.from({ length: n }, (_, i) => sceneInput(i + 1)) });
  expect(sc.status, sc.raw).toBe(200);
  expect((await w.post(`/api/worker/jobs/${job.body.id}/complete`, { result: {} })).status).toBe(200);
  const detail = (await c.get(`/lan/api/plans/${planId}`)).body;
  return { plan: { id: planId }, scenes: detail.scenes.map((s: any) => ({ id: s.id, code: s.code })), slug: (L.env.ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').get(planId) as { slug: string }).slug };
}
