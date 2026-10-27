/**
 * Bản hoàn chỉnh (final cut) cho kế hoạch LAN. GỌI LẠI dịch vụ hiện có (`final-cuts.ts`: tạo + job `edit_plan`, render lại bằng EDL,
 * hủy, xoá logo lại; hàng đợi render và bước xoá logo của `final-render/`), chỉ thêm:
 * - điều kiện dựng của dự án `lan` = MỌI cảnh có video được chọn (không phụ thuộc trạng thái `done` của máy trạng thái app; cảnh LAN
 *   không bao giờ đổi trạng thái vì upload video). Hàm `createFinalCutManual` của app vốn chỉ kiểm tra `selected_video_id`, nên dự án
 *   `app` không đổi hành vi; việc TỰ kích hoạt (`maybeAutoFinalCut`) bị chặn riêng cho dự án `lan`;
 * - trần hàng đợi LAN (6) trước khi tạo việc;
 * - JSON an toàn cho LAN: URL qua `/lan/files`, không có .mlt, đường dẫn tuyệt đối trong lỗi bị che, không có `watermark_meta`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../lib/errors.js';
import type { AssetRow, FinalCutRow, ProjectRow } from '../db/types.js';
import { colorRefOfGrade } from './color-refs.js';
import { assertLanQueueRoom } from './lan-queue.js';
import { LAN_UPLOAD_SOURCE, lanFileUrl, scrubForLan } from './lan-common.js';
import {
  cancelFinalCut,
  cleanFinalCut,
  createFinalCutManual,
  currentSelection,
  finalCutJson,
  getFinalCutRow,
  rerenderBody,
  rerenderFinalCut,
  type FinalCutJson,
} from './final-cuts.js';

export { rerenderBody };
import { createFeedbackRevision, createGradeRevision, regradeFinalCut } from './final-revisions.js';
import { gradePreview } from './final-render/grade-preview.js';
import { parseJson } from './repo.js';
import type { WatermarkStatus } from './final-render/index.js';

const ACTIVE = new Set(['planning', 'rendering']);

/** Cắt đúng cột của một bản dựng thuộc dự án `lan`; bản của dự án khác trả 404 như không tồn tại. */
export function lanFinalCutRow(ctx: AppContext, project: ProjectRow, cutId: number): FinalCutRow {
  const row = getFinalCutRow(ctx, cutId);
  if (row.project_id !== project.id) throw notFound('bản dựng hoàn chỉnh');
  return row;
}

/** URL qua LAN của video nguồn nếu là video người dùng LAN tải lên (video do chủ máy tạo không phục vụ qua LAN → null). */
function lanSourceUrl(ctx: AppContext, assetId: number): string | null {
  const a = ctx.db.prepare('SELECT file_path, meta FROM assets WHERE id = ?').get(assetId) as Pick<AssetRow, 'file_path' | 'meta'> | undefined;
  return a && parseJson<{ source?: string }>(a.meta, {}).source === LAN_UPLOAD_SOURCE ? lanFileUrl(a.file_path) : null;
}

/** JSON của một bản dựng cho người dùng LAN (cùng hình dạng với FinalCut của app chính để dùng lại EdlEditor/FinalTimeline). */
export function lanFinalCutJson(ctx: AppContext, row: FinalCutRow, currentSig?: string) {
  const j: FinalCutJson = finalCutJson(ctx, row, currentSig);
  const ready = row.status === 'ready';
  const pos = row.status === 'rendering' ? (ctx.finalRender?.position('cut', row.id) ?? null) : null;
  return {
    ...j,
    // chỉ video nguồn do người dùng LAN tải lên mới xem được qua LAN
    selection: j.selection.map((s) => ({ ...s, video_url: lanSourceUrl(ctx, s.asset_id) })),
    video_path: null,
    video_url: ready && row.video_path ? lanFileUrl(row.video_path) : null,
    raw_video_path: null,
    raw_video_url: row.raw_video_path ? lanFileUrl(row.raw_video_path) : null,
    contact_sheet_path: null,
    base_path: null,
    contact_sheet_url: ready && row.contact_sheet_path ? lanFileUrl(row.contact_sheet_path) : null,
    color_ref: colorRefOfGrade(ctx, row.project_id, j.grade?.match?.ref_id, lanFileUrl),
    project_file_path: null,
    render_ref: null,
    watermark_meta: null,
    error: scrubForLan(row.error, row.failed_stage === 'clean' ? 'Xoá logo Veo không thành công. Bấm «Thử xoá logo lại»; nếu vẫn lỗi, báo chủ máy.' : row.failed_stage === 'grade' ? 'Chỉnh màu không thành công. Bấm «Thử chỉnh màu lại»; nếu vẫn lỗi, báo chủ máy.' : 'Edit không thành công. Bấm «Edit tự động» để thử lại; nếu vẫn lỗi, báo chủ máy.'),
    /** (Cũ, giữ để tương thích) 0 = đang chạy; n = `running_count + queue_position`; null = không ở trong hàng đợi. Dùng `queue_state`/`queue_position`/`running_count`/`concurrency`/`ai_queue`. */
    queue_ahead: pos,
  };
}
export type LanFinalCutJson = ReturnType<typeof lanFinalCutJson>;

export function listLanFinalCuts(ctx: AppContext, project: ProjectRow): LanFinalCutJson[] {
  const sig = currentSelection(ctx, project.id).signature;
  const rows = ctx.db.prepare('SELECT * FROM final_cuts WHERE project_id = ? ORDER BY version DESC').all(project.id) as FinalCutRow[];
  return rows.map((r) => lanFinalCutJson(ctx, r, sig));
}

/** Lý do chưa bấm được "Dựng bản hoàn chỉnh" (null = được): mọi cảnh phải có video được chọn, file còn đủ, và chưa có bản đang chạy. */
export function lanFinalBlock(ctx: AppContext, projectId: number): { code: string; message: string } | null {
  const sel = currentSelection(ctx, projectId);
  if (sel.sceneCount === 0) return { code: 'SCENES_NOT_READY', message: 'Kế hoạch chưa có cảnh nào' };
  if (sel.missing.length) return { code: 'SCENES_NOT_READY', message: `Còn ${sel.missing.join(', ')} chưa có video` };
  for (const it of sel.items) {
    const a = ctx.db.prepare('SELECT file_path FROM assets WHERE id = ?').get(it.asset_id) as { file_path: string } | undefined;
    if (!a || !fs.existsSync(path.join(ctx.config.rootDir, a.file_path))) return { code: 'FILE_MISSING', message: `Video của cảnh ${it.code} không còn trên máy chủ, hãy tải lên lại` };
  }
  const active = ctx.db.prepare("SELECT version, status FROM final_cuts WHERE project_id = ? AND status IN ('planning','rendering') ORDER BY version DESC LIMIT 1").get(projectId) as
    | { version: number; status: string }
    | undefined;
  if (active) return { code: 'FINAL_CUT_ACTIVE', message: `Đang ${active.status === 'planning' ? 'chọn điểm cắt cho' : 'dựng'} bản hoàn chỉnh v${active.version}` };
  return null;
}

/** Tóm tắt cho chi tiết kế hoạch: khối "Bản hoàn chỉnh" cần biết nút dựng có bấm được không và có bản nào đang chạy. */
export function lanFinalSummary(ctx: AppContext, project: ProjectRow) {
  const latest = ctx.db.prepare('SELECT id, version, status FROM final_cuts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(project.id) as
    | { id: number; version: number; status: string }
    | undefined;
  return {
    block: lanFinalBlock(ctx, project.id),
    active: !!latest && ACTIVE.has(latest.status),
    latest: latest ?? null,
  };
}

/** Che lý do của tool xoá logo (có thể chứa đường dẫn trên máy chủ). */
export function lanWatermarkInfo(wm: WatermarkStatus): { active: boolean; reason: string } {
  if (wm.active) return { active: true, reason: 'Tool xoá logo Veo sẵn sàng' };
  return {
    active: false,
    reason: wm.mode === 'off' ? 'Chủ máy đã tắt bước xoá logo Veo' : 'Tool xoá logo Veo chưa sẵn sàng trên máy chủ',
  };
}

/** Dựng bản mới: kiểm tra điều kiện LAN + trần hàng đợi, rồi dùng `createFinalCutManual` (tạo final_cut `planning` + job `edit_plan`). */
export function createLanFinalCut(ctx: AppContext, project: ProjectRow): { cutId: number; jobId: number } {
  return ctx.tx(() => {
    const block = lanFinalBlock(ctx, project.id);
    if (block) throw conflict(block.code, block.message);
    assertLanQueueRoom(ctx);
    return createFinalCutManual(ctx, project.id);
  });
}

/** Render lại với EDL người dùng sửa (version mới, không qua worker, không tốn credit). */
export function rerenderLanFinalCut(ctx: AppContext, project: ProjectRow, cutId: number, input: { edl: unknown; note?: string }): number {
  return ctx.tx(() => {
    lanFinalCutRow(ctx, project, cutId);
    assertLanQueueRoom(ctx);
    return rerenderFinalCut(ctx, cutId, input);
  });
}

/** Góp ý cho AI trên một bản `ready`: phiên bản mới + job `edit_plan`; tính vào trần hàng đợi LAN. */
export function createLanFeedback(ctx: AppContext, project: ProjectRow, cutId: number, feedback: string, wm: { active: boolean }): { cutId: number; jobId: number } {
  return ctx.tx(() => {
    lanFinalCutRow(ctx, project, cutId);
    assertLanQueueRoom(ctx);
    return createFeedbackRevision(ctx, cutId, feedback, wm);
  });
}

/** Chỉnh màu tay (phiên bản mới, không qua AI); tính vào trần hàng đợi LAN. */
export function createLanGrade(ctx: AppContext, project: ProjectRow, cutId: number, grade: unknown, note: string | undefined, wm: { active: boolean }): number {
  return ctx.tx(() => {
    lanFinalCutRow(ctx, project, cutId);
    assertLanQueueRoom(ctx);
    return createGradeRevision(ctx, cutId, grade, note, wm);
  });
}

/** Chạy lại bước chỉnh màu của bản lỗi/hủy giữa bước chỉnh màu. */
export function regradeLanFinalCut(ctx: AppContext, project: ProjectRow, cutId: number): FinalCutRow {
  return ctx.tx(() => {
    lanFinalCutRow(ctx, project, cutId);
    assertLanQueueRoom(ctx);
    return regradeFinalCut(ctx, cutId);
  });
}

/** Ảnh trước/sau (đường dẫn qua `/lan/files`); không vào hàng đợi nhưng có hạn mức riêng theo IP. */
export async function lanGradePreview(ctx: AppContext, project: ProjectRow, cutId: number, grade: unknown) {
  lanFinalCutRow(ctx, project, cutId);
  const r = await gradePreview(ctx, cutId, grade);
  return { hash: r.hash, items: r.items.map((i) => ({ t: i.t, before_url: lanFileUrl(i.before), after_url: lanFileUrl(i.after) })) };
}

export function cancelLanFinalCut(ctx: AppContext, project: ProjectRow, cutId: number): FinalCutRow {
  lanFinalCutRow(ctx, project, cutId);
  return cancelFinalCut(ctx, cutId);
}

/** Chạy lại RIÊNG bước xoá logo của một bản dựng (không render lại). Tool tắt → 409 WATERMARK_REMOVER_UNAVAILABLE với lý do đã che đường dẫn. */
export function cleanLanFinalCut(ctx: AppContext, project: ProjectRow, cutId: number, wm: WatermarkStatus): FinalCutRow {
  return ctx.tx(() => {
    lanFinalCutRow(ctx, project, cutId);
    assertLanQueueRoom(ctx);
    // cleanFinalCut kiểm tra trạng thái bản dựng trước, rồi mới tới tool (nhận lý do đã che đường dẫn)
    return cleanFinalCut(ctx, cutId, lanWatermarkInfo(wm));
  });
}
