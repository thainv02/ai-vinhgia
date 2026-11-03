/** Cài đặt bộ dựng Video HTML (chỉ bản desktop): trạng thái + tải/hủy trình duyệt dựng (không bao giờ tự tải). */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { cancelRendererDownload, rendererStatus, startRendererDownload } from '../services/html/engine/index.js';

export function registerLanHtmlRendererRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/lan/api/settings/html-renderer', async () => rendererStatus(ctx));
  app.post('/lan/api/settings/html-renderer/download', async () => {
    if (!rendererStatus(ctx).installed) void startRendererDownload(ctx);
    return rendererStatus(ctx);
  });
  app.post('/lan/api/settings/html-renderer/download/cancel', async () => {
    cancelRendererDownload(ctx);
    return rendererStatus(ctx);
  });
}
