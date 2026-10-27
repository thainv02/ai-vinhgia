/**
 * Công cụ độc lập cho người dùng LAN: "Xoá logo Veo" cho một video tải lên bất kỳ (không cần kế hoạch). Mỗi việc là một dòng `lan_tool_jobs`
 * (migration 010), file nằm trong `output/lan-tools/<id>/` (input.<ext>, clean.mp4). Việc chạy qua CÙNG hàng đợi render một-việc-một-lúc
 * với bản dựng hoàn chỉnh (`FinalRenderService.enqueueTool`) và dùng đúng `runWatermarkCli` + `verifyCleaned` của bước clean hiện có.
 * Quyền xem/tải/hủy chỉ thuộc trình duyệt tạo việc (hash cookie client); việc của người khác trả 404 như không tồn tại.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../lib/errors.js';
import type { UploadedVideoProbe } from './media.js';
import { probeMedia } from './media.js';
import { runWatermarkCli, verifyCleaned } from './final-render/watermark.js';
import { RenderCancelled } from './final-render/types.js';
import { lanFileUrl, scrubForLan } from './lan-common.js';
import { assertLanQueueRoom } from './lan-queue.js';
import { assertVideoProbe } from './lan-video.js';
import { parseJson } from './repo.js';

export const TOOL_MIN_S = 1;
export const TOOL_MAX_S = 120;
export const TOOL_RETENTION_DAYS = 7;
const RETENTION_MS = TOOL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_LISTED = 30;
const STALE_TMP_MS = 60 * 60 * 1000;

export type ToolStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled' | 'expired';

export interface ToolJobRow {
  id: number;
  kind: 'remove_logo';
  status: ToolStatus;
  progress: number | null;
  input_path: string | null;
  output_path: string | null;
  original_name: string;
  client_id_hash: string;
  created_by_name: string | null;
  error: string | null;
  meta: string;
  created_at: string;
  finished_at: string | null;
}

const TOOLS_ROOT = 'output/lan-tools';
export const toolIncomingDir = (rootDir: string): string => path.join(rootDir, TOOLS_ROOT, '.incoming');
const toolDirRel = (id: number): string => `${TOOLS_ROOT}/${id}`;
const toolDirAbs = (ctx: AppContext, id: number): string => path.join(ctx.config.rootDir, TOOLS_ROOT, String(id));
const GENERIC_FAIL = 'Xoá logo Veo không thành công. Bấm «Thử lại»; nếu vẫn lỗi, báo chủ máy.';

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function getToolRow(ctx: AppContext, id: number): ToolJobRow | undefined {
  return ctx.db.prepare('SELECT * FROM lan_tool_jobs WHERE id = ?').get(id) as ToolJobRow | undefined;
}

/** Việc của CHÍNH trình duyệt này; việc của người khác hoặc không tồn tại đều 404 (không lộ sự tồn tại). */
export function getOwnedToolJob(ctx: AppContext, id: number, clientHash: string): ToolJobRow {
  const row = ctx.db.prepare('SELECT * FROM lan_tool_jobs WHERE id = ? AND client_id_hash = ?').get(id, clientHash) as ToolJobRow | undefined;
  if (!row) throw notFound('việc xoá logo');
  return row;
}

function patchTool(ctx: AppContext, id: number, patch: Partial<Pick<ToolJobRow, 'status' | 'progress' | 'input_path' | 'output_path' | 'error' | 'meta' | 'finished_at'>>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  ctx.db.prepare(`UPDATE lan_tool_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
}

export function toolJobJson(ctx: AppContext, row: ToolJobRow) {
  const meta = parseJson<Record<string, any>>(row.meta, {});
  const created = Date.parse(row.created_at);
  const waiting = row.status === 'queued' || row.status === 'processing';
  const q = waiting ? (ctx.finalRender?.queueInfo('tool', row.id) ?? null) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    original_name: row.original_name,
    created_by_name: row.created_by_name,
    error: scrubForLan(row.error, GENERIC_FAIL),
    created_at: row.created_at,
    finished_at: row.finished_at,
    expires_at: new Date(created + RETENTION_MS).toISOString(),
    input: meta.input ?? null,
    output: row.status === 'ready' && row.output_path ? { url: lanFileUrl(row.output_path), ...(meta.output ?? {}) } : null,
    /** (Cũ, giữ để tương thích) 0 = đang chạy; n = `running_count + queue_position`. Dùng `queue_position`/`running_count`/`concurrency`. */
    queue_ahead: waiting ? (ctx.finalRender?.position('tool', row.id) ?? null) : null,
    /** `waiting` (xếp hàng, chưa bắt đầu) | `running`; `null` khi việc không ở trong hàng đợi. */
    queue_state: q?.state ?? null,
    /** 1 = sẽ chạy tiếp theo; `null` khi đang chạy. */
    queue_position: q?.position ?? null,
    /** Số việc đang chạy lúc này / số việc được chạy cùng lúc. */
    running_count: q?.running_count ?? null,
    concurrency: q?.concurrency ?? null,
    can_retry: row.status === 'failed' || row.status === 'cancelled',
  };
}
export type ToolJobJson = ReturnType<typeof toolJobJson>;

export function listToolJobs(ctx: AppContext, clientHash: string): ToolJobJson[] {
  const rows = ctx.db.prepare('SELECT * FROM lan_tool_jobs WHERE client_id_hash = ? ORDER BY id DESC LIMIT ?').all(clientHash, MAX_LISTED) as ToolJobRow[];
  return rows.map((r) => toolJobJson(ctx, r));
}

/** Thống kê cho khối "Chia sẻ LAN" của app chính. */
export function toolJobsLast24h(ctx: AppContext): number {
  const since = new Date(ctx.clock.now() - 24 * 60 * 60 * 1000).toISOString();
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM lan_tool_jobs WHERE created_at >= ?').get(since) as { n: number }).n;
}

// ------------------------------------------------------------------ tạo, chạy, hủy, thử lại

export function checkToolProbe(probe: UploadedVideoProbe | null): UploadedVideoProbe {
  return assertVideoProbe(probe, { min: TOOL_MIN_S, max: TOOL_MAX_S });
}

export interface NewToolJob {
  clientHash: string;
  createdByName: string;
  originalName: string;
  tmpAbs: string;
  bytes: number;
  probe: UploadedVideoProbe;
}

const inputExt = (name: string): 'mp4' | 'mov' => (/\.mov$/i.test(name) ? 'mov' : 'mp4');

const inputMeta = (o: { bytes: number; probe: UploadedVideoProbe }) => ({
  bytes: o.bytes,
  duration_s: round3(o.probe.info.duration_s ?? 0),
  width: o.probe.info.width,
  height: o.probe.info.height,
  has_audio: o.probe.info.has_audio,
});

/**
 * Tạo việc `queued` từ file đã tải xong (file tạm nằm trong `output/lan-tools/.incoming/`, cùng ổ đĩa nên đổi tên nguyên tử vào thư mục của việc),
 * rồi xếp vào hàng đợi render. Trần hàng đợi LAN được kiểm tra trong cùng transaction với lúc ghi dòng mới.
 */
export function createToolJob(ctx: AppContext, o: NewToolJob): ToolJobRow {
  let dir: string | null = null;
  try {
    const id = ctx.tx(() => {
      assertLanQueueRoom(ctx);
      const info = ctx.db
        .prepare("INSERT INTO lan_tool_jobs (kind, status, progress, original_name, client_id_hash, created_by_name, meta, created_at) VALUES ('remove_logo', 'queued', NULL, ?, ?, ?, ?, ?)")
        .run(o.originalName, o.clientHash, o.createdByName || null, JSON.stringify({ input: inputMeta(o) }), ctx.now());
      const newId = Number(info.lastInsertRowid);
      dir = toolDirAbs(ctx, newId);
      fs.mkdirSync(dir, { recursive: true });
      const rel = `${toolDirRel(newId)}/input.${inputExt(o.originalName)}`;
      fs.renameSync(o.tmpAbs, path.join(ctx.config.rootDir, rel)); // nguyên tử (cùng ổ đĩa)
      patchTool(ctx, newId, { input_path: rel });
      ctx.afterCommit(() => ctx.finalRender?.enqueueTool(newId, (abort) => runToolJob(ctx, newId, abort)));
      return newId;
    });
    return getToolRow(ctx, id)!;
  } catch (err) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Chạy một việc (được gọi bởi hàng đợi render, mỗi lúc một việc). Mọi kết cục đều được ghi vào DB; không ném lỗi ra ngoài. */
export async function runToolJob(ctx: AppContext, id: number, abort: AbortController): Promise<void> {
  const row = getToolRow(ctx, id);
  if (!row || row.status !== 'queued' || !row.input_path) return; // đã hủy khi còn trong hàng đợi
  const root = ctx.config.rootDir;
  const inputAbs = path.join(root, row.input_path);
  const outRel = `${toolDirRel(id)}/clean.mp4`;
  const outAbs = path.join(root, outRel);
  const tmpAbs = path.join(path.dirname(outAbs), '.clean.tmp.mp4');
  patchTool(ctx, id, { status: 'processing', progress: 0, error: null, finished_at: null, output_path: null });

  const throttle = ctx.finalRender?.progressThrottleMs ?? 1000;
  let lastWrite = 0;
  let lastPct = -1;
  const onProgress = (pct: number) => {
    if (abort.signal.aborted) return;
    const now = Date.now();
    const p = Math.max(0, Math.min(99, Math.round(pct * 10) / 10));
    if (p === lastPct || (now - lastWrite < throttle && p < 99)) return;
    lastWrite = now;
    lastPct = p;
    if (getToolRow(ctx, id)?.status === 'processing') patchTool(ctx, id, { progress: p });
  };
  const stillProcessing = () => getToolRow(ctx, id)?.status === 'processing';

  fs.rmSync(tmpAbs, { force: true });
  try {
    if (!fs.existsSync(inputAbs)) throw new Error('không thấy video đã tải lên (có thể đã bị xoá)');
    fs.rmSync(outAbs, { force: true });
    const tool = await runWatermarkCli({ config: ctx.config, inputAbs, tmpAbs, signal: abort.signal, onProgress });
    if (abort.signal.aborted || !stillProcessing()) {
      fs.rmSync(tmpAbs, { force: true });
      return;
    }
    const dur = verifyCleaned(ctx.config, inputAbs, tmpAbs);
    if (!stillProcessing()) {
      fs.rmSync(tmpAbs, { force: true });
      return;
    }
    fs.renameSync(tmpAbs, outAbs); // nguyên tử: bản sạch chỉ xuất hiện khi đã đầy đủ và hợp lệ
    const meta = parseJson<Record<string, unknown>>(getToolRow(ctx, id)?.meta, {});
    const t = (tool ?? {}) as { meta?: { status?: unknown; denoiseBackend?: unknown } };
    const out = probeMedia(ctx.config, outAbs);
    ctx.tx(() => {
      if (!stillProcessing()) return;
      patchTool(ctx, id, {
        status: 'ready',
        progress: 100,
        output_path: outRel,
        error: null,
        finished_at: ctx.now(),
        meta: JSON.stringify({
          ...meta,
          output: { bytes: fs.statSync(outAbs).size, duration_s: round3(dur ?? out?.duration_s ?? 0), width: out?.width ?? null, height: out?.height ?? null, has_audio: out?.has_audio ?? null },
          tool: { status: typeof t.meta?.status === 'string' ? t.meta.status : null, denoise_backend: typeof t.meta?.denoiseBackend === 'string' ? t.meta.denoiseBackend : null },
        }),
      });
    });
    if (getToolRow(ctx, id)?.status !== 'ready') fs.rmSync(outAbs, { force: true });
  } catch (err) {
    fs.rmSync(tmpAbs, { force: true });
    if (abort.signal.aborted || err instanceof RenderCancelled || !stillProcessing()) return; // đã hủy: trạng thái do cancelToolJob ghi
    const msg = err instanceof Error ? err.message : String(err);
    patchTool(ctx, id, { status: 'failed', progress: null, error: `Xoá logo Veo thất bại: ${msg}`, finished_at: ctx.now() });
  }
}

/** Hủy việc đang chờ/đang chạy của chính trình duyệt này. Đang chạy: dừng cả cây tiến trình của tool. Giữ input để thử lại. */
export function cancelToolJob(ctx: AppContext, id: number, clientHash: string): ToolJobRow {
  return ctx.tx(() => {
    const row = getOwnedToolJob(ctx, id, clientHash);
    if (row.status !== 'queued' && row.status !== 'processing') throw conflict('INVALID_STATE', `Việc đang ở trạng thái ${row.status}, không thể hủy`);
    patchTool(ctx, id, { status: 'cancelled', progress: null, error: null, finished_at: ctx.now() });
    ctx.afterCommit(() => {
      ctx.finalRender?.cancelTool(id);
      fs.rmSync(path.join(toolDirAbs(ctx, id), '.clean.tmp.mp4'), { force: true });
    });
    return getToolRow(ctx, id)!;
  });
}

/** Thử lại việc `failed`/`cancelled` (giữ input): xếp lại hàng đợi; chịu trần hàng đợi LAN. */
export function retryToolJob(ctx: AppContext, id: number, clientHash: string): ToolJobRow {
  return ctx.tx(() => {
    const row = getOwnedToolJob(ctx, id, clientHash);
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw conflict('INVALID_STATE', row.status === 'expired' ? 'Việc đã hết hạn, hãy tải video lên lại' : `Việc đang ở trạng thái ${row.status}, chỉ thử lại được việc lỗi hoặc đã hủy`);
    }
    if (!row.input_path || !fs.existsSync(path.join(ctx.config.rootDir, row.input_path))) throw conflict('FILE_MISSING', 'Video đã tải lên không còn trên máy chủ, hãy tải lên lại');
    assertLanQueueRoom(ctx);
    patchTool(ctx, id, { status: 'queued', progress: null, error: null, output_path: null, finished_at: null });
    ctx.afterCommit(() => ctx.finalRender?.enqueueTool(id, (abort) => runToolJob(ctx, id, abort)));
    return getToolRow(ctx, id)!;
  });
}

// ------------------------------------------------------------------ khởi động lại, hết hạn

/** Khi server khởi động: việc đang `queued`/`processing` của tiến trình cũ (đã chết) → `failed`, giữ input để thử lại, dọn file tạm. */
export function recoverToolJobs(ctx: AppContext): number {
  return ctx.tx(() => {
    const rows = ctx.db.prepare("SELECT id FROM lan_tool_jobs WHERE status IN ('queued','processing')").all() as { id: number }[];
    for (const r of rows) {
      patchTool(ctx, r.id, { status: 'failed', progress: null, error: 'Server khởi động lại trong lúc xử lý; bấm Thử lại', finished_at: ctx.now() });
      ctx.afterCommit(() => fs.rmSync(path.join(toolDirAbs(ctx, r.id), '.clean.tmp.mp4'), { force: true }));
    }
    return rows.length;
  });
}

/**
 * Dọn việc công cụ quá 7 ngày (tính từ lúc tạo): xoá thư mục `output/lan-tools/<id>/` (đường dẫn dựng từ id, không tin cột trong DB) và
 * đánh dấu `expired`. Chỉ đụng việc đã kết thúc (ready/failed/cancelled). Cũng dọn file tải dở bị bỏ quên (> 1 giờ) trong `.incoming`.
 */
export function expireToolJobs(ctx: AppContext): { expired: number; staleTmp: number } {
  const cutoff = new Date(ctx.clock.now() - RETENTION_MS).toISOString();
  const rows = ctx.db.prepare("SELECT id FROM lan_tool_jobs WHERE status IN ('ready','failed','cancelled') AND created_at < ?").all(cutoff) as { id: number }[];
  for (const r of rows) {
    fs.rmSync(toolDirAbs(ctx, r.id), { recursive: true, force: true });
    ctx.db
      .prepare("UPDATE lan_tool_jobs SET status = 'expired', progress = NULL, input_path = NULL, output_path = NULL, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .run(ctx.now(), r.id);
  }
  let staleTmp = 0;
  const sweep = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^\.lan-upload-[0-9a-f]+\.tmp$/.test(f)) continue;
        const abs = path.join(dir, f);
        if (Date.now() - fs.statSync(abs).mtimeMs > STALE_TMP_MS) {
          fs.rmSync(abs, { force: true });
          staleTmp++;
        }
      }
    } catch {
      /* thư mục chưa có */
    }
  };
  sweep(toolIncomingDir(ctx.config.rootDir));
  for (const p of ctx.db.prepare("SELECT slug FROM projects WHERE source = 'lan' AND deleted_at IS NULL").all() as { slug: string }[]) sweep(path.join(ctx.config.rootDir, 'output', p.slug, 'video'));
  return { expired: rows.length, staleTmp };
}
