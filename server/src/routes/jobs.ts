import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { intParam, optionalIntParam, parse } from '../lib/validate.js';
import { JOB_STATUSES, JOB_TYPES, SCENE_STATUSES, SCENE_STATUS_LABEL, VERDICTS, VERDICT_LABEL, COMMENT_ACTIONS, FAIL_CODES } from '../db/types.js';
import { clipLimits } from '../services/clips/lan.js';
import { cancelJob } from '../services/jobs.js';
import { reconcileBody, reconcileJob } from '../services/reconcile.js';
import { getJobJson, getJobRow, listJobsJson } from '../services/repo.js';
import { sceneSummaryById } from '../services/scene-view.js';
import { pauseQueue, resumeQueue, workerStatus } from '../services/worker.js';

const csv = (v: string | undefined, allowed: readonly string[], name: string): string[] | undefined => {
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.find((p) => !allowed.includes(p));
  if (bad) throw badRequest('VALIDATION_ERROR', `Giá trị ${name} không hợp lệ: ${bad}`);
  return parts;
};

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/jobs', async (req) => {
    const q = req.query as { projectId?: string; status?: string; type?: string; limit?: string };
    return listJobsJson(ctx, {
      projectId: optionalIntParam(q.projectId, 'projectId'),
      statuses: csv(q.status, JOB_STATUSES, 'status'),
      types: csv(q.type, JOB_TYPES, 'type'),
      limit: Math.min(optionalIntParam(q.limit, 'limit') ?? 200, 1000),
    });
  });

  app.get('/api/jobs/:id', async (req) => getJobJson(ctx, intParam((req.params as { id: string }).id)));

  app.post('/api/jobs/:id/cancel', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const row = getJobRow(ctx, id);
    cancelJob(ctx, id);
    return { job: getJobJson(ctx, id), scene: row.scene_id ? sceneSummaryById(ctx, row.scene_id) : null };
  });

  // Đối soát job managed có thao tác tạo bên ngoài chưa rõ kết quả: { outcome: retry_download|nothing_created|charge_and_fail, note? }.
  app.post('/api/jobs/:id/reconcile', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const body = parse(reconcileBody, req.body ?? {});
    const row = getJobRow(ctx, id);
    const { replay } = reconcileJob(ctx, id, body);
    return { job: getJobJson(ctx, id), scene: row.scene_id ? sceneSummaryById(ctx, row.scene_id) : null, replay };
  });

  // ---- hàng đợi / worker (cho web, không cần token) ----
  app.get('/api/worker/status', async () => ({ ...workerStatus(ctx), server_time: ctx.now() }));

  app.post('/api/queue/resume', async () => {
    resumeQueue(ctx);
    return workerStatus(ctx);
  });

  app.post('/api/queue/pause', async (req) => {
    const body = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    // pauseQueue ghi event theo dự án; không biết dự án nào nên chỉ cập nhật trạng thái.
    pauseQueue(ctx, 'MANUAL', body.reason?.trim() || 'Người dùng tạm dừng hàng đợi');
    return workerStatus(ctx);
  });

  app.get('/api/meta', async () => ({
    final_renderer: await ctx.finalRender!.status(),
    watermark_remover: await ctx.finalRender!.watermarkStatus(),
    /** Cắt clip từ video dài: giới hạn video nguồn, nhận dạng lời nói và phụ đề có sẵn không (xem GET /api/clip-status). */
    clips: clipLimits(ctx, false),
    config: {
      max_concurrent_video_jobs: ctx.config.maxConcurrentVideoJobs,
      require_prompt_approval: ctx.config.requirePromptApproval,
      heartbeat_stale_minutes: ctx.config.heartbeatStaleMinutes,
      worker_online_seconds: ctx.config.workerOnlineSeconds,
      max_upload_bytes: ctx.config.maxUploadBytes,
    },
    scene_statuses: SCENE_STATUSES.map((value) => ({ value, label: SCENE_STATUS_LABEL[value] })),
    job_types: JOB_TYPES,
    job_statuses: JOB_STATUSES,
    verdicts: VERDICTS.map((value) => ({ value, label: VERDICT_LABEL[value] })),
    comment_actions: COMMENT_ACTIONS,
    fail_codes: FAIL_CODES,
  }));

  app.get('/api/health', async () => ({ ok: true, time: ctx.now() }));
}
