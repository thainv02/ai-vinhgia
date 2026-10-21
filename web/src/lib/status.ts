import type { CommentAction, FinalCutStatus, JobStatus, JobType, ProjectStatus, SceneStatus, Verdict } from '../api/types';

export type Tone = 'neutral' | 'info' | 'warn' | 'ok' | 'danger' | 'violet';

/** Lớp Tailwind theo tông màu (viết nguyên chuỗi để Tailwind quét được). */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  info: 'bg-info-bg text-info-fg',
  warn: 'bg-warn-bg text-warn-fg',
  ok: 'bg-ok-bg text-ok-fg',
  danger: 'bg-danger-bg text-danger-fg',
  violet: 'bg-violet-bg text-violet-fg',
};

/** Màu nền đặc cho thanh tiến trình / chấm. */
export const TONE_SOLID: Record<Tone, string> = {
  neutral: 'bg-neutral-fg',
  info: 'bg-info-fg',
  warn: 'bg-warn-fg',
  ok: 'bg-ok-fg',
  danger: 'bg-danger-fg',
  violet: 'bg-violet-fg',
};

export const TONE_BORDER: Record<Tone, string> = {
  neutral: 'border-neutral-fg',
  info: 'border-info-fg',
  warn: 'border-warn-fg',
  ok: 'border-ok-fg',
  danger: 'border-danger-fg',
  violet: 'border-violet-fg',
};

export interface StatusInfo {
  label: string;
  tone: Tone;
  /** Có chấm nhấp nháy: đang chạy. */
  live?: boolean;
}

// Nhãn khớp với `scene_statuses` của GET /api/meta.
export const SCENE_STATUS: Record<SceneStatus, StatusInfo> = {
  draft: { label: 'Nháp', tone: 'neutral' },
  prompt_ready: { label: 'Prompt sẵn sàng', tone: 'neutral' },
  awaiting_approval: { label: 'Chờ duyệt', tone: 'warn' },
  storyboard_queued: { label: 'Storyboard đang chờ', tone: 'info' },
  storyboard_running: { label: 'Đang tạo storyboard', tone: 'info', live: true },
  storyboard_review: { label: 'Xem storyboard', tone: 'violet' },
  video_queued: { label: 'Video đang chờ', tone: 'info' },
  video_running: { label: 'Đang tạo video', tone: 'info', live: true },
  video_review: { label: 'Xem video', tone: 'violet' },
  done: { label: 'Hoàn tất', tone: 'ok' },
  needs_revision: { label: 'Cần sửa prompt', tone: 'warn', live: true },
  failed: { label: 'Lỗi', tone: 'danger' },
  blocked_budget: { label: 'Flow hết credit', tone: 'danger' },
  cancelled: { label: 'Đã hủy', tone: 'neutral' },
};

export function sceneStatusInfo(s: string): StatusInfo {
  return SCENE_STATUS[s as SceneStatus] ?? { label: s, tone: 'neutral' };
}

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  analyze_brief: 'Phân tích kịch bản',
  storyboard: 'Storyboard',
  video: 'Video',
  revise_prompt: 'Sửa prompt',
  edit_plan: 'Chọn điểm cắt',
};

export const JOB_STATUS: Record<JobStatus, StatusInfo> = {
  queued: { label: 'Đang chờ', tone: 'neutral' },
  claimed: { label: 'Đã nhận', tone: 'info', live: true },
  running: { label: 'Đang chạy', tone: 'info', live: true },
  done: { label: 'Xong', tone: 'ok' },
  failed: { label: 'Lỗi', tone: 'danger' },
  cancelled: { label: 'Đã hủy', tone: 'neutral' },
};

export const PROJECT_STATUS: Record<ProjectStatus, StatusInfo> = {
  draft: { label: 'Chưa phân tích', tone: 'neutral' },
  analyzing: { label: 'Đang phân tích', tone: 'info', live: true },
  active: { label: 'Đang sản xuất', tone: 'ok' },
  archived: { label: 'Lưu trữ', tone: 'neutral' },
};

export const FINAL_STATUS: Record<FinalCutStatus, StatusInfo> = {
  planning: { label: 'AI đang chọn điểm cắt', tone: 'info', live: true },
  rendering: { label: 'Đang render', tone: 'info', live: true },
  ready: { label: 'Sẵn sàng', tone: 'ok' },
  failed: { label: 'Lỗi', tone: 'danger' },
  cancelled: { label: 'Đã hủy', tone: 'neutral' },
};

export const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  pass: { label: 'Đạt', tone: 'ok' },
  fix_in_edit: { label: 'Sửa khi dựng', tone: 'warn' },
  redo: { label: 'Tạo lại', tone: 'danger' },
};
export const VERDICT_ORDER: Verdict[] = ['pass', 'fix_in_edit', 'redo'];

export const COMMENT_ACTION_LABEL: Record<CommentAction, string> = {
  note: 'Ghi chú',
  revise_and_regenerate: 'Sửa prompt rồi tạo lại',
  regenerate_same: 'Tạo lại y nguyên',
  regenerate_storyboard: 'Tạo lại storyboard',
};

export const FAIL_CODE_LABEL: Record<string, string> = {
  CAPTCHA: 'Gặp CAPTCHA',
  LOGIN_REQUIRED: 'Cần đăng nhập',
  FLOW_OUT_OF_CREDIT: 'Flow hết credit',
  UI_CHANGED: 'Giao diện dịch vụ đã đổi',
  OTHER: 'Lỗi khác',
};

export const ACTIVE_JOB_STATUSES = 'queued,claimed,running';

/** Thay mã trạng thái tiếng Anh trong message sự kiện bằng nhãn tiếng Việt. */
export function humanizeEventMessage(msg: string): string {
  return msg.replace(/\b[a-z]+(?:_[a-z]+)+\b|\b(?:draft|done|failed|cancelled)\b/g, (m) => {
    const info = SCENE_STATUS[m as SceneStatus];
    if (info) return info.label;
    return COMMENT_ACTION_LABEL[m as CommentAction] ?? m;
  });
}

/** Các trạng thái cho phép sửa prompt tay (API.md 5.3). */
export const PROMPT_EDITABLE: ReadonlySet<SceneStatus> = new Set<SceneStatus>([
  'draft',
  'prompt_ready',
  'awaiting_approval',
  'storyboard_review',
  'video_review',
  'done',
  'failed',
  'blocked_budget',
]);

/** Trạng thái cho phép comment "sửa prompt rồi tạo lại". */
export const REVISE_ALLOWED: ReadonlySet<SceneStatus> = new Set<SceneStatus>([
  'storyboard_review',
  'video_review',
  'done',
  'awaiting_approval',
  'failed',
]);

/** Cảnh đang có job hoạt động hoặc chờ AI. */
export function isBusy(status: SceneStatus): boolean {
  return (
    status === 'storyboard_queued' ||
    status === 'storyboard_running' ||
    status === 'video_queued' ||
    status === 'video_running' ||
    status === 'needs_revision'
  );
}
