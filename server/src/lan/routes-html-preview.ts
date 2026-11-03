import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { conflict } from '../lib/errors.js';
import { intParam } from '../lib/validate.js';
import { getHtmlPreview } from '../services/html/preview.js';
import { getHtmlProject, getVersion, getVersionById } from '../services/html/repo.js';
import { listSegments } from '../services/html/segments.js';

/**
 * Xem trước Video HTML (CHỈ bản desktop): cấp phiên preview cho một phiên bản `ready`. Nội dung được phục vụ bởi listener preview riêng
 * (xem services/html/preview.ts), KHÔNG qua listener planner. Trả `{url, origin, expires_at}`; token nằm trong url và không bao giờ được ghi log.
 */
export function registerLanHtmlPreviewRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/lan/api/html-projects/:id/versions/:v/segments/:idx/preview',async(req,reply)=>{
    const p=req.params as {id:string;v:string;idx:string};
    const owner=getVersion(ctx,getHtmlProject(ctx,intParam(p.id)).id,intParam(p.v,'v'));
    const row=listSegments(ctx,owner.id).find(s=>s.idx===intParam(p.idx,'idx'));
    if(!row?.segment_version_id||row.status!=='ready')throw conflict('SEGMENT_NOT_READY','Đoạn chưa sẵn sàng');
    const svc=getHtmlPreview(ctx);if(!svc?.origin)throw conflict('PREVIEW_UNAVAILABLE','Dịch vụ xem trước chưa chạy');
    reply.header('Cache-Control','no-store');return svc.createSession(getVersionById(ctx,row.segment_version_id));
  });
  app.post('/lan/api/html-projects/:id/versions/:v/preview', async (req: FastifyRequest, reply) => {
    const p = req.params as { id: string; v: string };
    const project = getHtmlProject(ctx, intParam(p.id));
    const v = getVersion(ctx, project.id, intParam(p.v, 'v'));
    if(v.is_segmented)throw conflict('SEGMENT_PREVIEW_REQUIRED','Chọn một đoạn để xem trước video dài');
    const svc = getHtmlPreview(ctx);
    if (!svc?.origin) throw conflict('PREVIEW_UNAVAILABLE', 'Dịch vụ xem trước chưa chạy (không mở được cổng cục bộ). Khởi động lại ứng dụng.');
    reply.header('Cache-Control', 'no-store');
    return svc.createSession(v);
  });
}
