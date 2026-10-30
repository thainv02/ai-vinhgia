import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { readImageUploads } from '../lib/uploads.js';
import { intParam, optionalIntParam, parse } from '../lib/validate.js';
import type { EventRow, ProjectRow, RefRow } from '../db/types.js';
import { approveAll, previewApproveAll } from '../services/approvals.js';
import { budgetSummary } from '../services/budget.js';
import { ledgerCsv, ledgerView } from '../services/exports.js';
import { generateLogMd } from '../services/logmd.js';
import {
  createProjectBody,
  patchProjectBody,
  createProject,
  patchProject,
  projectDetail,
  submitBrief,
} from '../services/projects.js';
import { projectSummary } from '../services/project-view.js';
import {
  addRefsFromLibrary,
  deleteRef,
  refLibrary,
  reorderRefs,
  setRefLabel,
  storeRef,
} from '../services/refs.js';
import { eventJson, getJobJson, getProject, getRef, projectRefs, refJson } from '../services/repo.js';
import { listSceneSummaries } from '../services/scene-view.js';
import { deleteProject } from '../services/trash.js';

const stageSchema = z.enum(['storyboard', 'video']);

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/projects', async (req, reply) => {
    const body = parse(createProjectBody, req.body ?? {});
    const project = createProject(ctx, body);
    return reply.code(201).send(projectDetail(ctx, project));
  });

  app.get('/api/projects', async () => {
    const rows = ctx.db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY id DESC').all() as ProjectRow[];
    return rows.map((p) => projectSummary(ctx, p));
  });

  app.get('/api/projects/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    return projectDetail(ctx, getProject(ctx, id));
  });

  app.patch('/api/projects/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const patch = parse(patchProjectBody, req.body ?? {});
    return projectDetail(ctx, patchProject(ctx, id, patch));
  });

  // Xoá = chuyển vào thùng rác 30 ngày (khôi phục được ở POST /api/trash/:id/restore). Body { confirm_name } phải trùng tên dự án.
  app.delete('/api/projects/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ confirm_name: z.string({ error: 'cần confirm_name (tên dự án)' }) }), req.body ?? {});
    getProject(ctx, id);
    const r = deleteProject(ctx, id, { by: 'app', confirmName: body.confirm_name });
    return { ok: true, id: r.id, name: r.name, restorable_days: ctx.config.trashRetentionDays };
  });

  // ---- ảnh tham chiếu ----
  app.post('/api/projects/:id/refs', async (req, reply) => {
    const projectId = intParam((req.params as { id: string }).id);
    getProject(ctx, projectId);
    const items = await readImageUploads(req);
    const created: RefRow[] = items.map((it) => storeRef(ctx, projectId, it.name, it.buf, it.type, it.label));
    return reply.code(201).send(created.map(refJson));
  });

  // Thư viện ảnh dùng lại giữa các dự án (mỗi ảnh duy nhất theo content_hash, mới nhất trước)
  app.get('/api/ref-library', async (req) => {
    const q = req.query as { projectId?: string };
    return refLibrary(ctx, optionalIntParam(q.projectId, 'projectId'));
  });

  // Thêm ảnh từ thư viện: chép file của ref nguồn vào refs/<id>/ (không dùng chung đường dẫn)
  app.post('/api/projects/:id/refs/from-library', async (req, reply) => {
    const projectId = intParam((req.params as { id: string }).id);
    const body = parse(
      z.object({
        ref_ids: z.array(z.number().int().positive()).min(1).max(20),
        labels: z.record(z.string(), z.string().max(100)).optional(),
      }),
      req.body,
    );
    return reply.code(201).send(addRefsFromLibrary(ctx, projectId, body.ref_ids, body.labels).map(refJson));
  });

  app.patch('/api/refs/reorder', async (req) => {
    const body = parse(z.object({ project_id: z.number().int(), ids: z.array(z.number().int()) }), req.body);
    return reorderRefs(ctx, body.project_id, body.ids).map(refJson);
  });

  app.patch('/api/refs/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ label: z.string().trim().min(1).max(100) }), req.body);
    return refJson(setRefLabel(ctx, id, body.label));
  });

  app.delete('/api/refs/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    getRef(ctx, id);
    deleteRef(ctx, id);
    return { ok: true };
  });

  // ---- kịch bản / cảnh ----
  app.post('/api/projects/:id/brief', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ brief: z.string().max(50_000).optional() }), req.body ?? {});
    const { jobId } = submitBrief(ctx, id, body.brief);
    return reply.code(201).send({ project: projectSummary(ctx, getProject(ctx, id)), job: getJobJson(ctx, jobId) });
  });

  app.get('/api/projects/:id/scenes', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    return listSceneSummaries(ctx, id);
  });

  app.get('/api/projects/:id/budget', async (req) => {
    return budgetSummary(ctx, intParam((req.params as { id: string }).id));
  });

  // ---- duyệt hàng loạt ----
  app.get('/api/projects/:id/approve-all/preview', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const stage = parse(stageSchema, (req.query as { stage?: string }).stage, 'Tham số stage');
    return previewApproveAll(ctx, id, stage);
  });

  app.post('/api/projects/:id/approve-all', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ stage: stageSchema, expectedCredits: z.number().int().min(0).optional() }), req.body);
    if (body.stage === 'video' && body.expectedCredits === undefined) {
      throw badRequest('VALIDATION_ERROR', 'Cần expectedCredits (tổng credit người dùng đã xác nhận) khi duyệt video hàng loạt');
    }
    return approveAll(ctx, id, body.stage, body.expectedCredits);
  });

  // ---- dòng thời gian, sổ cái, xuất file ----
  app.get('/api/projects/:id/events', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    getProject(ctx, id);
    const q = req.query as { sceneId?: string; limit?: string; before?: string };
    const sceneId = optionalIntParam(q.sceneId, 'sceneId');
    const before = optionalIntParam(q.before, 'before');
    const limit = Math.min(optionalIntParam(q.limit, 'limit') ?? 200, 1000);
    const where = ['e.project_id = ?'];
    const args: number[] = [id];
    if (sceneId !== undefined) {
      where.push('e.scene_id = ?');
      args.push(sceneId);
    }
    if (before !== undefined) {
      where.push('e.id < ?');
      args.push(before);
    }
    args.push(limit);
    const rows = ctx.db
      .prepare(
        `SELECT e.*, s.code AS scene_code FROM events e LEFT JOIN scenes s ON s.id = e.scene_id
         WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...args) as (EventRow & { scene_code: string | null })[];
    return rows.map(eventJson);
  });

  app.get('/api/projects/:id/ledger', async (req) => ledgerView(ctx, intParam((req.params as { id: string }).id)));

  app.get('/api/projects/:id/ledger.csv', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const project = getProject(ctx, id);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="ledger-${project.slug}.csv"`)
      .send(ledgerCsv(ctx, id));
  });

  app.get('/api/projects/:id/log.md', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    const project = getProject(ctx, id);
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="log-${project.slug}.md"`)
      .send(generateLogMd(ctx, id));
  });

  // danh sách ảnh tham chiếu riêng (tiện cho trang tạo dự án)
  app.get('/api/projects/:id/refs', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    getProject(ctx, id);
    return projectRefs(ctx, id).map(refJson);
  });
}
