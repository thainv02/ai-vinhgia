/**
 * AI chọn đoạn: job `clip_plan` (managed worker, hoặc worker legacy theo WORKER.md). Server tạo job, tính payload lúc claim (câu, cửa sổ, preset), và
 * KIỂM TRA LẠI toàn bộ kết quả: AI chỉ trả ID câu; server ánh xạ ID → từ → giây (bám khoảng lặng), không bao giờ tin giây do AI viết.
 */
import { z } from 'zod';
import { cleanupPayload, cleanupStale, expireWaitingCleanup, isCleanupJob } from './cleanup.js';
import { resolveBoundaries, type ResolvedBoundary } from '../../lib/clip-boundaries.js';
import { clipParts, isMultiPart, MAX_CLIP_PARTS, partsDuration, partsOverlapRatio, type ClipPart } from '../../lib/clip-parts.js';
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { AppError, conflict } from '../../lib/errors.js';
import { insertJob } from '../job-create.js';
import { emitProject } from '../project-view.js';
import { getProject, logEvent, parseJson } from '../repo.js';
import { boundsForParts, insertClip, requireTranscript } from './clips.js';
import { getClipProject, projectClips } from './repo.js';
import { sourceFileOk } from './source.js';
import { buildWindows, validateCaptionWords, type Transcript } from './transcript.js';
import { emitClip } from './view.js';

export const DURATION_PRESET_KEYS = ['15_30', '30_60', '60_90', '90_180'] as const;
export type DurationPresetKey = (typeof DURATION_PRESET_KEYS)[number];

/** Khoảng độ dài cứng (giây) và khoảng lý tưởng của từng preset. Server nới ±20% khi kiểm tra kết quả. */
export const DURATION_PRESETS: Record<DurationPresetKey, { min_s: number; max_s: number; ideal_min_s: number; ideal_max_s: number }> = {
  '15_30': { min_s: 15, max_s: 30, ideal_min_s: 18, ideal_max_s: 28 },
  '30_60': { min_s: 30, max_s: 60, ideal_min_s: 38, ideal_max_s: 55 },
  '60_90': { min_s: 60, max_s: 90, ideal_min_s: 65, ideal_max_s: 85 },
  '90_180': { min_s: 90, max_s: 180, ideal_min_s: 100, ideal_max_s: 160 },
};
export const PRESET_TOLERANCE = 0.2;
export const PLAN_MAX_CLIPS = 15;
/** Clip ghép do AI đề xuất: 2–4 đoạn (người dùng tự ghép được tới MAX_CLIP_PARTS). */
export const AI_MAX_PARTS = 4;

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export const clipPlanBody = z.object({
  count: z.number().int().min(1).max(PLAN_MAX_CLIPS).default(5),
  duration_preset: z.enum(DURATION_PRESET_KEYS).default('30_60'),
  focus: z.string().trim().max(300, 'tối đa 300 ký tự').refine(noControl, 'không được chứa ký tự điều khiển').optional(),
  exclude_existing: z.boolean().default(false),
  /** Cho phép AI đề xuất thêm clip ghép nhiều đoạn (montage). */
  allow_multi: z.boolean().default(true),
});
export type ClipPlanBody = z.infer<typeof clipPlanBody>;

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** `POST /api/projects/:id/clip-plan`: tạo job `clip_plan`. Chỉ khi video đã nhận dạng xong, còn file, có lời; mỗi dự án một job đang chạy. */
export function createClipPlan(ctx: AppContext, projectId: number, body: ClipPlanBody): number {
  return ctx.tx(() => {
    const project = getClipProject(ctx, projectId);
    expireWaitingCleanup(ctx, projectId);
    const { source, transcript } = requireTranscript(ctx, projectId);
    if (!transcript.words.length) throw conflict('NO_SPEECH', 'Video không có lời thoại nên AI không đề xuất highlight được');
    if (!sourceFileOk(ctx, source)) throw conflict('SOURCE_DELETED', 'Video gốc đã bị xoá nên không đề xuất highlight mới được (vẫn xem được transcript và các clip đã dựng)');
    const active = ctx.db.prepare("SELECT id FROM jobs WHERE project_id = ? AND type = 'clip_plan' AND status IN ('queued','claimed','running') LIMIT 1").get(projectId);
    if (active) throw conflict('JOB_ACTIVE', 'Dự án đang có yêu cầu AI đề xuất highlight chưa xong');
    const jobId = insertJob(ctx, {
      project_id: project.id,
      scene_id: null,
      type: 'clip_plan',
      requires_approval: false,
      approved: false,
      payload: { source_id: source.id, count: body.count, duration_preset: body.duration_preset, focus: body.focus ?? '', exclude_existing: body.exclude_existing, allow_multi: body.allow_multi },
    });
    logEvent(ctx, { project_id: project.id, type: 'clip.plan_created', message: `Yêu cầu AI đề xuất ${body.count} highlight (${body.duration_preset.replace('_', '–')} giây)${body.focus ? `, tập trung: ${body.focus.slice(0, 80)}` : ''}${body.exclude_existing ? ', loại trừ đoạn đã có' : ''}${body.allow_multi ? '' : ', không ghép nhiều đoạn'}` });
    emitProject(ctx, project.id);
    return jobId;
  });
}

/** Job `clip_plan` không còn hợp lệ (video chưa/không còn nhận dạng xong, bị xoá): hủy lúc claim. */
export function clipPlanStale(ctx: AppContext, job: JobRow): string | null {
  if (isCleanupJob(job)) { const stale = cleanupStale(ctx, job); if (stale) return stale; }
  const p = parseJson<{ source_id?: number }>(job.payload, {});
  const row = p.source_id ? (ctx.db.prepare('SELECT status, path, deleted_at FROM source_videos WHERE id = ?').get(p.source_id) as { status: string; path: string | null; deleted_at: string | null } | undefined) : undefined;
  if (!row || row.status !== 'transcribed') return 'Video nguồn không còn ở trạng thái đã nhận dạng';
  if (row.deleted_at) return 'Video gốc đã bị xoá';
  return null;
}

/**
 * Payload của job `clip_plan` (tính lúc claim, ghi đè cột payload):
 * `{source, sentences:[{id,start,end,start_word,text}], windows:[{from_id,to_id}], count, duration_preset:{key,min_s,max_s,ideal_*}, focus, existing:[{start_id,end_id,title,parts?}], allow_multi, content_hint, ...}`.
 * `existing[].parts` (chỉ clip ghép): `[{start_id,end_id,start_word,end_word}]` theo thứ tự phát. Job cũ không có `allow_multi` coi như cho phép.
 * `windows` dài 15–20 phút, chồng 60 giây, tính theo ID câu. `focus` và `content_hint` là DỮ LIỆU của người dùng.
 */
export function clipPlanPayloadFor(ctx: AppContext, job: JobRow): Record<string, unknown> {
  if (isCleanupJob(job)) return cleanupPayload(ctx, job);
  const stored = parseJson<{ count?: number; duration_preset?: DurationPresetKey | { key?: DurationPresetKey }; focus?: string; exclude_existing?: boolean; allow_multi?: boolean }>(job.payload, {});
  const project = getProject(ctx, job.project_id);
  const { source, transcript } = requireTranscript(ctx, job.project_id);
  // lần claim đầu: chuỗi preset do người dùng chọn; các lần claim lại (job được trả về hàng đợi): đối tượng {key,...} đã tính
  const wanted = typeof stored.duration_preset === 'string' ? stored.duration_preset : stored.duration_preset?.key;
  const key: DurationPresetKey = wanted && wanted in DURATION_PRESETS ? wanted : '30_60';
  const existing = stored.exclude_existing
    ? projectClips(ctx, project.id).map((c) => ({
      start_id: c.start_sentence,
      end_id: c.end_sentence,
      title: c.title ?? '',
      ...(isMultiPart(c) ? { parts: clipParts(c).map((p) => ({ start_id: p.start_sentence ?? c.start_sentence, end_id: p.end_sentence ?? c.end_sentence, start_word: p.start_word, end_word: p.end_word })) } : {}),
    }))
    : [];
  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    /** Giữ ở cấp trên cùng: các lần claim lại (job trả về hàng đợi) đọc lại từ payload đã tính để kiểm tra video nguồn còn hợp lệ. */
    source_id: source.id,
    source: { id: source.id, path: source.path, duration_s: source.duration_s, width: source.width, height: source.height },
    sentences: transcript.sentences.map((s) => ({ id: s.id, start: round2(s.start), end: round2(s.end), start_word: s.start_word, text: s.text, words: transcript.words.slice(s.start_word, s.end_word + 1).map(({ i, start, end }) => ({ i, start, end })) })),
    windows: buildWindows(transcript.sentences),
    count: Math.max(1, Math.min(PLAN_MAX_CLIPS, stored.count ?? 5)),
    duration_preset: { key, ...DURATION_PRESETS[key] },
    focus: (stored.focus ?? '').slice(0, 300),
    exclude_existing: !!stored.exclude_existing,
    allow_multi: stored.allow_multi !== false,
    existing,
    content_hint: [`Tên dự án: ${project.name}`, project.stt_terms ? `Tên riêng/thuật ngữ hay xuất hiện: ${project.stt_terms}` : ''].filter(Boolean).join('. '),
    speech_ratio: transcript.speech_ratio,
    requeued: job.requeue_count > 0,
  };
}

// ---------------------------------------------------------------- kết quả

const verifySchema = z
  .looseObject({
    status: z.enum(['kept', 'unverified', 'repaired']).optional(),
    keep: z.boolean().optional(),
    standalone_score: z.number().min(0).max(1).nullable().optional(),
    diagnosis: z.string().max(60).nullable().optional(),
    repaired: z.boolean().optional(),
  })
  .optional();

const boundaryShape = { start_id: z.number().int(), end_id: z.number().int(), start_word: z.number().int().nonnegative().optional(), end_word: z.number().int().nonnegative().optional(), start_quote: z.string().max(200).optional(), end_quote: z.string().max(200).optional() };
export const clipPlanResult = z.looseObject({
  /** Clip ghép: `parts` theo thứ tự phát (AI: 2–4 đoạn); khi có thì start_id/end_id ở ngoài chỉ để tham khảo (khung bao). */
  clips: z.array(z.looseObject({ ...boundaryShape, parts: z.array(z.looseObject(boundaryShape)).min(1).max(MAX_CLIP_PARTS).optional() })).max(60),
  summary: z.string().trim().min(1, 'cần tóm tắt 1–3 câu').max(2000),
  not_found_reason: z.string().trim().max(1000).optional(),
});

interface RawBoundary {
  start_id: number;
  end_id: number;
  start_word?: number;
  end_word?: number;
  start_quote?: string;
  end_quote?: string;
}

interface RawClip extends RawBoundary {
  parts?: RawBoundary[];
  title?: unknown;
  hook?: unknown;
  score?: unknown;
  reason?: unknown;
  content_type?: unknown;
  verify?: unknown;
  caption_words?: unknown;
}

export interface AcceptedClip {
  start_word: number;
  end_word: number;
  start_sentence: number;
  end_sentence: number;
  start_s: number;
  end_s: number;
  /** Clip ghép: các đoạn theo thứ tự phát; null = một đoạn (khi đó các trường trên là của chính đoạn đó, không phải khung bao). */
  parts: ClipPart[] | null;
  title: string | null;
  hook: string | null;
  score: number | null;
  reason: string | null;
  content_type: string | null;
  verify: Record<string, unknown>;
  caption_words: { i: number; w: string }[] | null;
}

/** Khoảng từ của đề xuất/clip để so chồng nhau (clip một đoạn: một khoảng). */
type Ranged = { start_word: number; end_word: number; parts?: { start_word: number; end_word: number }[] | null };
const rangesOf = (c: Ranged) => (c.parts && c.parts.length > 1 ? c.parts : [c]);

/** `caption_words` của clip ghép: khớp từ ASR của từng đoạn nối theo thứ tự phát; lệch ở đâu cũng bỏ toàn bộ (dùng chữ ASR). */
function validatePartsCaptionWords(t: Transcript, parts: { start_word: number; end_word: number }[], raw: unknown): { i: number; w: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { i: number; w: string }[] = [];
  let at = 0;
  for (const p of parts) {
    const n = p.end_word - p.start_word + 1;
    const ok = validateCaptionWords(t, p.start_word, p.end_word, raw.slice(at, at + n));
    if (!ok) return null;
    out.push(...ok);
    at += n;
  }
  return at === raw.length ? out : null;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : null);

/** Phần chồng nhau của hai đoạn từ, chia cho độ dài đoạn ngắn hơn (0–1). */
export function overlapRatio(a: { start_word: number; end_word: number }, b: { start_word: number; end_word: number }): number {
  const inter = Math.min(a.end_word, b.end_word) - Math.max(a.start_word, b.start_word) + 1;
  if (inter <= 0) return 0;
  return inter / Math.min(a.end_word - a.start_word + 1, b.end_word - b.start_word + 1);
}

/**
 * Kiểm tra lại từng đề xuất của AI. Nhận: ID câu tồn tại, `start_id ≤ end_id`, độ dài (sau bám khoảng lặng) trong khoảng cứng của preset ±20% (và 3–300 giây),
 * không chồng > 60% với đề xuất đã nhận hay clip có sẵn (khi `exclude_existing`). `caption_words` chỉ được nhận nếu GIỮ NGUYÊN dãy từ ASR (xem `validateCaptionWords`);
 * sai thì bỏ riêng phần này (clip vẫn dùng chữ ASR). Điểm cắt (giây) luôn do server tính từ chỉ số từ.
 * Clip ghép (`parts`, 2–4 đoạn theo thứ tự phát): từng đoạn qua cùng bộ dò câu trích, kiểm tra như clip ghép tạo tay (`boundsForParts`),
 * độ dài là TỔNG các đoạn, chồng nhau tính theo `partsOverlapRatio`, `caption_words` khớp từ ASR các đoạn nối theo thứ tự phát.
 */
export function validateClipPlan(
  t: Transcript,
  clips: RawClip[],
  o: { preset?: { min_s: number; max_s: number } | null; max?: number; existing?: Ranged[]; allowMulti?: boolean },
): { accepted: AcceptedClip[]; rejected: { index: number; reason: string }[] } {
  const accepted: AcceptedClip[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const byId = new Map(t.sentences.map((s) => [s.id, s]));
  const boundarySentences = t.sentences.map((s) => ({ ...s, words: t.words.slice(s.start_word, s.end_word + 1) }));
  clips.forEach((raw, index) => {
    if (accepted.length >= (o.max ?? PLAN_MAX_CLIPS)) return void rejected.push({ index, reason: 'vượt số lượng yêu cầu' });
    const multi = !!raw.parts && raw.parts.length > 1;
    if (multi && o.allowMulti === false) return void rejected.push({ index, reason: 'người dùng không cho ghép nhiều đoạn' });
    if (multi && raw.parts!.length > AI_MAX_PARTS) return void rejected.push({ index, reason: `clip ghép tối đa ${AI_MAX_PARTS} đoạn` });
    // `parts` một phần tử = clip một đoạn
    const ranges: RawBoundary[] = raw.parts?.length ? raw.parts : [raw];
    const resolved: ResolvedBoundary[] = [];
    for (const [k, c] of ranges.entries()) {
      const at = multi ? `Đoạn ${k + 1}: ` : '';
      if (!byId.has(c.start_id) || !byId.has(c.end_id)) return void rejected.push({ index, reason: `${at}ID câu không tồn tại (${c.start_id}–${c.end_id})` });
      if (c.start_id > c.end_id) return void rejected.push({ index, reason: `${at}start_id (${c.start_id}) lớn hơn end_id (${c.end_id})` });
      const r = resolveBoundaries(boundarySentences, c);
      if (!r) return void rejected.push({ index, reason: `${at}Điểm từ không khớp ID câu / câu trích` });
      resolved.push(r);
    }
    let b: ReturnType<typeof boundsForParts>;
    try {
      b = boundsForParts(t, resolved);
    } catch (e) {
      return void rejected.push({ index, reason: e instanceof AppError ? e.message : String(e) });
    }
    const len = b.parts ? partsDuration(b.parts) : b.end_s - b.start_s;
    if (o.preset && (len < o.preset.min_s * (1 - PRESET_TOLERANCE) || len > o.preset.max_s * (1 + PRESET_TOLERANCE))) {
      return void rejected.push({ index, reason: `${b.parts ? 'tổng ' : ''}độ dài ${len.toFixed(1)} giây ngoài khoảng ${o.preset.min_s}–${o.preset.max_s} giây` });
    }
    const cand = b.parts ?? [{ start_word: b.start_word, end_word: b.end_word }];
    const clash = [...accepted, ...(o.existing ?? [])].find((x) => partsOverlapRatio(cand, rangesOf(x)) > 0.6);
    if (clash) return void rejected.push({ index, reason: 'chồng quá 60% với đoạn đã có' });
    const v = verifySchema.safeParse(raw.verify);
    const verify = v.success && v.data ? v.data : {};
    const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? Math.max(0, Math.min(100, Math.round(raw.score))) : null;
    accepted.push({
      start_word: b.start_word,
      end_word: b.end_word,
      start_sentence: b.start_sentence,
      end_sentence: b.end_sentence,
      start_s: b.start_s,
      end_s: b.end_s,
      parts: b.parts,
      title: str(raw.title, 200),
      hook: str(raw.hook, 200),
      score,
      reason: str(raw.reason, 1000),
      content_type: str(raw.content_type, 40),
      // chưa kiểm định thì ghi rõ `unverified` (KHÔNG tự coi là đạt)
      verify: { ...verify, status: verify.status ?? 'unverified', boundary: resolved.every((r) => r.boundary === 'word_quote') ? 'word_quote' : 'sentence_fallback' },
      caption_words: b.parts ? validatePartsCaptionWords(t, b.parts, raw.caption_words) : validateCaptionWords(t, b.start_word, b.end_word, raw.caption_words),
    });
  });
  return { accepted, rejected };
}

/**
 * Worker hoàn thành `clip_plan`: kiểm tra lại, rồi tạo các clip `proposed` (mã K<n> nối tiếp). Có đề xuất mà TẤT CẢ đều sai → 400 `INVALID_CLIP_PLAN`
 * (job giữ nguyên để worker sửa và gọi lại, như `INVALID_EDL`). Mảng rỗng là hợp lệ ("không có đoạn nào đạt"). Trả `{created, rejected}`.
 */
export function completeClipPlanJob(ctx: AppContext, job: JobRow, result: z.infer<typeof clipPlanResult>): { created: number; rejected: { index: number; reason: string }[] } {
  const { source, transcript } = requireTranscript(ctx, job.project_id);
  const project = getClipProject(ctx, job.project_id);
  const payload = parseJson<{ duration_preset?: { min_s?: number; max_s?: number } | string; count?: number; exclude_existing?: boolean; allow_multi?: boolean }>(job.payload, {});
  const preset = payload.duration_preset && typeof payload.duration_preset === 'object' && typeof payload.duration_preset.min_s === 'number' && typeof payload.duration_preset.max_s === 'number'
    ? { min_s: payload.duration_preset.min_s, max_s: payload.duration_preset.max_s }
    : typeof payload.duration_preset === 'string' && payload.duration_preset in DURATION_PRESETS
      ? DURATION_PRESETS[payload.duration_preset as DurationPresetKey]
      : null;
  const existing = payload.exclude_existing ? projectClips(ctx, project.id).map((c) => ({ start_word: c.start_word, end_word: c.end_word, parts: clipParts(c) })) : [];
  const { accepted, rejected } = validateClipPlan(transcript, result.clips as RawClip[], { preset, max: payload.count ?? PLAN_MAX_CLIPS, existing, allowMulti: payload.allow_multi !== false });
  if (result.clips.length > 0 && accepted.length === 0) {
    throw new AppError('INVALID_CLIP_PLAN', `Kết quả chọn đoạn không hợp lệ — ${rejected.slice(0, 5).map((r) => `#${r.index + 1}: ${r.reason}`).join('; ')}`, 400, { rejected });
  }
  const created = accepted.map((c) =>
    insertClip(ctx, project, source, transcript, {
      start_word: c.start_word,
      end_word: c.end_word,
      parts: c.parts,
      title: c.title,
      hook: c.hook,
      score: c.score,
      reason: c.reason,
      content_type: c.content_type,
      verify: c.verify,
      created_by: 'agent',
      job_id: job.id,
      caption_words: c.caption_words,
      caption_source: 'ai',
    }),
  );
  logEvent(ctx, {
    project_id: project.id,
    type: 'clip.plan_done',
    message: created.length
      ? `AI đã đề xuất ${created.length} clip (${created.map((c) => c.code).join(', ')})${rejected.length ? `; bỏ ${rejected.length} đề xuất không hợp lệ` : ''} — ${result.summary.slice(0, 200)}`
      : `AI không chọn được đoạn nào${result.not_found_reason ? `: ${result.not_found_reason.slice(0, 200)}` : ''}`,
  });
  for (const c of created) emitClip(ctx, c.id, project.id);
  emitProject(ctx, project.id);
  return { created: created.length, rejected };
}

