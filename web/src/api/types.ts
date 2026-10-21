// Kiểu dữ liệu phản chiếu server/API.md (mục 3-4). Tên trường là snake_case đúng như server trả về.

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

export type JobType = 'analyze_brief' | 'storyboard' | 'video' | 'revise_prompt' | 'edit_plan';
export type JobStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';
export type AssetKind = 'storyboard' | 'video' | 'grid';
export type Verdict = 'pass' | 'fix_in_edit' | 'redo';
export type CommentAction = 'note' | 'revise_and_regenerate' | 'regenerate_same' | 'regenerate_storyboard';
export type ProjectStatus = 'draft' | 'analyzing' | 'active' | 'archived';
export type Stage = 'storyboard' | 'video';
export type FailCode = 'CAPTCHA' | 'LOGIN_REQUIRED' | 'FLOW_OUT_OF_CREDIT' | 'UI_CHANGED' | 'OTHER';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface Ref {
  id: number;
  project_id: number;
  label: string;
  file_path: string;
  original_name: string;
  order_index: number;
  created_at: string;
  url: string;
  /** sha256 hex nội dung file (dùng để gom ảnh trùng trong thư viện). */
  content_hash: string | null;
}

/** Một ảnh duy nhất (theo content_hash) trong thư viện ảnh tham chiếu của mọi dự án. */
export interface LibraryRef {
  ref_id: number;
  file_path: string;
  url: string;
  label: string;
  original_name: string;
  content_hash: string;
  created_at: string;
  projects: { id: number; name: string }[];
  /** Dự án đang xét (projectId) đã có ảnh cùng nội dung. */
  in_project: boolean;
}

export interface Asset {
  id: number;
  scene_id: number;
  job_id: number | null;
  kind: AssetKind;
  file_path: string;
  url: string;
  attempt: number;
  meta: { duration_s?: number; width?: number; height?: number; [k: string]: unknown } | null;
  verdict: Verdict | null;
  verdict_note: string | null;
  created_at: string;
}

export interface Job {
  id: number;
  project_id: number;
  project_name?: string;
  scene_id: number | null;
  scene_code: string | null;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  error_code: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  finished_at: string | null;
  credits_cost: number;
  requires_approval: boolean;
  approved_at: string | null;
  requeue_count: number;
  last_requeued_at: string | null;
}

export interface BlockInfo {
  code: string;
  message: string;
}

export interface Scene {
  id: number;
  project_id: number;
  code: string;
  order_index: number;
  title: string;
  prompt: string;
  first_frame_desc: string;
  upload_refs: number[];
  use_prev_storyboard: boolean;
  status: SceneStatus;
  selected_video_id: number | null;
  created_at: string;
  updated_at: string;
  prompt_version: number;
  attempts_used: number;
  max_attempts: number;
  storyboard_count: number;
  video_count: number;
  storyboard: Asset | null;
  video: Asset | null;
  grid: Asset | null;
  active_job: Job | null;
  waiting_reason: string | null;
  open_comments: number;
  storyboard_block: BlockInfo | null;
  video_block: BlockInfo | null;
}

export interface Comment {
  id: number;
  scene_id: number;
  asset_id: number | null;
  author: 'user' | 'claude';
  body: string;
  timecode: number | null;
  action: CommentAction;
  resolved: boolean;
  created_at: string;
}

export interface PromptVersion {
  id: number;
  scene_id: number;
  version: number;
  prompt: string;
  reason: string | null;
  created_by: 'claude' | 'user';
  created_at: string;
}

export interface SceneDetail extends Scene {
  project: {
    id: number;
    slug: string;
    name: string;
    style_lock: string;
    credit_per_video: number;
    max_attempts_per_scene: number;
  };
  assets: Asset[];
  comments: Comment[];
  prompt_versions: PromptVersion[];
  jobs: Job[];
  prev_scene_id: number | null;
  next_scene_id: number | null;
}

export interface Budget {
  used: number;
  reserved: number;
  credit_per_video: number;
  max_attempts: number;
  scenes: { scene_id: number; code: string; attempts_used: number; max_attempts: number }[];
}

export interface ProjectSummary {
  id: number;
  slug: string;
  name: string;
  brief: string;
  style_lock: string;
  max_attempts_per_scene: number;
  credit_per_video: number;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  scene_count: number;
  done_count: number;
  status_counts: Partial<Record<SceneStatus, number>>;
  credits_used: number;
  credits_reserved: number;
  /** Bản hoàn chỉnh mới nhất (gọn). null/vắng nếu chưa có. */
  latest_final_cut?: LatestFinalCut | null;
  /** Lý do chưa bấm được "Dựng bản mới" (null = bấm được). */
  final_cut_block?: { code: string; message: string } | null;
}

export interface ProjectDetail extends ProjectSummary {
  refs: Ref[];
  budget: Budget;
  requeued_jobs: Job[];
}

export interface LedgerEntry {
  id: number;
  project_id: number;
  scene_id: number | null;
  scene_code: string | null;
  job_id: number | null;
  delta: number;
  note: string | null;
  created_at: string;
  /** Tổng credit đã tiêu lũy kế tới dòng này. */
  cumulative_used: number;
}

export interface Ledger {
  totals: { used: number; reserved: number };
  entries: LedgerEntry[];
}

export interface WorkerStatus {
  online: boolean;
  last_seen_at: string | null;
  worker_id: string | null;
  queue_paused: boolean;
  pause_reason: string | null;
  pause_code: string | null;
  paused_at: string | null;
  server_time?: string;
}

export interface ApprovePreview {
  stage: Stage;
  count: number;
  scenes: { scene_id: number; code: string; title: string; status: SceneStatus; credits: number }[];
  skipped: { scene_id: number; code: string; reason_code: string; message: string }[];
  total_credits: number;
  credit_per_video: number;
}

export interface ApproveAllResult {
  stage: Stage;
  count: number;
  total_credits: number;
  jobs: { scene_id: number; code: string; job_id: number }[];
}

export interface AppEvent {
  id: number;
  project_id: number;
  scene_id: number | null;
  scene_code: string | null;
  type: string;
  message: string;
  created_at: string;
}

export interface Meta {
  /** Trình dựng bản hoàn chỉnh đang dùng và lý do. */
  final_renderer?: {
    mode: string;
    active: 'shotcut' | 'ffmpeg' | null;
    reason: string;
    shotcut?: { configured: boolean; ready: boolean; detail: string | null };
    ffmpeg?: { available: boolean; path: string | null };
  };
  /** Tool xoá logo Veo chạy sau khi render bản hoàn chỉnh. */
  watermark_remover?: {
    mode: 'auto' | 'off';
    active: boolean;
    reason: string;
    cli: string | null;
  };
  config: {
    max_concurrent_video_jobs: number;
    require_prompt_approval: boolean;
    heartbeat_stale_minutes: number;
    worker_online_seconds: number;
    max_upload_bytes: number;
  };
}

// ---- Bản hoàn chỉnh (dựng cuối) ----
export type FinalCutStatus = 'planning' | 'rendering' | 'ready' | 'failed' | 'cancelled';
/** Bước con khi `rendering`: dựng video hoặc xoá logo Veo. */
export type FinalCutStage = 'render' | 'clean';

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
  note?: string | null;
}
export interface Edl {
  scenes: EdlScene[];
}

export interface FinalCutSelection {
  scene_id: number;
  code: string;
  asset_id: number;
  attempt: number;
  /** Video nguồn của cảnh lúc dựng (để vẽ timeline / trình phát nguồn). */
  video_url: string | null;
  duration_s: number | null;
}

export interface FinalCut {
  id: number;
  project_id: number;
  version: number;
  status: FinalCutStatus;
  selection: FinalCutSelection[];
  selection_signature: string;
  edl: Edl | null;
  renderer: 'shotcut' | 'ffmpeg' | null;
  video_path: string | null;
  project_file_path: string | null;
  contact_sheet_path: string | null;
  /** URL tĩnh (/files/...) nếu server trả; web tự dựng từ *_path khi vắng. */
  video_url?: string | null;
  contact_sheet_url?: string | null;
  duration_s: number | null;
  job_id: number | null;
  render_ref: string | null;
  /** 0–100, riêng cho từng bước (`stage`). */
  progress: number | null;
  /** Khi `rendering`: đang dựng (`render`) hay đang xoá logo Veo (`clean`); null ở trạng thái khác. */
  stage: FinalCutStage | null;
  /** Bước bị lỗi/hủy (`failed`, hoặc `cancelled` giữa bước xoá logo). */
  failed_stage: FinalCutStage | null;
  /** `video_path` là bản đã xoá logo Veo. */
  watermark_removed: boolean;
  /** Bản render còn logo (không bao giờ hiển thị như bản hoàn chỉnh; chỉ để tải về). */
  raw_video_path: string | null;
  raw_video_url?: string | null;
  created_by: 'claude' | 'user';
  note: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** Lựa chọn video của dự án đã đổi so với lúc dựng bản này. */
  outdated: boolean;
}

export interface LatestFinalCut {
  id: number;
  version: number;
  status: FinalCutStatus;
  progress: number | null;
  stage: FinalCutStage | null;
  failed_stage: FinalCutStage | null;
  watermark_removed: boolean;
  url: string | null;
  duration_s: number | null;
  outdated: boolean;
  error: string | null;
}

// ---- Payload sự kiện SSE (API.md mục 7) ----
export interface SseEventMap {
  'scene.updated': { scene: Scene };
  'job.updated': { job: Job };
  'asset.created': { asset: Asset };
  'asset.updated': { asset: Asset };
  'comment.created': { comment: Comment };
  'comment.updated': { comment: Comment };
  'worker.status': WorkerStatus;
  'budget.updated': { project_id: number };
  'event.created': { event: AppEvent };
  'project.updated': { project: ProjectSummary };
  'final_cut.updated': { final_cut: FinalCut };
}
