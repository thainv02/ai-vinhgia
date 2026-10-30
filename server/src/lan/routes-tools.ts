import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { intParam } from '../lib/validate.js';
import { streamVideoToDisk } from '../lib/video-upload.js';
import { lanWatermarkInfo } from '../services/lan-final.js';
import { assertLanQueueRoom, lanQueueLoad } from '../services/lan-queue.js';
import {
  TOOL_MAX_S,
  TOOL_MIN_S,
  TOOL_RETENTION_DAYS,
  cancelToolJob,
  checkToolProbe,
  createToolJob,
  getOwnedToolJob,
  listToolJobs,
  retryToolJob,
  toolIncomingDir,
  toolJobJson,
} from '../services/lan-tools.js';
import { probeUploadedVideo } from '../services/media.js';
import { ensureClientHash } from './client-id.js';
import { LAN_RATE, beginUpload, tooMany, type LanLimiters } from './limits.js';
import { lanIp } from './security.js';

const NAME_MAX = 60;

/**
 * Công cụ độc lập "Xoá logo Veo" (CHỈ trên listener LAN). Mọi route cần phiên LAN (hook bảo mật) VÀ chỉ thấy/đụng việc của chính trình duyệt
 * này (cookie client). Upload stream xuống `output/lan-tools/.incoming/`; việc chạy qua hàng đợi render chung, mỗi lúc một việc.
 */
export function registerLanToolRoutes(app: FastifyInstance, ctx: AppContext, L: LanLimiters): void {
  const jobId = (req: FastifyRequest) => intParam((req.params as { id: string }).id);
  const watermark = async () => lanWatermarkInfo(await ctx.finalRender!.watermarkStatus());
  const unavailable = (reason: string) => new AppError('WATERMARK_REMOVER_UNAVAILABLE', `Không xoá logo Veo được: ${reason}`, 409);
  const remaining = (ip: string) => Math.max(0, L.removeLogo.check(ip).remaining - L.gate.inflight(ip));

  app.get('/lan/api/tools/status', async (req) => {
    const wm = await watermark();
    return {
      remove_logo: {
        available: wm.active,
        reason: wm.active ? null : wm.reason,
        max_bytes: ctx.config.lanVideoMaxBytes,
        min_s: TOOL_MIN_S,
        max_s: TOOL_MAX_S,
        remaining: remaining(lanIp(req)),
        rate: LAN_RATE.removeLogo,
      },
      queue: lanQueueLoad(ctx),
      render: ctx.finalRender?.summary() ?? null,
      retention_days: TOOL_RETENTION_DAYS,
    };
  });

  // Việc của CHÍNH trình duyệt này (mới nhất trước)
  app.get('/lan/api/tools/jobs', async (req, reply) => listToolJobs(ctx, ensureClientHash(req, reply)));

  app.get('/lan/api/tools/jobs/:id', async (req, reply) => toolJobJson(ctx, getOwnedToolJob(ctx, jobId(req), ensureClientHash(req, reply))));

  // Tải video lên và xếp vào hàng đợi (multipart: trường `created_by_name` tùy chọn + một `file`; stream xuống đĩa)
  app.post('/lan/api/tools/jobs', async (req, reply) => {
    const ip = lanIp(req);
    const hash = ensureClientHash(req, reply);
    const wm = await watermark();
    if (!wm.active) throw unavailable(wm.reason);
    assertLanQueueRoom(ctx); // đầy: báo ngay, không nhận file
    const release = beginUpload(reply, L, L.removeLogo, ip, `Mỗi người chỉ được xoá logo tối đa ${L.removeLogo.max} lần mỗi giờ.`);
    let tmp: string | null = null;
    try {
      const maxMb = Math.round(ctx.config.lanVideoMaxBytes / 1024 / 1024);
      const up = await streamVideoToDisk(req, {
        tmpDir: toolIncomingDir(ctx.config.rootDir),
        maxBytes: ctx.config.lanVideoMaxBytes,
        fieldNames: ['created_by_name'],
        tooLargeMessage: `Video vượt quá ${maxMb} MB`,
      });
      tmp = up.tmpAbs;
      const probe = checkToolProbe(await probeUploadedVideo(ctx.config, up.tmpAbs));
      const row = createToolJob(ctx, { clientHash: hash, createdByName: (up.fields.created_by_name ?? '').slice(0, NAME_MAX), originalName: up.originalName, tmpAbs: up.tmpAbs, bytes: up.bytes, probe });
      tmp = null; // đã đổi tên vào thư mục của việc
      L.removeLogo.record(ip);
      return reply.code(201).send({ job: toolJobJson(ctx, row), rate: { remove_logo_remaining: remaining(ip) } });
    } finally {
      release();
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  });

  app.post('/lan/api/tools/jobs/:id/cancel', async (req, reply) => {
    const row = cancelToolJob(ctx, jobId(req), ensureClientHash(req, reply));
    return { job: toolJobJson(ctx, row) };
  });

  // Thử lại việc lỗi/đã hủy (giữ input); tính vào hạn mức xoá logo
  app.post('/lan/api/tools/jobs/:id/retry', async (req, reply) => {
    const ip = lanIp(req);
    const hash = ensureClientHash(req, reply);
    const id = jobId(req);
    getOwnedToolJob(ctx, id, hash); // 404 trước nếu không phải việc của mình
    const lim = L.removeLogo.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được xoá logo tối đa ${L.removeLogo.max} lần mỗi giờ.`, lim.retryAfterMs);
    const wm = await watermark();
    if (!wm.active) throw unavailable(wm.reason);
    const row = retryToolJob(ctx, id, hash);
    L.removeLogo.record(ip);
    return { job: toolJobJson(ctx, row), rate: { remove_logo_remaining: remaining(ip) } };
  });
}
