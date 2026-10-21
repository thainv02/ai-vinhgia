import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import type {
  AssetRow,
  CommentRow,
  EventRow,
  JobRow,
  LedgerRow,
  ProjectRow,
  PromptVersionRow,
  RefRow,
  SceneRow,
} from '../db/types.js';

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** URL tĩnh cho một đường dẫn tương đối từ ROOT. */
export function fileUrl(filePath: string): string {
  return '/files/' + filePath.split('/').map(encodeURIComponent).join('/');
}

// ---------- getters (ném 404 nếu không có) ----------

export function getProject(ctx: AppContext, id: number): ProjectRow {
  const row = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw notFound('dự án');
  return row;
}

export function getScene(ctx: AppContext, id: number): SceneRow {
  const row = ctx.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow | undefined;
  if (!row) throw notFound('cảnh');
  return row;
}

export function getJobRow(ctx: AppContext, id: number): JobRow {
  const row = ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!row) throw notFound('job');
  return row;
}

export function getAsset(ctx: AppContext, id: number): AssetRow {
  const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
  if (!row) throw notFound('asset');
  return row;
}

export function getComment(ctx: AppContext, id: number): CommentRow {
  const row = ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined;
  if (!row) throw notFound('comment');
  return row;
}

export function getRef(ctx: AppContext, id: number): RefRow {
  const row = ctx.db.prepare('SELECT * FROM project_refs WHERE id = ?').get(id) as RefRow | undefined;
  if (!row) throw notFound('ảnh tham chiếu');
  return row;
}

export function projectRefs(ctx: AppContext, projectId: number): RefRow[] {
  return ctx.db
    .prepare('SELECT * FROM project_refs WHERE project_id = ? ORDER BY order_index, id')
    .all(projectId) as RefRow[];
}

// ---------- serializers ----------

export function refJson(row: RefRow) {
  return { ...row, url: fileUrl(row.file_path) };
}

export function assetJson(row: AssetRow) {
  return {
    id: row.id,
    scene_id: row.scene_id,
    job_id: row.job_id,
    kind: row.kind,
    file_path: row.file_path,
    url: fileUrl(row.file_path),
    attempt: row.attempt,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    verdict: row.verdict,
    verdict_note: row.verdict_note,
    created_at: row.created_at,
  };
}
export type AssetJson = ReturnType<typeof assetJson>;

export function commentJson(row: CommentRow) {
  return {
    id: row.id,
    scene_id: row.scene_id,
    asset_id: row.asset_id,
    author: row.author,
    body: row.body,
    timecode: row.timecode,
    action: row.action,
    resolved: !!row.resolved,
    created_at: row.created_at,
  };
}
export type CommentJson = ReturnType<typeof commentJson>;

export function eventJson(row: EventRow & { scene_code?: string | null }) {
  return {
    id: row.id,
    project_id: row.project_id,
    scene_id: row.scene_id,
    scene_code: row.scene_code ?? null,
    type: row.type,
    message: row.message,
    created_at: row.created_at,
  };
}
export type EventJson = ReturnType<typeof eventJson>;

export function promptVersionJson(row: PromptVersionRow) {
  return {
    id: row.id,
    scene_id: row.scene_id,
    version: row.version,
    prompt: row.prompt,
    reason: row.reason,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function ledgerJson(row: LedgerRow & { scene_code?: string | null }) {
  return {
    id: row.id,
    project_id: row.project_id,
    scene_id: row.scene_id,
    scene_code: row.scene_code ?? null,
    job_id: row.job_id,
    delta: row.delta,
    note: row.note,
    created_at: row.created_at,
  };
}

type JobJoinRow = JobRow & { scene_code: string | null; project_name: string };

export function jobJsonFromRow(row: JobJoinRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    scene_id: row.scene_id,
    scene_code: row.scene_code,
    type: row.type,
    status: row.status,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    result: parseJson<Record<string, unknown> | null>(row.result, null),
    error: row.error,
    error_code: row.error_code,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    heartbeat_at: row.heartbeat_at,
    created_at: row.created_at,
    finished_at: row.finished_at,
    credits_cost: row.credits_cost,
    requires_approval: !!row.requires_approval,
    approved_at: row.approved_at,
    requeue_count: row.requeue_count,
    last_requeued_at: row.last_requeued_at,
  };
}
export type JobJson = ReturnType<typeof jobJsonFromRow>;

const JOB_SELECT = `SELECT j.*, s.code AS scene_code, p.name AS project_name
  FROM jobs j
  LEFT JOIN scenes s ON s.id = j.scene_id
  JOIN projects p ON p.id = j.project_id`;

export function getJobJson(ctx: AppContext, id: number): JobJson {
  const row = ctx.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as JobJoinRow | undefined;
  if (!row) throw notFound('job');
  return jobJsonFromRow(row);
}

export function listJobsJson(
  ctx: AppContext,
  filter: { projectId?: number; sceneId?: number; statuses?: string[]; types?: string[]; limit?: number },
): JobJson[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.projectId !== undefined) {
    where.push('j.project_id = ?');
    args.push(filter.projectId);
  }
  if (filter.sceneId !== undefined) {
    where.push('j.scene_id = ?');
    args.push(filter.sceneId);
  }
  if (filter.statuses?.length) {
    where.push(`j.status IN (${filter.statuses.map(() => '?').join(',')})`);
    args.push(...filter.statuses);
  }
  if (filter.types?.length) {
    where.push(`j.type IN (${filter.types.map(() => '?').join(',')})`);
    args.push(...filter.types);
  }
  const sql = `${JOB_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.id DESC LIMIT ?`;
  args.push(filter.limit ?? 200);
  return (ctx.db.prepare(sql).all(...args) as JobJoinRow[]).map(jobJsonFromRow);
}

// ---------- events ----------

export interface NewEvent {
  project_id: number;
  scene_id?: number | null;
  type: string;
  message: string;
  ext_key?: string | null;
}

/** Ghi một dòng vào bảng events và phát SSE `event.created` sau commit. */
export function logEvent(ctx: AppContext, ev: NewEvent): number {
  const info = ctx.db
    .prepare('INSERT INTO events (project_id, scene_id, type, message, created_at, ext_key) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ev.project_id, ev.scene_id ?? null, ev.type, ev.message, ctx.now(), ev.ext_key ?? null);
  const id = Number(info.lastInsertRowid);
  ctx.publish('event.created', ev.project_id, () => {
    const row = ctx.db
      .prepare('SELECT e.*, s.code AS scene_code FROM events e LEFT JOIN scenes s ON s.id = e.scene_id WHERE e.id = ?')
      .get(id) as (EventRow & { scene_code: string | null }) | undefined;
    return { event: row ? eventJson(row) : null };
  });
  return id;
}

export function emitJob(ctx: AppContext, jobId: number, projectId: number): void {
  ctx.publish('job.updated', projectId, () => ({ job: getJobJson(ctx, jobId) }), `job:${jobId}`);
}

export function emitBudget(ctx: AppContext, projectId: number): void {
  ctx.publish('budget.updated', projectId, { project_id: projectId }, `budget:${projectId}`);
}
