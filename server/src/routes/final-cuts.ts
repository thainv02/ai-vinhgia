import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { intParam, parse } from '../lib/validate.js';
import {
  cancelFinalCut,
  cleanFinalCut,
  createFinalCutManual,
  currentSelection,
  getFinalCutJson,
  warmCutMedia,
  warmSourceMedia,
  getFinalCutRow,
  listFinalCuts,
  rerenderBody,
  rerenderFinalCut,
} from '../services/final-cuts.js';
import { getJobJson, getProject } from '../services/repo.js';

/** Bản dựng hoàn chỉnh (final cut): xem docs mục "Bản dựng hoàn chỉnh" trong server/API.md. */
export function registerFinalCutRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects/:id/final-cuts', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const rows = ctx.db.prepare('SELECT selection FROM final_cuts WHERE project_id = ?').all(id) as { selection: string }[];
    await Promise.all(rows.map((r) => warmCutMedia(ctx, r.selection)));
    return listFinalCuts(ctx, id);
  });

  app.post('/api/projects/:id/final-cuts', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    getProject(ctx, id);
    // làm nóng cache ffprobe để payload job edit_plan và validate EDL có thời lượng/fps của video đã chọn
    await warmSourceMedia(ctx, currentSelection(ctx, id).items.map((i) => i.asset_id));
    const { cutId, jobId } = createFinalCutManual(ctx, id);
    return reply.code(201).send({ final_cut: getFinalCutJson(ctx, cutId), job: getJobJson(ctx, jobId) });
  });

  app.get('/api/final-cuts/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    await warmCutMedia(ctx, getFinalCutRow(ctx, id).selection);
    return getFinalCutJson(ctx, id);
  });

  app.post('/api/final-cuts/:id/rerender', async (req, reply) => {
    const id = intParam((req.params as { id: string }).id);
    await warmCutMedia(ctx, getFinalCutRow(ctx, id).selection); // validate EDL cần thời lượng video nguồn
    const body = parse(rerenderBody, req.body ?? {});
    const newId = rerenderFinalCut(ctx, id, { edl: body.edl, note: body.note });
    return reply.code(201).send({ final_cut: getFinalCutJson(ctx, newId) });
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
}
