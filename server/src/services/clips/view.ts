/**
 * JSON trả cho API cắt clip (hợp đồng mục 5 của đặc tả) và các hàm phát SSE. Cùng một bộ dựng cho app chính và listener LAN:
 * khác nhau ở tiền tố URL file (`/files` ↔ `/lan/files`), thông báo lỗi (LAN không lộ đường dẫn máy chủ) và bản xem video nguồn (LAN chỉ có bản 480p).
 */
import fs from 'node:fs';
import type { AppContext } from '../../context.js';
import type { ClipCutRow, ClipRow, JobRow, ProjectRow, SourceVideoRow } from '../../db/types.js';
import { aiQueueInfo } from '../job-queue.js';
import { lanFileUrl, scrubForLan } from '../lan-common.js';
import { fileUrl, parseJson } from '../repo.js';
import { projectDeleteBlocks } from '../trash.js';
import { abs, getClipRow, getCutRow, getSourceRow, latestCut, posterRel, previewRel, projectClips, projectSource, readTranscript, thumbRel } from './repo.js';
import { excerptOf, type Transcript } from './transcript.js';

export interface ViewOpts {
  lan: boolean;
  /** LAN: băm cookie client của người gọi (để tính `can_delete`). */
  clientHash?: string | null;
}

const urlOf = (o: ViewOpts) => (rel: string): string => (o.lan ? lanFileUrl(rel) : fileUrl(rel));
const GENERIC_FAIL = 'Có lỗi khi xử lý. Bấm thử lại; nếu vẫn lỗi, báo chủ máy.';
const err = (o: ViewOpts, message: string | null): string | null => (o.lan ? scrubForLan(message, GENERIC_FAIL) : message);
const fileExists = (ctx: AppContext, rel: string): boolean => fs.existsSync(abs(ctx, rel));

const slugOf = (ctx: AppContext, projectId: number): string => (ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as { slug: string }).slug;

// ---------------------------------------------------------------- video nguồn

export function sourceJson(ctx: AppContext, row: SourceVideoRow, o: ViewOpts) {
  const slug = slugOf(ctx, row.project_id);
  const u = urlOf(o);
  const meta = parseJson<{ word_count?: number; speech_ratio?: number } | null>(row.stt_meta, null);
  const q = ctx.stt?.queueInfo(row.id) ?? null;
  const deleted = !!row.deleted_at;
  let videoUrl: string | null = null;
  if (o.lan) videoUrl = fileExists(ctx, previewRel(slug)) ? u(previewRel(slug)) : null;
  else videoUrl = row.path && !deleted && fileExists(ctx, row.path) ? u(row.path) : null;
  return {
    id: row.id,
    project_id: row.project_id,
    original_name: row.original_name,
    bytes: row.bytes,
    duration_s: row.duration_s,
    width: row.width,
    height: row.height,
    fps: row.fps,
    status: row.status,
    /** Tiến độ nhận dạng ƯỚC TÍNH (dịch vụ không trả %), kẹp 95 cho tới khi xong. */
    progress: row.progress,
    error: err(o, row.error),
    error_code: row.error_code,
    queue: { state: q?.state ?? null, position: q?.position ?? null },
    video_url: videoUrl,
    poster_url: fileExists(ctx, posterRel(slug)) ? u(posterRel(slug)) : null,
    word_count: meta?.word_count ?? null,
    speech_ratio: meta?.speech_ratio ?? null,
    /** true: video gốc đã bị xoá sau hạn lưu (LAN); `status` vẫn giữ nguyên, không dựng được clip mới. */
    source_deleted: deleted,
    created_at: row.created_at,
  };
}

export function emitSource(ctx: AppContext, row: Pick<SourceVideoRow, 'id' | 'project_id'>): void {
  ctx.publish('source.updated', row.project_id, () => ({ source: sourceJson(ctx, getSourceRow(ctx, row.id), { lan: false }) }), `source:${row.id}`);
}

// ---------------------------------------------------------------- bản dựng

export function cutJson(ctx: AppContext, row: ClipCutRow, o: ViewOpts) {
  const u = urlOf(o);
  const ready = row.status === 'ready';
  const q = row.status === 'rendering' ? (ctx.finalRender?.queueInfo('clip', row.id) ?? null) : null;
  return {
    id: row.id,
    clip_id: row.clip_id,
    project_id: row.project_id,
    version: row.version,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error: err(o, row.error),
    aspect: row.aspect,
    reframe: parseJson<Record<string, unknown>>(row.reframe, {}),
    captions: parseJson<Record<string, unknown>>(row.captions, {}),
    start_s: row.start_s,
    end_s: row.end_s,
    duration_s: row.duration_s,
    video_url: ready && row.video_path ? u(row.video_path) : null,
    srt_url: ready && row.srt_path ? u(row.srt_path) : null,
    /** `waiting` (xếp hàng, chưa bắt đầu) | `running`; null khi không ở trong hàng đợi. */
    queue_state: q?.state ?? null,
    queue_position: q?.position ?? null,
    running_count: q?.running_count ?? null,
    concurrency: q?.concurrency ?? null,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

export function emitCut(ctx: AppContext, cutId: number, projectId: number): void {
  ctx.publish('clip_cut.updated', projectId, () => ({ cut: cutJson(ctx, getCutRow(ctx, cutId), { lan: false }) }), `clip_cut:${cutId}`);
}

// ---------------------------------------------------------------- clip

/** Chữ phụ đề hiện tại của clip: danh sách `{i, w}` đã sửa/khôi phục, hoặc null nếu dùng chữ ASR. */
export function captionWordsOf(row: Pick<ClipRow, 'caption_words'>): { i: number; w: string }[] | null {
  const v = parseJson<{ i: number; w: string }[] | null>(row.caption_words, null);
  return Array.isArray(v) ? v : null;
}

export interface ClipPre {
  transcript?: Transcript | null;
}

export function clipJson(ctx: AppContext, row: ClipRow, o: ViewOpts, pre: ClipPre = {}) {
  const slug = slugOf(ctx, row.project_id);
  const u = urlOf(o);
  const cw = captionWordsOf(row);
  let transcript = pre.transcript;
  if (transcript === undefined) {
    const src = ctx.db.prepare('SELECT * FROM source_videos WHERE id = ?').get(row.source_id) as SourceVideoRow | undefined;
    transcript = src ? readTranscript(ctx, src) : null;
  }
  let excerpt: string | null = null;
  if (transcript) {
    const words = cw ? cw.filter((w) => w.w) : transcript.words.slice(row.start_word, row.end_word + 1);
    excerpt = excerptOf(words, 400);
  }
  const thumb = thumbRel(slug, row.code);
  let thumbUrl: string | null = null;
  try {
    const st = fs.statSync(abs(ctx, thumb));
    thumbUrl = `${u(thumb)}?v=${Math.floor(st.mtimeMs)}`;
  } catch {
    thumbUrl = null;
  }
  const cut = latestCut(ctx, row.id);
  const cuts = (ctx.db.prepare('SELECT COUNT(*) AS n FROM clip_cuts WHERE clip_id = ?').get(row.id) as { n: number }).n;
  return {
    id: row.id,
    project_id: row.project_id,
    code: row.code,
    status: row.status,
    start_s: row.start_s,
    end_s: row.end_s,
    duration_s: Math.round((row.end_s - row.start_s) * 1000) / 1000,
    start_word: row.start_word,
    end_word: row.end_word,
    start_sentence: row.start_sentence,
    end_sentence: row.end_sentence,
    title: row.title,
    hook: row.hook,
    score: row.score,
    reason: row.reason,
    content_type: row.content_type,
    verify: parseJson<Record<string, unknown> | null>(row.verify, null),
    created_by: row.created_by,
    thumb_url: thumbUrl,
    transcript_excerpt: excerpt,
    caption_edited: row.caption_source === 'user',
    /** Đề xuất bổ sung hợp đồng: chữ phụ đề hiện tại `[{i, w}]` (đã khôi phục dấu câu / sửa tay); null = dùng chữ ASR. */
    caption_words: cw,
    latest_cut: cut ? cutJson(ctx, cut, o) : null,
    cuts_count: cuts,
  };
}

export function emitClip(ctx: AppContext, clipId: number, projectId: number): void {
  ctx.publish('clip.updated', projectId, () => ({ clip: clipJson(ctx, getClipRow(ctx, clipId), { lan: false }) }), `clip:${clipId}`);
}

// ---------------------------------------------------------------- job đề xuất (clip_plan)

export function planJobJson(ctx: AppContext, job: JobRow, o: ViewOpts) {
  const q = job.status === 'queued' || job.status === 'claimed' || job.status === 'running' ? aiQueueInfo(ctx, job) : null;
  const result = parseJson<{ summary?: string; not_found_reason?: string; created?: number } | null>(job.result, null);
  return {
    id: job.id,
    status: job.status,
    queue: q ? { state: q.state, position: q.position, ahead: q.ahead } : null,
    /** Lý do job đang chờ chưa được nhận (hết hạn mức AI, đối soát...). */
    wait_reason: q?.wait_reason ?? null,
    worker: q ? q.worker : null,
    error: job.status === 'failed' ? err(o, job.error) : job.status === 'cancelled' ? 'Đã hủy' : null,
    summary: result?.summary ?? null,
    not_found_reason: result?.not_found_reason ?? null,
    created_clips: result?.created ?? null,
    created_at: job.created_at,
    finished_at: job.finished_at,
  };
}

export function latestPlanJob(ctx: AppContext, projectId: number): JobRow | undefined {
  return ctx.db.prepare("SELECT * FROM jobs WHERE project_id = ? AND type = 'clip_plan' ORDER BY id DESC LIMIT 1").get(projectId) as JobRow | undefined;
}

// ---------------------------------------------------------------- dự án

export function clipProjectInfo(p: ProjectRow) {
  return { id: p.id, name: p.name, slug: p.slug, kind: 'clips' as const, source: p.source, stt_terms: p.stt_terms, created_at: p.created_at, created_by_name: p.created_by_name };
}

export function clipProjectDetail(ctx: AppContext, p: ProjectRow, o: ViewOpts) {
  const source = projectSource(ctx, p.id);
  const transcript = source ? readTranscript(ctx, source) : null;
  const plan = latestPlanJob(ctx, p.id);
  const blocks = projectDeleteBlocks(ctx, p.id);
  const base = {
    project: clipProjectInfo(p),
    source: source ? sourceJson(ctx, source, o) : null,
    clips: projectClips(ctx, p.id).map((c) => clipJson(ctx, c, o, { transcript })),
    plan_job: plan ? planJobJson(ctx, plan, o) : null,
  };
  if (!o.lan) return { ...base, delete_block: blocks.length ? { code: blocks[0]!.code, message: blocks.map((b) => b.message).join(' '), reasons: blocks } : null };
  const owns = !!p.lan_client_hash && !!o.clientHash && p.lan_client_hash === o.clientHash;
  return { ...base, can_delete: owns, delete_block: owns ? (blocks[0]?.message ?? null) : null };
}

/** Một dòng danh sách dự án cắt clip (LAN: `GET /lan/api/clip-projects`). */
export function clipProjectSummary(ctx: AppContext, p: ProjectRow, o: ViewOpts) {
  const source = projectSource(ctx, p.id);
  const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE project_id = ?').get(p.id) as { n: number }).n;
  const base = {
    id: p.id,
    name: p.name,
    slug: p.slug,
    kind: 'clips' as const,
    status: p.status,
    source: p.source,
    created_by_name: p.created_by_name,
    created_at: p.created_at,
    updated_at: p.updated_at,
    clip_count: n,
    source_video: source ? { duration_s: source.duration_s, status: source.status } : null,
  };
  if (!o.lan) return base;
  const owns = !!p.lan_client_hash && !!o.clientHash && p.lan_client_hash === o.clientHash;
  return { ...base, can_delete: owns, delete_block: owns ? (projectDeleteBlocks(ctx, p.id)[0]?.message ?? null) : null };
}
