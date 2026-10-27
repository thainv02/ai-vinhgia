import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { JobRow } from '../db/types.js';
import { applyJobFailure } from './jobs.js';
import { LIVE_ACTION_STATES, liveAction, type ActionRow } from './managed.js';
import { emitBudget, emitJob, getJobRow, getProject, getScene, logEvent, parseJson } from './repo.js';
import { transition } from './transition.js';

export const RECONCILE_OUTCOMES = ['retry_download', 'nothing_created', 'charge_and_fail'] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];
export const reconcileBody = z.object({
  outcome: z.enum(RECONCILE_OUTCOMES),
  note: z.string().trim().max(500).optional(),
});

const LABEL: Record<ReconcileOutcome, string> = {
  retry_download: 'kết quả đã được tạo bên ngoài, cho worker tìm và tải lại',
  nothing_created: 'không có gì được tạo; chạy lại từ đầu',
  charge_and_fail: 'đã tốn credit nhưng không lấy được kết quả; ghi nhận lượt đã dùng',
};

/**
 * Job đang chờ người dùng đối soát: managed, chưa có worker giữ (queued) và còn một action sống (intent/uncertain/submitted/downloaded).
 * `wait_reason='needs_reconciliation'` là trường hợp phổ biến; job queued có action `submitted` sau khi mất heartbeat cũng được tính
 * để người dùng không bị kẹt (hủy bị chặn, nhưng worker chưa chạy lại).
 */
export function reconcileState(ctx: AppContext, job: JobRow): { required: boolean; action: ActionRow | undefined } {
  if (job.worker_mode !== 'managed' || job.status !== 'queued') return { required: false, action: undefined };
  const action = liveAction(ctx, job.id);
  return { required: !!action && (LIVE_ACTION_STATES as readonly string[]).includes(action.state), action };
}

interface Reconciliation { id: number; outcome: ReconcileOutcome; action_id: string }

/** Đối soát một job `needs_reconciliation`. Idempotent: lặp lại cùng outcome sau khi đã áp dụng là no-op (không ghi sổ lần hai). */
export function reconcileJob(ctx: AppContext, jobId: number, input: z.infer<typeof reconcileBody>): { replay: boolean } {
  return ctx.tx(() => {
    const job = getJobRow(ctx, jobId);
    const { required, action } = reconcileState(ctx, job);
    const last = ctx.db.prepare('SELECT id,outcome,action_id FROM job_reconciliations WHERE job_id=? ORDER BY id DESC LIMIT 1').get(jobId) as Reconciliation | undefined;
    // Lặp lại đúng lựa chọn đã áp dụng (bấm đúp, mất phản hồi mạng) là no-op. Một lần chờ đối soát MỚI (worker lại báo
    // needs_reconciliation, hoặc action sống khác action đã đối soát) vẫn được xử lý bình thường.
    if (last?.outcome === input.outcome && (!required || (job.wait_reason !== 'needs_reconciliation' && action?.id === last.action_id))) return { replay: true };
    if (!required || !action) {
      if (last) throw conflict('ALREADY_RECONCILED', `Job #${job.id} đã được đối soát với lựa chọn khác (${last.outcome}); không áp dụng thêm`);
      throw conflict('INVALID_STATE', job.status === 'claimed' || job.status === 'running'
        ? `Job #${job.id} đang do worker xử lý; chỉ đối soát được khi worker đã dừng và job chờ đối soát`
        : `Job #${job.id} (${job.status}) không ở trạng thái cần đối soát`);
    }
    const project = getProject(ctx, job.project_id);
    const stored = parseJson<Record<string, unknown>>(job.payload, {});
    const now = ctx.now();
    let credits = 0;

    if (action.state === 'downloaded' && input.outcome !== 'retry_download') {
      throw conflict('RECONCILE_DOWNLOADED', 'Ảnh/video đã được tải về; chọn "tìm và tải lại" để worker hoàn tất job thay vì bỏ kết quả');
    }

    const evidence = { ...parseJson<Record<string, unknown>>(action.evidence, {}), reconciled: { outcome: input.outcome, at: now, from: action.state, ...(input.note ? { note: input.note } : {}) } };
    const setAction = (state: string) => ctx.db.prepare('UPDATE external_actions SET state=?,evidence=?,updated_at=? WHERE id=?').run(state, JSON.stringify(evidence), now, action.id);
    const queueScene = () => {
      if (job.scene_id === null) return;
      const scene = getScene(ctx, job.scene_id);
      if (job.type === 'storyboard' && scene.status === 'storyboard_running') transition(ctx, scene.id, 'storyboard_queued', `job #${job.id}: đối soát, trả về hàng đợi`);
      else if (job.type === 'video' && scene.status === 'video_running') transition(ctx, scene.id, 'video_queued', `job #${job.id}: đối soát, trả về hàng đợi`);
    };

    if (input.outcome === 'retry_download') {
      // Đã có journal: worker resume không được phép submit lại, chỉ tìm kết quả và tải.
      setAction(action.state === 'intent' || action.state === 'uncertain' ? 'submitted' : action.state);
      ctx.db.prepare('UPDATE jobs SET wait_reason=NULL,next_attempt_at=NULL WHERE id=?').run(job.id);
      queueScene();
    } else if (input.outcome === 'nothing_created') {
      // Người dùng xác nhận không có gì được tạo: bỏ action cũ, chạy lại từ đầu với action id mới và ngữ cảnh mới.
      setAction('abandoned');
      ctx.db.prepare('UPDATE jobs SET wait_reason=NULL,next_attempt_at=NULL,checkpoint=NULL WHERE id=?').run(job.id);
      ctx.db.prepare('DELETE FROM browser_leases WHERE job_id=?').run(job.id);
      queueScene();
    } else {
      if (job.type !== 'video') throw badRequest('INVALID_OUTCOME', 'charge_and_fail chỉ áp dụng cho job video (mất credit Flow)');
      credits = Number(stored.credits_expected ?? project.credit_per_video);
      if (!Number.isInteger(credits) || credits < 0) credits = project.credit_per_video;
      // Credit đã bị trừ nhưng không có kết quả: ghi ledger đúng một lần và tính một lượt (attemptsUsed đếm job video failed có credits_cost > 0).
      setAction(action.state === 'intent' || action.state === 'uncertain' ? 'submitted' : action.state);
      ctx.db.prepare('UPDATE jobs SET wait_reason=NULL,next_attempt_at=NULL,checkpoint=NULL,lease_id=NULL,claimed_by=NULL,claimed_at=NULL,heartbeat_at=NULL WHERE id=?').run(job.id);
      ctx.db.prepare('DELETE FROM browser_leases WHERE job_id=?').run(job.id);
      applyJobFailure(ctx, getJobRow(ctx, job.id), {
        error: `Đối soát: ${LABEL.charge_and_fail}${input.note ? ` (${input.note})` : ''}`,
        code: 'OTHER',
        credits_cost: credits,
      });
    }

    ctx.db.prepare('INSERT INTO job_reconciliations (job_id,action_id,outcome,prev_state,note,credits,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(job.id, action.id, input.outcome, action.state, input.note ?? null, credits, now);
    logEvent(ctx, {
      project_id: job.project_id,
      scene_id: job.scene_id,
      type: 'job.reconciled',
      message: `Job #${job.id} (${job.type}) đối soát: ${LABEL[input.outcome]}${credits ? ` — ghi ${credits} credit` : ''}${input.note ? `. Ghi chú: ${input.note}` : ''}`,
    });
    emitJob(ctx, job.id, job.project_id);
    emitBudget(ctx, job.project_id);
    return { replay: false };
  });
}
