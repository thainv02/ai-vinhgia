import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { intParam, parse } from '../lib/validate.js';
import { streamVideoToDisk } from '../lib/video-upload.js';
import {
  cancelLanFinalCut,
  cleanLanFinalCut,
  createLanFeedback,
  createLanFinalCut,
  createLanGrade,
  lanGradePreview,
  regradeLanFinalCut,
  lanFinalCutJson,
  lanFinalCutRow,
  listLanFinalCuts,
  rerenderBody,
  rerenderLanFinalCut,
} from '../services/lan-final.js';
import { feedbackBody, gradeBody } from '../services/final-revisions.js';
import { lanProject } from '../services/lan-plans.js';
import { assertVideoUploadable, assertVideoProbe, lanVideoJson, LAN_VIDEO_MAX_S, LAN_VIDEO_MIN_S, sceneVideosJson, selectLanVideo, addLanVideo } from '../services/lan-video.js';
import { probeUploadedVideo } from '../services/media.js';
import { getScene } from '../services/repo.js';
import { beginUpload, tooMany, type LanLimiters } from './limits.js';
import { lanIp } from './security.js';

/** Bước 3 (video từng cảnh) và bản hoàn chỉnh (final cut) của kế hoạch LAN. Chỉ có trên listener LAN, sau phiên + Host/Origin như mọi route. */
export function registerLanMediaRoutes(app: FastifyInstance, ctx: AppContext, L: LanLimiters): void {
  const planId = (req: FastifyRequest) => intParam((req.params as { id: string }).id);
  const cutId = (req: FastifyRequest) => intParam((req.params as { cutId: string }).cutId, 'cutId');
  const remaining = (limiter: { check(ip: string): { remaining: number } }, ip: string) => limiter.check(ip).remaining;
  const lanWm = (wm: { active: boolean } | undefined): { active: boolean } => ({ active: !!wm?.active });

  // ---- Bước 3: tải lên video cảnh (stream xuống đĩa, không đọc cả file vào RAM) ----
  app.post('/lan/api/plans/:id/scenes/:sceneId/video', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const sceneId = intParam((req.params as { sceneId: string }).sceneId, 'sceneId');
    const scene = getScene(ctx, sceneId);
    if (scene.project_id !== p.id) throw notFound('cảnh');
    assertVideoUploadable(ctx, scene); // bận/đủ 5 video: báo ngay, không nhận file
    const release = beginUpload(reply, L, L.uploadVideo, ip, 'Bạn đã tải lên quá nhiều video trong một giờ.');
    // đang ghi file vào output/<slug>/video: không cho xoá kế hoạch (chuyển thư mục vào thùng rác) cho tới khi xong
    const uploadDone = ctx.beginProjectUpload(p.id);
    let tmp: string | null = null;
    try {
      const maxMb = Math.round(ctx.config.lanVideoMaxBytes / 1024 / 1024);
      const up = await streamVideoToDisk(req, {
        tmpDir: path.join(ctx.config.rootDir, 'output', p.slug, 'video'),
        maxBytes: ctx.config.lanVideoMaxBytes,
        tooLargeMessage: `Video vượt quá ${maxMb} MB`,
      });
      tmp = up.tmpAbs;
      const probe = assertVideoProbe(await probeUploadedVideo(ctx.config, up.tmpAbs), { min: LAN_VIDEO_MIN_S, max: LAN_VIDEO_MAX_S });
      const asset = addLanVideo(ctx, p, sceneId, { tmpAbs: up.tmpAbs, bytes: up.bytes, originalName: up.originalName, probe });
      L.uploadVideo.record(ip); // mỗi lần tải THÀNH CÔNG tính một lượt (lỗi kiểm tra không tính)
      return reply.code(201).send({
        video: lanVideoJson(asset, asset.id),
        videos: sceneVideosJson(ctx, getScene(ctx, sceneId)),
        rate: { upload_video_remaining: remaining(L.uploadVideo, ip) },
      });
    } finally {
      uploadDone();
      release();
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  });

  // Chọn lại video khác của cảnh (chỉ trong các video đã tải lên)
  app.post('/lan/api/plans/:id/scenes/:sceneId/video/select', async (req) => {
    const p = lanProject(ctx, planId(req));
    const sceneId = intParam((req.params as { sceneId: string }).sceneId, 'sceneId');
    const body = parse(z.object({ asset_id: z.number().int().positive() }), req.body ?? {});
    const video = selectLanVideo(ctx, p, sceneId, body.asset_id);
    return { video, videos: sceneVideosJson(ctx, getScene(ctx, sceneId)) };
  });

  // ---- Bản hoàn chỉnh ----
  app.get('/lan/api/plans/:id/final-cuts', async (req) => listLanFinalCuts(ctx, lanProject(ctx, planId(req))));

  app.get('/lan/api/plans/:id/final-cuts/:cutId', async (req) => {
    const p = lanProject(ctx, planId(req));
    return lanFinalCutJson(ctx, lanFinalCutRow(ctx, p, cutId(req)));
  });

  // Dựng bản mới: version kế tiếp + job edit_plan (AI chọn điểm cắt) → server render → xoá logo. Không tự chạy khi upload.
  app.post('/lan/api/plans/:id/final-cuts', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const lim = L.createFinal.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được dựng hoặc render lại tối đa ${L.createFinal.max} lần mỗi giờ.`, lim.retryAfterMs);
    const { cutId: id } = createLanFinalCut(ctx, p);
    L.createFinal.record(ip);
    return reply.code(201).send({ final_cut: lanFinalCutJson(ctx, lanFinalCutRow(ctx, p, id)), rate: { create_final_remaining: remaining(L.createFinal, ip) } });
  });

  // Render lại với điểm cắt người dùng sửa (version mới; không qua worker, không tốn credit). Dùng chung hạn mức với "dựng".
  app.post('/lan/api/plans/:id/final-cuts/:cutId/rerender', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const src = lanFinalCutRow(ctx, p, cutId(req));
    const body = parse(rerenderBody, req.body ?? {});
    const lim = L.createFinal.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được dựng hoặc render lại tối đa ${L.createFinal.max} lần mỗi giờ.`, lim.retryAfterMs);
    const id = rerenderLanFinalCut(ctx, p, src.id, { edl: body.edl, note: body.note });
    L.createFinal.record(ip);
    return reply.code(201).send({ final_cut: lanFinalCutJson(ctx, lanFinalCutRow(ctx, p, id)), rate: { create_final_remaining: remaining(L.createFinal, ip) } });
  });

  app.post('/lan/api/plans/:id/final-cuts/:cutId/cancel', async (req) => {
    const p = lanProject(ctx, planId(req));
    const row = cancelLanFinalCut(ctx, p, cutId(req));
    return { final_cut: lanFinalCutJson(ctx, row) };
  });

  // Góp ý cho AI: phiên bản mới (parent_id = bản đang xem) + job edit_plan; bản cũ được giữ. 20 lần/giờ/IP, tính vào trần hàng đợi LAN.
  app.post('/lan/api/plans/:id/final-cuts/:cutId/feedback', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const src = lanFinalCutRow(ctx, p, cutId(req));
    const body = parse(feedbackBody, req.body ?? {});
    const lim = L.feedback.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được gửi tối đa ${L.feedback.max} góp ý mỗi giờ.`, lim.retryAfterMs);
    const { cutId: id } = createLanFeedback(ctx, p, src.id, body.feedback, lanWm(await ctx.finalRender?.watermarkStatus()));
    L.feedback.record(ip);
    return reply.code(201).send({ final_cut: lanFinalCutJson(ctx, lanFinalCutRow(ctx, p, id)), rate: { feedback_remaining: remaining(L.feedback, ip) } });
  });

  // Chỉnh màu tay: phiên bản mới chỉ chạy bước chỉnh màu (không AI). 30 lần/giờ/IP, tính vào trần hàng đợi LAN.
  app.post('/lan/api/plans/:id/final-cuts/:cutId/grade', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const src = lanFinalCutRow(ctx, p, cutId(req));
    const body = parse(gradeBody, req.body ?? {});
    const lim = L.grade.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được chỉnh màu tối đa ${L.grade.max} lần mỗi giờ.`, lim.retryAfterMs);
    const id = createLanGrade(ctx, p, src.id, body.grade, body.note, lanWm(await ctx.finalRender?.watermarkStatus()));
    L.grade.record(ip);
    return reply.code(201).send({ final_cut: lanFinalCutJson(ctx, lanFinalCutRow(ctx, p, id)), rate: { grade_remaining: remaining(L.grade, ip) } });
  });

  // Ảnh xem trước trước/sau (3 mốc thời gian). 60 lần/giờ/IP.
  app.post('/lan/api/plans/:id/final-cuts/:cutId/grade-preview', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const src = lanFinalCutRow(ctx, p, cutId(req));
    const body = parse(z.object({ grade: z.unknown() }), req.body ?? {});
    const lim = L.gradePreview.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được xem trước màu tối đa ${L.gradePreview.max} lần mỗi giờ.`, lim.retryAfterMs);
    const r = await lanGradePreview(ctx, p, src.id, body.grade);
    L.gradePreview.record(ip);
    return { ...r, rate: { grade_preview_remaining: remaining(L.gradePreview, ip) } };
  });

  // Thử chỉnh màu lại (bản lỗi/hủy giữa bước chỉnh màu). Dùng chung hạn mức chỉnh màu.
  app.post('/lan/api/plans/:id/final-cuts/:cutId/regrade', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const src = lanFinalCutRow(ctx, p, cutId(req));
    const lim = L.grade.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được chỉnh màu tối đa ${L.grade.max} lần mỗi giờ.`, lim.retryAfterMs);
    const row = regradeLanFinalCut(ctx, p, src.id);
    L.grade.record(ip);
    return { final_cut: lanFinalCutJson(ctx, row), rate: { grade_remaining: remaining(L.grade, ip) } };
  });

  // Xoá logo lại (riêng bước clean): khi lỗi ở bước xoá logo, hoặc bản `ready` còn logo. Tính vào hạn mức "xoá logo" (6/giờ).
  app.post('/lan/api/plans/:id/final-cuts/:cutId/clean', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const src = lanFinalCutRow(ctx, p, cutId(req));
    const lim = L.removeLogo.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được xoá logo tối đa ${L.removeLogo.max} lần mỗi giờ.`, lim.retryAfterMs);
    const wm = await ctx.finalRender!.watermarkStatus();
    const row = cleanLanFinalCut(ctx, p, src.id, wm);
    L.removeLogo.record(ip);
    return { final_cut: lanFinalCutJson(ctx, row), rate: { remove_logo_remaining: remaining(L.removeLogo, ip) } };
  });
}
