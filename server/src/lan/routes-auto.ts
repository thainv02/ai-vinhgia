import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { intParam, parse } from '../lib/validate.js';
import {
  approveAllBody,
  autoAll,
  autoAllCount,
  autoCancel,
  autoDetail,
  autoEditPrompt,
  autoGenerators,
  autoSelectVideo,
  autoStoryboard,
  autoSummary,
  autoVideo,
  createAutoBody,
  createLanAuto,
  lanAutoProject,
  listLanAuto,
  patchAutoBody,
  promptBody,
  selectBody,
  setAutoStoryboardGenerator,
  videoBody,
} from '../services/lan-auto.js';
import { lanFinalSummary, lanWatermarkInfo } from '../services/lan-final.js';
import type { SlidingWindowLimiter } from './rate-limit.js';
import { ensureClientHash, peekClientHash } from './client-id.js';
import { LAN_RATE, tooMany, type LanLimiters } from './limits.js';
import { lanIp } from './security.js';

/**
 * Tab Autovideo trên listener LAN (`/lan/api/auto/...`): người dùng LAN bấm tạo storyboard/video, worker nền tạo bằng Muse2API/Flow2API.
 * Ảnh tham chiếu, phân tích, xoá dự án và bản hoàn chỉnh dùng lại route của kế hoạch (`/lan/api/plans/:id/...`), vì dự án Autovideo cũng là dự án LAN.
 * Hạn mức theo IP: tạo dự án 10/giờ, storyboard 40 cảnh/giờ, video 20 cảnh/giờ, sửa/chọn/hủy 120/giờ; trần chung 20 việc ảnh/video LAN đang chờ/chạy.
 */
export function registerLanAutoRoutes(app: FastifyInstance, ctx: AppContext, L: LanLimiters): void {
  const project = (req: FastifyRequest) => lanAutoProject(ctx, intParam((req.params as { id: string }).id));
  const sceneId = (req: FastifyRequest) => intParam((req.params as { sceneId: string }).sceneId, 'sceneId');

  /** Chạy `fn` nếu IP còn `n` lượt của `limiter`; chỉ ghi nhận lượt khi thành công. */
  const limited = <T>(req: FastifyRequest, reply: FastifyReply, limiter: SlidingWindowLimiter, what: string, n: number, fn: () => T): T => {
    const ip = lanIp(req);
    const lim = limiter.check(ip, Math.max(1, n));
    if (!lim.allowed) throw tooMany(reply, what, lim.retryAfterMs);
    const out = fn();
    limiter.record(ip, Math.max(1, n));
    return out;
  };
  const WHAT = {
    project: `Mỗi người chỉ được tạo tối đa ${LAN_RATE.autoProject.max} dự án Autovideo mỗi giờ.`,
    storyboard: `Mỗi người chỉ được tạo storyboard cho tối đa ${LAN_RATE.autoStoryboard.max} cảnh mỗi giờ.`,
    video: `Mỗi người chỉ được tạo video cho tối đa ${LAN_RATE.autoVideo.max} cảnh mỗi giờ.`,
    edit: `Mỗi người chỉ được sửa tối đa ${LAN_RATE.autoEdit.max} lần mỗi giờ.`,
  };

  app.get('/lan/api/auto/generators', async () => autoGenerators());

  app.get('/lan/api/auto/projects', async (req) => listLanAuto(ctx, peekClientHash(req)));

  app.post('/lan/api/auto/projects', async (req, reply) => {
    const body = parse(createAutoBody, req.body ?? {});
    return limited(req, reply, L.autoProject, WHAT.project, 1, () => {
      const hash = ensureClientHash(req, reply);
      const p = createLanAuto(ctx, body, hash);
      return reply.code(201).send({ project: autoSummary(ctx, p, hash) });
    });
  });

  app.get('/lan/api/auto/projects/:id', async (req) => {
    const p = project(req);
    const wm = ctx.finalRender ? lanWatermarkInfo(await ctx.finalRender.watermarkStatus()) : { active: false, reason: 'Chưa có trình dựng' };
    return { ...autoDetail(ctx, p, peekClientHash(req)), final: { ...lanFinalSummary(ctx, p), watermark: wm } };
  });

  app.patch('/lan/api/auto/projects/:id', async (req, reply) => {
    const p = project(req);
    const body = parse(patchAutoBody, req.body ?? {});
    return limited(req, reply, L.autoEdit, WHAT.edit, 1, () => ({ project: autoSummary(ctx, setAutoStoryboardGenerator(ctx, p, body.storyboard_generator), peekClientHash(req)) }));
  });

  app.post('/lan/api/auto/projects/:id/scenes/:sceneId/storyboard', async (req, reply) => {
    const p = project(req);
    return reply.code(201).send(limited(req, reply, L.autoStoryboard, WHAT.storyboard, 1, () => ({ job_id: autoStoryboard(ctx, p, sceneId(req)).jobId })));
  });

  app.post('/lan/api/auto/projects/:id/scenes/:sceneId/video', async (req, reply) => {
    const p = project(req);
    const body = parse(videoBody, req.body ?? {});
    return reply.code(201).send(limited(req, reply, L.autoVideo, WHAT.video, 1, () => ({ job_id: autoVideo(ctx, p, sceneId(req), body.generator).jobId })));
  });

  // Tạo storyboard (cảnh chờ duyệt) hoặc video (cảnh đang xem storyboard) cho mọi cảnh đủ điều kiện, tất-cả-hoặc-không; mỗi cảnh tính một lượt.
  app.post('/lan/api/auto/projects/:id/approve-all', async (req, reply) => {
    const p = project(req);
    const body = parse(approveAllBody, req.body ?? {});
    const n = autoAllCount(ctx, p, body.stage, body.generator);
    const [limiter, what] = body.stage === 'video' ? [L.autoVideo, WHAT.video] : [L.autoStoryboard, WHAT.storyboard];
    return reply.code(201).send(limited(req, reply, limiter, what, n, () => autoAll(ctx, p, body.stage, body.generator)));
  });

  app.post('/lan/api/auto/projects/:id/scenes/:sceneId/select', async (req, reply) => {
    const p = project(req);
    const body = parse(selectBody, req.body ?? {});
    return limited(req, reply, L.autoEdit, WHAT.edit, 1, () => {
      autoSelectVideo(ctx, p, sceneId(req), body.asset_id);
      return { ok: true };
    });
  });

  app.put('/lan/api/auto/projects/:id/scenes/:sceneId/prompt', async (req, reply) => {
    const p = project(req);
    const body = parse(promptBody, req.body ?? {});
    return limited(req, reply, L.autoEdit, WHAT.edit, 1, () => {
      autoEditPrompt(ctx, p, sceneId(req), body.prompt);
      return { ok: true };
    });
  });

  app.post('/lan/api/auto/projects/:id/scenes/:sceneId/cancel', async (req, reply) => {
    const p = project(req);
    return limited(req, reply, L.autoEdit, WHAT.edit, 1, () => {
      autoCancel(ctx, p, sceneId(req));
      return { ok: true };
    });
  });
}
