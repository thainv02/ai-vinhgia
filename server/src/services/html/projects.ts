/** Dự án Video HTML (projects.kind='html', source='lan' trên desktop): tạo/liệt kê/xem/đổi tên. Xoá đi qua `deleteFromPlanner` (trash.ts) với các điều kiện chặn của HTML. */
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { ProjectRow } from '../../db/types.js';
import { logEvent } from '../repo.js';
import { projectDeleteBlocks } from '../trash.js';
import { uniqueSlug } from '../projects.js';
import { HTML_ASPECTS, HTML_MAX_TOTAL_S, HTML_QUALITIES } from './config.js';
import { getHtmlProject } from './repo.js';
import { projectView, type HtmlProjectView } from './view.js';

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const modelId = z.string().trim().min(1).max(100).regex(/^[\w.:/-]+$/, 'ID model chỉ gồm chữ, số, . _ : / -');

export const createHtmlProjectBody = z.object({
  name: z.string().trim().min(1, 'tên dự án không được rỗng').max(200).refine(noControl, 'không được chứa ký tự điều khiển'),
  brief: z.string().trim().max(10_000, 'tối đa 10000 ký tự').default(''),
  aspect: z.enum(HTML_ASPECTS).default('9:16'),
  duration_s: z.number().int().min(1).max(HTML_MAX_TOTAL_S).default(15),
  quality: z.enum(HTML_QUALITIES).default('720p'),
  template: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'ID mẫu không hợp lệ').nullable().default(null),
  model: z.object({ compose: modelId.optional(), vision: modelId.optional() }).default({}),
});
export type CreateHtmlProjectBody = z.infer<typeof createHtmlProjectBody>;

export const patchHtmlProjectBody = z
  .object({
    name: z.string().trim().min(1).max(200).refine(noControl, 'không được chứa ký tự điều khiển'),
    brief: z.string().trim().max(10_000),
  })
  .partial();
export type PatchHtmlProjectBody = z.infer<typeof patchHtmlProjectBody>;

export function createHtmlProject(ctx: AppContext, body: CreateHtmlProjectBody): ProjectRow {
  return ctx.tx(() => {
    const now = ctx.now();
    const info = ctx.db
      .prepare(
        `INSERT INTO projects (slug, name, brief, kind, status, source, created_at, updated_at)
         VALUES (?, ?, ?, 'html', 'active', 'lan', ?, ?)`,
      )
      .run(uniqueSlug(ctx, body.name), body.name, body.brief, now, now);
    const id = Number(info.lastInsertRowid);
    ctx.db
      .prepare('INSERT INTO html_project_meta (project_id, aspect, duration_s, quality, template_id, model_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.aspect, body.duration_s, body.quality, body.template, JSON.stringify({ compose: body.model.compose ?? 'auto', vision: body.model.vision ?? 'auto' }), now);
    logEvent(ctx, { project_id: id, type: 'project.created', message: `Tạo dự án Video HTML "${body.name}" (${body.aspect}, ${body.duration_s}s, ${body.quality})` });
    return getHtmlProject(ctx, id);
  });
}

export function listHtmlProjects(ctx: AppContext): HtmlProjectView[] {
  const rows = ctx.db.prepare("SELECT * FROM projects WHERE kind = 'html' AND source = 'lan' AND deleted_at IS NULL ORDER BY id DESC LIMIT 500").all() as ProjectRow[];
  return rows.map((p) => htmlProjectView(ctx, p));
}

export function htmlProjectView(ctx: AppContext, p: ProjectRow): HtmlProjectView {
  const blocks = projectDeleteBlocks(ctx, p.id);
  return projectView(ctx, p, blocks.length ? { code: blocks[0]!.code, message: blocks.map((b) => b.message).join(' ') } : null);
}

export function patchHtmlProject(ctx: AppContext, id: number, patch: PatchHtmlProjectBody): ProjectRow {
  return ctx.tx(() => {
    const p = getHtmlProject(ctx, id);
    const keys = (Object.keys(patch) as (keyof PatchHtmlProjectBody)[]).filter((k) => patch[k] !== undefined);
    if (!keys.length) return p;
    ctx.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] as string), ctx.now(), id);
    logEvent(ctx, { project_id: id, type: 'project.updated', message: `Cập nhật dự án Video HTML: ${keys.join(', ')}` });
    return getHtmlProject(ctx, id);
  });
}
