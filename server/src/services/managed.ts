import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { conflict } from '../lib/errors.js';
import { getJobRow, parseJson, emitJob } from './repo.js';

export interface Lease { worker: string | null; lease: string | null }

/** Trạng thái action còn "sống": đã có thể phát sinh generation/credit bên ngoài và chưa được đối soát/hoàn tất. */
export const LIVE_ACTION_STATES = ['intent', 'uncertain', 'submitted', 'downloaded'] as const;
export interface ActionRow { id: string; state: string; evidence: string }

/** Action hiện hành của job: bản mới nhất chưa bị `abandoned` (đối soát nothing_created). */
export function liveAction(ctx: AppContext, jobId: number): ActionRow | undefined {
  return ctx.db.prepare("SELECT id,state,evidence FROM external_actions WHERE job_id=? AND state<>'abandoned' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(jobId) as ActionRow | undefined;
}
export const hasLiveAction = (ctx: AppContext, jobId: number): boolean => {
  const a = liveAction(ctx, jobId);
  return !!a && (LIVE_ACTION_STATES as readonly string[]).includes(a.state);
};

export function assertLease(ctx: AppContext, id: number, owner: Lease, allowDone = false) {
  const job = getJobRow(ctx, id);
  if (job.claimed_by && (job.lease_id || owner.worker) && owner.worker !== job.claimed_by) throw conflict('JOB_CANCELLED', 'Job không thuộc worker này');
  if (job.lease_id && job.lease_id !== owner.lease) throw conflict('LEASE_LOST', 'Lease đã hết hiệu lực; dừng mọi thao tác');
  if (job.worker_mode === 'legacy') return job;
  if (!['claimed', 'running', ...(allowDone ? ['done'] : [])].includes(job.status)) throw conflict('JOB_CANCELLED', 'Job không còn chạy');
  return job;
}

export function assertManagedLease(ctx: AppContext, id: number, owner: Lease) {
  const job = assertLease(ctx, id, owner);
  if (job.worker_mode !== 'managed' || !job.lease_id) throw conflict('MANAGED_REQUIRED', 'Endpoint yêu cầu managed lease');
  return job;
}

export function saveCheckpoint(ctx: AppContext, id: number, owner: Lease, value: Record<string, unknown>) {
  return ctx.tx(() => {
    assertManagedLease(ctx, id, owner);
    ctx.db.prepare('UPDATE jobs SET checkpoint = ? WHERE id = ?').run(JSON.stringify(value), id);
    return { ok: true };
  });
}

export function waitJob(ctx: AppContext, id: number, owner: Lease, reason: string, retryAt: string | null) {
  return ctx.tx(() => {
    const job = assertManagedLease(ctx, id, owner);
    ctx.db.prepare("UPDATE jobs SET status='queued', wait_reason=?, next_attempt_at=?, lease_id=NULL, claimed_by=NULL, heartbeat_at=NULL WHERE id=?")
      .run(reason, retryAt, id);
    ctx.db.prepare('DELETE FROM browser_leases WHERE job_id=?').run(id);
    emitJob(ctx, id, job.project_id);
    return { ok: true };
  });
}

export function actionJournal(ctx: AppContext, id: number, owner: Lease, input: { id: string; profile: string; kind: string; state: string; evidence: Record<string, unknown> }) {
  return ctx.tx(() => {
    const job = assertManagedLease(ctx, id, owner);
    const prior = ctx.db.prepare('SELECT * FROM external_actions WHERE id=?').get(input.id) as { job_id: number; state: string; kind: string; profile: string } | undefined;
    if (prior && (prior.job_id !== id || prior.kind !== input.kind || prior.profile !== input.profile)) throw conflict('ACTION_CONFLICT', 'Action không khớp job/profile');
    const transitions: Record<string, string[]> = {
      intent: ['submitted', 'uncertain'], submitted: ['downloaded', 'uncertain'], uncertain: ['submitted', 'downloaded'], downloaded: ['committed'], committed: [],
    };
    if (!prior && input.state !== 'intent') throw conflict('ACTION_CONFLICT', 'Action phải bắt đầu bằng intent');
    // Mỗi job chỉ có MỘT action sống. Muốn submit lần nữa phải đối soát (nothing_created → action cũ `abandoned`) trước.
    if (!prior && liveAction(ctx, id)) throw conflict('ACTION_CONFLICT', 'Job đã có thao tác tạo chưa được đối soát; không ghi intent mới');
    if (prior && prior.state !== input.state && !transitions[prior.state]?.includes(input.state)) throw conflict('ACTION_CONFLICT', 'Action transition không hợp lệ');
    ctx.db.prepare(`INSERT INTO external_actions(id,job_id,lease_epoch,profile,kind,state,evidence,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,evidence=excluded.evidence,updated_at=excluded.updated_at`)
      .run(input.id, id, job.lease_epoch, input.profile, input.kind, input.state, JSON.stringify(input.evidence), ctx.now(), ctx.now());
    return { ok: true };
  });
}

export function actions(ctx: AppContext, id: number) {
  getJobRow(ctx, id); // 404 nếu job không tồn tại hoặc thuộc dự án trong thùng rác
  return (ctx.db.prepare('SELECT id,profile,kind,state,evidence FROM external_actions WHERE job_id=? ORDER BY created_at').all(id) as { evidence: string }[])
    .map((r) => ({ ...r, evidence: parseJson(r.evidence, {}) }));
}

export function browserLease(ctx: AppContext, id: number, owner: Lease, profile: string) {
  return ctx.tx(() => {
    const job = assertManagedLease(ctx, id, owner);
    const existing = ctx.db.prepare('SELECT * FROM browser_leases WHERE profile=?').get(profile) as { job_id: number; lease_id: string; expires_at: string } | undefined;
    if (existing && existing.lease_id !== job.lease_id && Date.parse(existing.expires_at) > ctx.clock.now()) throw conflict('BROWSER_BUSY', 'Browser profile đang được dùng');
    const expires = new Date(ctx.clock.now() + 90_000).toISOString();
    ctx.db.prepare(`INSERT INTO browser_leases VALUES(?,?,?,?) ON CONFLICT(profile) DO UPDATE SET job_id=excluded.job_id,lease_id=excluded.lease_id,expires_at=excluded.expires_at`)
      .run(profile, id, job.lease_id, expires);
    return { ok: true, expires_at: expires };
  });
}

export function completionHash(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function stampProvenance(ctx: AppContext, jobId: number, sceneIds: number[] = [], commentId?: number) {
  const info = ctx.db.prepare(`SELECT a.provider,r.model,r.account_id FROM ai_attempts r JOIN ai_accounts a ON a.id=r.account_id WHERE r.job_id=? AND r.outcome='ok' ORDER BY r.id DESC LIMIT 1`)
    .get(jobId) as { provider: string; model: string; account_id: number } | undefined;
  if (!info) return;
  for (const id of sceneIds) ctx.db.prepare("UPDATE scene_prompt_versions SET provider=?,model=?,account_id=? WHERE scene_id=? AND version=(SELECT MAX(version) FROM scene_prompt_versions WHERE scene_id=?) AND created_by='agent'")
    .run(info.provider, info.model, info.account_id, id, id);
  if (commentId) ctx.db.prepare('UPDATE comments SET provider=?,model=?,account_id=? WHERE id=?').run(info.provider, info.model, info.account_id, commentId);
  ctx.db.prepare("UPDATE final_cuts SET created_by='agent',provider=?,model=?,account_id=? WHERE job_id=?").run(info.provider, info.model, info.account_id, jobId);
}
