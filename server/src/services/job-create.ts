import type { AppContext } from '../context.js';
import type { JobType } from '../db/types.js';
import { emitBudget, emitJob } from './repo.js';

export interface NewJob {
  project_id: number;
  scene_id: number | null;
  type: JobType;
  requires_approval: boolean;
  /** true = đặt approved_at = now (đã được người dùng duyệt, hoặc không cần duyệt do cấu hình). */
  approved: boolean;
  payload?: Record<string, unknown>;
}

/** Tạo một job `queued` (phát SSE job.updated / budget.updated sau commit). */
export function insertJob(ctx: AppContext, j: NewJob): number {
  return ctx.tx(() => {
    const now = ctx.now();
    const info = ctx.db
      .prepare(
        `INSERT INTO jobs (project_id, scene_id, type, status, payload, created_at, requires_approval, approved_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(j.project_id, j.scene_id, j.type, JSON.stringify(j.payload ?? {}), now, j.requires_approval ? 1 : 0, j.approved ? now : null);
    const id = Number(info.lastInsertRowid);
    emitJob(ctx, id, j.project_id);
    emitBudget(ctx, j.project_id);
    return id;
  });
}
