import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context.js';
import { AppError, notFound } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { isHiddenByTrash } from '../services/trash.js';

const FILE_PREFIXES = ['output', 'refs'];

/**
 * `GET /files/<đường dẫn tương đối>`: chỉ cho phép prefix output/ và refs/, chặn `..`, đường dẫn tuyệt đối,
 * symlink trỏ ra ngoài. Hỗ trợ Range (tua video) nhờ @fastify/static (send).
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
    if (isHiddenByTrash(ctx, rel) || !resolveInside(root, rel, FILE_PREFIXES)) throw notFound('file'); // dự án trong thùng rác: không phục vụ
    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    void reply.sendFile(rel, root, { cacheControl: false });
  });

  // 404 chung (JSON). API chính không phục vụ giao diện: giao diện nằm ở listener planner (src/lan/).
  app.setNotFoundHandler(() => {
    throw new AppError('NOT_FOUND', 'Không tìm thấy đường dẫn', 404);
  });
}
