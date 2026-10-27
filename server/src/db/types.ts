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

export const JOB_TYPES = ['analyze_brief', 'storyboard', 'video', 'revise_prompt', 'edit_plan', 'clip_plan'] as const;
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

export const PROJECT_SOURCES = ['app', 'lan'] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

export const PROJECT_KINDS = ['scenes', 'clips'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export interface ProjectRow {
  id: number;
  /** 'scenes': dự án sản xuất video theo cảnh (mặc định); 'clips': dự án cắt clip từ video dài. */
  kind: ProjectKind;
  /** Tên riêng/thuật ngữ gợi ý cho nhận dạng lời nói (chỉ dự án 'clips'). */
  stt_terms: string | null;
  slug: string;
  name: string;
  brief: string;
  style_lock: string;
  /** Cột giữ lại cho tương thích; server không còn đọc/kiểm tra/hiển thị (đã bỏ hạn mức credit). */
  credit_budget: number;
  max_attempts_per_scene: number;
  credit_per_video: number;
  status: ProjectStatus;
  /** 'app': tạo từ app chính; 'lan': tạo từ trang planner LAN (chỉ lập kế hoạch prompt). */
  source: ProjectSource;
  /** Tên do người dùng LAN tự nhập (không xác thực); NULL với dự án 'app'. */
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  /** Thùng rác: NULL = đang dùng; có giá trị = đã xoá (mềm), chờ khôi phục hoặc xoá vĩnh viễn. */
  deleted_at: string | null;
  deleted_by: 'app' | 'lan' | null;
  /** Thư mục thùng rác tương đối từ ROOT (output/.trash/<id>-<slug>-<mốc>). */
  trash_path: string | null;
  /** sha256 của cookie client LAN đã tạo kế hoạch (chỉ kế hoạch mới); NULL = chỉ xoá được từ app chính. Không bao giờ trả ra API. */
  lan_client_hash: string | null;
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
  /** Bước đang chạy khi status='rendering': render | clean (xoá logo Veo) | grade (chỉnh màu); NULL ở các trạng thái khác. */
  stage: 'render' | 'clean' | 'grade' | null;
  /** Bản render còn logo (<slug>_final_v<n>_raw.mp4). */
  raw_video_path: string | null;
  failed_stage: 'render' | 'clean' | 'grade' | null;
  watermark_removed: number;
  watermark_meta: string | null;
  /** Bản đã được góp ý / chỉnh màu để tạo ra bản này (NULL = bản dựng gốc). */
  parent_id: number | null;
  /** Góp ý của người dùng cho AI (dữ liệu, không phải lệnh). */
  feedback: string | null;
  /** JSON Grade đã áp; NULL = chưa chỉnh màu. */
  grade: string | null;
  /** JSON {kind:'ai'|'manual', edl_changed, summary, not_done}. */
  revision: string | null;
  /** Bản sạch (đã xoá logo) CHƯA chỉnh màu; chỉ có khi grade không trung tính. */
  base_path: string | null;
}

/** Ảnh mẫu / file LUT dùng cho "màu theo ảnh mẫu" của bản hoàn chỉnh (migration 013). `file_path`/`thumb_path` tương đối từ ROOT, dưới `output/<slug>/final/color-refs/`. */
export interface ColorRefRow {
  id: number;
  project_id: number;
  kind: 'image' | 'lut';
  file_path: string;
  thumb_path: string | null;
  original_name: string | null;
  content_hash: string;
  width: number | null;
  height: number | null;
  lut_size: number | null;
  created_by_name: string | null;
  created_at: string;
}

// ---------------------------------------------------------------- cắt clip từ video dài (migration 014)

export const SOURCE_STATUSES = ['uploaded', 'transcribing', 'transcribed', 'failed', 'cancelled'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface SourceVideoRow {
  id: number;
  project_id: number;
  path: string | null;
  original_name: string;
  bytes: number;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  has_audio: number;
  status: SourceStatus;
  progress: number | null;
  error: string | null;
  error_code: string | null;
  stt_job_id: string | null;
  transcript_path: string | null;
  /** JSON {model, elapsed_ms, word_count, speech_ratio, terms}. */
  stt_meta: string | null;
  content_hash: string;
  created_at: string;
  transcribed_at: string | null;
  deleted_at: string | null;
}

export const CLIP_STATUSES = ['proposed', 'approved', 'rejected'] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

export interface ClipRow {
  id: number;
  project_id: number;
  source_id: number;
  code: string;
  status: ClipStatus;
  start_sentence: number;
  end_sentence: number;
  start_word: number;
  end_word: number;
  start_s: number;
  end_s: number;
  title: string | null;
  hook: string | null;
  score: number | null;
  reason: string | null;
  content_type: string | null;
  verify: string | null;
  created_by: 'agent' | 'user';
  job_id: number | null;
  caption_words: string | null;
  caption_source: 'ai' | 'user' | null;
  created_at: string;
  updated_at: string;
}

export const CLIP_CUT_STATUSES = ['rendering', 'ready', 'failed', 'cancelled'] as const;
export type ClipCutStatus = (typeof CLIP_CUT_STATUSES)[number];
export const CLIP_ASPECTS = ['9:16', '1:1', '16:9', 'source'] as const;
export type ClipAspect = (typeof CLIP_ASPECTS)[number];
export const REFRAME_MODES = ['center', 'fit'] as const;
export type ReframeMode = (typeof REFRAME_MODES)[number];
export const CAPTION_PRESETS = ['highlight', 'karaoke', 'minimal', 'none'] as const;
export type CaptionPreset = (typeof CAPTION_PRESETS)[number];

export interface ClipCutRow {
  id: number;
  clip_id: number;
  project_id: number;
  version: number;
  status: ClipCutStatus;
  stage: string | null;
  progress: number | null;
  error: string | null;
  aspect: ClipAspect;
  reframe: string;
  captions: string;
  start_s: number;
  end_s: number;
  video_path: string | null;
  srt_path: string | null;
  ass_path: string | null;
  duration_s: number | null;
  parent_id: number | null;
  feedback: string | null;
  grade: string | null;
  created_at: string;
  finished_at: string | null;
}
