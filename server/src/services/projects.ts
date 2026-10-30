import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../lib/errors.js';
import { slugify } from '../lib/paths.js';
import type { JobRow, ProjectRow, ProjectSource } from '../db/types.js';
import { budgetSummary } from './budget.js';
import { insertJob } from './jobs.js';
import { emitProject, projectSummary } from './project-view.js';
import { getJobJson, getProject, logEvent, projectRefs, refJson } from './repo.js';
import { projectDeleteBlocks } from './trash.js';

export const createProjectBody = z.object({
  name: z.string().trim().min(1, 'tên dự án không được rỗng').max(200),
  brief: z.string().max(50_000).default(''),
  style_lock: z.string().max(20_000).default(''),
  max_attempts_per_scene: z.number().int().min(1).max(20).default(2),
  credit_per_video: z.number().int().min(0).default(15),
});
export type CreateProjectBody = z.infer<typeof createProjectBody>;

export const patchProjectBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    brief: z.string().max(50_000),
    style_lock: z.string().max(20_000),
    max_attempts_per_scene: z.number().int().min(1).max(20),
    credit_per_video: z.number().int().min(0),
  })
  .partial();
export type PatchProjectBody = z.infer<typeof patchProjectBody>;

/** Slug duy nhất từ tên (thêm -2, -3… nếu trùng). */
export function uniqueSlug(ctx: AppContext, name: string): string {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; ctx.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export interface CreateProjectOrigin {
  /** 'lan': dự án do người dùng LAN tạo qua trang planner (chỉ lập kế hoạch). Mặc định 'app'. */
  source?: ProjectSource;
  created_by_name?: string | null;
  /** sha256 của cookie client LAN của trình duyệt tạo kế hoạch (chỉ dự án 'lan' tạo từ khi có tính năng xoá); NULL = không ai ngoài chủ máy xoá được. */
  lan_client_hash?: string | null;
}

export function createProject(ctx: AppContext, body: CreateProjectBody, origin: CreateProjectOrigin = {}): ProjectRow {
  return ctx.tx(() => {
    const now = ctx.now();
    const source = origin.source ?? 'app';
    const info = ctx.db
      .prepare(
        `INSERT INTO projects (slug, name, brief, style_lock, max_attempts_per_scene, credit_per_video, status, source, created_by_name, lan_client_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(
        uniqueSlug(ctx, body.name),
        body.name,
        body.brief,
        body.style_lock,
        body.max_attempts_per_scene,
        body.credit_per_video,
        source,
        origin.created_by_name ?? null,
        source === 'lan' ? (origin.lan_client_hash ?? null) : null,
        now,
        now,
      );
    const project = getProject(ctx, Number(info.lastInsertRowid));
    logEvent(ctx, {
      project_id: project.id,
      type: 'project.created',
      message: source === 'lan' ? `Tạo kế hoạch "${project.name}" từ trang LAN (người tạo: ${project.created_by_name ?? 'không rõ'})` : `Tạo dự án "${project.name}"`,
    });
    return project;
  });
}

export function patchProject(ctx: AppContext, id: number, patch: PatchProjectBody): ProjectRow {
  return ctx.tx(() => {
    const project = getProject(ctx, id);
    const keys = Object.keys(patch) as (keyof PatchProjectBody)[];
    if (keys.length === 0) return project;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    ctx.db.prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] as string | number), ctx.now(), id);
    logEvent(ctx, { project_id: id, type: 'project.updated', message: `Cập nhật dự án: ${keys.join(', ')}` });
    ctx.publish('budget.updated', id, { project_id: id }, `budget:${id}`);
    emitProject(ctx, id);
    return getProject(ctx, id);
  });
}

/** Gửi kịch bản cho AI: tạo job analyze_brief (không cần duyệt). */
export function submitBrief(ctx: AppContext, projectId: number, brief?: string) {
  return ctx.tx(() => {
    const project = getProject(ctx, projectId);
    const text = (brief ?? project.brief).trim();
    if (!text) throw badRequest('VALIDATION_ERROR', 'Cần nhập yêu cầu kịch bản (brief) trước khi gửi cho AI');
    const active = ctx.db
      .prepare("SELECT id FROM jobs WHERE project_id = ? AND type = 'analyze_brief' AND status IN ('queued','claimed','running') LIMIT 1")
      .get(projectId);
    if (active) throw conflict('JOB_ACTIVE', 'Dự án đang có job phân tích kịch bản chưa xong');
    ctx.db.prepare("UPDATE projects SET brief = ?, status = 'analyzing', updated_at = ? WHERE id = ?").run(text, ctx.now(), projectId);
    const jobId = insertJob(ctx, { project_id: projectId, scene_id: null, type: 'analyze_brief', requires_approval: false, approved: false });
    logEvent(ctx, { project_id: projectId, type: 'project.brief', message: 'Gửi kịch bản cho AI phân tích' });
    emitProject(ctx, projectId);
    return { jobId };
  });
}

export function projectDetail(ctx: AppContext, p: ProjectRow) {
  const requeued = ctx.db
    .prepare("SELECT id FROM jobs WHERE project_id = ? AND requeue_count > 0 AND status IN ('queued','claimed','running') ORDER BY id")
    .all(p.id) as Pick<JobRow, 'id'>[];
  return {
    ...projectSummary(ctx, p),
    refs: projectRefs(ctx, p.id).map(refJson),
    budget: budgetSummary(ctx, p.id),
    requeued_jobs: requeued.map((r) => getJobJson(ctx, r.id)),
    /** Lý do chưa chuyển được vào thùng rác (job đang chạy, đang dựng/render, thao tác Flow chưa đối soát, đang tải video); null = xoá được. */
    delete_block: (() => {
      const blocks = projectDeleteBlocks(ctx, p.id);
      return blocks.length ? { code: blocks[0]!.code, message: blocks.map((b) => b.message).join(' '), reasons: blocks } : null;
    })(),
  };
}
