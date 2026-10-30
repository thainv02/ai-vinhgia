import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';

/**
 * Trần hàng đợi TOÀN CỤC cho việc từ LAN: bản dựng của dự án `lan` (đang chờ AI chọn điểm cắt hoặc đang render/xoá logo)
 * cộng việc công cụ (`lan_tool_jobs`) đang chờ hoặc chạy. Chạm trần → 429 "Hàng đợi đang đầy, thử lại sau".
 * Việc của app chính không tính vào trần (chủ máy không bị chặn bởi LAN).
 */
export const LAN_QUEUE_CAP = 6;

export interface LanQueueLoad {
  cuts: number;
  tools: number;
  /** Việc cắt clip từ LAN: nhận dạng lời nói đang chờ/chạy, job AI chọn đoạn đang chờ/chạy, bản dựng clip đang dựng. */
  clips: number;
  total: number;
  cap: number;
}

export function lanQueueLoad(ctx: AppContext): LanQueueLoad {
  const cuts = (
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM final_cuts f JOIN projects p ON p.id = f.project_id WHERE p.source = 'lan' AND p.deleted_at IS NULL AND f.status IN ('planning','rendering')")
      .get() as { n: number }
  ).n;
  const tools = (ctx.db.prepare("SELECT COUNT(*) AS n FROM lan_tool_jobs WHERE status IN ('queued','processing')").get() as { n: number }).n;
  const clips = clipQueueLoad(ctx);
  return { cuts, tools, clips, total: cuts + tools + clips, cap: LAN_QUEUE_CAP };
}

function clipQueueLoad(ctx: AppContext): number {
  const one = (sql: string): number => (ctx.db.prepare(sql).get() as { n: number }).n;
  const lanProj = "p.source = 'lan' AND p.deleted_at IS NULL AND p.kind = 'clips'";
  return (
    one(`SELECT COUNT(*) AS n FROM source_videos s JOIN projects p ON p.id = s.project_id WHERE ${lanProj} AND s.status = 'transcribing'`) +
    one(`SELECT COUNT(*) AS n FROM jobs j JOIN projects p ON p.id = j.project_id WHERE ${lanProj} AND j.type = 'clip_plan' AND j.status IN ('queued','claimed','running')`) +
    one(`SELECT COUNT(*) AS n FROM clip_cuts c JOIN projects p ON p.id = c.project_id WHERE ${lanProj} AND c.status = 'rendering'`)
  );
}

export const queueFull = (): AppError => new AppError('QUEUE_FULL', 'Hàng đợi đang đầy, thử lại sau', 429, { retry_after_s: 60 });

/** Ném 429 nếu hàng đợi LAN đã đủ LAN_QUEUE_CAP việc. Gọi trong cùng transaction với lúc tạo việc để không vượt trần khi chạy song song. */
export function assertLanQueueRoom(ctx: AppContext): void {
  if (lanQueueLoad(ctx).total >= LAN_QUEUE_CAP) throw queueFull();
}
