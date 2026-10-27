/**
 * Vị trí của một job trong hàng đợi của worker (chỉ để hiển thị; việc nhận job vẫn do `claimNext` quyết định).
 *
 * Mỗi "làn" có đúng MỘT worker chạy tuần tự: làn managed (loại trong MANAGED_JOB_TYPES, hoặc job đã từng do managed giữ) do managed worker
 * (account pool), làn legacy do worker Claude Code. `claimNext` lấy job `queued` cũ nhất (theo id) đủ điều kiện của làn đó, nên vị trí của một job =
 * số job đủ điều kiện CÙNG LÀN có id nhỏ hơn + 1; job nào đang `claimed/running` trong làn là job worker đang bận.
 * Dùng cho bước AI chọn điểm cắt (`edit_plan`) của bản dựng hoàn chỉnh và bước phân tích của kế hoạch LAN.
 */
import type { AppContext } from '../context.js';
import { isManagedJobType } from '../config.js';
import type { JobRow, JobType } from '../db/types.js';
import { claimBlockReason } from './rules.js';
import { clipPlanStale } from './clips/plan.js';
import { isOnline, getWorkerRow } from './worker.js';

/** Trạng thái cảnh mà một job `queued` đòi hỏi (job lệch trạng thái bị hủy lúc claim). Dùng chung với `claimNext`. */
export const QUEUED_SCENE_STATUS: Partial<Record<JobType, string>> = {
  storyboard: 'storyboard_queued',
  video: 'video_queued',
  revise_prompt: 'needs_revision',
};

export interface AiQueueInfo {
  /** `waiting`: job đang xếp hàng chờ worker; `running`: worker đã nhận. */
  state: 'waiting' | 'running';
  /** 1 = job kế tiếp worker sẽ nhận; `null` khi đang chạy. */
  position: number | null;
  /** Số job đủ điều kiện, cùng làn worker, đứng trước job này trong hàng đợi (không tính job worker đang chạy). */
  ahead: number;
  /** Job worker của làn này đang bận (`own: true` = chính job này). `null` = worker đang rảnh. Không lộ id/dự án. */
  running: { type: JobType; own: boolean } | null;
  /** Worker nhận loại job này: `online` = có request hợp lệ gần đây; `paused` = hàng đợi đang tạm dừng. */
  worker: { online: boolean; paused: boolean };
  /** Lý do job này chưa tới hạn nhận (`ai_quota` hết hạn mức, `needs_reconciliation`, ...); `null` = nhận được ngay khi worker rảnh. */
  wait_reason: string | null;
}

/** Job thuộc làn managed (true) hay legacy (false), đúng quy tắc của `claimNext`. */
const isManagedLane = (ctx: AppContext, job: Pick<JobRow, 'type' | 'worker_mode'>): boolean => isManagedJobType(ctx.config, job.type) || job.worker_mode === 'managed';

/** Job `queued` này mà worker gọi `claimNext` ngay bây giờ có thể nhận (không bị hoãn/chặn/lỗi thời) không. */
function claimable(ctx: AppContext, job: JobRow, now: string): boolean {
  if (job.wait_reason && (!job.next_attempt_at || job.next_attempt_at > now)) return false;
  if (job.scene_id !== null) {
    const sceneStatus = (ctx.db.prepare('SELECT status FROM scenes WHERE id = ?').get(job.scene_id) as { status: string } | undefined)?.status;
    const expected = QUEUED_SCENE_STATUS[job.type];
    // job lệch trạng thái cảnh bị hủy lúc claim (không tốn thời gian worker)
    if (expected && sceneStatus !== expected && !(job.worker_mode === 'managed' && sceneStatus === expected.replace('_queued', '_running'))) return false;
  }
  if (job.type === 'edit_plan') {
    const cut = ctx.db.prepare('SELECT status FROM final_cuts WHERE job_id = ?').get(job.id) as { status: string } | undefined;
    if (!cut || cut.status !== 'planning') return false;
  }
  if (job.type === 'clip_plan' && clipPlanStale(ctx, job)) return false;
  return claimBlockReason(ctx, job) === null;
}

/**
 * Vị trí của job trong hàng đợi worker. `null` nếu job không ở trạng thái chờ/chạy (đã xong, lỗi, hủy).
 * Job `queued` bị hoãn (`wait_reason`) vẫn có `position`, tính theo các job đủ điều kiện đứng trước nó; `wait_reason` cho biết vì sao chưa nhận.
 */
export function aiQueueInfo(ctx: AppContext, job: JobRow): AiQueueInfo | null {
  if (job.status !== 'queued' && job.status !== 'claimed' && job.status !== 'running') return null;
  const ws = getWorkerRow(ctx);
  const worker = { online: isOnline(ctx, ws), paused: !!ws.queue_paused };
  const lane = isManagedLane(ctx, job);

  const busy = (ctx.db.prepare("SELECT * FROM jobs WHERE status IN ('claimed','running') ORDER BY id").all() as JobRow[]).find((j) => isManagedLane(ctx, j) === lane);
  const running = busy ? { type: busy.type, own: busy.id === job.id } : null;
  if (job.status !== 'queued') return { state: 'running', position: null, ahead: 0, running: { type: job.type, own: true }, worker, wait_reason: null };

  const now = ctx.now();
  const before = ctx.db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND id < ? ORDER BY id").all(job.id) as JobRow[];
  const ahead = before.filter((j) => isManagedLane(ctx, j) === lane && claimable(ctx, j, now)).length;
  const waiting = job.wait_reason && (!job.next_attempt_at || job.next_attempt_at > now) ? job.wait_reason : null;
  return { state: 'waiting', position: ahead + 1, ahead, running, worker, wait_reason: waiting };
}

/** Như `aiQueueInfo` nhưng theo id job (`null` nếu không có job hoặc job không còn chờ/chạy). */
export function aiQueueInfoById(ctx: AppContext, jobId: number | null): AiQueueInfo | null {
  if (jobId === null) return null;
  const job = ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  return job ? aiQueueInfo(ctx, job) : null;
}
