import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { intParam, parse } from '../lib/validate.js';
import { readColorRefUpload } from '../lib/color-upload.js';
import { addColorRef, addColorRefFromSource, colorRefJson, colorRefsListJson, deleteColorRef, fromSourceBody, getColorRef } from '../services/color-refs.js';
import { lanFileUrl } from '../services/lan-common.js';
import { lanProject } from '../services/lan-plans.js';
import { beginUpload, tooMany, type LanLimiters } from './limits.js';
import { lanIp } from './security.js';

/**
 * Ảnh mẫu / file LUT của kế hoạch LAN (dùng chung dịch vụ `color-refs` với app chính). Chỉ có trên listener LAN, sau phiên + Host/Origin như mọi route.
 * Tải lên (và chép từ ảnh có sẵn) 20 lần/giờ/IP; ảnh và thumb phục vụ qua `/lan/files` (allowlist `isLanServable`), file .cube KHÔNG bao giờ phục vụ.
 * Kế hoạch đã xoá (thùng rác) hoặc không phải kế hoạch LAN → 404 (qua `lanProject`).
 */
export function registerLanColorRoutes(app: FastifyInstance, ctx: AppContext, L: LanLimiters): void {
  const planId = (req: FastifyRequest) => intParam((req.params as { id: string }).id);
  const remaining = (ip: string) => L.colorRef.check(ip).remaining;

  app.get('/lan/api/plans/:id/color-refs', async (req) => colorRefsListJson(ctx, lanProject(ctx, planId(req)), lanFileUrl, { lanOnly: true }));

  app.post('/lan/api/plans/:id/color-refs', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const release = beginUpload(reply, L, L.colorRef, ip, 'Bạn đã tải lên quá nhiều ảnh mẫu / file LUT trong một giờ.');
    try {
      const up = await readColorRefUpload(req);
      const r = await addColorRef(ctx, p, { originalName: up.name, buf: up.buf, type: up.type, createdByName: up.createdByName });
      if (r.created) L.colorRef.record(ip); // chỉ lượt tạo mới tính (tải trùng nội dung thì dùng lại)
      return reply.code(r.created ? 201 : 200).send({ color_ref: colorRefJson(ctx, r.row, lanFileUrl), existing: !r.created, rate: { color_ref_remaining: remaining(ip) } });
    } finally {
      release();
    }
  });

  app.post('/lan/api/plans/:id/color-refs/from-asset', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const body = parse(fromSourceBody, req.body ?? {});
    const lim = L.colorRef.check(ip);
    if (!lim.allowed) throw tooMany(reply, 'Bạn đã tải lên quá nhiều ảnh mẫu / file LUT trong một giờ.', lim.retryAfterMs);
    const r = await addColorRefFromSource(ctx, p, body, { lanOnly: true });
    if (r.created) L.colorRef.record(ip);
    return reply.code(r.created ? 201 : 200).send({ color_ref: colorRefJson(ctx, r.row, lanFileUrl), existing: !r.created, rate: { color_ref_remaining: remaining(ip) } });
  });

  app.delete('/lan/api/plans/:id/color-refs/:refId', async (req) => {
    const p = lanProject(ctx, planId(req));
    const refId = intParam((req.params as { refId: string }).refId, 'refId');
    getColorRef(ctx, p, refId);
    deleteColorRef(ctx, p, refId);
    return { ok: true };
  });
}
