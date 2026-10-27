import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { intParam, parse } from '../lib/validate.js';
import { projectDetail } from '../services/projects.js';
import { listTrash, purgeProject, restoreProject } from '../services/trash.js';

const confirmBody = z.object({ confirm_name: z.string({ error: 'cần confirm_name (tên dự án)' }) });

/** Thùng rác dự án (chỉ app chính; trang LAN không có khôi phục hay xoá vĩnh viễn). Xem server/API.md mục 5.8. */
export function registerTrashRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/trash', async () => listTrash(ctx));

  app.post('/api/trash/:id/restore', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    return projectDetail(ctx, restoreProject(ctx, id));
  });

  // Xoá vĩnh viễn (không hoàn tác): phải gõ đúng tên dự án
  app.delete('/api/trash/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(confirmBody, req.body ?? {});
    const r = purgeProject(ctx, id, { confirmName: body.confirm_name });
    return { ok: true, id: r.id, name: r.name };
  });
}
