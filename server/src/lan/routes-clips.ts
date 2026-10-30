import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError, notFound } from '../lib/errors.js';
import { intParam } from '../lib/validate.js';
import { registerClipEndpoints, type LimitHandle, type LimitKind } from '../services/clips/http.js';
import { lanClipProject, listLanClipProjects } from '../services/clips/lan.js';
import { ownsLanPlan } from '../services/lan-plans.js';
import { deleteProject } from '../services/trash.js';
import { ensureClientHash, peekClientHash } from './client-id.js';
import { LAN_RATE, beginClipUpload, tooMany, type LanLimiters } from './limits.js';
import { lanIp } from './security.js';

const WHAT: Record<Exclude<LimitKind, 'upload'>, string> = {
  project: `Mỗi người chỉ được tạo tối đa ${LAN_RATE.clipProject.max} dự án cắt clip mỗi giờ.`,
  source: `Mỗi người chỉ được tải video nguồn hoặc nhận dạng lại tối đa ${LAN_RATE.clipSource.max} lần mỗi giờ.`,
  plan: `Mỗi người chỉ được nhờ AI chọn đoạn tối đa ${LAN_RATE.clipPlan.max} lần mỗi giờ.`,
  render: `Mỗi người chỉ được dựng clip tối đa ${LAN_RATE.clipRender.max} lần mỗi giờ.`,
  edit: `Mỗi người chỉ được sửa clip tối đa ${LAN_RATE.clipEdit.max} lần mỗi giờ.`,
};

/**
 * Cắt clip từ video dài trên listener LAN: cùng bộ endpoint với app chính (`/lan/api/...`), thêm danh sách dự án và xoá theo cookie người tạo.
 * Hạn mức theo IP: tạo dự án 10/giờ, video nguồn 3/giờ (1 lượt tải đồng thời mỗi IP), AI chọn đoạn 6/giờ, dựng 30/giờ, sửa 120/giờ; tính vào trần hàng đợi LAN.
 */
export function registerLanClipRoutes(app: FastifyInstance, ctx: AppContext, L: LanLimiters): void {
  const limiterOf = (kind: Exclude<LimitKind, 'upload'>) => ({ project: L.clipProject, source: L.clipSource, plan: L.clipPlan, render: L.clipRender, edit: L.clipEdit })[kind];

  registerClipEndpoints(app, ctx, {
    lan: true,
    prefix: '/lan/api',
    view: (req) => ({ lan: true, clientHash: peekClientHash(req) }),
    scope: (project) => {
      if (project.source !== 'lan') throw notFound('dự án cắt clip');
    },
    origin: (req, reply) => ({ source: 'lan', lan_client_hash: ensureClientHash(req, reply) }),
    limit: (kind, req, reply): LimitHandle => {
      const ip = lanIp(req);
      if (kind === 'upload') {
        const release = beginClipUpload(reply, L, ip, WHAT.source);
        return { record: () => L.clipSource.record(ip), release };
      }
      const limiter = limiterOf(kind);
      const lim = limiter.check(ip);
      if (!lim.allowed) throw tooMany(reply, WHAT[kind], lim.retryAfterMs);
      return { record: () => limiter.record(ip) };
    },
  });

  // Danh sách dự án cắt clip của LAN (mọi người trong LAN đều thấy; xoá theo cookie người tạo)
  app.get('/lan/api/clip-projects', async (req) => listLanClipProjects(ctx, { lan: true, clientHash: peekClientHash(req) }));

  // Xoá = chuyển vào thùng rác của chủ máy (30 ngày). CHỈ trình duyệt đã tạo dự án; cùng hạn mức với xoá kế hoạch (10/giờ/IP).
  app.delete('/lan/api/clip-projects/:id', async (req, reply) => {
    const ip = lanIp(req);
    const lim = L.deletePlan.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được xoá tối đa ${LAN_RATE.deletePlan.max} dự án mỗi giờ.`, lim.retryAfterMs);
    const p = lanClipProject(ctx, intParam((req.params as { id: string }).id));
    L.deletePlan.record(ip);
    if (!ownsLanPlan(p, peekClientHash(req))) throw new AppError('NOT_PLAN_OWNER', 'Chỉ người tạo (trình duyệt đã tạo dự án) mới xoá được; nhờ chủ máy xoá', 403);
    deleteProject(ctx, p.id, { by: 'lan' });
    return { ok: true, id: p.id, restorable_days: ctx.config.trashRetentionDays };
  });
}
