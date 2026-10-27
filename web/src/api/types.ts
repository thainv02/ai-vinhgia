// Kiểu dữ liệu phản chiếu server/API.md (mục 3-4). Tên trường là snake_case đúng như server trả về.
import type { Clip, ClipCut, SourceVideo } from '../clips/types';

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

export type JobType = 'analyze_brief' | 'storyboard' | 'video' | 'revise_prompt' | 'edit_plan' | 'clip_plan';
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

export type ReconcileOutcome = 'retry_download' | 'nothing_created' | 'charge_and_fail';

export interface Job {
  ai: { alias: string; provider: string; model: string; outcome: string } | null;
  /** ai_quota | needs_reconciliation | browser_offline (job queued đang chờ). */
  wait_reason: string | null;
  /** Trạng thái thao tác tạo bên ngoài hiện hành (intent/uncertain/submitted/downloaded) của job managed. */
  action_state?: string | null;
  /** true: cần người dùng đối soát; hủy bị chặn (POST /api/jobs/:id/reconcile). */
  reconcile_required?: boolean;
  next_attempt_at: string | null;
  worker_mode: string;
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
  author: 'user' | 'claude' | 'agent';
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
  created_by: 'claude' | 'agent' | 'user';
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
  /** 'clips': dự án cắt clip từ video dài (mở ở /clips/:id). Vắng = 'scenes'. */
  kind?: 'scenes' | 'clips';
  /** 'lan': kế hoạch do người dùng LAN tạo qua trang planner. Vắng = 'app'. */
  source?: 'app' | 'lan';
  /** Tên người tạo do người dùng LAN tự nhập (không xác thực). */
  created_by_name?: string | null;
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

export interface DeleteBlock {
  code: 'JOB_RUNNING' | 'FINAL_CUT_ACTIVE' | 'ACTION_LIVE' | 'UPLOAD_ACTIVE';
  message: string;
}

export interface ProjectDetail extends ProjectSummary {
  refs: Ref[];
  budget: Budget;
  requeued_jobs: Job[];
  /** Lý do chưa chuyển được vào thùng rác (job đang chạy, đang dựng/render, thao tác Flow chưa đối soát...); null = xoá được. */
  delete_block?: { code: string; message: string; reasons: DeleteBlock[] } | null;
}

/** Một dự án trong thùng rác (`GET /api/trash`). */
export interface TrashItem {
  id: number;
  name: string;
  slug: string;
  source: 'app' | 'lan';
  created_by_name: string | null;
  status: ProjectStatus;
  created_at: string;
  deleted_at: string;
  /** 'app' = chủ máy xoá; 'lan' = người tạo kế hoạch xoá từ trang LAN. */
  deleted_by: 'app' | 'lan' | null;
  purge_at: string;
  days_left: number;
  retention_days: number;
  size_bytes: number | null;
  scene_count: number;
  done_count: number;
  credits_used: number;
  /** Lý do chưa khôi phục được (chỗ cũ bị chiếm); null = khôi phục được. */
  restore_block: string | null;
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
/** Bước con khi `rendering`: dựng video, xoá logo Veo hoặc chỉnh màu (chỉnh màu luôn chạy SAU xoá logo). */
export type FinalCutStage = 'render' | 'clean' | 'grade';

/** Thông số chỉnh màu (khớp `server/src/services/grade.ts`). `scenes` = chỉnh thêm cho riêng một cảnh, áp chồng lên chỉnh chung. */
export interface SceneGrade {
  scene_id: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  temperature_k?: number;
}
/** Màu theo ảnh mẫu / file LUT (khớp `server/src/services/grade.ts`): chạy trước mọi chỉnh khác; `ref_id` là id trong `color_refs` của dự án. */
export interface GradeMatch {
  kind: 'image' | 'lut';
  ref_id: number;
  /** 0–1 (mặc định 0,7). */
  strength: number;
  /** `color` = chỉ lấy tông màu (giữ độ sáng), `full` = cả độ sáng/tương phản. Chỉ có nghĩa với ảnh. */
  mode: 'color' | 'full';
  /** Khớp riêng từng cảnh (đồng đều tông giữa các cảnh). Chỉ có nghĩa với ảnh. */
  per_scene: boolean;
}
export interface Grade {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  /** Cao hơn = ấm hơn; 6500 = trung tính. */
  temperature_k: number;
  vibrance: number;
  scenes?: SceneGrade[];
  match?: GradeMatch;
}

/** Ảnh mẫu / file LUT của dự án (`/color-refs`). File LUT không có URL (server không phục vụ). */
export interface ColorRef {
  id: number;
  kind: 'image' | 'lut';
  original_name: string | null;
  thumb_url: string | null;
  image_url: string | null;
  width: number | null;
  height: number | null;
  lut_size: number | null;
  created_by_name: string | null;
  created_at: string;
  /** Các version của bản dựng đang dùng (có thì không xoá được). */
  used_by: number[];
}
export interface ColorRefSources {
  refs: { id: number; label: string; url: string }[];
  assets: { id: number; scene_code: string; url: string }[];
}
export interface ColorRefList {
  items: ColorRef[];
  sources: ColorRefSources;
}
/** Ảnh mẫu / LUT của một bản dựng (để lịch sử hiện chip có ảnh thu nhỏ). */
export interface FinalCutColorRef {
  id: number;
  kind: 'image' | 'lut';
  original_name: string | null;
  thumb_url: string | null;
}

/** Trả lời của AI (hoặc ghi chú chỉnh tay) cho một phiên bản góp ý / chỉnh màu. */
export interface FinalCutRevision {
  kind: 'ai' | 'manual';
  /** true = điểm cắt đổi nên đã render + xoá logo lại; false = chỉ đổi màu. */
  edl_changed: boolean;
  summary: string;
  /** Yêu cầu AI nói là không làm được (thêm nhạc, chữ, chuyển cảnh...). */
  not_done: string[];
}

/** Ảnh xem trước chỉnh màu: ba mốc thời gian, mỗi mốc một ảnh trước và một ảnh sau. */
export interface GradePreview {
  hash: string;
  items: { t: number; before_url: string; after_url: string }[];
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

/** Vị trí của job trong hàng đợi của worker AI (một worker, tuần tự). Dùng cho bước AI chọn điểm cắt và bước phân tích của kế hoạch LAN. */
export interface AiQueue {
  /** `waiting`: đang xếp hàng chờ worker; `running`: worker đã nhận. */
  state: 'waiting' | 'running';
  /** 1 = job kế tiếp worker sẽ nhận; null khi đang chạy. */
  position: number | null;
  /** Số job đủ điều kiện đứng trước (không tính job worker đang chạy). */
  ahead: number;
  /** Job worker đang bận (`own` = chính job này); null = worker rảnh. */
  running: { type: string; own: boolean } | null;
  worker: { online: boolean; paused: boolean };
  /** Lý do chưa tới hạn nhận (vd `ai_quota`); null = nhận được ngay khi worker rảnh. */
  wait_reason: string | null;
}

/** Hàng đợi render chung: `waiting` = đã xếp hàng nhưng chưa bắt đầu (đợi chỗ trống); `running` = đang chạy. */
export type RenderQueueState = 'waiting' | 'running';

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
  created_by: 'claude' | 'agent' | 'user';
  note: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** Lựa chọn video của dự án đã đổi so với lúc dựng bản này. */
  outdated: boolean;
  /** Chỉ khi `rendering` và có trong hàng đợi render (không có ở server cũ). */
  queue_state?: RenderQueueState | null;
  /** 1 = sẽ chạy tiếp theo; null khi đang chạy. */
  queue_position?: number | null;
  /** Số việc render/xoá logo đang chạy / số việc được chạy cùng lúc. */
  running_count?: number | null;
  concurrency?: number | null;
  /** Chỉ khi `planning`: vị trí job `edit_plan` trong hàng đợi worker AI. */
  ai_queue?: AiQueue | null;
  /** Phiên bản góp ý / chỉnh màu: bản cha (id + số version); null với bản dựng gốc. Server cũ không có các trường này. */
  parent_id?: number | null;
  parent_version?: number | null;
  /** Góp ý của người dùng cho AI (chỉ phiên bản tạo từ góp ý). */
  feedback?: string | null;
  /** Grade đã áp; null = chưa chỉnh màu (trung tính). */
  grade?: Grade | null;
  /** Các thông số khác mặc định dạng chữ ngắn ("Ấm 7200K", "Tương phản 1.15"). */
  grade_chips?: string[];
  /** Ảnh mẫu / LUT của `grade.match`; null nếu không dùng. */
  color_ref?: FinalCutColorRef | null;
  revision?: FinalCutRevision | null;
  /** Bản sạch chưa chỉnh màu (chỉ có khi đã chỉnh màu; không có qua LAN). */
  base_path?: string | null;
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
  queue_state?: RenderQueueState | null;
  queue_position?: number | null;
  ai_queue?: AiQueue | null;
}

// ---- Payload sự kiện SSE (API.md mục 7) ----
export interface SseEventMap {
  'source.updated': { source: SourceVideo };
  'clip.updated': { clip: Clip };
  'clip.deleted': { clip_id: number; project_id?: number };
  'clip_cut.updated': { cut: ClipCut };
  'ai.updated': { job_id?: number; account_id?: number; state: string };
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
  'project.deleted': { project_id: number; name: string; deleted_by: 'app' | 'lan' };
  'project.restored': { project: ProjectSummary };
  'project.purged': { project_id: number };
}

/** `GET /api/lan`: trạng thái chia sẻ qua LAN (chỉ app chính). */
export interface LanInfo {
  enabled: boolean;
  listening: boolean;
  error: string | null;
  host: string;
  port: number;
  urls: string[];
  /** Trang planner có đòi mã truy cập không (`LAN_REQUIRE_CODE`, mặc định không). Không có ở server cũ (coi là có mã). */
  require_code?: boolean;
  /** Chỉ có khi `require_code`. */
  access_code: string | null;
  plan_count: number;
  /** Việc xoá logo (công cụ độc lập của trang planner) tạo trong 24 giờ qua. */
  tool_jobs_24h: number;
  /** Việc từ LAN đang trong hàng đợi (bản dựng chờ AI/đang render + việc công cụ) / trần toàn cục. */
  queue: { cuts: number; tools: number; total: number; cap: number };
  /** Hàng đợi render chung (bản dựng + xoá logo): đang chạy / đang chờ / số việc chạy cùng lúc (`RENDER_CONCURRENCY`). */
  render?: { running_count: number; waiting_count: number; concurrency: number } | null;
}
