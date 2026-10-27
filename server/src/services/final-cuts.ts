import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isManagedJobType } from '../config.js';
import type { AppContext } from '../context.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import type { AssetRow, CommentRow, FinalCutRow, FinalCutStatus, JobRow, ProjectRow, SceneRow } from '../db/types.js';
import { colorRefOfGrade } from './color-refs.js';
import { gradeChips, isNeutralGrade, parseStoredGrade, type Grade } from './grade.js';
import { insertJob } from './job-create.js';
import { aiQueueInfoById } from './job-queue.js';
import { appendLogRow } from './logmd.js';
import { probeMedia } from './media.js';
import { emitProject } from './project-view.js';
import { commentJson, fileUrl, getJobJson, getProject, getProjectAny, logEvent, parseJson } from './repo.js';

/**
 * Bản dựng hoàn chỉnh (final cut): sau khi mọi cảnh đã chọn video, AI (job `edit_plan`) chọn điểm cắt (EDL),
 * server render nền (Shotcut MCP hoặc ffmpeg) ra `output/<slug>/final/<slug>_final_v<n>.mp4`.
 */

export const MIN_SEGMENT_S = 0.3;
export const FINAL_CONSTRAINTS = { aspect: '9:16', transition: 'cut', min_segment_s: MIN_SEGMENT_S, keep_scene_order: true } as const;
const ACTIVE: FinalCutStatus[] = ['planning', 'rendering'];

export interface SelectionItem {
  scene_id: number;
  code: string;
  asset_id: number;
  attempt: number;
}

export interface EdlSegment {
  in_s: number;
  out_s: number;
}
export interface EdlRemoved {
  from_s: number;
  to_s: number;
  reason: string;
}
export interface EdlScene {
  scene_id: number;
  asset_id: number;
  segments: EdlSegment[];
  removed: EdlRemoved[];
  note: string;
}
export interface Edl {
  scenes: EdlScene[];
}

// ------------------------------------------------------------------ đường dẫn, lựa chọn, chữ ký

export function finalPaths(slug: string, version: number) {
  const base = `output/${slug}/final`;
  return {
    video_path: `${base}/${slug}_final_v${version}.mp4`,
    /** Bản render còn logo (khi bật xoá logo Veo, video_path là bản đã xoá logo). */
    raw_video_path: `${base}/${slug}_final_v${version}_raw.mp4`,
    contact_sheet_path: `${base}/${slug}_final_v${version}_contact.png`,
    /** Lưới khung hình của bản ĐÃ chỉnh màu (khi `contact_sheet_path` của bước render đã có). */
    contact_graded_path: `${base}/${slug}_final_v${version}_contact_graded.png`,
    /** Bản sạch (đã xoá logo) CHƯA chỉnh màu; chỉ có khi grade không trung tính. */
    base_path: `${base}/${slug}_final_v${version}_base.mp4`,
    project_file_path: `${base}/shotcut/${slug}_final_v${version}.mlt`,
  };
}

/** Số version kế tiếp: lớn hơn mọi version trong DB VÀ mọi file `<slug>_final_v<n>*` trên đĩa; không bao giờ ghi đè bản cũ. */
export function nextVersion(ctx: AppContext, project: ProjectRow): number {
  const dbMax = (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM final_cuts WHERE project_id = ?').get(project.id) as { v: number }).v;
  let diskMax = 0;
  const re = new RegExp(`^${project.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_final_v(\\d+)`);
  for (const dir of [path.join(ctx.config.rootDir, 'output', project.slug, 'final'), path.join(ctx.config.rootDir, 'output', project.slug, 'final', 'shotcut')]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = re.exec(f);
        if (m) diskMax = Math.max(diskMax, Number(m[1]));
      }
    } catch {
      /* thư mục chưa có */
    }
  }
  let v = Math.max(dbMax, diskMax) + 1;
  // phòng hờ: tên file lạ không khớp mẫu nhưng trùng đúng đường dẫn
  for (;;) {
    const p = finalPaths(project.slug, v);
    if (![p.video_path, p.raw_video_path, p.contact_sheet_path, p.contact_graded_path, p.base_path, p.project_file_path].some((rel) => fs.existsSync(path.join(ctx.config.rootDir, rel)))) return v;
    v++;
  }
}

export function selectionSignature(pairs: [number, number | null][]): string {
  return crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

interface SceneSelRow {
  scene_id: number;
  code: string;
  status: string;
  selected_video_id: number | null;
  asset_id: number | null;
  attempt: number | null;
}

/** Lựa chọn video hiện tại của dự án theo thứ tự cảnh. `missing` = mã cảnh chưa có video được chọn. */
export function currentSelection(ctx: AppContext, projectId: number) {
  const rows = ctx.db
    .prepare(
      `SELECT s.id AS scene_id, s.code, s.status, s.selected_video_id, a.id AS asset_id, a.attempt
       FROM scenes s LEFT JOIN assets a ON a.id = s.selected_video_id AND a.kind = 'video' AND a.scene_id = s.id
       WHERE s.project_id = ? ORDER BY s.order_index, s.id`,
    )
    .all(projectId) as SceneSelRow[];
  const items: SelectionItem[] = [];
  const missing: string[] = [];
  for (const r of rows) {
    if (r.asset_id !== null) items.push({ scene_id: r.scene_id, code: r.code, asset_id: r.asset_id, attempt: r.attempt ?? 1 });
    else missing.push(r.code);
  }
  return {
    items,
    missing,
    sceneCount: rows.length,
    allDone: rows.length > 0 && rows.every((r) => r.status === 'done' && r.asset_id !== null),
    signature: selectionSignature(rows.map((r) => [r.scene_id, r.asset_id])),
  };
}

// ------------------------------------------------------------------ đọc / JSON

export function getFinalCutRow(ctx: AppContext, id: number): FinalCutRow {
  // dự án đã xoá (thùng rác) → bản dựng của nó không tồn tại với mọi API
  const row = ctx.db
    .prepare('SELECT f.* FROM final_cuts f JOIN projects p ON p.id = f.project_id WHERE f.id = ? AND p.deleted_at IS NULL')
    .get(id) as FinalCutRow | undefined;
  if (!row) throw notFound('bản dựng hoàn chỉnh');
  return row;
}

const assetById = (ctx: AppContext, id: number): AssetRow | undefined =>
  ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;

/** Thời lượng video nguồn: ffprobe (có cache) rồi tới asset.meta.duration_s; null nếu không biết. */
export function sourceDuration(ctx: AppContext, asset: AssetRow): number | null {
  const info = probeMedia(ctx.config, path.join(ctx.config.rootDir, asset.file_path));
  if (info?.duration_s) return info.duration_s;
  const meta = parseJson<Record<string, unknown>>(asset.meta, {});
  return typeof meta.duration_s === 'number' && meta.duration_s > 0 ? meta.duration_s : null;
}

export function finalCutJson(ctx: AppContext, row: FinalCutRow, currentSig?: string) {
  const sig = currentSig ?? currentSelection(ctx, row.project_id).signature;
  const selection = parseJson<SelectionItem[]>(row.selection, []).map((s) => {
    const a = assetById(ctx, s.asset_id);
    return { ...s, video_url: a ? fileUrl(a.file_path) : null, duration_s: a ? sourceDuration(ctx, a) : null };
  });
  const ready = row.status === 'ready';
  const parentVersion = row.parent_id ? ((ctx.db.prepare('SELECT version FROM final_cuts WHERE id = ?').get(row.parent_id) as { version: number } | undefined)?.version ?? null) : null;
  const grade = parseStoredGrade(row.grade);
  // Hàng đợi render (hai bước render + xoá logo dùng chung): `waiting` = đã `rendering` nhưng CHƯA bắt đầu vì đang đợi chỗ trống.
  const q = row.status === 'rendering' ? (ctx.finalRender?.queueInfo('cut', row.id) ?? null) : null;
  return {
    id: row.id,
    project_id: row.project_id,
    version: row.version,
    status: row.status,
    selection,
    selection_signature: row.selection_signature,
    edl: parseJson<Edl | null>(row.edl, null),
    renderer: row.renderer,
    video_path: row.video_path,
    video_url: ready && row.video_path ? fileUrl(row.video_path) : null,
    raw_video_path: row.raw_video_path,
    raw_video_url: row.raw_video_path ? fileUrl(row.raw_video_path) : null,
    stage: row.stage,
    failed_stage: row.failed_stage,
    watermark_removed: !!row.watermark_removed,
    watermark_meta: parseJson<Record<string, unknown> | null>(row.watermark_meta, null),
    project_file_path: row.project_file_path,
    contact_sheet_path: row.contact_sheet_path,
    contact_sheet_url: ready && row.contact_sheet_path ? fileUrl(row.contact_sheet_path) : null,
    duration_s: row.duration_s,
    job_id: row.job_id,
    render_ref: row.render_ref,
    progress: row.progress,
    created_by: row.created_by,
    note: row.note,
    summary: row.summary,
    /** Phiên bản góp ý / chỉnh màu: bản cha (id + số version), góp ý của người dùng, Grade đã áp (null = chưa chỉnh màu), trả lời của AI. */
    parent_id: row.parent_id,
    parent_version: parentVersion,
    feedback: row.feedback,
    grade,
    grade_chips: gradeChips(grade),
    /** Ảnh mẫu / LUT của `grade.match` (null nếu không dùng): để lịch sử phiên bản hiện chip có ảnh thu nhỏ. */
    color_ref: colorRefOfGrade(ctx, row.project_id, grade?.match?.ref_id, fileUrl),
    revision: parseJson<FinalCutRevision | null>(row.revision, null),
    /** Bản sạch chưa chỉnh màu (chỉ có khi grade không trung tính). */
    base_path: row.base_path,
    error: row.error,
    created_at: row.created_at,
    finished_at: row.finished_at,
    outdated: row.selection_signature !== sig,
    /** Chỉ khi `status="rendering"` và việc nằm trong hàng đợi render: `waiting` (chưa bắt đầu) | `running`. */
    queue_state: q?.state ?? null,
    /** 1 = sẽ chạy tiếp theo; `null` khi đang chạy hoặc không ở trong hàng đợi. */
    queue_position: q?.position ?? null,
    /** Số việc render/xoá logo đang chạy lúc này và số việc được chạy cùng lúc (`RENDER_CONCURRENCY`). */
    running_count: q?.running_count ?? null,
    concurrency: q?.concurrency ?? null,
    /** Chỉ khi `status="planning"`: vị trí job `edit_plan` trong hàng đợi của worker AI (một worker, tuần tự). */
    ai_queue: row.status === 'planning' ? aiQueueInfoById(ctx, row.job_id) : null,
  };
}
export type FinalCutJson = ReturnType<typeof finalCutJson>;

/** Trả lời của AI (hoặc ghi chú chỉnh tay) cho một phiên bản góp ý / chỉnh màu. */
export interface FinalCutRevision {
  kind: 'ai' | 'manual';
  /** true = điểm cắt (EDL) đổi nên đã render + xoá logo lại; false = chỉ đổi màu. */
  edl_changed: boolean;
  summary: string;
  /** Yêu cầu AI nói là không làm được (thêm nhạc, chữ, chuyển cảnh...). */
  not_done: string[];
}

export function listFinalCuts(ctx: AppContext, projectId: number): FinalCutJson[] {
  getProject(ctx, projectId);
  const sig = currentSelection(ctx, projectId).signature;
  const rows = ctx.db.prepare('SELECT * FROM final_cuts WHERE project_id = ? ORDER BY version DESC').all(projectId) as FinalCutRow[];
  return rows.map((r) => finalCutJson(ctx, r, sig));
}

export function getFinalCutJson(ctx: AppContext, id: number): FinalCutJson {
  return finalCutJson(ctx, getFinalCutRow(ctx, id));
}

/** Gọn cho thẻ dự án / bảng cảnh (`project.latest_final_cut`): bản có version cao nhất, null nếu chưa có. */
export function latestFinalCutBrief(ctx: AppContext, projectId: number) {
  const row = ctx.db.prepare('SELECT * FROM final_cuts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as FinalCutRow | undefined;
  if (!row) return null;
  const sig = currentSelection(ctx, projectId).signature;
  const q = row.status === 'rendering' ? (ctx.finalRender?.queueInfo('cut', row.id) ?? null) : null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    queue_state: q?.state ?? null,
    queue_position: q?.position ?? null,
    ai_queue: row.status === 'planning' ? aiQueueInfoById(ctx, row.job_id) : null,
    progress: row.progress,
    stage: row.stage,
    failed_stage: row.failed_stage,
    watermark_removed: !!row.watermark_removed,
    url: row.status === 'ready' && row.video_path ? fileUrl(row.video_path) : null,
    duration_s: row.duration_s,
    outdated: row.selection_signature !== sig,
    error: row.error,
  };
}

/** Lý do chưa thể bấm "Dựng bản mới" (null = được). Cùng điều kiện với `POST /api/projects/:id/final-cuts`. */
export function finalCutBlock(ctx: AppContext, projectId: number): { code: string; message: string } | null {
  const sel = currentSelection(ctx, projectId);
  if (sel.sceneCount === 0) return { code: 'SCENES_NOT_READY', message: 'Dự án chưa có cảnh nào' };
  if (sel.missing.length) return { code: 'SCENES_NOT_READY', message: `Còn ${sel.missing.join(', ')} chưa chọn video` };
  const active = ctx.db
    .prepare("SELECT version, status FROM final_cuts WHERE project_id = ? AND status IN ('planning','rendering') ORDER BY version DESC LIMIT 1")
    .get(projectId) as { version: number; status: string } | undefined;
  if (active) {
    return { code: 'FINAL_CUT_ACTIVE', message: `Đang ${active.status === 'planning' ? 'chọn điểm cắt cho' : 'render'} bản hoàn chỉnh v${active.version}` };
  }
  return null;
}

// ------------------------------------------------------------------ cập nhật + SSE

export function emitFinalCut(ctx: AppContext, id: number, projectId: number): void {
  ctx.publish('final_cut.updated', projectId, () => ({ final_cut: getFinalCutJson(ctx, id) }), `final_cut:${id}`);
}

/** Chữ ký vị trí hàng đợi AI đã phát qua SSE cho từng bản `planning` (theo ctx), để chỉ phát khi đổi. */
const planningSig = new WeakMap<AppContext, Map<number, string>>();

/**
 * Phát `final_cut.updated` cho bản đang `planning` khi vị trí/tình trạng trong hàng đợi worker AI đổi (job khác được nhận/xong, worker online/offline,
 * tạm dừng, chờ hạn mức). Được gọi định kỳ bởi timer của server (chỉ khi có người nghe SSE); chính chu kỳ timer là throttle.
 * Trả về số bản đã phát. Bản hết `planning` được dọn khỏi bộ nhớ.
 */
export function emitPlanningQueueChanges(ctx: AppContext): number {
  const memo = planningSig.get(ctx) ?? planningSig.set(ctx, new Map()).get(ctx)!;
  const rows = ctx.db.prepare("SELECT id, project_id, job_id FROM final_cuts WHERE status = 'planning' AND job_id IS NOT NULL").all() as { id: number; project_id: number; job_id: number }[];
  const live = new Set<number>();
  let emitted = 0;
  for (const r of rows) {
    live.add(r.id);
    const q = aiQueueInfoById(ctx, r.job_id);
    const sig = q ? JSON.stringify([q.state, q.position, q.running?.type ?? null, q.running?.own ?? null, q.worker.online, q.worker.paused, q.wait_reason]) : 'none';
    if (memo.get(r.id) === sig) continue;
    const first = !memo.has(r.id);
    memo.set(r.id, sig);
    if (first) continue; // lần đầu thấy: trạng thái khởi tạo đã được phát lúc tạo bản dựng
    emitFinalCut(ctx, r.id, r.project_id);
    emitted++;
  }
  for (const id of [...memo.keys()]) if (!live.has(id)) memo.delete(id);
  return emitted;
}

type CutPatch = Partial<
  Pick<
    FinalCutRow,
    | 'status'
    | 'renderer'
    | 'video_path'
    | 'project_file_path'
    | 'contact_sheet_path'
    | 'duration_s'
    | 'render_ref'
    | 'progress'
    | 'summary'
    | 'error'
    | 'finished_at'
    | 'edl'
    | 'stage'
    | 'raw_video_path'
    | 'failed_stage'
    | 'watermark_removed'
    | 'watermark_meta'
    | 'base_path'
    | 'grade'
    | 'revision'
  >
>;

/** Cập nhật cột của final_cut và phát SSE `final_cut.updated` (+ `project.updated` khi đổi trạng thái). */
export function updateCut(ctx: AppContext, id: number, patch: CutPatch): FinalCutRow {
  return ctx.tx(() => {
    const before = getFinalCutRow(ctx, id);
    const keys = Object.keys(patch) as (keyof CutPatch)[];
    if (keys.length) {
      ctx.db
        .prepare(`UPDATE final_cuts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
    }
    emitFinalCut(ctx, id, before.project_id);
    if (patch.status && patch.status !== before.status) emitProject(ctx, before.project_id);
    return getFinalCutRow(ctx, id);
  });
}

// ------------------------------------------------------------------ tạo bản dựng + job edit_plan

export function insertCut(
  ctx: AppContext,
  project: ProjectRow,
  fields: {
    status: FinalCutStatus;
    selection: SelectionItem[];
    signature: string;
    created_by: 'claude' | 'agent' | 'user';
    edl?: Edl;
    note?: string | null;
    /** Bước đầu của bản `rendering` (mặc định `render`; chỉnh màu thủ công bắt đầu ở `grade`). */
    stage?: 'render' | 'clean' | 'grade';
    /** Phiên bản góp ý / chỉnh màu: bản cha, góp ý, grade đã áp (null = trung tính), trả lời, các cột kế thừa từ bản cha. */
    revision?: { parent_id: number; feedback?: string | null; grade?: Grade | null; revision?: FinalCutRevision | null; inherit?: Partial<Pick<FinalCutRow, 'renderer' | 'duration_s' | 'watermark_removed' | 'raw_video_path'>> };
  },
): number {
  const version = nextVersion(ctx, project);
  const rv = fields.revision;
  const info = ctx.db
    .prepare(
      `INSERT INTO final_cuts (project_id, version, status, stage, selection, selection_signature, edl, created_by, note, created_at,
                               parent_id, feedback, grade, revision, renderer, duration_s, watermark_removed, raw_video_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      version,
      fields.status,
      fields.status === 'rendering' ? (fields.stage ?? 'render') : null,
      JSON.stringify(fields.selection),
      fields.signature,
      fields.edl ? JSON.stringify(fields.edl) : null,
      fields.created_by,
      fields.note ?? null,
      ctx.now(),
      rv?.parent_id ?? null,
      rv?.feedback ?? null,
      rv?.grade && !isNeutralGrade(rv.grade) ? JSON.stringify(rv.grade) : null,
      rv?.revision ? JSON.stringify(rv.revision) : null,
      rv?.inherit?.renderer ?? null,
      rv?.inherit?.duration_s ?? null,
      rv?.inherit?.watermark_removed ?? 0,
      rv?.inherit?.raw_video_path ?? null,
    );
  return Number(info.lastInsertRowid);
}

function createPlanning(ctx: AppContext, project: ProjectRow, sel: ReturnType<typeof currentSelection>, reason: string): { cutId: number; jobId: number } {
  const cutId = insertCut(ctx, project, { status: 'planning', selection: sel.items, signature: sel.signature, created_by: isManagedJobType(ctx.config, 'edit_plan') ? 'agent' : 'claude' });
  const version = getFinalCutRow(ctx, cutId).version;
  const jobId = insertJob(ctx, {
    project_id: project.id,
    scene_id: null,
    type: 'edit_plan',
    requires_approval: false,
    approved: false,
    payload: { final_cut_id: cutId, version },
  });
  ctx.db.prepare('UPDATE final_cuts SET job_id = ? WHERE id = ?').run(jobId, cutId);
  logEvent(ctx, { project_id: project.id, type: 'final_cut.created', message: `Bản hoàn chỉnh v${version}: ${reason}` });
  emitFinalCut(ctx, cutId, project.id);
  emitProject(ctx, project.id);
  return { cutId, jobId };
}

/**
 * Tự kích hoạt: mọi cảnh `done` có video được chọn và CHƯA có final_cut (không tính failed/cancelled) cho chữ ký lựa chọn hiện tại
 * → tạo final_cut `planning` + job `edit_plan`. Idempotent; chạy trong BEGIN IMMEDIATE nên an toàn với race giữa các tiến trình.
 */
export function maybeAutoFinalCut(ctx: AppContext, projectId: number): { cutId: number; jobId: number } | null {
  return ctx.tx(() => {
    const project = getProject(ctx, projectId);
    // Kế hoạch LAN KHÔNG BAO GIỜ tự dựng: người dùng LAN bấm "Dựng bản hoàn chỉnh" (xem lan-final.ts).
    if (project.source === 'lan') return null;
    const sel = currentSelection(ctx, projectId);
    if (!sel.allDone) return null;
    const dup = ctx.db
      .prepare("SELECT 1 FROM final_cuts WHERE project_id = ? AND selection_signature = ? AND status NOT IN ('failed','cancelled') LIMIT 1")
      .get(projectId, sel.signature);
    if (dup) return null;
    return createPlanning(ctx, project, sel, 'mọi cảnh đã chọn video, AI đang chọn điểm cắt');
  });
}

/** Thủ công (`POST /api/projects/:id/final-cuts`): tạo version mới + job edit_plan, kể cả khi đã có bản cũ. */
export function createFinalCutManual(ctx: AppContext, projectId: number): { cutId: number; jobId: number } {
  return ctx.tx(() => {
    const project = getProject(ctx, projectId);
    const block = finalCutBlock(ctx, projectId);
    if (block) throw conflict(block.code, block.message);
    const sel = currentSelection(ctx, projectId);
    return createPlanning(ctx, project, sel, 'người dùng yêu cầu dựng bản mới, AI đang chọn điểm cắt');
  });
}

// ------------------------------------------------------------------ EDL

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

const edlSchema = z.object({
  scenes: z.array(
    z.object({
      scene_id: z.number().int(),
      asset_id: z.number().int(),
      segments: z.array(z.object({ in_s: z.number(), out_s: z.number() })),
      removed: z.array(z.object({ from_s: z.number(), to_s: z.number(), reason: z.string().max(500) })).optional(),
      note: z.string().max(2000).optional(),
    }),
  ),
});

const invalidEdl = (message: string, details?: Record<string, unknown>): AppError => new AppError('INVALID_EDL', `EDL không hợp lệ — ${message}`, 400, details);

/**
 * Kiểm tra EDL theo lựa chọn của bản dựng: đủ mọi cảnh, đúng thứ tự, đúng asset_id; mỗi cảnh ≥ 1 đoạn, đoạn trong [0, duration],
 * in < out, tăng dần, không chồng nhau, mỗi đoạn ≥ 0.3 giây. Trả EDL đã chuẩn hóa (làm tròn mili giây, luôn có `removed` và `note`).
 * Sai → 400 `INVALID_EDL` (message nêu rõ cảnh/đoạn).
 */
export function validateEdl(ctx: AppContext, selection: SelectionItem[], input: unknown): Edl {
  const parsed = edlSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    const p = i.path;
    let where = 'cấu trúc EDL';
    if (p[0] === 'scenes' && typeof p[1] === 'number') {
      const sel = selection[p[1]];
      where = `cảnh thứ ${p[1] + 1}${sel ? ` (${sel.code})` : ''}`;
      if (p[2] === 'segments' && typeof p[3] === 'number') where += `, đoạn ${p[3] + 1}`;
      if (p[2] === 'removed' && typeof p[3] === 'number') where += `, đoạn bị bỏ ${p[3] + 1}`;
    }
    throw invalidEdl(`${where}: trường ${p.slice(p[0] === 'scenes' && typeof p[1] === 'number' ? 2 : 0).join('.') || '(gốc)'} ${i.message}`, { path: p });
  }
  const scenes = parsed.data.scenes;
  if (scenes.length !== selection.length) {
    throw invalidEdl(`cần đủ ${selection.length} cảnh (${selection.map((s) => s.code).join(', ')}), nhận được ${scenes.length}`);
  }
  const out: EdlScene[] = [];
  scenes.forEach((sc, idx) => {
    const sel = selection[idx]!;
    if (sc.scene_id !== sel.scene_id) {
      throw invalidEdl(`vị trí ${idx + 1} phải là cảnh ${sel.code} (scene_id ${sel.scene_id}), nhận được scene_id ${sc.scene_id}; không được đổi thứ tự cảnh`, { scene: sel.code });
    }
    if (sc.asset_id !== sel.asset_id) {
      throw invalidEdl(`cảnh ${sel.code} phải dùng asset_id ${sel.asset_id} (video đã chọn), nhận được ${sc.asset_id}`, { scene: sel.code });
    }
    if (sc.segments.length === 0) throw invalidEdl(`cảnh ${sel.code} phải giữ lại ít nhất một đoạn`, { scene: sel.code });
    const asset = assetById(ctx, sel.asset_id);
    const dur = asset ? sourceDuration(ctx, asset) : null;
    const segs: EdlSegment[] = [];
    let prevOut = 0;
    sc.segments.forEach((seg, si) => {
      const tag = `cảnh ${sel.code}, đoạn ${si + 1}`;
      const inS = round3(seg.in_s);
      let outS = round3(seg.out_s);
      if (inS < 0) throw invalidEdl(`${tag}: in_s = ${seg.in_s} nhỏ hơn 0`, { scene: sel.code, segment: si + 1 });
      if (dur !== null) {
        if (inS >= dur) throw invalidEdl(`${tag}: in_s = ${seg.in_s} vượt thời lượng video (${round3(dur)} giây)`, { scene: sel.code, segment: si + 1 });
        if (outS > dur + 0.05) throw invalidEdl(`${tag}: out_s = ${seg.out_s} vượt thời lượng video (${round3(dur)} giây)`, { scene: sel.code, segment: si + 1 });
        outS = Math.min(outS, round3(dur));
      }
      if (inS >= outS) throw invalidEdl(`${tag}: in_s (${seg.in_s}) phải nhỏ hơn out_s (${seg.out_s})`, { scene: sel.code, segment: si + 1 });
      if (round3(outS - inS) < MIN_SEGMENT_S - 1e-9) {
        throw invalidEdl(`${tag}: dài ${round3(outS - inS)} giây, mỗi đoạn phải ≥ ${MIN_SEGMENT_S} giây`, { scene: sel.code, segment: si + 1 });
      }
      if (inS < prevOut - 1e-9) {
        throw invalidEdl(`${tag}: in_s = ${seg.in_s} chồng lên đoạn trước (kết thúc ở ${prevOut}); các đoạn phải tăng dần và không chồng nhau`, { scene: sel.code, segment: si + 1 });
      }
      prevOut = outS;
      segs.push({ in_s: inS, out_s: outS });
    });
    const removed: EdlRemoved[] = sc.removed
      ? sc.removed.map((r, ri) => {
          if (!(r.from_s >= 0) || !(r.to_s > r.from_s)) {
            throw invalidEdl(`cảnh ${sel.code}, đoạn bị bỏ ${ri + 1}: cần 0 ≤ from_s < to_s (nhận ${r.from_s} → ${r.to_s})`, { scene: sel.code });
          }
          return { from_s: round3(r.from_s), to_s: round3(r.to_s), reason: r.reason };
        })
      : deriveRemoved(segs, dur);
    out.push({ scene_id: sc.scene_id, asset_id: sc.asset_id, segments: segs, removed, note: sc.note ?? '' });
  });
  return { scenes: out };
}

/** Khi EDL không ghi `removed` (vd người dùng chỉnh tay): suy ra các khoảng bị bỏ từ khoảng trống giữa các đoạn giữ. */
function deriveRemoved(segs: EdlSegment[], dur: number | null): EdlRemoved[] {
  const out: EdlRemoved[] = [];
  const reason = 'Bỏ khi chỉnh tay';
  let cursor = 0;
  for (const s of segs) {
    if (s.in_s - cursor > 0.0005) out.push({ from_s: round3(cursor), to_s: s.in_s, reason });
    cursor = s.out_s;
  }
  if (dur !== null && dur - cursor > 0.0005) out.push({ from_s: round3(cursor), to_s: round3(dur), reason });
  return out;
}

// ------------------------------------------------------------------ payload job edit_plan (tính lúc claim)

export function editPlanPayload(ctx: AppContext, job: JobRow): Record<string, unknown> {
  const cut = ctx.db.prepare('SELECT * FROM final_cuts WHERE job_id = ?').get(job.id) as FinalCutRow | undefined;
  if (!cut) throw conflict('INVALID_STATE', `Job #${job.id} không gắn với bản dựng hoàn chỉnh nào`);
  const project = getProject(ctx, cut.project_id);
  const selection = parseJson<SelectionItem[]>(cut.selection, []);
  const scenes = selection.map((s) => {
    const scene = ctx.db.prepare('SELECT * FROM scenes WHERE id = ?').get(s.scene_id) as SceneRow;
    const asset = assetById(ctx, s.asset_id);
    const abs = asset ? path.join(ctx.config.rootDir, asset.file_path) : null;
    const info = abs ? probeMedia(ctx.config, abs) : null;
    const meta = asset ? parseJson<Record<string, unknown>>(asset.meta, {}) : {};
    const grid = asset
      ? (ctx.db.prepare("SELECT file_path FROM assets WHERE scene_id = ? AND kind = 'grid' AND attempt = ? ORDER BY id DESC LIMIT 1").get(s.scene_id, asset.attempt) as
          | { file_path: string }
          | undefined)
      : undefined;
    const comments = ctx.db
      .prepare('SELECT * FROM comments WHERE scene_id = ? AND resolved = 0 AND timecode IS NOT NULL ORDER BY id')
      .all(s.scene_id) as CommentRow[];
    return {
      scene_id: s.scene_id,
      code: s.code,
      title: scene.title,
      prompt: scene.prompt,
      asset_id: s.asset_id,
      attempt: s.attempt,
      video_path: asset?.file_path ?? null,
      abs_path: abs,
      duration_s: info?.duration_s ?? (typeof meta.duration_s === 'number' ? meta.duration_s : null),
      fps: info?.fps ?? null,
      width: info?.width ?? (typeof meta.width === 'number' ? meta.width : null),
      height: info?.height ?? (typeof meta.height === 'number' ? meta.height : null),
      grid_path: grid?.file_path ?? null,
      verdict: asset?.verdict ?? null,
      verdict_note: asset?.verdict_note ?? null,
      comments: comments.map(commentJson),
    };
  });
  return {
    final_cut_id: cut.id,
    version: cut.version,
    project: { id: project.id, slug: project.slug, name: project.name, style_lock: project.style_lock },
    scenes,
    constraints: { ...FINAL_CONSTRAINTS },
    output: (({ video_path, project_file_path, contact_sheet_path }) => ({ video_path, project_file_path, contact_sheet_path }))(finalPaths(project.slug, cut.version)),
    requeued: job.requeue_count > 0,
  };
}

// ------------------------------------------------------------------ vòng đời theo job edit_plan

export const editPlanResult = z.object({
  edl: z.unknown().optional(), // thiếu → validateEdl báo INVALID_EDL (bản góp ý: null/thiếu = giữ nguyên điểm cắt)
  summary: z.string().trim().min(1, 'cần tóm tắt 1–3 câu').max(2000),
  /** Chỉ bản góp ý (`payload.revision`): Grade đầy đủ (thiếu → giữ grade của bản cha) và các yêu cầu AI không làm được. */
  grade: z.unknown().optional(),
  not_done: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
});

/** Worker hoàn thành job edit_plan: kiểm tra EDL (sai → 400 INVALID_EDL, job giữ nguyên), lưu, chuyển `rendering` và xếp hàng render. */
export function completeEditPlan(ctx: AppContext, job: JobRow, result: { edl?: unknown; summary: string; grade?: unknown; not_done?: string[] }): number {
  const cut = ctx.db.prepare('SELECT * FROM final_cuts WHERE job_id = ?').get(job.id) as FinalCutRow | undefined;
  if (!cut) throw conflict('INVALID_STATE', `Job #${job.id} không gắn với bản dựng hoàn chỉnh nào`);
  if (cut.status !== 'planning') throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${cut.version} đang ở trạng thái ${cut.status}, không nhận kế hoạch dựng`);
  const edl = validateEdl(ctx, parseJson<SelectionItem[]>(cut.selection, []), result.edl);
  updateCut(ctx, cut.id, { edl: JSON.stringify(edl), summary: result.summary, status: 'rendering', stage: 'render', progress: null, error: null, failed_stage: null });
  logEvent(ctx, { project_id: cut.project_id, type: 'final_cut.planned', message: `Bản hoàn chỉnh v${cut.version}: AI đã chọn điểm cắt — ${result.summary}` });
  ctx.afterCommit(() => ctx.finalRender?.enqueue(cut.id));
  return cut.id;
}

/** Job edit_plan lỗi → bản dựng `failed`. */
export function failEditPlanCut(ctx: AppContext, jobId: number, error: string): void {
  const cut = ctx.db.prepare("SELECT * FROM final_cuts WHERE job_id = ? AND status = 'planning'").get(jobId) as FinalCutRow | undefined;
  if (!cut) return;
  updateCut(ctx, cut.id, { status: 'failed', error, finished_at: ctx.now() });
  logEvent(ctx, { project_id: cut.project_id, type: 'final_cut.failed', message: `Bản hoàn chỉnh v${cut.version} lỗi ở bước chọn điểm cắt: ${error}` });
}

/** Job edit_plan bị hủy (từ hàng đợi hoặc từ bản dựng) → bản dựng `cancelled`. */
export function cancelCutForJob(ctx: AppContext, jobId: number): void {
  const cut = ctx.db.prepare("SELECT * FROM final_cuts WHERE job_id = ? AND status = 'planning'").get(jobId) as FinalCutRow | undefined;
  if (!cut) return;
  updateCut(ctx, cut.id, { status: 'cancelled', finished_at: ctx.now() });
  logEvent(ctx, { project_id: cut.project_id, type: 'final_cut.cancelled', message: `Bản hoàn chỉnh v${cut.version} đã bị hủy` });
}

// ------------------------------------------------------------------ người dùng: render lại / hủy / mở Shotcut

export const rerenderBody = z.object({ edl: z.unknown().optional(), note: z.string().trim().max(2000).optional() });

/** Người dùng chỉnh EDL → version MỚI (created_by `user`, cùng lựa chọn video như bản gốc), render ngay, không qua worker, không tốn credit. */
export function rerenderFinalCut(ctx: AppContext, sourceId: number, input: { edl: unknown; note?: string }): number {
  return ctx.tx(() => {
    const src = getFinalCutRow(ctx, sourceId);
    const project = getProject(ctx, src.project_id);
    const busy = ctx.db
      .prepare("SELECT version FROM final_cuts WHERE project_id = ? AND status = 'rendering' ORDER BY version DESC LIMIT 1")
      .get(src.project_id) as { version: number } | undefined;
    if (busy) throw conflict('FINAL_CUT_ACTIVE', `Đang render bản hoàn chỉnh v${busy.version}; hãy đợi hoặc hủy trước khi render lại`);
    const selection = parseJson<SelectionItem[]>(src.selection, []);
    const edl = validateEdl(ctx, selection, input.edl);
    const id = insertCut(ctx, project, { status: 'rendering', selection, signature: src.selection_signature, created_by: 'user', edl, note: input.note ?? null });
    const cut = getFinalCutRow(ctx, id);
    logEvent(ctx, {
      project_id: project.id,
      type: 'final_cut.created',
      message: `Bản hoàn chỉnh v${cut.version}: người dùng chỉnh điểm cắt từ v${src.version}, đang render${input.note ? ` — ${input.note}` : ''}`,
    });
    emitFinalCut(ctx, id, project.id);
    emitProject(ctx, project.id);
    ctx.afterCommit(() => ctx.finalRender?.enqueue(id));
    return id;
  });
}

/** Hủy: `planning` → hủy job edit_plan; `rendering` → hủy render (kill ffmpeg / cancel_render). Trạng thái khác → 409. */
export function cancelFinalCut(ctx: AppContext, id: number): FinalCutRow {
  return ctx.tx(() => {
    const cut = getFinalCutRow(ctx, id);
    if (!ACTIVE.includes(cut.status)) throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${cut.version} đang ở trạng thái ${cut.status}, không thể hủy`);
    if (cut.status === 'planning') {
      const job = cut.job_id ? (ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(cut.job_id) as JobRow | undefined) : undefined;
      if (job && ['queued', 'claimed', 'running'].includes(job.status)) {
        ctx.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, error = 'Đã hủy bởi người dùng' WHERE id = ?").run(ctx.now(), job.id);
        ctx.publish('job.updated', job.project_id, () => ({ job: getJobJson(ctx, job.id) }), `job:${job.id}`);
      }
    } else {
      ctx.afterCommit(() => ctx.finalRender?.cancel(id));
    }
    // Hủy giữa bước xoá logo: giữ bản raw (đã render xong) và ghi failed_stage='clean' để còn bấm "Thử xoá logo lại"
    const updated = updateCut(ctx, id, {
      status: 'cancelled',
      finished_at: ctx.now(),
      error: null,
      // Hủy giữa bước chỉnh màu: bản sạch/bản cha còn nguyên nên bấm «Thử chỉnh màu lại» chạy lại được (failed_stage='grade')
      failed_stage: cut.stage === 'clean' && cut.raw_video_path ? 'clean' : cut.stage === 'grade' ? 'grade' : null,
      stage: null,
    });
    logEvent(ctx, { project_id: cut.project_id, type: 'final_cut.cancelled', message: `Bản hoàn chỉnh v${cut.version} đã bị hủy` });
    return updated;
  });
}

/** Ghi nhận xong (render [+ xoá logo]): `ready` + log.md + event. */
export function markReady(
  ctx: AppContext,
  id: number,
  r: {
    renderer: 'shotcut' | 'ffmpeg' | null;
    video_path: string;
    raw_video_path?: string | null;
    /** Bản sạch chưa chỉnh màu (chỉ khi có chỉnh màu); undefined = giữ nguyên. */
    base_path?: string | null;
    contact_sheet_path: string | null;
    project_file_path: string | null;
    duration_s: number | null;
    watermark_removed: boolean;
    watermark_meta?: unknown;
    /** true khi chỉ chạy lại bước xoá logo (endpoint /clean), không render lại. */
    cleanOnly?: boolean;
  },
): boolean {
  return ctx.tx(() => {
    const cut = getFinalCutRow(ctx, id);
    if (cut.status !== 'rendering') return false; // đã bị hủy trong lúc render
    const project = getProject(ctx, cut.project_id);
    const renderer = r.renderer ?? cut.renderer;
    updateCut(ctx, id, {
      status: 'ready',
      stage: null,
      failed_stage: null,
      renderer,
      video_path: r.video_path,
      raw_video_path: r.raw_video_path === undefined ? cut.raw_video_path : r.raw_video_path,
      base_path: r.base_path === undefined ? cut.base_path : r.base_path,
      contact_sheet_path: r.contact_sheet_path ?? cut.contact_sheet_path,
      project_file_path: r.project_file_path ?? cut.project_file_path,
      duration_s: r.duration_s,
      watermark_removed: r.watermark_removed ? 1 : 0,
      watermark_meta: r.watermark_meta === undefined || r.watermark_meta === null ? (r.watermark_meta === undefined ? cut.watermark_meta : null) : JSON.stringify(r.watermark_meta),
      progress: 100,
      error: null,
      finished_at: ctx.now(),
    });
    const dur = r.duration_s ? `, ${round3(r.duration_s)} giây` : '';
    logEvent(ctx, {
      project_id: cut.project_id,
      type: 'final_cut.ready',
      message: `Bản hoàn chỉnh v${cut.version} sẵn sàng (${renderer}${dur}${r.watermark_removed ? ', đã xoá logo Veo' : r.cleanOnly ? '' : ', chưa xoá logo Veo'}${gradeNote(cut)})`,
    });
    appendLogRow(
      ctx,
      project.slug,
      r.cleanOnly
        ? { clip: 'FINAL', attempt: `v${cut.version}`, type: 'xoá logo Veo', issue: `Bản dựng v${cut.version} đã xoá logo Veo (bản gốc còn logo: ${path.basename(r.raw_video_path ?? cut.raw_video_path ?? '')})`, conclusion: 'Sẵn sàng' }
        : { clip: 'FINAL', attempt: `v${cut.version}`, type: finalLogType(renderer, r.watermark_removed, parseStoredGrade(cut.grade)), issue: cut.summary ?? cut.note ?? '', conclusion: 'Sẵn sàng' },
    );
    return true;
  });
}

/** Cột "loại" của dòng log.md cho bản dựng. */
export const finalLogType = (renderer: string | null, watermarkRemoved: boolean, grade?: Grade | null): string =>
  `bản dựng (${renderer ?? '?'}, cắt thẳng${watermarkRemoved ? '; đã xoá logo Veo' : ''}${grade && !isNeutralGrade(grade) ? '; đã chỉnh màu' : ''})`;

/** ", đã chỉnh màu (Ấm 7200K, Tương phản 1.15)" cho thông báo; rỗng khi chưa chỉnh màu. */
const gradeNote = (cut: FinalCutRow): string => {
  const g = parseStoredGrade(cut.grade);
  return g && !isNeutralGrade(g) ? `, đã chỉnh màu (${gradeChips(g).join(', ')})` : '';
};

/** Thất bại ở bước `render` hoặc `clean`. Với `clean`, GIỮ `raw_video_path` (không hiển thị raw như bản hoàn chỉnh). */
export function markFailed(ctx: AppContext, id: number, error: string, failedStage: 'render' | 'clean' | 'grade' = 'render'): boolean {
  return ctx.tx(() => {
    const cut = getFinalCutRow(ctx, id);
    if (cut.status !== 'rendering') return false;
    updateCut(ctx, id, { status: 'failed', stage: null, failed_stage: failedStage, error, finished_at: ctx.now() });
    logEvent(ctx, {
      project_id: cut.project_id,
      type: 'final_cut.failed',
      message: `Bản hoàn chỉnh v${cut.version} ${failedStage === 'render' ? 'render ' : ''}lỗi: ${error}`,
    });
    return true;
  });
}

/**
 * Khi server khởi động: bản đang `rendering` (tiến trình cũ đã chết) → `failed`.
 * Đang ở bước xoá logo → `failed_stage='clean'` (bản raw còn đó, bấm "Thử xoá logo lại"), dọn file tạm.
 */
export function recoverRenderingCuts(ctx: AppContext): number {
  return ctx.tx(() => {
    const rows = ctx.db.prepare("SELECT * FROM final_cuts WHERE status = 'rendering'").all() as FinalCutRow[];
    for (const cut of rows) {
      const cleaning = cut.stage === 'clean';
      const grading = cut.stage === 'grade';
      const project = getProjectAny(ctx, cut.project_id); // khởi động không được hỏng vì dự án nằm trong thùng rác
      if (cleaning || grading) {
        // file tạm của bước xoá logo (ra bản chính hoặc bản sạch khi có chỉnh màu) và của bước chỉnh màu
        const p = finalPaths(project.slug, cut.version);
        const tmps = [tmpCleanPath(ctx.config.rootDir, p.video_path), tmpCleanPath(ctx.config.rootDir, p.base_path)];
        ctx.afterCommit(() => tmps.forEach((t) => fs.rmSync(t, { force: true })));
      }
      updateCut(ctx, cut.id, {
        status: 'failed',
        stage: null,
        failed_stage: grading ? 'grade' : cleaning ? 'clean' : 'render',
        error: grading
          ? 'Server khởi động lại trong lúc chỉnh màu; bấm Thử chỉnh màu lại'
          : cleaning
            ? 'Server khởi động lại trong lúc xoá logo Veo; bấm Thử xoá logo lại'
            : 'Server khởi động lại trong lúc render; bấm Render lại',
        finished_at: ctx.now(),
      });
      logEvent(ctx, {
        project_id: cut.project_id,
        type: 'final_cut.failed',
        message: `Bản hoàn chỉnh v${cut.version}: server khởi động lại trong lúc ${grading ? 'chỉnh màu' : cleaning ? 'xoá logo Veo' : 'render'}`,
      });
    }
    return rows.length;
  });
}

/** File tạm của bước xoá logo: cùng thư mục với bản chính, tên `.<tên>.tmp.mp4`. */
export function tmpCleanPath(rootDir: string, mainRel: string): string {
  const abs = path.join(rootDir, mainRel);
  return path.join(path.dirname(abs), `.${path.basename(abs, '.mp4')}.tmp.mp4`);
}

/**
 * `POST /api/final-cuts/:id/clean`: chạy lại RIÊNG bước xoá logo Veo (không render lại, không tốn credit).
 * Cho phép khi `failed_stage='clean'` (failed hoặc cancelled giữa chừng) hoặc khi `ready` mà `watermark_removed=0`.
 * Bản cũ chưa có `raw_video_path` (render trước khi có bước này): đổi tên `<slug>_final_v<n>.mp4` → `_raw.mp4` TRƯỚC
 * (nguyên tử, cập nhật DB), rồi xoá logo ra tên chính. Route phải kiểm tra tool khả dụng trước khi gọi.
 */
export function cleanFinalCut(ctx: AppContext, id: number, wm: { active: boolean; reason: string }): FinalCutRow {
  return ctx.tx(() => {
    const cut = getFinalCutRow(ctx, id);
    const project = getProject(ctx, cut.project_id);
    const retry = cut.failed_stage === 'clean' && (cut.status === 'failed' || cut.status === 'cancelled');
    const legacy = cut.status === 'ready' && !cut.watermark_removed;
    if (!retry && !legacy) {
      throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${cut.version} đang ở trạng thái ${cut.status}${cut.watermark_removed ? ' (đã xoá logo)' : ''}; chỉ xoá logo lại được bản lỗi ở bước xoá logo hoặc bản đã sẵn sàng nhưng còn logo`);
    }
    if (!wm.active) throw conflict('WATERMARK_REMOVER_UNAVAILABLE', `Không xoá logo Veo được: ${wm.reason}`);
    // Bản đã chỉnh màu mà chưa có bản gốc còn logo (render lúc tool xoá logo tắt): video hiện có đã bị đổi màu nên KHÔNG được coi là bản raw (xoá logo sau chỉnh màu sẽ để lại vết)
    if (legacy && !cut.raw_video_path && !isNeutralGrade(parseStoredGrade(cut.grade))) {
      throw conflict('GRADED_CUT', `Bản hoàn chỉnh v${cut.version} đã chỉnh màu nên không xoá logo sau được (chỉnh màu phải chạy SAU xoá logo). Hãy «Edit tự động» lại để tạo bản mới`);
    }
    const root = ctx.config.rootDir;
    const paths = finalPaths(project.slug, cut.version);
    let rawRel = cut.raw_video_path;
    let renamed: { from: string; to: string } | null = null;
    if (!rawRel) {
      // bản cũ: video hiện có (còn logo) trở thành bản raw
      if (!cut.video_path) throw conflict('FILE_MISSING', `Bản hoàn chỉnh v${cut.version} không có video để xoá logo`);
      const from = path.join(root, cut.video_path);
      const to = path.join(root, paths.raw_video_path);
      if (!fs.existsSync(from)) throw conflict('FILE_MISSING', `Không thấy file ${cut.video_path} để xoá logo`);
      if (fs.existsSync(to)) throw conflict('RAW_EXISTS', `File ${paths.raw_video_path} đã tồn tại; không ghi đè`);
      fs.renameSync(from, to); // nguyên tử (cùng thư mục)
      renamed = { from, to };
      rawRel = paths.raw_video_path;
    } else if (!fs.existsSync(path.join(root, rawRel))) {
      throw conflict('FILE_MISSING', `Không thấy bản gốc ${rawRel} để xoá logo`);
    }
    if (fs.existsSync(path.join(root, paths.video_path))) {
      if (renamed) fs.renameSync(renamed.to, renamed.from);
      throw conflict('INVALID_STATE', `File ${paths.video_path} đã tồn tại; không ghi đè`);
    }
    try {
      const updated = updateCut(ctx, id, {
        status: 'rendering',
        stage: 'clean',
        failed_stage: null,
        raw_video_path: rawRel,
        video_path: null,
        progress: 0,
        error: null,
        finished_at: null,
      });
      logEvent(ctx, { project_id: cut.project_id, type: 'final_cut.clean', message: `Bản hoàn chỉnh v${cut.version}: bắt đầu xoá logo Veo${renamed ? ' (đổi tên bản cũ thành _raw)' : ''}` });
      ctx.afterCommit(() => ctx.finalRender?.enqueue(id, 'clean'));
      return updated;
    } catch (err) {
      if (renamed) fs.renameSync(renamed.to, renamed.from); // DB lỗi: trả file về chỗ cũ
      throw err;
    }
  });
}
