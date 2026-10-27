import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isManagedJobType } from '../config.js';
import type { AppContext } from '../context.js';
import type { FinalCutRow, JobRow } from '../db/types.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  type Edl,
  editPlanPayload,
  emitFinalCut,
  type FinalCutRevision,
  getFinalCutRow,
  insertCut,
  type SelectionItem,
  updateCut,
  validateEdl,
  completeEditPlan,
} from './final-cuts.js';
import {
  type ColorMatch,
  type Grade,
  GRADE_RANGES,
  gradeChips,
  gradesEqual,
  isNeutralGrade,
  neutralGrade,
  normalizeGrade,
  outRanges,
  parseStoredGrade,
} from './grade.js';
import { colorRefKinds, colorRefOfGrade } from './color-refs.js';
import { insertJob } from './job-create.js';
import { emitProject } from './project-view.js';
import { getProject, logEvent, parseJson } from './repo.js';

/**
 * Góp ý cho AI sau "Edit tự động" và chỉnh màu thủ công. Mỗi lần tạo PHIÊN BẢN MỚI (không bao giờ ghi đè bản cũ):
 * `parent_id` = bản đang xem, `feedback` = góp ý, job `edit_plan` mang `payload.revision`. AI trả `{edl|null, grade, summary, not_done}`.
 * Chỉ đổi màu (EDL không đổi) → KHÔNG render lại, KHÔNG xoá logo lại: lấy bản sạch chưa chỉnh màu của bản cha rồi chạy bước chỉnh màu.
 * EDL đổi → render → xoá logo → chỉnh màu. Chỉnh màu luôn chạy SAU xoá logo.
 */

export const FEEDBACK_MAX_CHARS = 1000;
export const feedbackBody = z.object({ feedback: z.string().trim().min(1, 'cần nhập góp ý').max(FEEDBACK_MAX_CHARS, `tối đa ${FEEDBACK_MAX_CHARS} ký tự`) });
export const gradeBody = z.object({ grade: z.unknown(), note: z.string().trim().max(500).optional() });

/** Số góp ý gần nhất (theo chuỗi bản cha) đưa vào payload để "ấm hơn nữa" được hiểu tương đối. */
export const FEEDBACK_HISTORY = 5;

const sceneIdsOf = (selection: SelectionItem[]): number[] => selection.map((s) => s.scene_id);

/** `match.ref_id` đã qua `normalizeGrade` (thuộc dự án); thêm: file ảnh mẫu/LUT còn trên đĩa, để báo lỗi ngay thay vì thất bại ở bước dựng. */
export function assertMatchRefUsable(ctx: AppContext, projectId: number, grade: Grade): void {
  if (!grade.match) return;
  const row = ctx.db.prepare('SELECT file_path, original_name FROM color_refs WHERE id = ? AND project_id = ?').get(grade.match.ref_id, projectId) as { file_path: string; original_name: string | null } | undefined;
  if (!row || !fs.existsSync(path.join(ctx.config.rootDir, row.file_path))) {
    throw conflict('FILE_MISSING', `Không thấy file của ${grade.match.kind === 'lut' ? 'file LUT' : 'ảnh mẫu'} «${(row?.original_name ?? `#${grade.match.ref_id}`).slice(0, 60)}»; hãy tải lên lại`);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Kết quả AI → `match` của phiên bản mới. AI KHÔNG tự chọn ảnh mẫu: `kind` và `ref_id` luôn lấy từ bản cha.
 * - `grade` thiếu `match` (hoặc `grade` không phải đối tượng/thiếu hẳn) → GIỮ nguyên `match` của bản cha;
 * - `match: null` (hoặc `false`) → bỏ ảnh mẫu (góp ý "bỏ ảnh mẫu");
 * - `match` là đối tượng → chỉ nhận `strength`, `mode`, `per_scene` (hợp lệ) đè lên bản cha; bản cha không có match thì bỏ qua (AI không thêm ảnh mẫu mới).
 */
export function reconcileAiMatch(parentMatch: ColorMatch | undefined, aiMatch: unknown): ColorMatch | undefined {
  if (!parentMatch) return undefined;
  if (aiMatch === undefined) return parentMatch;
  if (aiMatch === null || aiMatch === false) return undefined;
  if (!isPlainObject(aiMatch)) return parentMatch;
  const next: ColorMatch = { ...parentMatch };
  if (typeof aiMatch.strength === 'number' && Number.isFinite(aiMatch.strength)) next.strength = aiMatch.strength;
  if (parentMatch.kind === 'image') {
    if (aiMatch.mode === 'color' || aiMatch.mode === 'full') next.mode = aiMatch.mode;
    if (typeof aiMatch.per_scene === 'boolean') next.per_scene = aiMatch.per_scene;
  }
  return next;
}

/** Điều kiện chung để góp ý / chỉnh màu từ một bản dựng (ném 409 nếu không đủ). Trả đường dẫn tương đối của bản sạch chưa chỉnh màu. */
export function assertCanRevise(ctx: AppContext, src: FinalCutRow, wm: { active: boolean }): string {
  if (src.status !== 'ready' || !src.video_path) {
    throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${src.version} đang ở trạng thái ${src.status}; chỉ góp ý / chỉnh màu được bản đã sẵn sàng`);
  }
  const busy = ctx.db
    .prepare("SELECT version, status FROM final_cuts WHERE project_id = ? AND status IN ('planning','rendering') ORDER BY version DESC LIMIT 1")
    .get(src.project_id) as { version: number; status: string } | undefined;
  if (busy) throw conflict('FINAL_CUT_ACTIVE', `Đang ${busy.status === 'planning' ? 'chờ AI chọn điểm cắt cho' : 'render'} bản hoàn chỉnh v${busy.version}; hãy đợi hoặc hủy trước`);
  // Chỉnh màu chạy SAU xoá logo: bản còn logo (render trước khi có bước này, hoặc xoá logo lỗi) phải được xoá logo trước.
  if (wm.active && !src.watermark_removed) {
    throw conflict('LOGO_NOT_REMOVED', `Bản hoàn chỉnh v${src.version} còn logo Veo: hãy bấm «Xoá logo Veo» trước (chỉnh màu luôn chạy sau xoá logo)`);
  }
  const baseRel = src.base_path ?? src.video_path;
  if (!fs.existsSync(path.join(ctx.config.rootDir, baseRel))) throw conflict('FILE_MISSING', `Không thấy file ${path.basename(baseRel)} của bản v${src.version}`);
  return baseRel;
}

/** Bản sạch chưa chỉnh màu của một bản dựng (tương đối từ ROOT): `base_path` nếu bản đó đã chỉnh màu, ngược lại chính `video_path`. */
export const cleanBaseOf = (cut: Pick<FinalCutRow, 'base_path' | 'video_path'>): string | null => cut.base_path ?? cut.video_path;

// ------------------------------------------------------------------ tạo phiên bản

/** `POST /api/final-cuts/:id/feedback`: phiên bản mới `planning` + job `edit_plan` mang `payload.revision`. */
export function createFeedbackRevision(ctx: AppContext, sourceId: number, feedback: string, wm: { active: boolean }): { cutId: number; jobId: number } {
  return ctx.tx(() => {
    const src = getFinalCutRow(ctx, sourceId);
    const project = getProject(ctx, src.project_id);
    assertCanRevise(ctx, src, wm);
    const text = feedback.trim();
    if (!text || text.length > FEEDBACK_MAX_CHARS) throw new AppError('VALIDATION_ERROR', `Góp ý phải dài 1–${FEEDBACK_MAX_CHARS} ký tự`, 400);
    const selection = parseJson<SelectionItem[]>(src.selection, []);
    const cutId = insertCut(ctx, project, {
      status: 'planning',
      selection,
      signature: src.selection_signature,
      created_by: isManagedJobType(ctx.config, 'edit_plan') ? 'agent' : 'claude',
      revision: { parent_id: src.id, feedback: text, inherit: { renderer: src.renderer, duration_s: src.duration_s } },
    });
    const version = getFinalCutRow(ctx, cutId).version;
    const jobId = insertJob(ctx, {
      project_id: project.id,
      scene_id: null,
      type: 'edit_plan',
      requires_approval: false,
      approved: false,
      payload: { final_cut_id: cutId, version, revision: { parent_cut_id: src.id, feedback: text } },
    });
    ctx.db.prepare('UPDATE final_cuts SET job_id = ? WHERE id = ?').run(jobId, cutId);
    logEvent(ctx, { project_id: project.id, type: 'final_cut.created', message: `Bản hoàn chỉnh v${version}: góp ý cho AI trên v${src.version} — ${text.length > 120 ? `${text.slice(0, 117)}…` : text}` });
    emitFinalCut(ctx, cutId, project.id);
    emitProject(ctx, project.id);
    return { cutId, jobId };
  });
}

/** `POST /api/final-cuts/:id/grade`: chỉnh màu thủ công → phiên bản mới `rendering` (stage `grade`), không qua AI, không tốn credit. */
export function createGradeRevision(ctx: AppContext, sourceId: number, gradeInput: unknown, note: string | undefined, wm: { active: boolean }): number {
  return ctx.tx(() => {
    const src = getFinalCutRow(ctx, sourceId);
    const project = getProject(ctx, src.project_id);
    const selection = parseJson<SelectionItem[]>(src.selection, []);
    const grade = normalizeGrade(gradeInput, { sceneIds: sceneIdsOf(selection), matchRefs: colorRefKinds(ctx, project.id) });
    assertCanRevise(ctx, src, wm);
    assertMatchRefUsable(ctx, project.id, grade);
    const edl = parseJson<Edl | null>(src.edl, null);
    if (!edl) throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${src.version} chưa có điểm cắt (EDL)`);
    const chips = gradeChips(grade);
    const id = insertCut(ctx, project, {
      status: 'rendering',
      stage: 'grade',
      selection,
      signature: src.selection_signature,
      created_by: 'user',
      edl,
      note: note ?? null,
      revision: {
        parent_id: src.id,
        grade,
        revision: { kind: 'manual', edl_changed: false, summary: chips.length ? `Chỉnh màu: ${chips.join(', ')}` : 'Trả về màu gốc', not_done: [] },
        inherit: { renderer: src.renderer, duration_s: src.duration_s, watermark_removed: src.watermark_removed, raw_video_path: src.raw_video_path },
      },
    });
    const cut = getFinalCutRow(ctx, id);
    logEvent(ctx, { project_id: project.id, type: 'final_cut.created', message: `Bản hoàn chỉnh v${cut.version}: người dùng chỉnh màu từ v${src.version}${chips.length ? ` (${chips.join(', ')})` : ' (về màu gốc)'}` });
    emitFinalCut(ctx, id, project.id);
    emitProject(ctx, project.id);
    ctx.afterCommit(() => ctx.finalRender?.enqueue(id, 'grade'));
    return id;
  });
}

/**
 * `POST /api/final-cuts/:id/regrade`: chạy lại RIÊNG bước chỉnh màu của một bản lỗi/hủy giữa bước chỉnh màu (`failed_stage='grade'`).
 * Bản sạch (hoặc bản cha) còn nguyên nên không render lại, không xoá logo lại.
 */
export function regradeFinalCut(ctx: AppContext, id: number): FinalCutRow {
  return ctx.tx(() => {
    const cut = getFinalCutRow(ctx, id);
    if (!((cut.status === 'failed' || cut.status === 'cancelled') && cut.failed_stage === 'grade')) {
      throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${cut.version} đang ở trạng thái ${cut.status}; chỉ chạy lại chỉnh màu được bản lỗi hoặc bị hủy ở bước chỉnh màu`);
    }
    const busy = ctx.db
      .prepare("SELECT version FROM final_cuts WHERE project_id = ? AND status IN ('planning','rendering') ORDER BY version DESC LIMIT 1")
      .get(cut.project_id) as { version: number } | undefined;
    if (busy) throw conflict('FINAL_CUT_ACTIVE', `Đang xử lý bản hoàn chỉnh v${busy.version}; hãy đợi hoặc hủy trước`);
    const updated = updateCut(ctx, id, { status: 'rendering', stage: 'grade', failed_stage: null, progress: 0, error: null, finished_at: null });
    logEvent(ctx, { project_id: cut.project_id, type: 'final_cut.grade', message: `Bản hoàn chỉnh v${cut.version}: chạy lại bước chỉnh màu` });
    ctx.afterCommit(() => ctx.finalRender?.enqueue(id, 'grade'));
    return updated;
  });
}

// ------------------------------------------------------------------ payload job edit_plan có góp ý

interface HistoryEntry {
  version: number;
  kind: 'ai' | 'manual';
  feedback: string | null;
  summary: string | null;
  not_done: string[];
  grade_chips: string[];
}

/** Chuỗi góp ý trước đó (cũ → mới, tối đa `FEEDBACK_HISTORY`), đi từ bản cha ngược lên các bản tổ tiên. */
export function feedbackHistory(ctx: AppContext, parent: FinalCutRow): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const seen = new Set<number>();
  let node: FinalCutRow | undefined = parent;
  while (node && !seen.has(node.id) && out.length < FEEDBACK_HISTORY) {
    seen.add(node.id);
    const rev = parseJson<FinalCutRevision | null>(node.revision, null);
    if (node.feedback || rev?.kind === 'manual') {
      out.push({
        version: node.version,
        kind: rev?.kind ?? 'ai',
        feedback: node.feedback,
        summary: rev?.summary ?? node.summary,
        not_done: rev?.not_done ?? [],
        grade_chips: gradeChips(parseStoredGrade(node.grade)),
      });
    }
    node = node.parent_id ? (ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(node.parent_id) as FinalCutRow | undefined) : undefined;
  }
  return out.reverse();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `parent_grade` gửi AI: grade của bản cha, `match` kèm `original_name` của ảnh mẫu (AI chỉ cần tên để hiểu, không chọn được ảnh khác). */
function parentGradeForAi(ctx: AppContext, parent: FinalCutRow): Record<string, unknown> {
  const g = parseStoredGrade(parent.grade) ?? neutralGrade();
  if (!g.match) return g as unknown as Record<string, unknown>;
  const ref = colorRefOfGrade(ctx, parent.project_id, g.match.ref_id, (rel) => rel);
  return { ...g, match: { ...g.match, original_name: ref?.original_name ?? null } };
}

/** Payload edit_plan (tính lúc claim): payload thường + `revision` khi bản dựng là phiên bản góp ý. */
export function editPlanPayloadFor(ctx: AppContext, job: JobRow): Record<string, unknown> {
  const base = editPlanPayload(ctx, job);
  const cut = ctx.db.prepare('SELECT * FROM final_cuts WHERE job_id = ?').get(job.id) as FinalCutRow | undefined;
  if (!cut?.parent_id) return base;
  const parent = ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(cut.parent_id) as FinalCutRow | undefined;
  if (!parent) return base;
  const parentEdl = parseJson<Edl | null>(parent.edl, null);
  const baseScenes = base.scenes as { scene_id: number; code: string; title: string; prompt: string; duration_s: number | null }[];
  const ranges = parentEdl ? outRanges(parentEdl) : [];
  const codeOf = new Map(baseScenes.map((s) => [s.scene_id, s.code]));
  const contact = parent.contact_sheet_path && fs.existsSync(path.join(ctx.config.rootDir, parent.contact_sheet_path)) ? parent.contact_sheet_path : null;
  return {
    ...base,
    revision: {
      parent_cut_id: parent.id,
      parent_version: parent.version,
      feedback: cut.feedback ?? '',
      parent_edl: parentEdl,
      parent_grade: parentGradeForAi(ctx, parent),
      grade_ranges: GRADE_RANGES,
      feedback_history: feedbackHistory(ctx, parent),
      scenes: baseScenes.map((s) => ({ scene_id: s.scene_id, code: s.code, title: s.title, prompt: clip(s.prompt ?? '', 300), duration_s: s.duration_s })),
      timeline: ranges.map((r) => ({ scene_id: r.scene_id, code: codeOf.get(r.scene_id) ?? null, out_start_s: r.start, out_end_s: r.end })),
      contact_sheet: contact,
    },
  };
}

// ------------------------------------------------------------------ kết quả của AI

/** Hai EDL có cùng điểm cắt không (so sánh cảnh, asset và các đoạn giữ lại; bỏ qua `removed`/`note`). */
export function sameCutPoints(a: Edl | null, b: Edl | null): boolean {
  if (!a || !b) return false;
  const key = (e: Edl) => JSON.stringify(e.scenes.map((s) => [s.scene_id, s.asset_id, s.segments.map((g) => [g.in_s, g.out_s])]));
  return key(a) === key(b);
}

export interface RevisionResult {
  edl?: unknown;
  summary: string;
  grade?: unknown;
  not_done?: string[];
}

/**
 * Worker hoàn thành job edit_plan của phiên bản góp ý. `edl` null/thiếu hoặc giống hệt bản cha = giữ nguyên điểm cắt; `grade` thiếu = giữ grade của bản cha.
 * EDL sai → 400 INVALID_EDL, grade sai → 400 INVALID_GRADE (job giữ nguyên để worker sửa). Hợp lệ → `rendering`: chỉ đổi màu thì bước đầu là `grade`
 * (không render, không xoá logo), đổi điểm cắt thì `render` → xoá logo → chỉnh màu.
 */
export function completeRevisionPlan(ctx: AppContext, job: JobRow, result: RevisionResult): number {
  const cut = ctx.db.prepare('SELECT * FROM final_cuts WHERE job_id = ?').get(job.id) as FinalCutRow | undefined;
  if (!cut) throw conflict('INVALID_STATE', `Job #${job.id} không gắn với bản dựng hoàn chỉnh nào`);
  if (cut.status !== 'planning') throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${cut.version} đang ở trạng thái ${cut.status}, không nhận kế hoạch dựng`);
  const parent = cut.parent_id ? (ctx.db.prepare('SELECT * FROM final_cuts WHERE id = ?').get(cut.parent_id) as FinalCutRow | undefined) : undefined;
  if (!parent) throw conflict('INVALID_STATE', `Bản cha của v${cut.version} không còn tồn tại`);
  const selection = parseJson<SelectionItem[]>(cut.selection, []);
  const parentEdl = parseJson<Edl | null>(parent.edl, null);
  const newEdl = result.edl === null || result.edl === undefined ? null : validateEdl(ctx, selection, result.edl);
  const edlChanged = !!newEdl && !sameCutPoints(newEdl, parentEdl);
  const parentGrade = parseStoredGrade(parent.grade);
  const matchRefs = colorRefKinds(ctx, cut.project_id);
  let grade: Grade;
  if (result.grade === undefined) grade = parentGrade ?? neutralGrade();
  else if (result.grade === null || isPlainObject(result.grade)) {
    // `match` do server quyết (xem reconcileAiMatch): AI không đổi ảnh mẫu, không làm mất match nếu không được bảo bỏ
    const { match: aiMatch, ...rest } = (result.grade ?? {}) as Record<string, unknown>;
    const match = reconcileAiMatch(parentGrade?.match, aiMatch);
    grade = normalizeGrade({ ...rest, ...(match ? { match } : {}) }, { sceneIds: sceneIdsOf(selection), matchRefs });
  } else grade = normalizeGrade(result.grade, { sceneIds: sceneIdsOf(selection), matchRefs }); // sai kiểu → 400 INVALID_GRADE như cũ
  const revision: FinalCutRevision = { kind: 'ai', edl_changed: edlChanged, summary: result.summary, not_done: result.not_done ?? [] };
  const edl = edlChanged ? newEdl! : parentEdl;
  if (!edl) throw conflict('INVALID_STATE', `Bản cha v${parent.version} không có điểm cắt (EDL)`);
  updateCut(ctx, cut.id, {
    edl: JSON.stringify(edl),
    grade: isNeutralGrade(grade) ? null : JSON.stringify(grade),
    revision: JSON.stringify(revision),
    summary: result.summary,
    status: 'rendering',
    stage: edlChanged ? 'render' : 'grade',
    progress: null,
    error: null,
    failed_stage: null,
    // chỉ đổi màu: kế thừa kết quả của bản cha (không render/xoá logo lại)
    ...(edlChanged ? {} : { duration_s: parent.duration_s, watermark_removed: parent.watermark_removed }),
  });
  if (!edlChanged && parent.raw_video_path) ctx.db.prepare('UPDATE final_cuts SET raw_video_path = ? WHERE id = ?').run(parent.raw_video_path, cut.id);
  const same = !edlChanged && gradesEqual(grade, parentGrade);
  logEvent(ctx, {
    project_id: cut.project_id,
    type: 'final_cut.planned',
    message: `Bản hoàn chỉnh v${cut.version}: AI đã đọc góp ý — ${result.summary}${edlChanged ? ' (đổi điểm cắt: render + xoá logo + chỉnh màu lại)' : same ? ' (không đổi gì)' : ' (chỉ chỉnh màu)'}`,
  });
  ctx.afterCommit(() => ctx.finalRender?.enqueue(cut.id, edlChanged ? 'full' : 'grade'));
  return cut.id;
}

/** Điểm vào duy nhất cho job `edit_plan` hoàn thành: bản góp ý (có `parent_id`) → `completeRevisionPlan`, bản thường → `completeEditPlan`. */
export function completeEditPlanJob(ctx: AppContext, job: JobRow, result: RevisionResult): number {
  const cut = ctx.db.prepare('SELECT parent_id FROM final_cuts WHERE job_id = ?').get(job.id) as { parent_id: number | null } | undefined;
  return cut?.parent_id ? completeRevisionPlan(ctx, job, result) : completeEditPlan(ctx, job, { edl: result.edl, summary: result.summary });
}
