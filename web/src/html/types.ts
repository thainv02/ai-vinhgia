// Kiểu dữ liệu Video HTML phía web: khớp server/src/services/html/view.ts + API.md mục 15 (+ hợp đồng render/preview/renderer/template).
export type HtmlAspect = '9:16' | '1:1' | '16:9';
export type HtmlQuality = '720p' | '1080p';
export type HtmlVersionStatus = 'composing' | 'validating' | 'ready' | 'failed' | 'cancelled';

export interface HtmlVariable {
  id: string;
  type: 'text' | 'color' | 'asset';
  label: string;
  value: string;
  target: string;
  maxLength?: number;
}
export interface LintIssue {
  code: string;
  message: string;
  file?: string;
}
export interface LintReport {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
  checks: string[];
}

export interface HtmlAsset {
  id: number;
  name: string;
  kind: 'image' | 'video' | 'audio';
  media_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  has_audio: boolean | null;
  path: string;
  url: string;
  created_at: string;
  description?: { summary: string; text: string; details: string; uncertain: boolean } | null;
  scan_error_code?: string | null;
  manual_label?: string | null;
  label_confirmed?: boolean;
}

export interface HtmlVoice {
  asset_id: number | null;
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';
  captions: boolean;
  error: string | null;
  transcript: { duration_s: number; words: { i: number; w: string; start: number; end: number }[]; sentences: { id: number; start: number; end: number; text: string }[] } | null;
}

export interface HtmlVersion {
  segments?:{idx:number;start_s:number;end_s:number;status:string;error:string|null;summary:string|null;variables:HtmlVariable[]}[];
  segments_ready?:number;
  id: number;
  project_id: number;
  version: number;
  parent_version: number | null;
  status: HtmlVersionStatus;
  created_by: 'ai' | 'user';
  prompt: string;
  feedback: string | null;
  summary: string | null;
  variables: HtmlVariable[];
  lint_report: LintReport | null;
  policy: { compose: string; vision: string };
  error: string | null;
  error_code: string | null;
  job: { id: number; status: string; error: string | null; error_code: string | null; queue: { state: 'waiting' | 'running'; position: number | null; ahead?: number; wait_reason?: string | null } | null } | null;
  created_at: string;
  published_at: string | null;
}

export interface HtmlProject {
  id: number;
  slug: string;
  name: string;
  brief: string;
  aspect: HtmlAspect;
  width: number;
  height: number;
  duration_s: number;
  quality: HtmlQuality;
  template_id: string | null;
  model: { compose: string; vision: string };
  asset_count: number;
  asset_bytes: number;
  version_count: number;
  latest_version: { id: number; version: number; status: HtmlVersionStatus; created_by: 'ai' | 'user'; summary: string | null; created_at: string; published_at: string | null } | null;
  active_versions: number;
  delete_block: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
}

export interface HtmlRender {
  id: number;
  version_id: number;
  version: number;
  quality: HtmlQuality;
  status: 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled';
  progress: number | null;
  queue: { state: 'waiting' | 'running'; position: number } | null;
  error: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  video_url: string | null;
  poster_url: string | null;
  duration_s: number | null;
  bytes: number | null;
  width: number;
  height: number;
}

export interface HtmlTemplate {
  id: string;
  label: string;
  description: string;
  aspects?: HtmlAspect[];
}
export interface HtmlPreview {
  url: string;
  origin: string;
  expires_at: string;
}

export interface HtmlRendererStatus {
  installed: boolean;
  version: string;
  path?: string;
  download_bytes: number;
  disk_bytes: number;
  download: { state: 'idle' | 'downloading' | 'done' | 'failed' | 'cancelled'; received: number; total: number; error?: string | null } | null;
}
