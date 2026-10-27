import type { AiQueue, EdlRemoved, EdlSegment, FinalCut, FinalCutStage, FinalCutStatus, RenderQueueState, Scene } from '../api/types';
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
  queue_state?: RenderQueueState | null;
  queue_position?: number | null;
  ai_queue?: AiQueue | null;
  /** Phiên bản góp ý / chỉnh màu (có bản cha). */
  parent_id?: number | null;
}

/**
 * Nhãn trạng thái tính cả bước con và hàng đợi: `planning` chờ worker AI → "Chờ AI (vị trí N)", AI nhận rồi → "AI đang chọn điểm cắt";
 * `rendering` chưa bắt đầu → "Chờ render (vị trí N)", rồi "Đang render" / "Đang xoá logo Veo".
 */
export function finalStatusLabel(fc: StageInfo): string {
  if (fc.status === 'planning' && fc.ai_queue?.state === 'waiting' && fc.ai_queue.position) return `Chờ AI (vị trí ${fc.ai_queue.position})`;
  if (fc.status === 'planning' && fc.parent_id) return 'AI đang đọc góp ý';
  if (fc.status === 'rendering') {
    if (fc.queue_state === 'waiting' && fc.queue_position) return `${STAGE_WAIT[fc.stage ?? 'render']} (vị trí ${fc.queue_position})`;
    return STAGE_RUN[fc.stage ?? 'render'];
  }
  if (fc.status === 'failed' && fc.failed_stage === 'clean') return 'Lỗi xoá logo';
  if (fc.status === 'failed' && fc.failed_stage === 'grade') return 'Lỗi chỉnh màu';
  return FINAL_STATUS[fc.status].label;
}

const STAGE_RUN: Record<FinalCutStage, string> = { render: 'Đang render', clean: 'Đang xoá logo Veo', grade: 'Đang chỉnh màu' };
const STAGE_WAIT: Record<FinalCutStage, string> = { render: 'Chờ render', clean: 'Chờ xoá logo', grade: 'Chờ chỉnh màu' };
/** Tên bước đang chạy cho thanh tiến độ (aria-label). */
export const stageProgressLabel = (stage: FinalCutStage | null): string => ({ render: 'Tiến độ render', clean: 'Tiến độ xoá logo Veo', grade: 'Tiến độ chỉnh màu' })[stage ?? 'render'];

/** Bản đã `rendering` trong DB nhưng đang đợi chỗ trống trong hàng đợi render (CHƯA bắt đầu): không có tiến độ để hiện. */
export const isWaitingToRender = (fc: Pick<StageInfo, 'status' | 'queue_state'>): boolean => fc.status === 'rendering' && fc.queue_state === 'waiting';

export interface QueueNote {
  /** Dòng chính: "Đang xếp hàng chờ AI (vị trí 2)" ... */
  title: string;
  /** Dòng phụ giải thích (có thể null). */
  detail: string | null;
  /** Cần chú ý (máy chủ AI chưa sẵn sàng, tạm dừng, hết hạn mức). */
  warn: boolean;
  /** Đang xếp hàng (chưa tới lượt). */
  waiting: boolean;
}

const AI_JOB_LABEL: Record<string, string> = {
  analyze_brief: 'phân tích kế hoạch',
  edit_plan: 'chọn điểm cắt hoặc đọc góp ý',
  revise_prompt: 'sửa prompt',
  storyboard: 'tạo storyboard',
  video: 'tạo video',
};

/**
 * Bước AI chọn điểm cắt (`planning`): máy chủ AI chỉ có MỘT worker, chạy tuần tự. Chưa tới lượt → "Đang xếp hàng chờ AI (vị trí N)" kèm lý do
 * (worker offline, tạm dừng, hết hạn mức, đang bận việc khác); worker nhận rồi → "AI đang chọn điểm cắt".
 * `workerOnline` chỉ dùng khi server cũ không trả `ai_queue`.
 */
export function aiQueueNote(q: AiQueue | null | undefined, workerOnline?: boolean, kind: 'cut' | 'feedback' = 'cut'): QueueNote {
  const doing = kind === 'feedback' ? 'AI đang đọc góp ý' : 'AI đang chọn điểm cắt';
  if (!q) {
    const off = workerOnline === false;
    return { title: doing, detail: off ? 'Máy chủ AI chưa sẵn sàng: việc chạy khi máy chủ mở lại.' : null, warn: off, waiting: false };
  }
  if (q.state === 'running') {
    return { title: doing, detail: kind === 'feedback' ? 'Máy chủ AI đang xử lý góp ý. Chỉ đổi màu thì xong sau vài giây; đổi điểm cắt thì sẽ render lại.' : 'Máy chủ AI đang xử lý. Video tự render khi AI gửi điểm cắt.', warn: false, waiting: false };
  }
  const pos = q.position ?? q.ahead + 1;
  const title = `Đang xếp hàng chờ AI (vị trí ${pos})`;
  if (q.worker.paused) return { title, detail: 'Hàng đợi AI đang tạm dừng: việc chạy tiếp khi chủ máy mở lại.', warn: true, waiting: true };
  if (!q.worker.online) return { title, detail: 'Máy chủ AI chưa sẵn sàng: việc chạy khi máy chủ mở lại.', warn: true, waiting: true };
  if (q.wait_reason === 'ai_quota') return { title, detail: 'Tài khoản AI đang hết hạn mức: việc tự thử lại sau.', warn: true, waiting: true };
  if (q.running && !q.running.own) {
    const what = AI_JOB_LABEL[q.running.type];
    return { title, detail: `Chỉ có một máy chủ AI, các việc chạy lần lượt. AI đang bận với 1 việc khác${what ? ` (${what})` : ''}.`, warn: false, waiting: true };
  }
  return { title, detail: pos <= 1 ? 'Sắp tới lượt: máy chủ AI sẽ nhận ngay khi rảnh.' : 'Chỉ có một máy chủ AI, các việc chạy lần lượt.', warn: false, waiting: true };
}

/** "Đang xếp hàng render (vị trí 2 · đang chạy 2/2 việc)": vị trí trong hàng đợi và số việc đang chạy / tối đa cùng lúc. */
export function renderQueueTitle(what: 'render' | 'xoá logo' | 'chỉnh màu', q: { position?: number | null; running_count?: number | null; concurrency?: number | null }): string {
  const parts: string[] = [];
  if (q.position) parts.push(`vị trí ${q.position}`);
  if (q.running_count !== null && q.running_count !== undefined && q.concurrency) parts.push(`đang chạy ${q.running_count}/${q.concurrency} việc`);
  return `Đang xếp hàng ${what}${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

/** Bản `rendering` đang đợi chỗ trống: dòng "Đang xếp hàng render (...)" (null nếu không đợi). */
export function renderQueueNote(fc: Pick<FinalCut, 'status' | 'stage' | 'queue_state' | 'queue_position' | 'running_count' | 'concurrency'>): QueueNote | null {
  if (!isWaitingToRender(fc)) return null;
  return {
    title: renderQueueTitle(fc.stage === 'clean' ? 'xoá logo' : fc.stage === 'grade' ? 'chỉnh màu' : 'render', { position: fc.queue_position, running_count: fc.running_count, concurrency: fc.concurrency }),
    detail: 'Có chỗ trống là tự bắt đầu, không cần làm gì thêm. Việc của chủ máy được xếp trước việc từ LAN.',
    warn: false,
    waiting: true,
  };
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

/**
 * Các cảnh chưa sẵn sàng để dựng. Dự án `app`: chưa hoàn tất (`done`) hoặc chưa có video được chọn. Kế hoạch `lan` (video do người dùng LAN tải lên,
 * trạng thái cảnh không đổi): chỉ cần có video được chọn, giống điều kiện của server.
 */
export function scenesNotReady(scenes: Scene[], source: 'app' | 'lan' = 'app'): string[] {
  return scenes.filter((s) => !(source === 'lan' ? !!s.selected_video_id : s.status === 'done' && s.selected_video_id)).map((s) => s.code);
}

/** Lý do chặn "Dựng bản mới" (hoặc null nếu bấm được). */
export function finalBlockReason(scenes: Scene[] | undefined, latest: FinalCut | undefined, serverBlock?: { message: string } | null, source: 'app' | 'lan' = 'app'): string | null {
  if (!scenes) return serverBlock?.message ?? 'Đang tải danh sách cảnh';
  if (scenes.length === 0) return 'Dự án chưa có cảnh nào';
  const missing = scenesNotReady(scenes, source);
  if (missing.length > 0) return `Còn ${missing.join(', ')} chưa chọn video`;
  if (latest && (latest.status === 'planning' || latest.status === 'rendering')) {
    return `Đang có bản dựng v${latest.version} ${latest.status === 'planning' ? 'chờ AI chọn điểm cắt' : 'đang render'}`;
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

/** Phiên bản của danh sách đang có việc chạy (AI hoặc render/chỉnh màu): chặn góp ý / chỉnh màu mới cho tới khi xong. */
export const activeVersion = (list: Pick<FinalCut, 'status' | 'version'>[]): Pick<FinalCut, 'status' | 'version'> | undefined => list.find((c) => c.status === 'planning' || c.status === 'rendering');

/**
 * Lý do chưa góp ý / chỉnh màu được từ bản `fc` (null = được): đang có bản khác chạy, hoặc bản này còn logo Veo trong khi tool xoá logo đang bật
 * (chỉnh màu luôn chạy SAU xoá logo, nên phải xoá logo trước).
 */
export function revisionBlockReason(fc: Pick<FinalCut, 'status' | 'version' | 'watermark_removed'>, list: Pick<FinalCut, 'status' | 'version'>[], watermarkActive: boolean): string | null {
  if (fc.status !== 'ready') return `Bản v${fc.version} chưa sẵn sàng`;
  const busy = activeVersion(list);
  if (busy) return `Đang có bản v${busy.version} ${busy.status === 'planning' ? 'chờ AI' : 'đang xử lý'}: đợi xong hoặc hủy bản đó trước`;
  if (watermarkActive && !fc.watermark_removed) return `Bản v${fc.version} còn logo Veo: bấm «Xoá logo Veo» trước (chỉnh màu luôn chạy sau khi xoá logo)`;
  return null;
}

/** Dòng "Logo Veo" của một phiên bản: tính cả bước đang chạy và phiên bản góp ý (chỉ đổi màu thì không xoá logo lại). */
export function logoStatusText(fc: Pick<FinalCut, 'status' | 'stage' | 'watermark_removed' | 'parent_id'>): string {
  if (fc.watermark_removed) return 'Đã xoá';
  if (fc.status === 'rendering' && fc.stage === 'clean') return 'Đang xoá';
  if (fc.parent_id && (fc.status === 'planning' || (fc.status === 'rendering' && fc.stage === 'grade'))) return 'Giữ như bản cha (chỉ xoá lại khi đổi điểm cắt)';
  if (fc.status === 'planning' || (fc.status === 'rendering' && fc.stage !== 'clean')) return 'Sẽ xoá sau khi render';
  return 'Còn logo';
}

/** Ai tạo điểm cắt/màu của phiên bản (cho dòng "Người tạo"). */
export function creatorText(fc: Pick<FinalCut, 'created_by' | 'parent_id' | 'revision'>): string {
  if (fc.created_by === 'user') return fc.revision?.kind === 'manual' ? 'Bạn chỉnh màu' : 'Bạn chỉnh điểm cắt';
  return fc.parent_id ? 'AI theo góp ý của bạn' : 'AI chọn điểm cắt';
}
