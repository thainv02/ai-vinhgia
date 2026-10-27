import type { Clip, ClipCut, ClipProjectDetail, SourceVideo, TranscriptSentence } from './types';
import { renderQueueTitle } from '../lib/finalCut';

/** m:ss hoặc h:mm:ss. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

/** "42 giây", "1 phút 05 giây". */
export function spokenDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)} giờ ${String(m % 60).padStart(2, '0')} phút`;
  return r ? `${m} phút ${String(r).padStart(2, '0')} giây` : `${m} phút`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Bỏ dấu tiếng Việt và hạ chữ thường: để tìm kiếm không phân biệt dấu. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
}

export const isVerticalSource = (s: SourceVideo | null | undefined): boolean => !!s && !!s.width && !!s.height && s.height > s.width;

export const MIN_CLIP_S = 3;
export const MAX_CLIP_S = 300;

export const DURATION_PRESETS = [
  { value: '15_30', label: '15–30 giây', hint: 'ngắn, dồn một ý' },
  { value: '30_60', label: '30–60 giây', hint: 'phổ biến nhất' },
  { value: '60_90', label: '60–90 giây', hint: 'có mở bài và kết' },
  { value: '90_180', label: '90–180 giây', hint: 'câu chuyện đầy đủ' },
] as const;

export const CAPTION_PRESETS = [
  { value: 'highlight', label: 'Nổi bật', hint: 'cụm 3 từ, từ đang nói tô vàng' },
  { value: 'karaoke', label: 'Karaoke', hint: 'cụm 3 từ, từ đang nói tô xanh' },
  { value: 'minimal', label: 'Tối giản', hint: 'cả câu, không tô màu' },
  { value: 'none', label: 'Không phụ đề', hint: 'chỉ cắt và đổi khung' },
] as const;

export const REFRAME_OPTIONS = [
  { value: 'fit', label: 'Nền mờ', hint: 'giữ nguyên khung ngang, nền là chính cảnh đó làm mờ' },
  { value: 'center', label: 'Cắt giữa', hint: 'cắt lấy phần giữa khung hình' },
] as const;

export const CONTENT_TYPE_LABEL: Record<string, string> = {
  livestream_ban_hang: 'Livestream bán hàng',
  podcast: 'Podcast',
  phong_van: 'Phỏng vấn',
  review: 'Review',
  huong_dan: 'Hướng dẫn',
  hoi_thao: 'Hội thảo',
  vlog: 'Vlog',
  khac: 'Khác',
};

export const SOURCE_STATUS_LABEL: Record<string, string> = {
  uploaded: 'Đã tải lên',
  transcribing: 'Đang nhận dạng lời nói',
  transcribed: 'Đã có lời thoại',
  failed: 'Nhận dạng lỗi',
  cancelled: 'Đã hủy nhận dạng',
};

/** Tiến độ 0-100 từ giá trị server (chấp nhận cả phân số 0-1 khi chắc chắn là phân số). */
export function pct100(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(100, v));
}

export function cutQueueTitle(cut: Pick<ClipCut, 'queue_position' | 'running_count' | 'concurrency'>): string {
  return renderQueueTitle('render', { position: cut.queue_position, running_count: cut.running_count, concurrency: cut.concurrency });
}

export const cutIsActive = (cut: ClipCut | null | undefined): boolean => cut?.status === 'rendering';
export const planIsActive = (d: ClipProjectDetail | undefined): boolean => !!d?.plan_job && ['queued', 'claimed', 'running'].includes(d.plan_job.status);
export const sourceIsActive = (s: SourceVideo | null | undefined): boolean => !!s && (s.status === 'uploaded' || s.status === 'transcribing');

/** Có việc đang chạy thì làm mới đều (SSE là chính, đây là lưới an toàn; trang LAN không có SSE). */
export function projectNeedsPolling(d: ClipProjectDetail | undefined): boolean {
  if (!d) return false;
  // LAN: bản xem thử 480p được sinh sau khi tải lên; chưa có thì hỏi lại cho tới khi có.
  const previewPending = d.project.source === 'lan' && d.source?.status === 'transcribed' && !d.source.video_url && !d.source.source_deleted;
  return previewPending || sourceIsActive(d.source) || planIsActive(d) || d.clips.some((c) => cutIsActive(c.latest_cut));
}

/** Chỉ số câu chứa từ `wordIdx` (nhị phân theo từ đầu mỗi câu). `starts[k]` là chỉ số từ đầu của câu k. */
export function sentenceOfWord(starts: number[], wordIdx: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] ?? 0) <= wordIdx) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Chỉ số câu chứa mốc thời gian `t` giây (câu cuối nếu t quá cuối). */
export function sentenceAtTime(sentences: TranscriptSentence[], t: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sentences[mid]?.start ?? 0) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function clipById(d: ClipProjectDetail | undefined, id: number): Clip | undefined {
  return d?.clips.find((c) => c.id === id);
}

/** Số clip đã dựng xong (bản mới nhất `ready`) để bật nút ZIP (server gói mọi clip có bản `ready`, kể cả clip đã bỏ). */
export const readyClipCount = (clips: Clip[]): number => clips.filter((c) => c.latest_cut?.status === 'ready').length;
