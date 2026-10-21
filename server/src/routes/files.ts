import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context.js';
import { AppError, notFound } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';

const FILE_PREFIXES = ['output', 'refs'];

/**
 * `GET /files/<đường dẫn tương đối>`: chỉ cho phép prefix output/ và refs/, chặn `..`, đường dẫn tuyệt đối,
 * symlink trỏ ra ngoài. Hỗ trợ Range (tua video) nhờ @fastify/static (send).
 * Production: phục vụ thêm web/dist với SPA fallback.
 */
export async function registerFileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const root = ctx.config.rootDir;
  await app.register(fastifyStatic, { root, serve: false, acceptRanges: true });

  // Handler đồng bộ (không async/return reply): tránh cảnh báo MaxListeners khi sendFile trả về reply.
  app.get('/files/*', (req, reply) => {
    const raw = (req.params as { '*': string })['*'];
    let rel: string;
    try {
      rel = cleanRelPath(raw, FILE_PREFIXES);
    } catch {
      throw notFound('file');
    }
    if (!resolveInside(root, rel, FILE_PREFIXES)) throw notFound('file');
    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    void reply.sendFile(rel, root, { cacheControl: false });
  });

  const dist = ctx.config.webDistDir;
  const hasDist = !!dist && fs.existsSync(path.join(dist, 'index.html'));
  if (hasDist) {
    await app.register(fastifyStatic, { root: dist!, prefix: '/', decorateReply: false, index: ['index.html'] });
  }
  // 404 chung (JSON); khi có web/dist thì GET trang HTML lạ trả về index.html (SPA fallback).
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0]!;
    if (hasDist && req.method === 'GET' && !url.startsWith('/api/') && !url.startsWith('/files/') && (req.headers.accept ?? '').includes('text/html')) {
      reply.header('Cache-Control', 'no-cache');
      void reply.sendFile('index.html', dist!);
      return;
    }
    throw new AppError('NOT_FOUND', 'Không tìm thấy đường dẫn', 404);
  });
}
