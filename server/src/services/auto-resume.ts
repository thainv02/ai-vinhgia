import type { AppContext } from '../context.js';
import type { JobRow, SceneRow } from '../db/types.js';
import { approveStoryboard, approveVideo } from './approvals.js';
import { generatorIdOfPayload } from './generators.js';
import { logEvent, parseJson } from './repo.js';
import { activeJobOf } from './rules.js';
import { getWorkerRow, resumeQueue } from './worker.js';

/** Mã tạm dừng mà worker được tự bật lại (lỗi phiên/tài khoản dịch vụ; extension của chủ máy tự đồng bộ lại cookie). */
export const AUTO_RESUME_CODES = ['LOGIN_REQUIRED'];

/**
 * Worker tự bật lại hàng đợi sau khi kiểm tra dịch vụ đã có tài khoản dùng được. Chỉ khi hàng đợi đang dừng với mã trong AUTO_RESUME_CODES
 * (dừng tay, CAPTCHA, hết credit... vẫn chờ chủ máy). Rồi tạo lại job storyboard/video đã lỗi với `result.retryable` (lỗi trước khi dịch vụ nhận
 * lệnh tạo, chưa tốn credit/lượt) nếu đó là job mới nhất của cảnh, cảnh vẫn `failed` và không có job khác. Video giữ đúng dịch vụ đã chọn.
 */
export function autoResumeQueue(ctx: AppContext, workerId: string | null) {
  return ctx.tx(() => {
    const ws = getWorkerRow(ctx);
    if (!ws.queue_paused || !AUTO_RESUME_CODES.includes(ws.pause_code ?? '')) return { resumed: false, requeued: [] as number[] };
    resumeQueue(ctx);
    const failed = ctx.db
      .prepare(
        `SELECT j.* FROM jobs j JOIN projects p ON p.id = j.project_id
         WHERE j.status = 'failed' AND j.type IN ('storyboard','video') AND p.deleted_at IS NULL
           AND json_valid(j.result) AND json_extract(j.result, '$.retryable') = 1 AND json_extract(j.result, '$.retried_by') IS NULL
           AND j.id = (SELECT MAX(id) FROM jobs WHERE scene_id = j.scene_id)
         ORDER BY j.id`,
      )
      .all() as JobRow[];
    const requeued: number[] = [];
    for (const job of failed) {
      const scene = ctx.db.prepare('SELECT * FROM scenes WHERE id = ?').get(job.scene_id) as SceneRow | undefined;
      if (!scene || scene.status !== 'failed' || activeJobOf(ctx, scene.id)) continue;
      try {
        const r = job.type === 'video' ? approveVideo(ctx, scene.id, generatorIdOfPayload(job.payload)) : approveStoryboard(ctx, scene.id);
        const result = parseJson<Record<string, unknown>>(job.result, {});
        ctx.db.prepare('UPDATE jobs SET result = ? WHERE id = ?').run(JSON.stringify({ ...result, retried_by: r.jobId }), job.id);
        logEvent(ctx, { project_id: job.project_id, scene_id: scene.id, type: 'job.retried', message: `${scene.code}: worker ${workerId ?? ''} tự tạo lại job #${job.id} (${job.type}) thành #${r.jobId} sau khi dịch vụ dùng lại được` });
        requeued.push(r.jobId);
      } catch {
        /* cảnh không còn đủ điều kiện (hết lượt, đổi trạng thái...): để người dùng xử lý */
      }
    }
    return { resumed: true, requeued };
  });
}
