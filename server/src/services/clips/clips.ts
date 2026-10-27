/**
 * Clip: tạo tay, duyệt/sửa điểm cắt bằng chỉ số từ (server tính lại câu và giây theo quy tắc bám khoảng lặng), sửa chữ phụ đề, ảnh đại diện, ZIP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { CLIP_STATUSES, type ClipRow, type ProjectRow, type SourceVideoRow } from '../../db/types.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { run } from '../final-render/ffmpeg-renderer.js';
import { ffmpegOf } from '../media.js';
import { emitProject } from '../project-view.js';
import { logEvent } from '../repo.js';
import type { ZipEntry } from '../zip.js';
import { abs, getClipProject, getClipRow, getSourceRow, projectClips, projectSource, readTranscript, thumbRel, thumbsDirRel } from './repo.js';
import { sourceFileOk } from './source.js';
import { sentenceOfWord, snapBounds, type Transcript } from './transcript.js';
import { captionWordsOf, emitClip } from './view.js';

export const CLIP_MIN_S = 3;
export const CLIP_MAX_S = 300;
export const CAPTION_WORD_MAX_CHARS = 60;

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const title = z.string().trim().max(200).refine(noControl, 'tiêu đề không được chứa ký tự điều khiển');
const wordIdx = z.number().int().min(0);

export const patchClipBody = z.object({ status: z.enum(CLIP_STATUSES), title, start_word: wordIdx, end_word: wordIdx }).partial();
export const createClipBody = z.object({ start_word: wordIdx, end_word: wordIdx, title: title.optional() });
export const captionsBody = z.object({
  words: z
    .array(z.object({ i: wordIdx, w: z.string().max(CAPTION_WORD_MAX_CHARS * 2).refine(noControl, 'không được chứa ký tự điều khiển') }))
    .min(1)
    .max(5000),
});

/** Transcript của dự án (409 `NOT_TRANSCRIBED` nếu video chưa nhận dạng xong). */
export function requireTranscript(ctx: AppContext, projectId: number): { source: SourceVideoRow; transcript: Transcript } {
  const source = projectSource(ctx, projectId);
  if (!source) throw conflict('NO_SOURCE', 'Dự án chưa có video nguồn');
  const transcript = source.status === 'transcribed' ? readTranscript(ctx, source) : null;
  if (!transcript) throw conflict('NOT_TRANSCRIBED', 'Video chưa được nhận dạng lời nói xong');
  return { source, transcript };
}

export function nextClipCode(ctx: AppContext, projectId: number): string {
  const rows = ctx.db.prepare('SELECT code FROM clips WHERE project_id = ?').all(projectId) as { code: string }[];
  let max = 0;
  for (const r of rows) {
    const m = /^K(\d+)$/.exec(r.code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `K${max + 1}`;
}

/** Kiểm tra khoảng từ và tính điểm cắt bám khoảng lặng. 400 nếu chỉ số sai hoặc độ dài ngoài 3–300 giây. */
export function boundsFor(t: Transcript, startWord: number, endWord: number) {
  if (!(startWord >= 0 && endWord >= startWord && endWord < t.words.length)) {
    throw badRequest('INVALID_WORD_RANGE', `Chỉ số từ không hợp lệ (0–${Math.max(0, t.words.length - 1)}, từ đầu ≤ từ cuối)`);
  }
  const { start_s, end_s } = snapBounds(t, startWord, endWord);
  const len = end_s - start_s;
  if (len < CLIP_MIN_S || len > CLIP_MAX_S) {
    throw new AppError('CLIP_LENGTH', `Clip dài ${len.toFixed(1).replace('.', ',')} giây; phải dài từ ${CLIP_MIN_S} đến ${CLIP_MAX_S} giây`, 400, { duration_s: len, min_s: CLIP_MIN_S, max_s: CLIP_MAX_S });
  }
  return { start_s, end_s, start_sentence: sentenceOfWord(t, startWord)!.id, end_sentence: sentenceOfWord(t, endWord)!.id };
}

export interface NewClip {
  start_word: number;
  end_word: number;
  title?: string | null;
  hook?: string | null;
  score?: number | null;
  reason?: string | null;
  content_type?: string | null;
  verify?: Record<string, unknown> | null;
  created_by: 'agent' | 'user';
  job_id?: number | null;
  caption_words?: { i: number; w: string }[] | null;
  caption_source?: 'ai' | 'user' | null;
}

/** Thêm một clip (đã kiểm tra khoảng từ). Dùng cho tạo tay và cho kết quả `clip_plan`. */
export function insertClip(ctx: AppContext, project: ProjectRow, source: SourceVideoRow, t: Transcript, c: NewClip): ClipRow {
  const b = boundsFor(t, c.start_word, c.end_word);
  const code = nextClipCode(ctx, project.id);
  const now = ctx.now();
  const info = ctx.db
    .prepare(
      `INSERT INTO clips (project_id, source_id, code, status, start_sentence, end_sentence, start_word, end_word, start_s, end_s, title, hook, score, reason, content_type, verify, created_by, job_id, caption_words, caption_source, created_at, updated_at)
       VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      source.id,
      code,
      b.start_sentence,
      b.end_sentence,
      c.start_word,
      c.end_word,
      b.start_s,
      b.end_s,
      c.title ?? null,
      c.hook ?? null,
      c.score ?? null,
      c.reason ?? null,
      c.content_type ?? null,
      c.verify ? JSON.stringify(c.verify) : null,
      c.created_by,
      c.job_id ?? null,
      c.caption_words ? JSON.stringify(c.caption_words) : null,
      c.caption_words ? (c.caption_source ?? 'ai') : null,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  ctx.afterCommit(() => queueThumb(ctx, id));
  return getClipRow(ctx, id);
}

/** `POST /api/projects/:id/clips`: clip tạo tay từ khoảng từ (người dùng bôi đen lời thoại). */
export function createManualClip(ctx: AppContext, projectId: number, body: z.infer<typeof createClipBody>): ClipRow {
  return ctx.tx(() => {
    const project = getClipProject(ctx, projectId);
    const { source, transcript } = requireTranscript(ctx, projectId);
    const clip = insertClip(ctx, project, source, transcript, {
      start_word: body.start_word,
      end_word: body.end_word,
      title: body.title || `Đoạn tự chọn ${nextClipCode(ctx, projectId)}`,
      created_by: 'user',
    });
    ctx.db.prepare("UPDATE clips SET status = 'approved' WHERE id = ?").run(clip.id); // người dùng tự tạo = đã duyệt
    logEvent(ctx, { project_id: projectId, type: 'clip.created', message: `Tạo clip ${clip.code} từ khoảng lời thoại do người dùng chọn` });
    emitClip(ctx, clip.id, projectId);
    emitProject(ctx, projectId);
    return getClipRow(ctx, clip.id);
  });
}

/**
 * Giữ lại chữ phụ đề đã có khi điểm cắt đổi: từ nào còn nằm trong khoảng mới thì giữ chữ cũ, từ mới thêm thì dùng chữ ASR.
 * Không có chữ đã sửa thì trả null (dùng ASR).
 */
function carryCaptionWords(old: { i: number; w: string }[] | null, t: Transcript, sw: number, ew: number): { i: number; w: string }[] | null {
  if (!old) return null;
  const byIdx = new Map(old.map((w) => [w.i, w.w]));
  const out: { i: number; w: string }[] = [];
  for (let i = sw; i <= ew; i++) out.push({ i, w: byIdx.get(i) ?? t.words[i]!.w });
  return out;
}

/** `PATCH /api/clips/:id`: đổi trạng thái/tiêu đề/điểm cắt (chỉ số từ). Điểm cắt đổi → tính lại câu và giây theo quy tắc bám, ảnh đại diện dựng lại. */
export function patchClip(ctx: AppContext, id: number, body: z.infer<typeof patchClipBody>): ClipRow {
  return ctx.tx(() => {
    const row = getClipRow(ctx, id);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    let rangeChanged = false;
    if (body.title !== undefined) {
      sets.push('title = ?');
      args.push(body.title || null);
    }
    if (body.status !== undefined) {
      sets.push('status = ?');
      args.push(body.status);
    }
    if (body.start_word !== undefined || body.end_word !== undefined) {
      const sw = body.start_word ?? row.start_word;
      const ew = body.end_word ?? row.end_word;
      if (sw !== row.start_word || ew !== row.end_word) {
        const { transcript } = requireTranscript(ctx, row.project_id);
        const b = boundsFor(transcript, sw, ew);
        sets.push('start_word = ?', 'end_word = ?', 'start_s = ?', 'end_s = ?', 'start_sentence = ?', 'end_sentence = ?');
        args.push(sw, ew, b.start_s, b.end_s, b.start_sentence, b.end_sentence);
        const carried = carryCaptionWords(captionWordsOf(row), transcript, sw, ew);
        sets.push('caption_words = ?');
        args.push(carried ? JSON.stringify(carried) : null);
        rangeChanged = true;
      }
    }
    if (!sets.length) return row;
    sets.push('updated_at = ?');
    args.push(ctx.now());
    ctx.db.prepare(`UPDATE clips SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    const after = getClipRow(ctx, id);
    logEvent(ctx, {
      project_id: row.project_id,
      type: 'clip.updated',
      message: `Clip ${row.code}: ${[body.status ? `trạng thái ${body.status}` : '', body.title !== undefined ? 'đổi tiêu đề' : '', rangeChanged ? `đổi điểm cắt (từ ${after.start_word}–${after.end_word}, ${after.start_s}–${after.end_s}s)` : ''].filter(Boolean).join(', ')}`,
    });
    if (rangeChanged) ctx.afterCommit(() => queueThumb(ctx, id));
    emitClip(ctx, id, row.project_id);
    return after;
  });
}

/**
 * `PUT /api/clips/:id/captions`: sửa chữ của từng từ, giữ mốc thời gian. Chuỗi rỗng nghĩa là ẩn từ. Từ thêm vào được gộp vào từ cạnh nó
 * ("ca cao a tiso" → sửa "ca"="Cacao", "cao"="", "a"="Actiso", "tiso"=""). Chỉ số phải nằm trong khoảng từ của clip.
 */
export function putCaptions(ctx: AppContext, id: number, body: z.infer<typeof captionsBody>): ClipRow {
  return ctx.tx(() => {
    const row = getClipRow(ctx, id);
    const { transcript } = requireTranscript(ctx, row.project_id);
    const map = new Map<number, string>();
    const cur = captionWordsOf(row);
    for (let i = row.start_word; i <= row.end_word; i++) map.set(i, transcript.words[i]!.w);
    for (const w of cur ?? []) if (map.has(w.i)) map.set(w.i, w.w);
    for (const w of body.words) {
      if (w.i < row.start_word || w.i > row.end_word) throw badRequest('INVALID_WORD_RANGE', `Từ số ${w.i} nằm ngoài clip ${row.code} (${row.start_word}–${row.end_word})`);
      const text = w.w.replace(/\s+/g, ' ').trim();
      if (text.length > CAPTION_WORD_MAX_CHARS) throw badRequest('VALIDATION_ERROR', `Chữ phụ đề tối đa ${CAPTION_WORD_MAX_CHARS} ký tự`);
      map.set(w.i, text);
    }
    const words = [...map].sort((a, b) => a[0] - b[0]).map(([i, w]) => ({ i, w }));
    ctx.db.prepare("UPDATE clips SET caption_words = ?, caption_source = 'user', updated_at = ? WHERE id = ?").run(JSON.stringify(words), ctx.now(), id);
    logEvent(ctx, { project_id: row.project_id, type: 'clip.captions', message: `Clip ${row.code}: sửa chữ phụ đề (${body.words.length} từ)` });
    emitClip(ctx, id, row.project_id);
    return getClipRow(ctx, id);
  });
}

// ---------------------------------------------------------------- ảnh đại diện

const chains = new WeakMap<AppContext, Promise<void>>();

/** Dựng ảnh đại diện `thumbs/<code>.jpg` (khung ở 40% clip), tuần tự để không bật nhiều ffmpeg cùng lúc. Lỗi thì bỏ qua. */
export function queueThumb(ctx: AppContext, clipId: number): void {
  const prev = chains.get(ctx) ?? Promise.resolve();
  const next = prev.then(() => makeThumb(ctx, clipId)).catch(() => undefined);
  chains.set(ctx, next);
}

/** Chờ mọi ảnh đại diện đang xếp hàng (test). */
export const thumbsIdle = (ctx: AppContext): Promise<void> => chains.get(ctx) ?? Promise.resolve();

export async function makeThumb(ctx: AppContext, clipId: number): Promise<void> {
  let row: ClipRow;
  let source: SourceVideoRow;
  let slug: string;
  try {
    row = getClipRow(ctx, clipId);
    source = getSourceRow(ctx, row.source_id);
    slug = (ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').get(row.project_id) as { slug: string }).slug;
  } catch {
    return; // dự án đã xoá / vào thùng rác / DB đã đóng
  }
  const bin = ffmpegOf(ctx.config);
  if (!bin || !sourceFileOk(ctx, source)) return;
  const rel = thumbRel(slug, row.code);
  const out = abs(ctx, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = path.join(abs(ctx, thumbsDirRel(slug)), `.${row.code}.${process.pid}.tmp.jpg`);
  const at = row.start_s + (row.end_s - row.start_s) * 0.4;
  try {
    await run(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', abs(ctx, source.path!), '-frames:v', '1', '-vf', 'scale=360:-2', tmp], new AbortController().signal);
    fs.renameSync(tmp, out); // thumb là bản sinh ra từ điểm cắt hiện tại nên được thay thế khi điểm cắt đổi
    emitClip(ctx, clipId, row.project_id);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------- ZIP

/** Các mục ZIP: mọi clip có bản dựng `ready` mới nhất (mp4 + srt). Tên `K1_tieu-de_v2.mp4`. */
export function clipsZipEntries(ctx: AppContext, projectId: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (const c of projectClips(ctx, projectId)) {
    const cut = ctx.db.prepare("SELECT * FROM clip_cuts WHERE clip_id = ? AND status = 'ready' ORDER BY version DESC LIMIT 1").get(c.id) as { video_path: string | null; srt_path: string | null; version: number } | undefined;
    if (!cut?.video_path || !fs.existsSync(abs(ctx, cut.video_path))) continue;
    const base = `${c.code}_${asciiSlug(c.title ?? '') || 'clip'}_v${cut.version}`;
    const video = abs(ctx, cut.video_path);
    entries.push({ name: `${base}.mp4`, read: () => fs.readFileSync(video) });
    if (cut.srt_path && fs.existsSync(abs(ctx, cut.srt_path))) {
      const srt = abs(ctx, cut.srt_path);
      entries.push({ name: `${base}.srt`, read: () => fs.readFileSync(srt) });
    }
  }
  return entries;
}

const asciiSlug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
