import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { parse } from '../lib/validate.js';
import {
  ASSET_KINDS,
  PAUSING_FAIL_CODES,
  FAIL_CODES,
  VERDICTS,
  type AssetKind,
  type AssetRow,
  type CommentRow,
  type FailCode,
  type JobRow,
  type JobType,
  type ProjectRow,
  type SceneRow,
} from '../db/types.js';
import { appendLogRow, VIDEO_TYPE_TEXT, verdictText } from './logmd.js';
import { cancelCutForJob, completeEditPlan, editPlanResult, failEditPlanCut } from './final-cuts.js';
import { emitProject } from './project-view.js';
import { computePayload } from './payload.js';
import {
  assetJson,
  commentJson,
  emitBudget,
  emitJob,
  getAsset,
  getJobJson,
  getJobRow,
  getProject,
  getScene,
  logEvent,
  parseJson,
} from './repo.js';
import { claimBlockReason } from './rules.js';
import { transition } from './transition.js';
import { getWorkerRow, pauseQueue } from './worker.js';

// ---------------------------------------------------------------- tạo job (đã tách sang job-create.ts)

export { insertJob, type NewJob } from './job-create.js';

// ---------------------------------------------------------------- claim

const QUEUED_SCENE_STATUS: Partial<Record<JobType, string>> = {
  storyboard: 'storyboard_queued',
  video: 'video_queued',
  revise_prompt: 'needs_revision',
};

/**
 * Claim nguyên tử job queued cũ nhất đủ điều kiện (BEGIN IMMEDIATE). Trả null nếu không có việc.
 * Ném QUEUE_PAUSED (503) nếu hàng đợi đang tạm dừng.
 */
export function claimNext(ctx: AppContext, workerId: string | null) {
  const id = ctx.tx(() => {
    const ws = getWorkerRow(ctx);
    if (ws.queue_paused) {
      throw new AppError('QUEUE_PAUSED', `Hàng đợi đang tạm dừng: ${ws.pause_reason ?? 'không rõ lý do'}`, 503, {
        pause_code: ws.pause_code,
        pause_reason: ws.pause_reason,
      });
    }
    const queued = ctx.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id").all() as JobRow[];
    for (const job of queued) {
      // Cảnh phải đang ở trạng thái *_queued tương ứng; nếu không, job đã cũ -> hủy.
      if (job.scene_id !== null) {
        const scene = getScene(ctx, job.scene_id);
        const expected = QUEUED_SCENE_STATUS[job.type];
        if (expected && scene.status !== expected) {
          cancelStale(ctx, job, scene);
          continue;
        }
      }
      if (job.type === 'edit_plan') {
        const cut = ctx.db.prepare('SELECT status FROM final_cuts WHERE job_id = ?').get(job.id) as { status: string } | undefined;
        if (!cut || cut.status !== 'planning') {
          cancelStaleEditPlan(ctx, job);
          continue;
        }
      }
      if (claimBlockReason(ctx, job)) continue;

      const now = ctx.now();
      const payload = computePayload(ctx, job);
      const res = ctx.db
        .prepare(
          `UPDATE jobs SET status = 'claimed', claimed_by = ?, claimed_at = ?, heartbeat_at = ?, payload = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(workerId, now, now, JSON.stringify(payload), job.id);
      if (res.changes !== 1) continue;
      if (job.type === 'storyboard') transition(ctx, job.scene_id as number, 'storyboard_running', `job #${job.id} được nhận`);
      else if (job.type === 'video') transition(ctx, job.scene_id as number, 'video_running', `job #${job.id} được nhận`);
      emitJob(ctx, job.id, job.project_id);
      // Tạo sẵn thư mục đầu ra để worker chỉ việc ghi file.
      ctx.afterCommit(() => ensureOutputDirs(ctx, payload));
      return job.id;
    }
    return null;
  });
  return id === null ? null : getJobJson(ctx, id);
}

function ensureOutputDirs(ctx: AppContext, payload: Record<string, unknown>): void {
  const out = payload.output as Record<string, string> | undefined;
  if (!out) return;
  for (const rel of Object.values(out)) {
    try {
      fs.mkdirSync(path.dirname(path.join(ctx.config.rootDir, rel)), { recursive: true });
    } catch {
      /* worker sẽ tự tạo nếu cần */
    }
  }
}

function cancelStaleEditPlan(ctx: AppContext, job: JobRow): void {
  ctx.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?").run(ctx.now(), 'Bản hoàn chỉnh không còn ở bước chọn điểm cắt', job.id);
  logEvent(ctx, { project_id: job.project_id, type: 'job.cancelled', message: `Job #${job.id} (edit_plan) bị hủy vì bản hoàn chỉnh không còn ở bước chọn điểm cắt` });
  emitJob(ctx, job.id, job.project_id);
}

function cancelStale(ctx: AppContext, job: JobRow, scene: SceneRow): void {
  ctx.db
    .prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?")
    .run(ctx.now(), `Trạng thái cảnh (${scene.status}) không còn khớp với job`, job.id);
  logEvent(ctx, {
    project_id: job.project_id,
    scene_id: scene.id,
    type: 'job.cancelled',
    message: `Job #${job.id} (${job.type} ${scene.code}) bị hủy vì trạng thái cảnh là ${scene.status}`,
  });
  emitJob(ctx, job.id, job.project_id);
  emitBudget(ctx, job.project_id);
}

// ---------------------------------------------------------------- heartbeat

export function heartbeat(ctx: AppContext, jobId: number, workerId?: string | null) {
  return ctx.tx(() => {
    const job = getJobRow(ctx, jobId);
    if (job.status !== 'claimed' && job.status !== 'running') {
      throw conflict(
        'JOB_CANCELLED',
        job.status === 'cancelled'
          ? `Job #${job.id} đã bị hủy; hãy dừng xử lý`
          : `Job #${job.id} đang ở trạng thái ${job.status}, không còn thuộc worker này; hãy dừng xử lý`,
      );
    }
    if (workerId && job.claimed_by && job.claimed_by !== workerId) {
      throw conflict('JOB_CANCELLED', `Job #${job.id} đã được giao cho worker khác; hãy dừng xử lý`);
    }
    const now = ctx.now();
    ctx.db.prepare("UPDATE jobs SET heartbeat_at = ?, status = 'running' WHERE id = ?").run(now, job.id);
    if (job.status === 'claimed') emitJob(ctx, job.id, job.project_id);
    return { ok: true, status: 'running' as const, heartbeat_at: now };
  });
}

// ---------------------------------------------------------------- complete

const assetInput = z.object({
  kind: z.enum(ASSET_KINDS),
  file_path: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const completeBody = z.object({
  result: z.record(z.string(), z.unknown()).optional(),
  assets: z.array(assetInput).optional(),
  credits_cost: z.number().int().min(0).optional(),
});
export type CompleteBody = z.infer<typeof completeBody>;

const ALLOWED_ASSET_KINDS: Record<JobType, AssetKind[]> = {
  analyze_brief: [],
  storyboard: ['storyboard'],
  video: ['video', 'grid'],
  revise_prompt: [],
  edit_plan: [],
};

function assertClaimed(job: JobRow): void {
  if (job.status === 'claimed' || job.status === 'running') return;
  if (job.status === 'cancelled') throw conflict('JOB_CANCELLED', `Job #${job.id} đã bị hủy; kết quả không được nhận`);
  throw conflict('INVALID_STATE', `Job #${job.id} đang ở trạng thái ${job.status}; chỉ job claimed/running mới complete/fail được`);
}

function checkAssetFiles(ctx: AppContext, job: JobRow, body: CompleteBody) {
  const allowed = ALLOWED_ASSET_KINDS[job.type];
  const out: { kind: AssetKind; file_path: string; meta: Record<string, unknown> }[] = [];
  for (const a of body.assets ?? []) {
    if (!allowed.includes(a.kind)) {
      throw badRequest('INVALID_ASSET_KIND', `Job ${job.type} không nhận asset loại "${a.kind}"`);
    }
    const rel = cleanRelPath(a.file_path, ['output']);
    if (!resolveInside(ctx.config.rootDir, rel, ['output'])) {
      throw badRequest('FILE_NOT_FOUND', `File không tồn tại hoặc không hợp lệ: ${rel}`);
    }
    out.push({ kind: a.kind, file_path: rel, meta: a.meta ?? {} });
  }
  return out;
}

function insertAsset(
  ctx: AppContext,
  scene: SceneRow,
  jobId: number,
  a: { kind: AssetKind; file_path: string; meta: Record<string, unknown>; attempt: number; verdict?: string | null; verdict_note?: string | null },
): AssetRow {
  const info = ctx.db
    .prepare(
      `INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, meta, verdict, verdict_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(scene.id, jobId, a.kind, a.file_path, a.attempt, JSON.stringify(a.meta), a.verdict ?? null, a.verdict_note ?? null, ctx.now());
  const id = Number(info.lastInsertRowid);
  ctx.publish('asset.created', scene.project_id, () => ({ asset: assetJson(getAsset(ctx, id)) }));
  return getAsset(ctx, id);
}

const reviseResult = z.looseObject({
  prompt: z.string().min(1, 'prompt không được rỗng'),
  reason: z.string().min(1, 'cần ghi lý do sửa'),
  resolved_comment_ids: z.array(z.number().int()).optional(),
});
const mediaResult = z.looseObject({
  verdict: z.enum(VERDICTS).optional(),
  verdict_note: z.string().optional(),
  note: z.string().optional(),
});

/** Worker báo hoàn thành job. Xử lý riêng theo loại job (decisions §E). */
export function completeJob(ctx: AppContext, jobId: number, input: CompleteBody) {
  ctx.tx(() => {
    const job = getJobRow(ctx, jobId);
    assertClaimed(job);
    const project = getProject(ctx, job.project_id);
    const stored = parseJson<Record<string, unknown>>(job.payload, {});
    const attempt = Number(stored.attempt ?? 1);
    const files = checkAssetFiles(ctx, job, input);
    const result = input.result ?? {};
    const now = ctx.now();
    let creditsCost = 0;

    if (job.type === 'storyboard') {
      const scene = getScene(ctx, job.scene_id as number);
      const meta = parse(mediaResult, result);
      if (!files.some((f) => f.kind === 'storyboard')) throw badRequest('ASSET_REQUIRED', 'Thiếu asset storyboard trong kết quả');
      for (const f of files) {
        const asset = insertAsset(ctx, scene, job.id, { ...f, attempt, verdict: meta.verdict ?? null, verdict_note: meta.verdict_note ?? meta.note ?? null });
        appendLogRow(ctx, project.slug, {
          clip: scene.code,
          attempt,
          type: 'storyboard',
          issue: asset.verdict_note ?? '',
          conclusion: verdictText(asset.verdict),
        });
      }
      transition(ctx, scene.id, 'storyboard_review', `job #${job.id} hoàn thành`);
    } else if (job.type === 'video') {
      const scene = getScene(ctx, job.scene_id as number);
      const meta = parse(mediaResult, result);
      if (!files.some((f) => f.kind === 'video')) throw badRequest('ASSET_REQUIRED', 'Thiếu asset video trong kết quả');
      for (const f of files) {
        const isVideo = f.kind === 'video';
        const asset = insertAsset(ctx, scene, job.id, {
          ...f,
          attempt,
          verdict: isVideo ? meta.verdict ?? null : null,
          verdict_note: isVideo ? meta.verdict_note ?? meta.note ?? null : null,
        });
        if (isVideo) {
          appendLogRow(ctx, project.slug, {
            clip: scene.code,
            attempt,
            type: VIDEO_TYPE_TEXT,
            issue: asset.verdict_note ?? '',
            conclusion: verdictText(asset.verdict),
          });
        }
      }
      creditsCost = input.credits_cost ?? project.credit_per_video;
      if (creditsCost > 0) addLedger(ctx, project, scene.id, job.id, -creditsCost, `Video ${scene.code} lượt ${attempt} (job #${job.id})`);
      transition(ctx, scene.id, 'video_review', `job #${job.id} hoàn thành`);
    } else if (job.type === 'revise_prompt') {
      const scene = getScene(ctx, job.scene_id as number);
      const r = parse(reviseResult, result);
      const version =
        (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(scene.id) as { v: number })
          .v + 1;
      ctx.db
        .prepare('INSERT INTO scene_prompt_versions (scene_id, version, prompt, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(scene.id, version, r.prompt, r.reason, 'claude', now);
      ctx.db.prepare('UPDATE scenes SET prompt = ?, updated_at = ? WHERE id = ?').run(r.prompt, now, scene.id);
      const ids = r.resolved_comment_ids ?? ((stored.comments ?? []) as { id: number }[]).map((c) => c.id);
      for (const cid of ids) {
        ctx.db.prepare('UPDATE comments SET resolved = 1 WHERE id = ? AND scene_id = ?').run(cid, scene.id);
        ctx.publish('comment.updated', scene.project_id, () => {
          const row = ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(cid) as CommentRow | undefined;
          return { comment: row ? commentJson(row) : null };
        });
      }
      logEvent(ctx, {
        project_id: scene.project_id,
        scene_id: scene.id,
        type: 'scene.prompt',
        message: `${scene.code}: Claude sửa prompt (v${version}) — ${r.reason}`,
      });
      transition(ctx, scene.id, 'awaiting_approval', `job #${job.id}: đã sửa prompt, chờ duyệt lại`);
    } else if (job.type === 'edit_plan') {
      // Không có asset, không tốn credit. EDL sai → INVALID_EDL (400), job giữ nguyên để worker sửa và gọi lại.
      completeEditPlan(ctx, job, parse(editPlanResult, result));
    } else {
      // analyze_brief: cần đã gọi POST /api/worker/scenes trước đó
      const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?').get(project.id) as { n: number }).n;
      if (n === 0) throw conflict('NO_SCENES', 'Chưa có cảnh nào; hãy gọi POST /api/worker/scenes trước khi complete analyze_brief');
      ctx.db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
      logEvent(ctx, { project_id: project.id, type: 'project.analyzed', message: `Claude đã phân tích kịch bản: ${n} cảnh` });
      emitProject(ctx, project.id);
    }

    ctx.db
      .prepare("UPDATE jobs SET status = 'done', result = ?, finished_at = ?, credits_cost = ?, heartbeat_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now, creditsCost, now, job.id);
    emitJob(ctx, job.id, job.project_id);
    emitBudget(ctx, job.project_id);
  });
  return getJobJson(ctx, jobId);
}

export function addLedger(ctx: AppContext, project: ProjectRow, sceneId: number | null, jobId: number | null, delta: number, note: string) {
  ctx.db
    .prepare('INSERT INTO credit_ledger (project_id, scene_id, job_id, delta, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(project.id, sceneId, jobId, delta, note, ctx.now());
  emitBudget(ctx, project.id);
}

// ---------------------------------------------------------------- fail

export const failBody = z.object({
  error: z.string().min(1, 'cần mô tả lỗi'),
  code: z.enum(FAIL_CODES).optional(),
  credits_cost: z.number().int().min(0).optional(),
});
export type FailBody = z.infer<typeof failBody>;

/** Worker báo job lỗi. CAPTCHA/LOGIN_REQUIRED/FLOW_OUT_OF_CREDIT/UI_CHANGED tạm dừng hàng đợi. */
export function failJob(ctx: AppContext, jobId: number, body: FailBody) {
  ctx.tx(() => {
    const job = getJobRow(ctx, jobId);
    assertClaimed(job);
    const project = getProject(ctx, job.project_id);
    const code: FailCode = body.code ?? 'OTHER';
    const now = ctx.now();
    const cost = job.type === 'video' ? body.credits_cost ?? 0 : 0;
    ctx.db
      .prepare("UPDATE jobs SET status = 'failed', error = ?, error_code = ?, finished_at = ?, credits_cost = ? WHERE id = ?")
      .run(body.error, code, now, cost, job.id);

    let sceneCode: string | null = null;
    if (job.scene_id !== null) {
      const scene = getScene(ctx, job.scene_id);
      sceneCode = scene.code;
      if (cost > 0) addLedger(ctx, project, scene.id, job.id, -cost, `Video ${scene.code} lỗi nhưng vẫn tốn credit (job #${job.id})`);
      const to = job.type === 'video' && code === 'FLOW_OUT_OF_CREDIT' ? 'blocked_budget' : 'failed';
      transition(ctx, scene.id, to, `job #${job.id} lỗi [${code}]: ${body.error}`);
    } else if (job.type === 'analyze_brief') {
      const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?').get(project.id) as { n: number }).n;
      ctx.db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(n > 0 ? 'active' : 'draft', now, project.id);
      emitProject(ctx, project.id);
    } else if (job.type === 'edit_plan') {
      failEditPlanCut(ctx, job.id, body.error);
    }
    logEvent(ctx, {
      project_id: job.project_id,
      scene_id: job.scene_id,
      type: 'job.failed',
      message: `Job #${job.id} (${job.type}${sceneCode ? ' ' + sceneCode : ''}) lỗi [${code}]: ${body.error}`,
    });
    if (PAUSING_FAIL_CODES.includes(code)) {
      pauseQueue(ctx, code, `${code}: ${body.error}`, job.project_id);
    }
    emitJob(ctx, job.id, job.project_id);
    emitBudget(ctx, job.project_id);
  });
  return getJobJson(ctx, jobId);
}

// ---------------------------------------------------------------- hủy (người dùng)

/** Hủy job queued/claimed/running; đưa cảnh về trạng thái ổn định (decisions §C). */
export function cancelJob(ctx: AppContext, jobId: number) {
  ctx.tx(() => {
    const job = getJobRow(ctx, jobId);
    if (job.status !== 'queued' && job.status !== 'claimed' && job.status !== 'running') {
      throw conflict('INVALID_STATE', `Job #${job.id} đã ở trạng thái ${job.status}, không thể hủy`);
    }
    const now = ctx.now();
    ctx.db
      .prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Đã hủy bởi người dùng' WHERE id = ?")
      .run(now, job.id);
    let sceneCode: string | null = null;
    if (job.scene_id !== null) {
      const scene = getScene(ctx, job.scene_id);
      sceneCode = scene.code;
      const hasStoryboard = !!ctx.db.prepare("SELECT 1 FROM assets WHERE scene_id = ? AND kind = 'storyboard' LIMIT 1").get(scene.id);
      const hasVideo = !!ctx.db.prepare("SELECT 1 FROM assets WHERE scene_id = ? AND kind = 'video' LIMIT 1").get(scene.id);
      const reason = `hủy job #${job.id}`;
      if (job.type === 'storyboard' && (scene.status === 'storyboard_queued' || scene.status === 'storyboard_running')) {
        transition(ctx, scene.id, hasStoryboard ? 'storyboard_review' : 'awaiting_approval', reason);
      } else if (job.type === 'video' && (scene.status === 'video_queued' || scene.status === 'video_running')) {
        transition(ctx, scene.id, hasVideo ? 'video_review' : 'storyboard_review', reason);
      } else if (job.type === 'revise_prompt' && scene.status === 'needs_revision') {
        transition(ctx, scene.id, 'awaiting_approval', reason);
      }
    } else if (job.type === 'analyze_brief') {
      const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?').get(job.project_id) as { n: number }).n;
      ctx.db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(n > 0 ? 'active' : 'draft', now, job.project_id);
      emitProject(ctx, job.project_id);
    } else if (job.type === 'edit_plan') {
      cancelCutForJob(ctx, job.id);
    }
    logEvent(ctx, {
      project_id: job.project_id,
      scene_id: job.scene_id,
      type: 'job.cancelled',
      message: `Job #${job.id} (${job.type}${sceneCode ? ' ' + sceneCode : ''}) đã bị hủy`,
    });
    emitJob(ctx, job.id, job.project_id);
    emitBudget(ctx, job.project_id);
  });
  return getJobJson(ctx, jobId);
}

// ---------------------------------------------------------------- quét job mất heartbeat

/**
 * Job claimed/running có heartbeat_at < now - HEARTBEAT_STALE_MINUTES: trả về queued,
 * requeue_count+1, cảnh *_running → *_queued. Trả về danh sách id job đã trả.
 */
export function sweepStaleJobs(ctx: AppContext): number[] {
  return ctx.tx(() => {
    const cutoff = new Date(ctx.clock.now() - ctx.config.heartbeatStaleMinutes * 60_000).toISOString();
    const stale = ctx.db
      .prepare("SELECT * FROM jobs WHERE status IN ('claimed','running') AND (heartbeat_at IS NULL OR heartbeat_at < ?) ORDER BY id")
      .all(cutoff) as JobRow[];
    const ids: number[] = [];
    for (const job of stale) {
      const now = ctx.now();
      ctx.db
        .prepare(
          `UPDATE jobs SET status = 'queued', requeue_count = requeue_count + 1, last_requeued_at = ?,
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL WHERE id = ?`,
        )
        .run(now, job.id);
      let code: string | null = null;
      if (job.scene_id !== null) {
        const scene = getScene(ctx, job.scene_id);
        code = scene.code;
        if (job.type === 'storyboard' && scene.status === 'storyboard_running') {
          transition(ctx, scene.id, 'storyboard_queued', `job #${job.id} mất heartbeat, trả về hàng đợi`);
        } else if (job.type === 'video' && scene.status === 'video_running') {
          transition(ctx, scene.id, 'video_queued', `job #${job.id} mất heartbeat, trả về hàng đợi`);
        }
      }
      logEvent(ctx, {
        project_id: job.project_id,
        scene_id: job.scene_id,
        type: 'job.requeued',
        message: `Cảnh báo: job #${job.id} (${job.type}${code ? ' ' + code : ''}) mất heartbeat quá ${ctx.config.heartbeatStaleMinutes} phút, đã trả về hàng đợi (lần ${job.requeue_count + 1}). Worker cần kiểm tra Flow/ChatGPT xem đã tạo chưa trước khi bấm tạo lại để tránh tốn credit hai lần.`,
      });
      emitJob(ctx, job.id, job.project_id);
      emitBudget(ctx, job.project_id);
      ids.push(job.id);
    }
    return ids;
  });
}
