// Kiểu dữ liệu của tính năng "Cắt clip từ video dài" (hợp đồng: clips-spec.md mục 5). Dùng chung cho app chính và trang planner LAN.

export type SourceStatus = 'uploaded' | 'transcribing' | 'transcribed' | 'failed' | 'cancelled';
export type ClipStatus = 'proposed' | 'approved' | 'rejected';
export type CutStatus = 'rendering' | 'ready' | 'failed' | 'cancelled';
export type ReframeMode = 'fit' | 'center';
export type CaptionPreset = 'highlight' | 'karaoke' | 'minimal' | 'none';
export type DurationPreset = '15_30' | '30_60' | '60_90' | '90_180';

export interface SourceVideo {
  id: number;
  /** Có thể vắng ở server cũ; dùng để khớp sự kiện SSE với dự án. */
  project_id?: number;
  original_name: string;
  bytes: number;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  status: SourceStatus;
  /** Tiến độ nhận dạng ước tính, 0-100. */
  progress: number | null;
  error: string | null;
  error_code: string | null;
  queue: { state: 'waiting' | 'running' | null; position: number | null };
  /** App: /files/… (video gốc). LAN: bản xem thử 480p. */
  video_url: string | null;
  poster_url: string | null;
  word_count: number | null;
  speech_ratio: number | null;
  /** LAN: video gốc đã bị xoá sau thời hạn lưu, vẫn xem được bản xem thử và clip đã dựng. */
  source_deleted?: boolean;
  created_at: string;
}

export interface ClipCut {
  id: number;
  clip_id?: number;
  project_id?: number;
  version: number;
  status: CutStatus;
  stage: string | null;
  progress: number | null;
  error: string | null;
  aspect: string;
  reframe: { mode?: ReframeMode } | null;
  captions: { preset?: CaptionPreset } | null;
  duration_s: number | null;
  video_url: string | null;
  srt_url: string | null;
  queue_state: 'waiting' | 'running' | null;
  queue_position: number | null;
  running_count: number | null;
  concurrency: number | null;
  created_at: string;
}

export interface ClipVerify {
  status: 'kept' | 'unverified' | 'repaired';
  standalone_score?: number | null;
  diagnosis?: string | null;
}

export interface CaptionWord {
  i: number;
  w: string;
}

export interface Clip {
  id: number;
  project_id?: number;
  code: string;
  status: ClipStatus;
  start_s: number;
  end_s: number;
  duration_s: number;
  /** Chỉ số từ (toàn cục trong transcript), gồm cả hai đầu. */
  start_word: number;
  end_word: number;
  title: string | null;
  hook: string | null;
  score: number | null;
  reason: string | null;
  content_type: string | null;
  verify: ClipVerify | null;
  start_sentence?: number;
  end_sentence?: number;
  created_by: 'agent' | 'user';
  thumb_url: string | null;
  transcript_excerpt: string | null;
  caption_edited: boolean;
  /** Đề xuất bổ sung hợp đồng: chữ phụ đề hiện tại (đã sửa tay hoặc đã khôi phục dấu câu). Vắng thì dùng chữ ASR. */
  caption_words?: CaptionWord[] | null;
  latest_cut: ClipCut | null;
  cuts_count: number;
}

export interface PlanJob {
  id: number;
  status: 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';
  queue: { state: 'waiting' | 'running' | null; position: number | null; ahead: number | null } | null;
  error?: string | null;
  /** Lý do chưa được nhận: 'ai_quota' (hết hạn mức AI), ... */
  wait_reason?: string | null;
  worker?: { online?: boolean; paused?: boolean } | null;
  summary?: string | null;
  not_found_reason?: string | null;
  created_clips?: number | null;
}

export interface ClipProjectInfo {
  id: number;
  name: string;
  slug: string;
  kind: 'clips';
  source?: 'app' | 'lan';
  stt_terms: string | null;
  created_at: string;
  created_by_name?: string | null;
}

export interface ClipProjectDetail {
  project: ClipProjectInfo;
  source: SourceVideo | null;
  clips: Clip[];
  plan_job: PlanJob | null;
  delete_block?: { code?: string; message: string } | string | null;
  can_delete?: boolean;
}

/** Dòng trong danh sách dự án cắt clip (`GET /api/projects` lọc `kind === 'clips'`). */
export interface ClipProjectSummary {
  id: number;
  name: string;
  slug: string;
  kind: 'clips' | 'scenes';
  status?: string;
  source?: 'app' | 'lan';
  created_by_name?: string | null;
  created_at: string;
  updated_at?: string;
  clip_count?: number;
  source_video?: { duration_s: number | null; status: SourceStatus } | null;
}

export interface TranscriptWord {
  i: number;
  w: string;
  start: number;
  end: number;
}
export interface TranscriptSentence {
  id: number;
  start: number;
  end: number;
  words: TranscriptWord[];
}
export interface TranscriptPage {
  total: number;
  sentences: TranscriptSentence[];
}

export interface PlanInput {
  count: number;
  duration_preset: DurationPreset;
  focus?: string;
  exclude_existing?: boolean;
}

export interface RenderInput {
  aspect?: '9:16';
  reframe_mode?: ReframeMode;
  captions_preset?: CaptionPreset;
}

/** `GET {base}/clip-status`: giới hạn và khả năng của máy chủ (bổ sung hợp đồng). */
export interface ClipServerStatus {
  max_bytes: number;
  max_s: number;
  retention_days: number | null;
  stt: { configured: boolean };
  captions: { available: boolean; reason: string | null; font?: string | null };
  plan: { min_count: number; max_count: number };
}
