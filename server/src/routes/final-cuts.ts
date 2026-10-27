import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { conflict } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { intParam, parse } from '../lib/validate.js';
import {
  cancelFinalCut,
  cleanFinalCut,
  createFinalCutManual,
  getFinalCutJson,
  getFinalCutRow,
  listFinalCuts,
  rerenderBody,
  rerenderFinalCut,
} from '../services/final-cuts.js';
import { createFeedbackRevision, createGradeRevision, feedbackBody, gradeBody, regradeFinalCut } from '../services/final-revisions.js';
import { gradePreview } from '../services/final-render/grade-preview.js';
import { fileUrl, getJobJson, getProject } from '../services/repo.js';

/** Trạng thái tool xoá logo (không có dịch vụ render, vd một số test → coi như tắt). */
export const watermarkOf = async (ctx: AppContext): Promise<{ active: boolean }> => (ctx.finalRender ? await ctx.finalRender.watermarkStatus() : { active: false });

/** Bản dựng hoàn chỉnh (final cut): xem docs mục "Bản dựng hoàn chỉnh" trong server/API.md. */
export function registerFinalCutRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects/:id/final-cuts', async (req) => listFinalCuts(ctx, intParam((req.params as { id: string }).id)));

  app.post('/api/projects/:id/final-cuts', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    getProject(ctx, id);
    const { cutId, jobId } = createFinalCutManual(ctx, id);
    return reply.code(201).send({ final_cut: getFinalCutJson(ctx, cutId), job: getJobJson(ctx, jobId) });
  });

  app.get('/api/final-cuts/:id', async (req) => getFinalCutJson(ctx, intParam((req.params as { id: string }).id)));

  app.post('/api/final-cuts/:id/rerender', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    getFinalCutRow(ctx, id);
    const body = parse(rerenderBody, req.body ?? {});
    const newId = rerenderFinalCut(ctx, id, { edl: body.edl, note: body.note });
    return reply.code(201).send({ final_cut: getFinalCutJson(ctx, newId) });
  });

  // Góp ý cho AI: phiên bản MỚI (parent_id = bản đang xem) + job edit_plan mang payload.revision. Bản cũ được giữ nguyên.
  app.post('/api/final-cuts/:id/feedback', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    getFinalCutRow(ctx, id);
    const body = parse(feedbackBody, req.body ?? {});
    const { cutId, jobId } = createFeedbackRevision(ctx, id, body.feedback, await watermarkOf(ctx));
    return reply.code(201).send({ final_cut: getFinalCutJson(ctx, cutId), job: getJobJson(ctx, jobId) });
  });

  // Chỉnh màu tay (không AI, không tốn credit): phiên bản mới chỉ chạy bước chỉnh màu trên bản sạch.
  app.post('/api/final-cuts/:id/grade', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    getFinalCutRow(ctx, id);
    const body = parse(gradeBody, req.body ?? {});
    const newId = createGradeRevision(ctx, id, body.grade, body.note, await watermarkOf(ctx));
    return reply.code(201).send({ final_cut: getFinalCutJson(ctx, newId) });
  });

  // Ảnh trước/sau ở 3 mốc thời gian (một khung ffmpeg từ bản sạch, cache theo hash grade)
  app.post('/api/final-cuts/:id/grade-preview', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(z.object({ grade: z.unknown() }), req.body ?? {});
    const r = await gradePreview(ctx, id, body.grade);
    return { hash: r.hash, items: r.items.map((i) => ({ t: i.t, before_url: fileUrl(i.before), after_url: fileUrl(i.after) })) };
  });

  // Chạy lại RIÊNG bước chỉnh màu của bản lỗi/hủy giữa bước chỉnh màu
  app.post('/api/final-cuts/:id/regrade', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    getFinalCutRow(ctx, id);
    regradeFinalCut(ctx, id);
    return { final_cut: getFinalCutJson(ctx, id) };
  });

  app.post('/api/final-cuts/:id/cancel', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    cancelFinalCut(ctx, id);
    return { final_cut: getFinalCutJson(ctx, id) };
  });

  // Chạy lại RIÊNG bước xoá logo Veo (không render lại, không tốn credit)
  app.post('/api/final-cuts/:id/clean', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    getFinalCutRow(ctx, id);
    const wm = await ctx.finalRender!.watermarkStatus();
    cleanFinalCut(ctx, id, wm);
    return { final_cut: getFinalCutJson(ctx, id) };
  });

  app.post('/api/final-cuts/:id/open-in-shotcut', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const cut = getFinalCutRow(ctx, id);
    if (!cut.project_file_path) {
      throw conflict('NO_PROJECT_FILE', `Bản hoàn chỉnh v${cut.version} không có file dự án Shotcut (.mlt) — chỉ bản dựng bằng Shotcut mới có`);
    }
    let abs: string | null = null;
    try {
      abs = resolveInside(ctx.config.rootDir, cleanRelPath(cut.project_file_path, ['output']), ['output']);
    } catch {
      abs = null;
    }
    if (!abs || !fs.existsSync(abs)) throw conflict('NO_PROJECT_FILE', `File dự án ${path.basename(cut.project_file_path)} không còn tồn tại`);
    try {
      await ctx.finalRender!.openInShotcut(abs);
    } catch (err) {
      throw conflict('SHOTCUT_UNAVAILABLE', `Không mở được Shotcut: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, project_file_path: cut.project_file_path };
  });
}
