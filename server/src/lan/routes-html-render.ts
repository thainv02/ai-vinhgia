import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { intParam, parse } from '../lib/validate.js';
import { getHtmlProject, getVersionById } from '../services/html/repo.js';
import { cancelRender, createRender, getProjectRender, listRenders, renderView, retryRender, revealFile } from '../services/html/render.js';

const idem = z.string().trim().min(8, 'idempotency_key tối thiểu 8 ký tự').max(100).regex(/^[\w.:-]+$/, 'idempotency_key chỉ gồm chữ, số, . _ : -');
const createBody = z.object({ quality: z.enum(['720p', '1080p']), idempotency_key: idem });
const retryBody = z.object({ idempotency_key: idem });

/**
 * Dựng MP4 Video HTML (CHỈ bản desktop; dự án `kind='html'`): tạo/liệt kê/hủy/thử lại bản dựng, phát video (Range), tải xuống, poster, mở Explorer.
 * Không đăng ký trên listener LAN thật (`desktop=false` → 404).
 */
export function registerLanHtmlRenderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const P = '/lan/api/html-projects';
  const pid = (req: FastifyRequest) => intParam((req.params as { id: string }).id);
  const rid = (req: FastifyRequest) => intParam((req.params as { rid: string }).rid, 'rid');

  app.post(`${P}/:id/versions/:v/renders`, async (req, reply) => {
    const body = parse(createBody, req.body ?? {});
    const r = await createRender(ctx, { projectId: pid(req), version: intParam((req.params as { v: string }).v, 'v'), quality: body.quality, idempotencyKey: body.idempotency_key });
    return reply.code(r.created ? 201 : 200).send(renderView(ctx, r.render));
  });

  app.get(`${P}/:id/renders`, async (req) => listRenders(ctx, pid(req)));
  app.get(`${P}/:id/renders/:rid`, async (req) => {
    getHtmlProject(ctx, pid(req));
    return renderView(ctx, getProjectRender(ctx, pid(req), rid(req)));
  });

  app.post(`${P}/:id/renders/:rid/cancel`, async (req) => {
    getHtmlProject(ctx, pid(req));
    return renderView(ctx, cancelRender(ctx, pid(req), rid(req)));
  });

  app.post(`${P}/:id/renders/:rid/retry`, async (req, reply) => {
    getHtmlProject(ctx, pid(req));
    const body = parse(retryBody, req.body ?? {});
    const r = await retryRender(ctx, pid(req), rid(req), body.idempotency_key);
    return reply.code(r.created ? 201 : 200).send(renderView(ctx, r.render));
  });

  /** File đã dựng xong (ready) của bản dựng thuộc dự án; đường dẫn lấy từ DB và phải nằm đúng thư mục `output/<slug>/html/renders/<id>/`. */
  const fileOf = (req: FastifyRequest, kind: 'video' | 'poster') => {
    const project = getHtmlProject(ctx, pid(req));
    const r = getProjectRender(ctx, project.id, rid(req));
    const rel = kind === 'video' ? r.video_path : r.poster_path;
    const expectedPrefix = `output/${project.slug}/html/renders/${r.id}/`;
    if (r.status !== 'ready' || !rel || !rel.startsWith(expectedPrefix) || rel.includes('..') || !fs.existsSync(path.join(ctx.config.rootDir, rel))) throw notFound(kind === 'video' ? 'video' : 'ảnh poster');
    return { project, r, rel };
  };

  // Range (tua video) nhờ @fastify/static (`sendFile`, acceptRanges). `?download=1` → tải xuống với tên `<slug>-v<n>-<quality>.mp4`.
  app.get(`${P}/:id/renders/:rid/video`, (req, reply) => {
    const { project, r, rel } = fileOf(req, 'video');
    if ((req.query as { download?: string }).download === '1') {
      const v = getVersionById(ctx, r.version_id);
      reply.header('Content-Disposition', `attachment; filename="${project.slug}-v${v.version}-${r.quality}.mp4"`);
    }
    reply.header('Content-Type', 'video/mp4').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-cache');
    void reply.sendFile(rel, ctx.config.rootDir, { cacheControl: false });
  });

  app.get(`${P}/:id/renders/:rid/poster`, (req, reply) => {
    const { rel } = fileOf(req, 'poster');
    reply.header('Content-Type', 'image/jpeg').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-cache');
    void reply.sendFile(rel, ctx.config.rootDir, { cacheControl: false });
  });

  // Mở Explorer chọn sẵn file (desktop: server chạy trên máy người dùng). Đường dẫn do server dựng, không nhận từ client.
  app.post(`${P}/:id/renders/:rid/reveal`, async (req) => {
    const { rel } = fileOf(req, 'video');
    revealFile(path.join(ctx.config.rootDir, ...rel.split('/')));
    return { ok: true };
  });

}
