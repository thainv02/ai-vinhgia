import type { EdlRemoved, EdlSegment, FinalCut, FinalCutStage, FinalCutStatus, Scene } from '../api/types';
import { FINAL_STATUS } from './status';

export const MIN_SEGMENT_S = 0.3;
const GAP_EPS = 0.04;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "38,2 giây" */
export function fmtSeconds(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(1).replace('.', ',')} giây`;
}

export function finalVideoUrl(fc: Pick<FinalCut, 'video_path' | 'video_url'>): string | null {
  if (fc.video_url) return fc.video_url;
  return fc.video_path ? `/files/${fc.video_path}` : null;
}

export function finalContactUrl(fc: Pick<FinalCut, 'contact_sheet_path' | 'contact_sheet_url'>): string | null {
  if (fc.contact_sheet_url) return fc.contact_sheet_url;
  return fc.contact_sheet_path ? `/files/${fc.contact_sheet_path}` : null;
}

interface StageInfo {
  status: FinalCutStatus;
  stage?: FinalCutStage | null;
  failed_stage?: FinalCutStage | null;
  watermark_removed?: boolean;
}

/** Nhãn trạng thái tính cả bước con: khi `rendering` thì là "Đang render" hoặc "Đang xoá logo Veo". */
export function finalStatusLabel(fc: StageInfo): string {
  if (fc.status === 'rendering') return fc.stage === 'clean' ? 'Đang xoá logo Veo' : 'Đang render';
  if (fc.status === 'failed' && fc.failed_stage === 'clean') return 'Lỗi xoá logo';
  return FINAL_STATUS[fc.status].label;
}

/**
 * Nút xoá logo Veo cho bản dựng: `retry` = lỗi/hủy ở bước xoá logo (bản render còn giữ) → "Thử xoá logo lại";
 * `clean` = bản sẵn sàng nhưng còn logo (render trước khi có bước này, hoặc tool đang tắt) → "Xoá logo Veo"; null = không có nút.
 */
export function cleanAction(fc: StageInfo): 'retry' | 'clean' | null {
  if ((fc.status === 'failed' || fc.status === 'cancelled') && fc.failed_stage === 'clean') return 'retry';
  if (fc.status === 'ready' && fc.watermark_removed === false) return 'clean';
  return null;
}

/** Các cảnh chưa sẵn sàng để dựng: chưa hoàn tất hoặc chưa có video được chọn. */
export function scenesNotReady(scenes: Scene[]): string[] {
  return scenes.filter((s) => !(s.status === 'done' && s.selected_video_id)).map((s) => s.code);
}

/** Lý do chặn "Dựng bản mới" (hoặc null nếu bấm được). */
export function finalBlockReason(scenes: Scene[] | undefined, latest: FinalCut | undefined, serverBlock?: { message: string } | null): string | null {
  if (!scenes) return serverBlock?.message ?? 'Đang tải danh sách cảnh';
  if (scenes.length === 0) return 'Dự án chưa có cảnh nào';
  const missing = scenesNotReady(scenes);
  if (missing.length > 0) return `Còn ${missing.join(', ')} chưa chọn video`;
  if (latest && (latest.status === 'planning' || latest.status === 'rendering')) {
    return `Đang có bản dựng v${latest.version} ${latest.status === 'planning' ? 'chờ Claude chọn điểm cắt' : 'đang render'}`;
  }
  return null;
}

// ---- Dựng timeline từ EDL ----
export interface TlSegment extends EdlSegment {
  /** Vị trí bắt đầu của đoạn trong video kết quả (giây). */
  outStart: number;
}
export interface TlRemoved extends EdlRemoved {
  /** Vị trí trong video kết quả tại chỗ cắt (để tua tới). */
  seekOut: number;
}
export interface TlScene {
  scene_id: number;
  code: string;
  asset_id: number;
  sourceDuration: number;
  kept: TlSegment[];
  removed: TlRemoved[];
  outStart: number;
  outDuration: number;
  note: string | null;
}
export interface Timeline {
  scenes: TlScene[];
  total: number;
}

/** Khoảng bị cắt = phần trống giữa các đoạn giữ; lý do lấy từ mục `removed` của EDL trùng nhiều nhất. */
export function computeRemoved(segments: EdlSegment[], duration: number, previous: EdlRemoved[], defaultReason = 'Người dùng cắt'): EdlRemoved[] {
  const segs = [...segments].filter((s) => s.out_s > s.in_s).sort((a, b) => a.in_s - b.in_s);
  const gaps: { from_s: number; to_s: number }[] = [];
  let cursor = 0;
  for (const s of segs) {
    if (s.in_s - cursor > GAP_EPS) gaps.push({ from_s: round2(cursor), to_s: round2(s.in_s) });
    cursor = Math.max(cursor, s.out_s);
  }
  if (duration - cursor > GAP_EPS) gaps.push({ from_s: round2(cursor), to_s: round2(duration) });
  return gaps.map((g) => {
    let best: EdlRemoved | null = null;
    let bestOverlap = 0;
    for (const p of previous) {
      const o = Math.min(g.to_s, p.to_s) - Math.max(g.from_s, p.from_s);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = p;
      }
    }
    return { ...g, reason: best?.reason || defaultReason };
  });
}

/** Độ dài video nguồn lấy từ `selection[].duration_s` của chính bản dựng. */
export function buildTimeline(fc: FinalCut): Timeline {
  const durations = new Map<number, number>();
  for (const s of fc.selection) if (typeof s.duration_s === 'number') durations.set(s.asset_id, s.duration_s);
  const codeOf = new Map(fc.selection.map((s) => [s.scene_id, s.code]));
  const order = new Map(fc.selection.map((s, i) => [s.scene_id, i]));
  const edlScenes = [...(fc.edl?.scenes ?? [])].sort((a, b) => (order.get(a.scene_id) ?? 0) - (order.get(b.scene_id) ?? 0));
  let acc = 0;
  const scenes: TlScene[] = edlScenes.map((es) => {
    const segs = [...es.segments].sort((a, b) => a.in_s - b.in_s);
    const sourceDuration = Math.max(durations.get(es.asset_id) ?? 0, ...segs.map((s) => s.out_s), ...es.removed.map((r) => r.to_s), 0.1);
    const outStart = acc;
    const kept: TlSegment[] = segs.map((s) => {
      const t: TlSegment = { in_s: s.in_s, out_s: s.out_s, outStart: acc };
      acc += s.out_s - s.in_s;
      return t;
    });
    const outDuration = acc - outStart;
    const removed: TlRemoved[] = computeRemoved(segs, sourceDuration, es.removed).map((r) => {
      const next = kept.find((k) => k.in_s >= r.to_s - GAP_EPS);
      return { ...r, seekOut: next ? next.outStart : outStart + outDuration };
    });
    return { scene_id: es.scene_id, code: codeOf.get(es.scene_id) ?? `#${es.scene_id}`, asset_id: es.asset_id, sourceDuration, kept, removed, outStart, outDuration, note: es.note ?? null };
  });
  return { scenes, total: acc };
}

/** Từ thời điểm t trong video kết quả suy ra vị trí trên timeline nguồn (cảnh + giây nguồn). */
export function outputToSource(tl: Timeline, t: number): { sceneIdx: number; sourceT: number } | null {
  for (let i = 0; i < tl.scenes.length; i++) {
    const sc = tl.scenes[i]!;
    for (const k of sc.kept) {
      if (t >= k.outStart - 1e-6 && t < k.outStart + (k.out_s - k.in_s) + 1e-6) return { sceneIdx: i, sourceT: k.in_s + (t - k.outStart) };
    }
  }
  return null;
}

/** Lỗi từng đoạn (khớp luật server): in<out, ≥0,3s, trong [0, duration], tăng dần và không chồng nhau. */
export function validateSegments(segments: EdlSegment[], duration: number | null): (string | null)[] {
  return segments.map((s, i) => {
    if (!Number.isFinite(s.in_s) || !Number.isFinite(s.out_s)) return 'Nhập số giây hợp lệ';
    if (s.in_s < 0) return 'In không được âm';
    if (s.out_s <= s.in_s) return 'Out phải lớn hơn in';
    if (s.out_s - s.in_s < MIN_SEGMENT_S - 1e-6) return `Đoạn phải dài ít nhất ${String(MIN_SEGMENT_S).replace('.', ',')} giây`;
    if (duration !== null && s.out_s > duration + 0.05) return `Vượt quá độ dài video (${fmtSeconds(duration)})`;
    const prev = segments[i - 1];
    if (prev && s.in_s < prev.out_s - 1e-6) return 'Chồng lên hoặc đứng trước đoạn trước';
    return null;
  });
}
