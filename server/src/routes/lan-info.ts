import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { lanQueueLoad } from '../services/lan-queue.js';
import { toolJobsLast24h } from '../services/lan-tools.js';

/** Địa chỉ IPv4 không loopback của máy (để đồng nghiệp mở trang planner). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/**
 * `GET /api/lan` (CHỈ app chính, localhost): trạng thái chia sẻ qua LAN cho khối "Chia sẻ qua LAN" trên web.
 * Chỉ báo cáo cấu hình; bật/tắt bằng .env + khởi động lại, API này không sửa gì. Trả mã truy cập (bí mật) chỉ khi `LAN_REQUIRE_CODE=true`, vì app chính
 * chỉ phục vụ localhost (kiểm tra Host/Origin); listener LAN không có route này.
 */
export function registerLanInfoRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/lan', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const c = ctx.config;
    const wildcard = c.lanHost === '0.0.0.0' || c.lanHost === '::';
    const hosts = wildcard ? lanAddresses() : [c.lanHost];
    return {
      enabled: c.lanEnabled,
      listening: c.lanEnabled && !!ctx.lan?.listening,
      error: ctx.lan?.error ?? null,
      host: c.lanHost,
      port: c.lanPort,
      urls: c.lanEnabled ? hosts.map((h) => `http://${h}:${c.lanPort}`) : [],
      /** Trang planner có đòi mã truy cập không (`LAN_REQUIRE_CODE`, mặc định `false`). */
      require_code: c.lanRequireCode,
      /** Mã truy cập: CHỈ khi `require_code`; mặc định không có mã nên luôn `null`. */
      access_code: c.lanEnabled && c.lanRequireCode && c.lanAccessCode ? c.lanAccessCode : null,
      plan_count: (ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE source = 'lan' AND kind = 'scenes' AND deleted_at IS NULL").get() as { n: number }).n,
      /** Dự án cắt clip tạo từ trang LAN. */
      clip_project_count: (ctx.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE source = 'lan' AND kind = 'clips' AND deleted_at IS NULL").get() as { n: number }).n,
      /** Việc xoá logo (công cụ độc lập) tạo trong 24 giờ qua. */
      tool_jobs_24h: toolJobsLast24h(ctx),
      /** Việc từ LAN đang trong hàng đợi (bản dựng chờ AI/đang render + việc công cụ) và trần toàn cục. */
      queue: lanQueueLoad(ctx),
      /** Hàng đợi render chung (bản dựng + xoá logo, của app và LAN): đang chạy / đang chờ / số việc chạy cùng lúc (`RENDER_CONCURRENCY`). */
      render: ctx.finalRender?.summary() ?? null,
    };
  });
}
