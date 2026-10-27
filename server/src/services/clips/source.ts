/**
 * Dự án cắt clip và video nguồn: tạo/sửa dự án, nhận video tải lên (đã stream xuống file tạm), kiểm tra ffprobe/dung lượng, dùng lại theo content_hash,
 * ảnh đại diện và bản xem thử 480p, hạn lưu video nguồn của LAN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GIB } from '../../config.js';
import type { AppContext } from '../../context.js';
import type { ProjectRow, SourceVideoRow } from '../../db/types.js';
import { AppError, conflict } from '../../lib/errors.js';
import { slugify } from '../../lib/paths.js';
import { run } from '../final-render/ffmpeg-renderer.js';
import { ffmpegOf, type UploadedVideoProbe } from '../media.js';
import { emitProject } from '../project-view.js';
import { getProject, logEvent } from '../repo.js';
import { uniqueSlug } from '../projects.js';
import { RenderCancelled } from '../final-render/types.js';
import { abs, clipsDirRel, getClipProject, getSourceRow, posterRel, previewRel, projectClips, projectSource, sourceDirRel, thumbsDirRel, transcriptRel } from './repo.js';
import { emitSource } from './view.js';

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export const createClipProjectBody = z.object({
  name: z.string().trim().min(1, 'tên dự án không được rỗng').max(200).refine(noControl, 'tên không được chứa ký tự điều khiển'),
  stt_terms: z.string().trim().max(500, 'tối đa 500 ký tự').refine(noControl, 'không được chứa ký tự điều khiển').optional(),
  /** Chỉ trang LAN: tên người tạo (tự nhập, không xác thực). */
  created_by_name: z.string().trim().max(60).refine(noControl, 'tên không được chứa ký tự điều khiển').optional(),
});
export type CreateClipProjectBody = z.infer<typeof createClipProjectBody>;

export const patchClipProjectBody = z
  .object({
    name: z.string().trim().min(1).max(200).refine(noControl, 'tên không được chứa ký tự điều khiển'),
    stt_terms: z.string().trim().max(500, 'tối đa 500 ký tự').refine(noControl, 'không được chứa ký tự điều khiển'),
  })
  .partial();
export type PatchClipProjectBody = z.infer<typeof patchClipProjectBody>;

/** Tạo dự án `kind='clips'` (status `active`, không có brief/cảnh). */
export function createClipProject(ctx: AppContext, body: CreateClipProjectBody, origin: { source?: 'app' | 'lan'; lan_client_hash?: string | null } = {}): ProjectRow {
  return ctx.tx(() => {
    const now = ctx.now();
    const source = origin.source ?? 'app';
    const info = ctx.db
      .prepare(
        `INSERT INTO projects (slug, name, brief, style_lock, max_attempts_per_scene, credit_per_video, status, source, created_by_name, lan_client_hash, kind, stt_terms, created_at, updated_at)
         VALUES (?, ?, '', '', 2, 0, 'active', ?, ?, ?, 'clips', ?, ?, ?)`,
      )
      .run(uniqueSlug(ctx, body.name), body.name, source, source === 'lan' ? (body.created_by_name || 'Khách LAN') : null, source === 'lan' ? (origin.lan_client_hash ?? null) : null, body.stt_terms || null, now, now);
    const project = getProject(ctx, Number(info.lastInsertRowid));
    logEvent(ctx, {
      project_id: project.id,
      type: 'project.created',
      message: source === 'lan' ? `Tạo dự án cắt clip "${project.name}" từ trang LAN (người tạo: ${project.created_by_name ?? 'không rõ'})` : `Tạo dự án cắt clip "${project.name}"`,
    });
    return project;
  });
}

export function patchClipProject(ctx: AppContext, id: number, patch: PatchClipProjectBody): ProjectRow {
  return ctx.tx(() => {
    const p = getClipProject(ctx, id);
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(patch.name);
    }
    if (patch.stt_terms !== undefined) {
      sets.push('stt_terms = ?');
      args.push(patch.stt_terms || null);
    }
    if (!sets.length) return p;
    ctx.db.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, ctx.now(), id);
    logEvent(ctx, { project_id: id, type: 'project.updated', message: `Cập nhật dự án cắt clip: ${Object.keys(patch).join(', ')}` });
    emitProject(ctx, id);
    return getProject(ctx, id);
  });
}

// ---------------------------------------------------------------- giới hạn, dung lượng trống

/** Giới hạn tải video nguồn theo nơi gọi (app chính hoặc LAN). */
export function sourceLimits(ctx: AppContext, lan: boolean): { max_bytes: number; max_s: number } {
  return lan ? { max_bytes: ctx.config.lanClipSourceMaxBytes, max_s: ctx.config.lanClipSourceMaxS } : { max_bytes: ctx.config.clipSourceMaxBytes, max_s: ctx.config.clipSourceMaxS };
}

export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Còn đủ dung lượng không: trống ≥ CLIP_MIN_FREE_GB + `factor` × `bytes`. Không đủ → 507 `INSUFFICIENT_STORAGE`.
 * Tải lên dùng factor 3 (file + audio + clip dựng); dựng clip dùng factor 1 trên kích thước ước tính.
 */
export function assertDiskRoom(ctx: AppContext, bytes: number, factor = 3): void {
  const free = freeBytes(ctx.config.rootDir);
  if (free === null) return;
  const need = ctx.config.clipMinFreeGb * GIB + factor * Math.max(0, bytes);
  if (free < need) {
    const fmt = (b: number) => `${(b / GIB).toFixed(1).replace('.', ',')} GB`;
    throw new AppError('INSUFFICIENT_STORAGE', `Ổ đĩa không đủ chỗ: còn ${fmt(free)}, cần ít nhất ${fmt(need)} (giữ trống ${ctx.config.clipMinFreeGb} GB). Hãy xoá bớt dự án rồi thử lại.`, 507, { free_bytes: free, need_bytes: need });
  }
}

export const sourceTmpDir = (ctx: AppContext, slug: string): string => abs(ctx, sourceDirRel(slug));

// ---------------------------------------------------------------- nhận video

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const EXT: Record<string, string> = { mp4: 'mp4', mov: 'mov', mkv: 'mkv', avi: 'avi' };

/** Kiểm tra kết quả ffprobe cho video nguồn: có hình + tiếng, thời lượng ≤ giới hạn. */
export function assertSourceProbe(probe: UploadedVideoProbe | null, maxS: number): UploadedVideoProbe {
  if (!probe || !probe.info.width || !probe.info.height) throw new AppError('INVALID_VIDEO', 'Không đọc được video (file hỏng hoặc không có luồng hình)', 422);
  const d = probe.info.duration_s;
  if (d === null || !Number.isFinite(d) || d <= 0) throw new AppError('INVALID_VIDEO', 'Không đọc được thời lượng video', 422);
  if (!probe.info.has_audio) throw new AppError('NO_AUDIO', 'Video không có âm thanh nên không nhận dạng được lời nói', 422);
  if (d > maxS) {
    throw new AppError('VIDEO_DURATION', `Video dài ${fmtDur(d)}; chỉ nhận video tối đa ${fmtDur(maxS)}`, 422, { duration_s: round3(d), max_s: maxS });
  }
  return probe;
}

export function fmtDur(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h} giờ ${m} phút` : `${m} phút ${t % 60} giây`;
}

export interface IngestInput {
  tmpAbs: string;
  bytes: number;
  originalName: string;
  sha256: string;
  container: 'mp4' | 'mov' | 'mkv' | 'avi';
  probe: UploadedVideoProbe;
}

/**
 * Ghi video đã tải xong vào dự án: dùng lại nếu trùng content_hash trong dự án; dự án đã có video khác thì chỉ thay khi chưa có clip và không đang nhận dạng.
 * File đổi tên NGUYÊN TỬ (cùng ổ đĩa) thành `output/<slug>/clips/source/<hash16>.<ext>`, không ghi đè file có sẵn.
 * Trả `{ source, reused }`; người gọi xếp nhận dạng lời nói (`ctx.stt`) và sinh ảnh/bản xem thử.
 */
export function registerSource(ctx: AppContext, project: ProjectRow, o: IngestInput): { source: SourceVideoRow; reused: boolean } {
  const slug = project.slug;
  const hash16 = o.sha256.slice(0, 16);
  const rel = `${sourceDirRel(slug)}/${hash16}.${EXT[o.container] ?? 'mp4'}`;
  return ctx.tx(() => {
    getClipProject(ctx, project.id);
    const existing = projectSource(ctx, project.id);
    if (existing && existing.content_hash === o.sha256 && !existing.deleted_at) {
      fs.rmSync(o.tmpAbs, { force: true });
      return { source: existing, reused: true };
    }
    if (existing) {
      const clips = projectClips(ctx, project.id).length;
      if (clips > 0 || existing.status === 'transcribing') {
        throw conflict('SOURCE_EXISTS', clips > 0 ? 'Dự án đã có video nguồn và các clip cắt từ đó; hãy tạo dự án mới cho video khác' : 'Video nguồn đang được nhận dạng; hãy đợi xong hoặc hủy trước khi thay video');
      }
    }
    const target = abs(ctx, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      // cùng nội dung đã nằm đó (vd dòng DB đã bị thay): không ghi đè, dùng lại file
      fs.rmSync(o.tmpAbs, { force: true });
    } else {
      fs.renameSync(o.tmpAbs, target); // nguyên tử (cùng ổ đĩa)
    }
    if (existing) removeSource(ctx, project, existing);
    const i = o.probe.info;
    const info = ctx.db
      .prepare(
        `INSERT INTO source_videos (project_id, path, original_name, bytes, duration_s, width, height, fps, has_audio, status, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'uploaded', ?, ?)`,
      )
      .run(project.id, rel, o.originalName, o.bytes, round3(i.duration_s ?? 0), i.width, i.height, i.fps === null ? null : round3(i.fps), o.sha256, ctx.now());
    const id = Number(info.lastInsertRowid);
    logEvent(ctx, { project_id: project.id, type: 'clip.source_uploaded', message: `Tải lên video nguồn "${o.originalName}" (${fmtDur(i.duration_s ?? 0)}, ${(o.bytes / 1024 / 1024).toFixed(0)} MB)` });
    emitProject(ctx, project.id);
    const source = getSourceRow(ctx, id);
    emitSource(ctx, source);
    return { source, reused: false };
  });
}

/** Thay video nguồn chưa có clip: xoá dòng cũ + file video cũ, lưu transcript cũ thành bản lưu (không ghi đè, không mất dữ liệu). */
function removeSource(ctx: AppContext, project: ProjectRow, old: SourceVideoRow): void {
  if (old.transcript_path) archiveTranscript(ctx, project.slug);
  ctx.db.prepare('DELETE FROM source_videos WHERE id = ?').run(old.id);
  const oldPath = old.path;
  ctx.afterCommit(() => {
    if (oldPath) fs.rmSync(abs(ctx, oldPath), { force: true });
  });
}

/** Đổi tên `transcript.json` hiện có thành `transcript.v<k>.json` (k nhỏ nhất chưa dùng) để file mới không ghi đè; trả đường dẫn bản lưu. */
export function archiveTranscript(ctx: AppContext, slug: string): string | null {
  const cur = abs(ctx, transcriptRel(slug));
  if (!fs.existsSync(cur)) return null;
  let k = 1;
  for (; fs.existsSync(abs(ctx, `${clipsDirRel(slug)}/transcript.v${k}.json`)); k++);
  const dest = `${clipsDirRel(slug)}/transcript.v${k}.json`;
  fs.renameSync(cur, abs(ctx, dest));
  return dest;
}

// ---------------------------------------------------------------- ảnh đại diện, bản xem thử

/** Ảnh poster của video nguồn (khung ở ~10%, tối đa 5 giây). Lỗi thì bỏ qua (không làm hỏng việc tải lên). Không ghi đè. */
export async function makePoster(ctx: AppContext, source: SourceVideoRow, slug: string): Promise<void> {
  const bin = ffmpegOf(ctx.config);
  if (!bin || !source.path) return;
  const out = abs(ctx, posterRel(slug));
  if (fs.existsSync(out)) return;
  const input = abs(ctx, source.path);
  if (!fs.existsSync(input)) return;
  const at = Math.min(5, Math.max(0, (source.duration_s ?? 0) * 0.1));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = path.join(path.dirname(out), `.poster.${process.pid}.tmp.jpg`);
  try {
    await run(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=640:-2', tmp], new AbortController().signal);
    fs.renameSync(tmp, out);
    emitSource(ctx, getSourceRow(ctx, source.id));
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Bản xem thử cho LAN: H.264 480p (cạnh ngắn 480), CRF 28, aac 64k, không ghi đè. Chạy trong hàng đợi render chung (xếp sau việc của app).
 * Lỗi thì bỏ qua (trang LAN chỉ thiếu player, vẫn dùng được transcript).
 */
export async function makePreview(ctx: AppContext, sourceId: number, signal: AbortSignal): Promise<void> {
  const source = ctx.db.prepare('SELECT s.*, p.slug FROM source_videos s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.deleted_at IS NULL').get(sourceId) as (SourceVideoRow & { slug: string }) | undefined;
  const bin = ffmpegOf(ctx.config);
  if (!source || !source.path || !bin) return;
  const out = abs(ctx, previewRel(source.slug));
  const input = abs(ctx, source.path);
  if (fs.existsSync(out) || !fs.existsSync(input)) return;
  const tmp = path.join(path.dirname(out), '.preview_480p.tmp.mp4');
  fs.rmSync(tmp, { force: true });
  const portrait = (source.height ?? 0) > (source.width ?? 0);
  const vf = portrait ? 'scale=480:-2' : 'scale=-2:480';
  try {
    await run(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', tmp], signal);
    if (signal.aborted) return;
    fs.renameSync(tmp, out); // nguyên tử: bản xem thử chỉ xuất hiện khi đã đầy đủ
    emitSource(ctx, getSourceRow(ctx, source.id));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (!(err instanceof RenderCancelled)) console.error('[clips] không tạo được bản xem thử 480p:', err instanceof Error ? err.message : err);
  }
}

/** Xếp việc tạo bản xem thử vào hàng đợi render chung (chỉ dự án LAN cần). */
export function queuePreview(ctx: AppContext, sourceId: number): void {
  ctx.finalRender?.enqueueClipTask('preview', sourceId, true, (abort) => makePreview(ctx, sourceId, abort.signal));
}

// ---------------------------------------------------------------- hạn lưu video nguồn LAN, file tạm

const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * Chạy mỗi giờ: (1) xoá video nguồn của dự án LAN quá `LAN_CLIP_SOURCE_RETENTION_DAYS` ngày (giữ transcript, bản xem thử, clip; `deleted_at` được đặt, `status` giữ
 * nguyên) — bỏ qua video đang được nhận dạng/dựng; (2) dọn file tải dở > 1 giờ trong `clips/source/`.
 */
export function expireClipSources(ctx: AppContext): { expired: number; staleTmp: number } {
  const cutoff = new Date(ctx.clock.now() - ctx.config.lanClipSourceRetentionDays * 86_400_000).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT s.*, p.slug FROM source_videos s JOIN projects p ON p.id = s.project_id
       WHERE p.source = 'lan' AND p.deleted_at IS NULL AND p.kind = 'clips' AND s.deleted_at IS NULL AND s.path IS NOT NULL AND s.created_at < ?`,
    )
    .all(cutoff) as (SourceVideoRow & { slug: string })[];
  let expired = 0;
  for (const s of rows) {
    if (s.status === 'transcribing' || ctx.stt?.queueInfo(s.id)) continue;
    const rendering = ctx.db.prepare("SELECT 1 FROM clip_cuts c JOIN clips k ON k.id = c.clip_id WHERE k.source_id = ? AND c.status = 'rendering' LIMIT 1").get(s.id);
    if (rendering) continue;
    fs.rmSync(abs(ctx, s.path!), { force: true });
    ctx.tx(() => {
      ctx.db.prepare('UPDATE source_videos SET deleted_at = ? WHERE id = ?').run(ctx.now(), s.id);
      logEvent(ctx, { project_id: s.project_id, type: 'clip.source_expired', message: `Đã xoá video nguồn sau ${ctx.config.lanClipSourceRetentionDays} ngày (giữ transcript, bản xem thử và clip)` });
      emitSource(ctx, getSourceRow(ctx, s.id));
    });
    expired++;
  }
  let staleTmp = 0;
  const sweep = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^\.lan-upload-[0-9a-f]+\.tmp$/.test(f) && !/^\.(poster|preview_480p)[\w.]*\.tmp\.(jpg|mp4)$/.test(f)) continue;
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > STALE_TMP_MS) {
          fs.rmSync(p, { force: true });
          staleTmp++;
        }
      }
    } catch {
      /* thư mục chưa có */
    }
  };
  for (const p of ctx.db.prepare("SELECT slug FROM projects WHERE kind = 'clips' AND deleted_at IS NULL").all() as { slug: string }[]) {
    sweep(abs(ctx, sourceDirRel(p.slug)));
    sweep(abs(ctx, thumbsDirRel(p.slug)));
  }
  return { expired, staleTmp };
}

/** Video nguồn còn dùng được (chưa bị xoá, file còn)? */
export function sourceFileOk(ctx: AppContext, s: Pick<SourceVideoRow, 'path' | 'deleted_at'>): boolean {
  return !s.deleted_at && !!s.path && fs.existsSync(abs(ctx, s.path));
}

/** Tên file ASCII an toàn từ tên dự án cho ZIP/Content-Disposition. */
export const safeName = (s: string): string => slugify(s).slice(0, 60);

