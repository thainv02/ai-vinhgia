export const SCENE_STATUSES = [
  'draft',
  'prompt_ready',
  'awaiting_approval',
  'storyboard_queued',
  'storyboard_running',
  'storyboard_review',
  'video_queued',
  'video_running',
  'video_review',
  'done',
  'needs_revision',
  'failed',
  'blocked_budget',
  'cancelled',
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const JOB_TYPES = ['analyze_brief', 'storyboard', 'video', 'revise_prompt', 'edit_plan'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'claimed', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: JobStatus[] = ['queued', 'claimed', 'running'];

export const ASSET_KINDS = ['storyboard', 'video', 'grid'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const VERDICTS = ['pass', 'fix_in_edit', 'redo'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: 'Đạt',
  fix_in_edit: 'Sửa khi dựng',
  redo: 'Tạo lại',
};

export const COMMENT_ACTIONS = ['note', 'revise_and_regenerate', 'regenerate_same', 'regenerate_storyboard'] as const;
export type CommentAction = (typeof COMMENT_ACTIONS)[number];

export const FAIL_CODES = ['CAPTCHA', 'LOGIN_REQUIRED', 'FLOW_OUT_OF_CREDIT', 'UI_CHANGED', 'OTHER'] as const;
export type FailCode = (typeof FAIL_CODES)[number];
/** Các mã lỗi làm tạm dừng hàng đợi. */
export const PAUSING_FAIL_CODES: FailCode[] = ['CAPTCHA', 'LOGIN_REQUIRED', 'FLOW_OUT_OF_CREDIT', 'UI_CHANGED'];

export const PROJECT_STATUSES = ['draft', 'analyzing', 'active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  brief: string;
  style_lock: string;
  /** Cột giữ lại cho tương thích; server không còn đọc/kiểm tra/hiển thị (đã bỏ hạn mức credit). */
  credit_budget: number;
  max_attempts_per_scene: number;
  credit_per_video: number;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

export interface RefRow {
  id: number;
  project_id: number;
  label: string;
  file_path: string;
  original_name: string | null;
  order_index: number;
  /** sha256 hex nội dung file; null nếu chưa điền được (file mất). */
  content_hash: string | null;
  created_at: string;
}

export interface SceneRow {
  id: number;
  project_id: number;
  code: string;
  order_index: number;
  title: string;
  prompt: string;
  first_frame_desc: string;
  upload_refs: string; // JSON
  use_prev_storyboard: number;
  status: SceneStatus;
  selected_video_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface PromptVersionRow {
  id: number;
  scene_id: number;
  version: number;
  prompt: string;
  reason: string;
  created_by: 'claude' | 'agent' | 'user';
  created_at: string;
  ext_key: string | null;
}

export interface JobRow {
  lease_id: string | null;
  lease_epoch: number;
  worker_mode: string;
  wait_reason: string | null;
  next_attempt_at: string | null;
  checkpoint: string | null;
  completion_key: string | null;
  completion_hash: string | null;
  id: number;
  project_id: number;
  scene_id: number | null;
  type: JobType;
  status: JobStatus;
  payload: string; // JSON
  result: string | null; // JSON
  error: string | null;
  error_code: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  finished_at: string | null;
  credits_cost: number;
  requires_approval: number;
  approved_at: string | null;
  requeue_count: number;
  last_requeued_at: string | null;
}

export interface AssetRow {
  id: number;
  scene_id: number;
  job_id: number | null;
  kind: AssetKind;
  file_path: string;
  attempt: number;
  meta: string; // JSON
  verdict: Verdict | null;
  verdict_note: string | null;
  created_at: string;
  ext_key: string | null;
}

export interface CommentRow {
  id: number;
  scene_id: number;
  asset_id: number | null;
  author: 'user' | 'claude' | 'agent';
  body: string;
  timecode: number | null;
  action: CommentAction;
  resolved: number;
  created_at: string;
  ext_key: string | null;
}

export interface EventRow {
  id: number;
  project_id: number;
  scene_id: number | null;
  type: string;
  message: string;
  created_at: string;
  ext_key: string | null;
}

export interface LedgerRow {
  id: number;
  project_id: number;
  scene_id: number | null;
  job_id: number | null;
  delta: number;
  note: string;
  created_at: string;
  ext_key: string | null;
}

export interface WorkerStateRow {
  id: 1;
  last_seen_at: string | null;
  worker_id: string | null;
  queue_paused: number;
  pause_reason: string | null;
  pause_code: string | null;
  paused_at: string | null;
}

/** Nhãn tiếng Việt cho trạng thái cảnh (dùng trong thông báo lỗi và GET /api/meta). */
export const SCENE_STATUS_LABEL: Record<SceneStatus, string> = {
  draft: 'Nháp',
  prompt_ready: 'Prompt sẵn sàng',
  awaiting_approval: 'Chờ duyệt',
  storyboard_queued: 'Storyboard đang chờ',
  storyboard_running: 'Đang tạo storyboard',
  storyboard_review: 'Xem storyboard',
  video_queued: 'Video đang chờ',
  video_running: 'Đang tạo video',
  video_review: 'Xem video',
  done: 'Hoàn tất',
  needs_revision: 'Cần sửa prompt',
  failed: 'Lỗi',
  blocked_budget: 'Flow hết credit',
  cancelled: 'Đã hủy',
};

export const FINAL_CUT_STATUSES = ['planning', 'rendering', 'ready', 'failed', 'cancelled'] as const;
export type FinalCutStatus = (typeof FINAL_CUT_STATUSES)[number];

export interface FinalCutRow {
  id: number;
  project_id: number;
  version: number;
  status: FinalCutStatus;
  selection: string; // JSON [{scene_id, code, asset_id, attempt}]
  selection_signature: string;
  edl: string | null; // JSON
  renderer: 'shotcut' | 'ffmpeg' | null;
  video_path: string | null;
  project_file_path: string | null;
  contact_sheet_path: string | null;
  duration_s: number | null;
  job_id: number | null;
  render_ref: string | null;
  progress: number | null;
  created_by: 'claude' | 'agent' | 'user';
  note: string | null;
  summary: string | null;
  error: string | null;
  ext_key: string | null;
  created_at: string;
  finished_at: string | null;
  /** Bước đang chạy khi status='rendering': render | clean (xoá logo Veo); NULL ở các trạng thái khác. */
  stage: 'render' | 'clean' | null;
  /** Bản render còn logo (<slug>_final_v<n>_raw.mp4). */
  raw_video_path: string | null;
  failed_stage: 'render' | 'clean' | null;
  watermark_removed: number;
  watermark_meta: string | null;
}
