import type { AppContext } from '../context.js';
import type { WorkerStateRow } from '../db/types.js';
import { logEvent } from './repo.js';

export function getWorkerRow(ctx: AppContext): WorkerStateRow {
  return ctx.db.prepare('SELECT * FROM worker_state WHERE id = 1').get() as WorkerStateRow;
}

export function isOnline(ctx: AppContext, row: WorkerStateRow = getWorkerRow(ctx)): boolean {
  if (!row.last_seen_at) return false;
  return ctx.clock.now() - Date.parse(row.last_seen_at) < ctx.config.workerOnlineSeconds * 1000;
}

/** Trạng thái worker cho web (`GET /api/worker/status`, SSE `worker.status`). */
export function workerStatus(ctx: AppContext) {
  const row = getWorkerRow(ctx);
  return {
    online: isOnline(ctx, row),
    last_seen_at: row.last_seen_at,
    worker_id: row.worker_id,
    queue_paused: !!row.queue_paused,
    pause_reason: row.pause_reason,
    pause_code: row.pause_code,
    paused_at: row.paused_at,
  };
}

export function emitWorkerStatus(ctx: AppContext): void {
  ctx.publish('worker.status', null, () => {
    const status = workerStatus(ctx);
    ctx.lastEmittedOnline = status.online;
    return status;
  });
}

/** Mọi request worker hợp lệ gọi hàm này để cập nhật last_seen_at (và phát SSE nếu vừa online trở lại). */
export function touchWorker(ctx: AppContext, workerId?: string | null): void {
  const wasOnline = isOnline(ctx);
  ctx.db
    .prepare('UPDATE worker_state SET last_seen_at = ?, worker_id = COALESCE(?, worker_id) WHERE id = 1')
    .run(ctx.now(), workerId ?? null);
  if (!wasOnline || ctx.lastEmittedOnline !== true) emitWorkerStatus(ctx);
}

/** Timer 10 giây: phát `worker.status` khi online/offline đổi. */
export function workerStatusTick(ctx: AppContext): void {
  const online = isOnline(ctx);
  if (ctx.lastEmittedOnline !== online) emitWorkerStatus(ctx);
}

export function pauseQueue(ctx: AppContext, code: string, reason: string, projectId?: number): void {
  ctx.tx(() => {
    ctx.db
      .prepare('UPDATE worker_state SET queue_paused = 1, pause_reason = ?, pause_code = ?, paused_at = ? WHERE id = 1')
      .run(reason, code, ctx.now());
    if (projectId !== undefined) {
      logEvent(ctx, { project_id: projectId, type: 'queue.paused', message: `Hàng đợi tạm dừng: ${reason}` });
    }
    emitWorkerStatus(ctx);
  });
}

export function resumeQueue(ctx: AppContext, projectId?: number): void {
  ctx.tx(() => {
    const before = getWorkerRow(ctx);
    ctx.db.prepare('UPDATE worker_state SET queue_paused = 0, pause_reason = NULL, pause_code = NULL, paused_at = NULL WHERE id = 1').run();
    if (before.queue_paused) {
      // Ghi vào dự án đã bị tạm dừng gần nhất (nếu có) để hiện trên dòng thời gian.
      const last = ctx.db.prepare("SELECT project_id FROM events WHERE type = 'queue.paused' ORDER BY id DESC LIMIT 1").get() as
        | { project_id: number }
        | undefined;
      const pid = projectId ?? last?.project_id;
      if (pid !== undefined) logEvent(ctx, { project_id: pid, type: 'queue.resumed', message: 'Hàng đợi được tiếp tục' });
    }
    emitWorkerStatus(ctx);
  });
}
