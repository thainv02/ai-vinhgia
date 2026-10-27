// Kiểu dữ liệu của API trang planner LAN (server/API.md mục 13). Tên trường snake_case đúng như server trả về.
import type { AiQueue, FinalCut } from '../api/types';

export type PlanStatus = 'draft' | 'analyzing' | 'ready' | 'failed';

export interface AnalysisInfo {
  state: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  job_id: number | null;
  waiting: string | null;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
  /** Vị trí job phân tích trong hàng đợi worker AI (không có ở server cũ). */
  queue?: AiQueue | null;
}

export interface PlanSummary {
  id: number;
  /** 'clips': dự án cắt clip (hiện ở tab Cắt clip, không phải ở danh sách kế hoạch). */
  kind?: 'scenes' | 'clips';
  name: string;
  created_by_name: string | null;
  status: PlanStatus;
  scene_count: number;
  ref_count: number;
  created_at: string;
  updated_at: string;
  analysis: AnalysisInfo;
  /** Trình duyệt này đã tạo kế hoạch nên được xoá. Kế hoạch tạo trước tính năng xoá hoặc của người khác: false (nhờ chủ máy xoá). */
  can_delete?: boolean;
  /** Chỉ khi `can_delete`: lý do chưa xoá được lúc này; null = xoá được. */
  delete_block?: string | null;
}

export interface PlanRefInfo {
  id: number;
  label: string;
  url: string;
  file_name: string;
  order_index: number;
}

export interface Attachment {
  order: number;
  kind: 'ref' | 'storyboard_prev' | 'storyboard_self';
  label: string;
  ref_id: number | null;
  scene_code: string | null;
  url: string | null;
  file_name: string | null;
  available: boolean;
  prompt_label: string | null;
  note: string | null;
}

export interface VideoSettings {
  aspect: string;
  duration_s: number;
  count: number;
  resolution: string;
  estimated_credits: number;
}

export interface ScenePlanView {
  id: number;
  code: string;
  title: string;
  order_index: number;
  use_prev_storyboard: boolean;
  step1: { message: string; attachments: Attachment[]; warnings: string[] };
  step2: { prompt: string; attachments: Attachment[]; settings: VideoSettings; notes: string[]; warnings: string[] };
  storyboard: { url: string; file_name: string; uploaded_at: string; stale: boolean } | null;
  storyboard_uploads: number;
  upload_block: string | null;
  /** Bước 3: video người dùng đã tải lên cho cảnh. */
  videos: SceneVideos;
}

export interface SceneVideo {
  id: number;
  attempt: number;
  url: string;
  file_name: string;
  uploaded_at: string;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  has_audio: boolean | null;
  selected: boolean;
}

export type SceneVideoLimits = PlanDetail['limits']['scene_video'];

export interface SceneVideos {
  items: SceneVideo[];
  selected_id: number | null;
  count: number;
  max: number;
  /** Lý do chưa tải thêm được (chủ máy đang sản xuất cảnh, đủ số video). */
  block: string | null;
}

export interface PlanDetail {
  plan: PlanSummary & { brief: string; style_lock: string; credit_per_video: number };
  refs: PlanRefInfo[];
  settings: VideoSettings;
  scenes: ScenePlanView[];
  markdown: string;
  worker: { online: boolean; queue_paused: boolean };
  analysis: AnalysisInfo;
  limits: {
    max_refs: number;
    max_upload_bytes: number;
    max_storyboard_uploads_per_scene: number;
    video: Omit<VideoSettings, 'estimated_credits'>;
    scene_video: { max_bytes: number; max_per_scene: number; min_s: number; max_s: number };
  };
  /** Khối "Bản hoàn chỉnh": điều kiện dựng, bản đang chạy, tool xoá logo có bật không. */
  final: { block: { code: string; message: string } | null; active: boolean; latest: { id: number; version: number; status: string } | null; watermark: { active: boolean; reason: string } };
}

/** Bản dựng cho người dùng LAN: cùng hình dạng FinalCut của app chính (dùng lại EdlEditor/FinalTimeline), URL qua /lan/files, không có .mlt. */
export type LanFinalCut = FinalCut & {
  /** (Cũ) 0 = đang chạy, n = `running_count + queue_position`. Giao diện dùng `queue_state`/`queue_position`/`running_count`/`concurrency`/`ai_queue`. */
  queue_ahead: number | null;
};

export type ToolJobStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled' | 'expired';

export interface ToolJob {
  id: number;
  kind: 'remove_logo';
  status: ToolJobStatus;
  progress: number | null;
  original_name: string;
  created_by_name: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string;
  input: { bytes: number; duration_s: number; width: number | null; height: number | null; has_audio: boolean } | null;
  output: { url: string; bytes?: number; duration_s?: number } | null;
  /** (Cũ) 0 = đang chạy, n = `running_count + queue_position`. */
  queue_ahead: number | null;
  /** `waiting` = xếp hàng chưa bắt đầu; `running` = đang xử lý; null khi không ở trong hàng đợi (không có ở server cũ). */
  queue_state?: 'waiting' | 'running' | null;
  /** 1 = sẽ chạy tiếp theo. */
  queue_position?: number | null;
  /** Số việc đang chạy / số việc được chạy cùng lúc. */
  running_count?: number | null;
  concurrency?: number | null;
  can_retry: boolean;
}

export interface ToolStatus {
  remove_logo: { available: boolean; reason: string | null; max_bytes: number; min_s: number; max_s: number; remaining: number; rate: { max: number; windowMs: number } };
  queue: QueueLoad;
  /** Hàng đợi render chung: đang chạy / đang chờ / số việc chạy cùng lúc. */
  render?: RenderLoad | null;
  retention_days: number;
}

export interface RenderLoad {
  running_count: number;
  waiting_count: number;
  concurrency: number;
}

export interface QueueLoad {
  cuts: number;
  tools: number;
  total: number;
  cap: number;
}

export interface PlannerStatus {
  worker: { online: boolean; queue_paused: boolean };
  /** Trang có đòi mã truy cập không (LAN_REQUIRE_CODE). Không có ở server cũ (coi là có). */
  code_required?: boolean;
  /** Hàng đợi render chung: đang chạy / đang chờ / số việc chạy cùng lúc. */
  render?: RenderLoad | null;
  limits: PlanDetail['limits'];
  rate: {
    loginFailures: { max: number; windowMs: number };
    analyze: { max: number; windowMs: number };
    createPlan: { max: number; windowMs: number };
    uploadFiles: { max: number; windowMs: number };
    uploadVideo: { max: number; windowMs: number };
    createFinal: { max: number; windowMs: number };
    removeLogo: { max: number; windowMs: number };
    feedback?: { max: number; windowMs: number };
    grade?: { max: number; windowMs: number };
    gradePreview?: { max: number; windowMs: number };
    colorRef?: { max: number; windowMs: number };
  };
  /** Số lượt phân tích còn lại của chính người gọi (theo IP) trong giờ này. */
  analyze_remaining: number;
  /** Hạn mức còn lại của chính người gọi (theo IP) trong giờ này. */
  remaining: { analyze: number; upload_video: number; create_final: number; remove_logo: number; feedback?: number; grade?: number; grade_preview?: number; color_ref?: number; [key: string]: number | undefined };
  /** Việc từ LAN đang trong hàng đợi / trần toàn cục. */
  queue: QueueLoad;
  server_time: string;
}

export interface LanLibraryItem {
  ref_id: number;
  url: string;
  label: string;
  original_name: string;
  content_hash: string;
  created_at: string;
  projects: { id: number; name: string }[];
  in_project: boolean;
}
