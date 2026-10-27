import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { intParam, parse } from '../lib/validate.js';
import { readColorRefUpload } from '../lib/color-upload.js';
import { addColorRef, addColorRefFromSource, colorRefJson, colorRefsListJson, deleteColorRef, fromSourceBody, getColorRef } from '../services/color-refs.js';
import { fileUrl, getProject } from '../services/repo.js';

/**
 * Ảnh mẫu / file LUT của dự án cho "Màu theo ảnh mẫu" (xem services/color-refs.ts, API.md mục Bản hoàn chỉnh).
 * Tải lên trùng nội dung → 200 kèm dòng cũ (`existing: true`); mới → 201.
 */
export function registerColorRefRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pid = (req: { params: unknown }) => intParam((req.params as { id: string }).id);

  app.get('/api/projects/:id/color-refs', async (req) => colorRefsListJson(ctx, getProject(ctx, pid(req)), fileUrl));

  app.post('/api/projects/:id/color-refs', async (req, reply) => {
    const project = getProject(ctx, pid(req));
    const up = await readColorRefUpload(req);
    const r = await addColorRef(ctx, project, { originalName: up.name, buf: up.buf, type: up.type, createdByName: up.createdByName });
    return reply.code(r.created ? 201 : 200).send({ color_ref: colorRefJson(ctx, r.row, fileUrl), existing: !r.created });
  });

  app.post('/api/projects/:id/color-refs/from-asset', async (req, reply) => {
    const project = getProject(ctx, pid(req));
    const body = parse(fromSourceBody, req.body ?? {});
    const r = await addColorRefFromSource(ctx, project, body);
    return reply.code(r.created ? 201 : 200).send({ color_ref: colorRefJson(ctx, r.row, fileUrl), existing: !r.created });
  });

  app.delete('/api/projects/:id/color-refs/:refId', async (req) => {
    const project = getProject(ctx, pid(req));
    const refId = intParam((req.params as { refId: string }).refId, 'refId');
    getColorRef(ctx, project, refId);
    deleteColorRef(ctx, project, refId);
    return { ok: true };
  });
}
