import { z } from 'zod';
import { isManagedJobType } from '../../config.js';
import type { AppContext } from '../../context.js';
import type { JobRow, ClipRow, ClipCutRow } from '../../db/types.js';
import { cleanupSegmentsSpans, validateCleanupSpans, editCleanupCutsSpans, type CleanupPlan, type EditSnapshot, type Segment } from '../../lib/clip-cleanup.js';
import { clipParts, isMultiPart, partSpans } from '../../lib/clip-parts.js';
import { AppError, conflict } from '../../lib/errors.js';
import { insertJob } from '../job-create.js';
import { assertLanQueueRoom } from '../lan-queue.js';
import { emitProject } from '../project-view.js';
import { emitJob, logEvent, parseJson } from '../repo.js';
import { requireTranscript } from './clips.js';
import { getClipRow, projectClips, getSourceRow } from './repo.js';
import { sourceFileOk } from './source.js';
import { emitClip } from './view.js';

export interface CleanupRequest { mode: 'cleanup'; clip_id: number; source_id: number; edit_revision: number }
export const isCleanupJob = (job: Pick<JobRow, 'payload'>) => parseJson<{ mode?: string }>(job.payload, {}).mode === 'cleanup';
export const cleanupApplyBody = z.object({ job_id: z.number().int().positive(), revision: z.number().int().nonnegative(), selected_ids: z.array(z.number().int().positive()).max(40), edits: z.array(z.object({ id: z.number().int().positive(), start_word: z.number().int().nonnegative(), end_word: z.number().int().nonnegative() })).max(40).optional() });
export const cleanupResult = z.object({ proposals: z.array(z.unknown()).max(40), summary: z.string().trim().min(1).max(2000) });
export const cleanupOf = (row: { cleanup: string | null }): CleanupPlan | null => parseJson<CleanupPlan | null>(row.cleanup, null);
export const CLEANUP_WORKER_TIMEOUT_MS = 5 * 60_000;

/** Fail unsupported/unattended requests, but preserve quota waits, paused queues and supported backlogs. */
export function expireWaitingCleanup(ctx: AppContext, projectId?: number): number[] {
  return ctx.tx(() => {
    if (ctx.db.prepare('SELECT 1 FROM worker_state WHERE queue_paused=1').get()) return [];
    const onlineSince = new Date(ctx.clock.now() - ctx.config.workerOnlineSeconds * 1000).toISOString();
    if (isManagedJobType(ctx.config, 'clip_plan') && ctx.db.prepare("SELECT 1 FROM worker_sessions WHERE mode='managed' AND last_seen_at>? AND EXISTS (SELECT 1 FROM json_each(features) WHERE value='clip_cleanup') LIMIT 1").get(onlineSince)) return [];
    const cutoff = new Date(ctx.clock.now() - CLEANUP_WORKER_TIMEOUT_MS).toISOString();
    const jobs = ctx.db.prepare("SELECT id,project_id,payload FROM jobs WHERE type='clip_plan' AND json_extract(payload,'$.mode')='cleanup' AND status='queued' AND wait_reason IS NULL AND COALESCE(last_requeued_at,created_at)<=? AND (? IS NULL OR project_id=?)").all(cutoff, projectId ?? null, projectId ?? null) as Pick<JobRow, 'id' | 'project_id' | 'payload'>[];
    const error = 'Không có managed worker hỗ trợ clip_cleanup nhận việc trong 5 phút. Cập nhật/khởi động worker rồi bấm Tiếp tục xử lý clip.';
    for (const job of jobs) {
      ctx.db.prepare("UPDATE jobs SET status='failed',error=?,error_code='OTHER',finished_at=? WHERE id=?").run(error, ctx.now(), job.id);
      logEvent(ctx, { project_id: job.project_id, type: 'clip.cleanup_timeout', message: `Job #${job.id}: ${error}` });
      emitJob(ctx, job.id, job.project_id);
      const request = parseJson<CleanupRequest>(job.payload, {} as CleanupRequest);
      emitClip(ctx, request.clip_id, job.project_id);
    }
    return jobs.map((j) => j.id);
  });
}

export function createCleanup(ctx: AppContext, clipId: number): number {
  return ctx.tx(() => {
    const clip = getClipRow(ctx, clipId);
    if (!isManagedJobType(ctx.config, 'clip_plan')) throw conflict('MANAGED_REQUIRED', 'Làm gọn cần managed worker nhận loại clip_plan');
    expireWaitingCleanup(ctx, clip.project_id);
    const { source, transcript } = requireTranscript(ctx, clip.project_id, clip.source_id);
    if (clip.status === 'rejected') throw conflict('INVALID_STATE', 'Khôi phục clip trước khi làm gọn');
    if (!sourceFileOk(ctx, source)) throw conflict('SOURCE_DELETED', 'Video gốc không còn để dựng bản làm gọn');
    if (!transcript.words.length) throw conflict('NO_SPEECH', 'Clip không có lời thoại');
    if (cleanupOf(clip)?.selected_ids.length) throw conflict('CLEANUP_APPLIED', 'Về bản chưa làm gọn trước khi nhờ AI đề xuất lại');
    const active = ctx.db.prepare("SELECT * FROM jobs WHERE project_id = ? AND type = 'clip_plan' AND status IN ('queued','claimed','running') LIMIT 1").get(clip.project_id) as JobRow | undefined;
    if (active) {
      const p = parseJson<CleanupRequest>(active.payload, {} as CleanupRequest);
      if (p.mode === 'cleanup' && p.clip_id === clip.id && p.edit_revision === clip.edit_revision) return active.id;
      throw conflict('JOB_ACTIVE', 'Dự án đang có yêu cầu AI đề xuất highlight hoặc làm gọn chưa xong');
    }
    const jobId = insertJob(ctx, { project_id: clip.project_id, scene_id: null, type: 'clip_plan', requires_approval: false, approved: false, payload: { mode: 'cleanup', clip_id: clip.id, source_id: source.id, edit_revision: clip.edit_revision } });
    logEvent(ctx, { project_id: clip.project_id, type: 'clip.cleanup_created', message: `Đang làm gọn bắt buộc ${clip.code} trước khi hiển thị` });
    emitClip(ctx, clip.id, clip.project_id); emitProject(ctx, clip.project_id);
    return jobId;
  });
}

function requestClip(ctx: AppContext, job: JobRow) {
  const p = parseJson<CleanupRequest>(job.payload, {} as CleanupRequest);
  const clip = getClipRow(ctx, p.clip_id);
  if (clip.project_id !== job.project_id || clip.source_id !== p.source_id || clip.edit_revision !== p.edit_revision) throw conflict('STALE_CLEANUP', 'Clip đã thay đổi; hãy nhờ AI làm gọn lại');
  return clip;
}
/** Từ ASR của mọi đoạn theo thứ tự phát (clip một đoạn: khoảng từ của clip). */
const clipWords = (t: { words: { i: number; w: string; start: number; end: number }[] }, clip: ClipRow) => clipParts(clip).flatMap((p) => t.words.slice(p.start_word, p.end_word + 1));
/** Các đoạn nguồn (giây) theo thứ tự phát: chỗ bỏ phải nằm trọn trong một đoạn. */
export const clipSpans = (clip: ClipRow): Segment[] => partSpans(clipParts(clip));

/**
 * Payload làm gọn cho worker: `words` = từ của mọi đoạn theo thứ tự phát, `parts` = các đoạn `{start_word,end_word,start_s,end_s}` theo thứ tự phát
 * (clip một đoạn: một phần tử). `start_s/end_s` là khung bao, giữ cho worker cũ.
 */
export function cleanupPayload(ctx: AppContext, job: JobRow) {
  const clip = requestClip(ctx, job);
  const { transcript } = requireTranscript(ctx, job.project_id, clip.source_id);
  const parts = clipParts(clip).map(({ start_word, end_word, start_s, end_s }) => ({ start_word, end_word, start_s, end_s }));
  return { mode: 'cleanup', clip_id: clip.id, source_id: clip.source_id, edit_revision: clip.edit_revision, start_s: clip.start_s, end_s: clip.end_s, parts, words: clipWords(transcript, clip) };
}
export function cleanupStale(ctx: AppContext, job: JobRow): string | null {
  try { requestClip(ctx, job); return null; } catch { return 'Clip đã đổi điểm cắt hoặc bản làm gọn, cần đề xuất lại'; }
}
export function completeCleanup(ctx: AppContext, job: JobRow, result: z.infer<typeof cleanupResult>) {
  const clip = requestClip(ctx, job);
  const { transcript } = requireTranscript(ctx, job.project_id, clip.source_id);
  let proposals;
  try { proposals = validateCleanupSpans(clipWords(transcript, clip), clipSpans(clip), result.proposals); }
  catch (e) { throw new AppError('INVALID_CLEANUP', e instanceof Error ? e.message : 'Đề xuất không hợp lệ', 400); }
  const cleanup: CleanupPlan = { job_id: job.id, revision: clip.edit_revision, proposals, selected_ids: proposals.map((p) => p.id) };
  ctx.db.prepare('UPDATE clips SET cleanup = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(cleanup), ctx.now(), clip.id);
  logEvent(ctx, { project_id: clip.project_id, type: 'clip.cleanup_proposed', message: `${clip.code}: đã làm gọn tự động ${proposals.length} chỗ; sẵn sàng xem và chỉnh tay` });
  emitClip(ctx, clip.id, clip.project_id); emitProject(ctx, clip.project_id);
}
export function applyCleanup(ctx: AppContext, clipId: number, body: z.infer<typeof cleanupApplyBody>) {
  return ctx.tx(() => {
    const clip = getClipRow(ctx, clipId);
    const cleanup = cleanupOf(clip);
    if (!cleanup || cleanup.job_id !== body.job_id || cleanup.revision !== body.revision || clip.edit_revision !== body.revision) throw conflict('STALE_CLEANUP', 'Đề xuất đã thay đổi; tải lại trước khi duyệt');
    const active = ctx.db.prepare("SELECT id FROM jobs WHERE project_id=? AND type='clip_plan' AND json_extract(payload,'$.mode')='cleanup' AND json_extract(payload,'$.clip_id')=? AND status IN ('queued','claimed','running') LIMIT 1").get(clip.project_id, clip.id);
    if (active) throw conflict('CLEANUP_RUNNING', 'AI đang làm gọn clip này; chờ xử lý xong trước khi lưu chỉnh sửa');
    try {
      if (body.edits?.length) {
        const { transcript } = requireTranscript(ctx, clip.project_id, clip.source_id);
        cleanup.proposals = editCleanupCutsSpans(clipWords(transcript, clip), clipSpans(clip), cleanup.proposals, body.edits);
      }
      cleanupSegmentsSpans(clipSpans(clip), cleanup.proposals, body.selected_ids);
    }
    catch (e) { throw new AppError('INVALID_CLEANUP', e instanceof Error ? e.message : 'Điểm bỏ không hợp lệ', 400); }
    cleanup.selected_ids = body.selected_ids;
    cleanup.revision++;
    ctx.db.prepare('UPDATE clips SET cleanup = ?, edit_revision = edit_revision + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(cleanup), ctx.now(), clip.id);
    logEvent(ctx, { project_id: clip.project_id, type: 'clip.cleanup_applied', message: `${clip.code}: đã lưu chỉnh sửa ${body.selected_ids.length} chỗ bỏ; áp dụng cho lần dựng tiếp theo` });
    emitClip(ctx, clip.id, clip.project_id); emitProject(ctx, clip.project_id);
    return getClipRow(ctx, clip.id);
  });
}

/** Mandatory pipeline continuation; at most one clip_plan per project, no inference in HTTP handlers. */
export function queueRequiredCleanup(ctx: AppContext, projectId: number, retry = false): number | null {
  return ctx.tx(() => {
    expireWaitingCleanup(ctx, projectId);
    if (!isManagedJobType(ctx.config, 'clip_plan')) return null;
    const project = ctx.db.prepare('SELECT deleted_at, source FROM projects WHERE id = ?').get(projectId) as { deleted_at: string | null; source: string } | undefined;
    if (!project || project.deleted_at) return null;
    const active = ctx.db.prepare("SELECT id FROM jobs WHERE project_id = ? AND type = 'clip_plan' AND status IN ('queued','claimed','running') LIMIT 1").get(projectId) as { id: number } | undefined;
    if (active) return active.id;
    for (const clip of projectClips(ctx, projectId)) {
      if (clip.cleanup || clip.status === 'rejected') continue;
      const source = getSourceRow(ctx, clip.source_id);
      if (source.status !== 'transcribed' || !sourceFileOk(ctx, source)) continue;
      const last = ctx.db.prepare("SELECT status FROM jobs WHERE project_id = ? AND type='clip_plan' AND json_extract(payload,'$.mode')='cleanup' AND json_extract(payload,'$.clip_id')=? AND json_extract(payload,'$.edit_revision')=? ORDER BY id DESC LIMIT 1").get(projectId, clip.id, clip.edit_revision) as { status: string } | undefined;
      if (!retry && last && ['failed', 'cancelled'].includes(last.status)) continue;
      if (project.source === 'lan') { try { assertLanQueueRoom(ctx); } catch { return null; } }
      return createCleanup(ctx, clip.id);
    }
    return null;
  });
}

/** Khoảng từ các đoạn của clip ghép để so với bản dựng; null = clip một đoạn (bản dựng cũ không có `parts`). */
const partsKey = (parts: { start_word: number; end_word: number }[] | null | undefined): string => (parts && parts.length > 1 ? JSON.stringify(parts.map((p) => [p.start_word, p.end_word])) : 'null');

/** A ready file remains historical when its cuts/captions no longer match the current clip. */
export function cutIsCurrent(clip: ClipRow, cut: Pick<ClipCutRow, 'edit_snapshot' | 'start_s' | 'end_s'>, segments?: Segment[]): boolean {
  const cleanup = cleanupOf(clip);
  if (!cleanup) return false;
  const retained = segments ?? cleanupSegmentsSpans(clipSpans(clip), cleanup.proposals, cleanup.selected_ids);
  const snapshot = parseJson<EditSnapshot | null>(cut.edit_snapshot, null);
  if (JSON.stringify(snapshot?.segments ?? [{ start: cut.start_s, end: cut.end_s }]) !== JSON.stringify(retained)) return false;
  if (partsKey(snapshot?.parts) !== partsKey(isMultiPart(clip) ? clipParts(clip) : null)) return false;
  // Legacy cuts lack a caption snapshot; user edits cannot be proven current until rendered again.
  return snapshot ? (snapshot.start_word === clip.start_word && snapshot.end_word === clip.end_word && JSON.stringify(snapshot.caption_words) === JSON.stringify(parseJson(clip.caption_words, null))) : clip.caption_source !== 'user';
}
