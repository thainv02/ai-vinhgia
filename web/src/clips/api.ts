import type { CaptionLayout } from './subtitleBox';
import type {
  Clip,
  ClipCut,
  ClipProjectDetail,
  ClipProjectSummary,
  ClipServerStatus,
  CaptionPreset,
  CaptionWord,
  PlanInput,
  PlanJob,
  RenderInput,
  SourceVideo,
  TranscriptPage,
} from './types';

/** Lớp truyền tải do nơi dùng cấp (app chính hay trang planner LAN: khác cách xử lý lỗi 401). */
export interface ClipIo {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  upload<T>(path: string, form: FormData, onProgress: (loaded: number, total: number) => void): { promise: Promise<T>; abort: () => void };
}

const unwrap = <K extends string, T>(r: T | Record<K, T>, key: K): T => (r && typeof r === 'object' && key in (r as object) ? (r as Record<K, T>)[key] : (r as T));

/**
 * API cắt clip. `base` là `/api` (app chính) hoặc `/lan/api` (trang LAN): hai nơi dùng cùng đường dẫn con (hợp đồng mục 5).
 * Nhiều route chưa chốt dạng phản hồi (bản ghi trần hay bọc `{clip}` / `{cut}`) nên `unwrap` nhận cả hai.
 */
export function makeClipApi(base: '/api' | '/lan/api', io: ClipIo) {
  const lan = base === '/lan/api';
  return {
    base,
    lan,
    listProjects: async (): Promise<ClipProjectSummary[]> => {
      // App: GET /api/projects (mỗi dự án có `kind`). LAN: danh sách dự án LAN (cùng cấu trúc `kind`).
      const rows = await io.get<ClipProjectSummary[]>(lan ? `${base}/clip-projects` : `${base}/projects`);
      return rows.filter((p) => p.kind === 'clips');
    },
    createProject: (input: { name: string; stt_terms?: string; created_by_name?: string }) => io.post<ClipProjectDetail>(`${base}/clip-projects`, input),
    getProject: (id: number) => io.get<ClipProjectDetail>(`${base}/clip-projects/${id}`),
    patchProject: (id: number, input: { name?: string; stt_terms?: string }) => io.patch<ClipProjectDetail | { ok: boolean }>(`${base}/clip-projects/${id}`, input),
    uploadSource: (projectId: number, file: File, onProgress: (loaded: number, total: number) => void) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return io.upload<{ source: SourceVideo }>(`${base}/projects/${projectId}/source`, form, onProgress);
    },
    transcribe: (sourceId: number) => io.post<unknown>(`${base}/sources/${sourceId}/transcribe`),
    cancelSource: (sourceId: number) => io.post<unknown>(`${base}/sources/${sourceId}/cancel`),
    transcript: (sourceId: number, from: number, limit: number) => io.get<TranscriptPage>(`${base}/sources/${sourceId}/transcript?from=${from}&limit=${limit}`),
    transcriptUrl: (sourceId: number, ext: 'srt' | 'txt') => `${base}/sources/${sourceId}/transcript.${ext}`,
    clipPlan: async (projectId: number, input: PlanInput) => unwrap<'job', PlanJob>(await io.post<{ job: PlanJob } | PlanJob>(`${base}/projects/${projectId}/clip-plan`, input), 'job'),
    patchClip: async (id: number, input: { status?: Clip['status']; title?: string; start_word?: number; end_word?: number; captions?: { preset?: CaptionPreset; layout?: CaptionLayout | null } }) =>
      unwrap<'clip', Clip>(await io.patch<{ clip: Clip } | Clip>(`${base}/clips/${id}`, input), 'clip'),
    createClip: async (projectId: number, input: { start_word: number; end_word: number; title?: string }) =>
      unwrap<'clip', Clip>(await io.post<{ clip: Clip } | Clip>(`${base}/projects/${projectId}/clips`, input), 'clip'),
    putCaptions: async (id: number, words: CaptionWord[]) => unwrap<'clip', Clip>(await io.put<{ clip: Clip } | Clip>(`${base}/clips/${id}/captions`, { words }), 'clip'),
    renderClip: async (id: number, input: RenderInput) => unwrap<'cut', ClipCut>(await io.post<{ cut: ClipCut } | ClipCut>(`${base}/clips/${id}/render`, input), 'cut'),
    clipStatus: () => io.get<ClipServerStatus>(`${base}/clip-status`),
    /** Dựng MỘT khung hình thật (ffmpeg + ASS) để xem thử; `at` = giây tính từ đầu clip. */
    previewFrame: (id: number, input: { at?: number; captions?: { preset?: CaptionPreset; layout?: CaptionLayout | null } }) => io.post<{ url: string; at: number; width: number; height: number }>(`${base}/clips/${id}/preview-frame`, input),
    cancelCut: (id: number) => io.post<unknown>(`${base}/clip-cuts/${id}/cancel`),
    zipUrl: (projectId: number) => `${base}/projects/${projectId}/clips.zip`,
  };
}

export type ClipApi = ReturnType<typeof makeClipApi>;
