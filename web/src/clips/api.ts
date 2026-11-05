import type {
  Clip,
  ClipCut,
  ClipProjectDetail,
  ClipProjectSummary,
  ClipServerStatus,
  CaptionWord,
  PlanInput,
  PartInput,
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

/** Sửa clip. `parts` (1–6 đoạn, theo thứ tự phát) thay toàn bộ các đoạn; `start_word/end_word` đưa clip về một đoạn. */
export interface ClipPatchInput {
  status?: Clip['status'];
  title?: string;
  start_word?: number;
  end_word?: number;
  parts?: PartInput[];
}
/** Tạo clip thủ công: một đoạn (`start_word/end_word`) hoặc ghép nhiều đoạn (`parts`). */
export type ClipCreateInput = ({ start_word: number; end_word: number; parts?: never } | { parts: PartInput[]; start_word?: never; end_word?: never }) & { title?: string };

const unwrap = <K extends string, T>(r: T | Record<K, T>, key: K): T => (r && typeof r === 'object' && key in (r as object) ? (r as Record<K, T>)[key] : (r as T));

/**
 * API highlight. `base` là `/api` (app chính) hoặc `/lan/api` (trang LAN): hai nơi dùng cùng đường dẫn con (hợp đồng mục 5).
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
    patchClip: async (id: number, input: ClipPatchInput) =>
      unwrap<'clip', Clip>(await io.patch<{ clip: Clip } | Clip>(`${base}/clips/${id}`, input), 'clip'),
    createClip: async (projectId: number, input: ClipCreateInput) =>
      unwrap<'clip', Clip>(await io.post<{ clip: Clip } | Clip>(`${base}/projects/${projectId}/clips`, input), 'clip'),
    putCaptions: async (id: number, words: CaptionWord[]) => unwrap<'clip', Clip>(await io.put<{ clip: Clip } | Clip>(`${base}/clips/${id}/captions`, { words }), 'clip'),
    renderClip: async (id: number, input: RenderInput) => unwrap<'cut', ClipCut>(await io.post<{ cut: ClipCut } | ClipCut>(`${base}/clips/${id}/render`, input), 'cut'),
    processClips: (projectId: number) => io.post(`${base}/projects/${projectId}/process-clips`, {}),
    cleanupPlan: async (id: number) => unwrap<'job', PlanJob>(await io.post<{ job: PlanJob }>(`${base}/clips/${id}/cleanup-plan`, {}), 'job'),
    applyCleanup: async (id: number, body: { job_id: number; revision: number; selected_ids: number[]; edits?: import('../../../server/src/lib/clip-cleanup').CleanupEdit[] }) => unwrap<'clip', Clip>(await io.put<{ clip: Clip }>(`${base}/clips/${id}/cleanup`, body), 'clip'),
    clipStatus: () => io.get<ClipServerStatus>(`${base}/clip-status`),
    cancelCut: (id: number) => io.post<unknown>(`${base}/clip-cuts/${id}/cancel`),
    zipUrl: (projectId: number) => `${base}/projects/${projectId}/clips.zip`,
  };
}

export type ClipApi = ReturnType<typeof makeClipApi>;
