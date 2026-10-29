import type {
  ApiErrorBody,
  ApproveAllResult,
  ApprovePreview,
  Asset,
  AppEvent,
  Budget,
  Comment,
  CommentAction,
  Edl,
  FinalCut,
  Job,
  Ledger,
  LibraryRef,
  Meta,
  ProjectDetail,
  ProjectSummary,
  Ref,
  Scene,
  SceneDetail,
  Stage,
  Verdict,
  WorkerStatus,
} from './types';

/** Lỗi API: giữ nguyên `{error:{code,message,details}}` của server. */
export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Đã xảy ra lỗi không xác định';
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    /* thân phản hồi không phải JSON */
  }
  if (body?.error?.message) return new ApiError(body.error.code ?? 'ERROR', body.error.message, res.status, body.error.details);
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return new ApiError('SERVER_UNREACHABLE', 'Không kết nối được máy chủ (server API có đang chạy ở cổng 8787 không?)', res.status);
  }
  return new ApiError('HTTP_' + res.status, `Máy chủ trả về lỗi ${res.status}`, res.status);
}

async function request<T>(method: string, path: string, body?: unknown, init?: { form?: FormData }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError('NETWORK', 'Không kết nối được máy chủ. Hãy kiểm tra server đang chạy.', 0);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);

export interface CreateProjectInput {
  name: string;
  brief?: string;
  style_lock?: string;
  max_attempts_per_scene?: number;
  credit_per_video?: number;
}
export type PatchProjectInput = Partial<CreateProjectInput>;

/** Các API tạo bản dựng có thể trả bản dựng trần hoặc `{ final_cut, job }`: chấp nhận cả hai. */
function unwrapFinalCut(r: FinalCut | { final_cut: FinalCut }): FinalCut {
  return 'final_cut' in r ? r.final_cut : r;
}

export interface JobsQuery {
  projectId?: number;
  status?: string;
  type?: string;
  limit?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // ---- dự án ----
  listProjects: () => get<ProjectSummary[]>('/api/projects'),
  getProject: (id: number) => get<ProjectDetail>(`/api/projects/${id}`),
  createProject: (input: CreateProjectInput) => post<ProjectDetail>('/api/projects', input),
  patchProject: (id: number, input: PatchProjectInput) => patch<ProjectDetail>(`/api/projects/${id}`, input),
  submitBrief: (id: number, brief?: string) =>
    post<{ project: ProjectSummary; job: Job }>(`/api/projects/${id}/brief`, brief !== undefined ? { brief } : {}),
  getBudget: (id: number) => get<Budget>(`/api/projects/${id}/budget`),

  // ---- ảnh tham chiếu ----
  /** Trường `label` đứng ngay trước `file` mà nó gắn nhãn (API.md 5.2). */
  uploadRefs: (projectId: number, items: { file: File; label: string }[]) => {
    const form = new FormData();
    for (const it of items) {
      form.append('label', it.label);
      form.append('file', it.file, it.file.name);
    }
    return request<Ref[]>('POST', `/api/projects/${projectId}/refs`, undefined, { form });
  },

  listRefs: (projectId: number) => get<Ref[]>(`/api/projects/${projectId}/refs`),
  patchRef: (id: number, label: string) => patch<Ref>(`/api/refs/${id}`, { label }),
  reorderRefs: (projectId: number, ids: number[]) => patch<Ref[]>('/api/refs/reorder', { project_id: projectId, ids }),
  deleteRef: (id: number) => request<{ ok: boolean }>('DELETE', `/api/refs/${id}`),
  /** Thư viện ảnh: mỗi ảnh một dòng theo nội dung; `projectId` để biết ảnh nào dự án đó đã có (in_project). */
  refLibrary: (projectId?: number) => get<LibraryRef[]>(`/api/ref-library${qs({ projectId })}`),
  /** Chép ảnh từ thư viện vào dự án, nối vào cuối theo đúng thứ tự `refIds`. */
  addRefsFromLibrary: (projectId: number, refIds: number[], labels?: Record<number, string>) =>
    post<Ref[]>(`/api/projects/${projectId}/refs/from-library`, { ref_ids: refIds, ...(labels ? { labels } : {}) }),

  // ---- cảnh ----
  listScenes: (projectId: number) => get<Scene[]>(`/api/projects/${projectId}/scenes`),
  getScene: (id: number) => get<SceneDetail>(`/api/scenes/${id}`),
  patchPrompt: (id: number, prompt: string, reason?: string) =>
    patch<{ scene: Scene }>(`/api/scenes/${id}/prompt`, { prompt, reason: reason || undefined }),
  approve: (id: number, stage: Stage) => post<{ scene: Scene; job: Job }>(`/api/scenes/${id}/approve`, { stage }),
  addComment: (id: number, input: { body: string; timecode?: number; action: CommentAction; asset_id?: number }) =>
    post<{ comment: Comment; job: Job | null; scene: Scene }>(`/api/scenes/${id}/comments`, input),
  resolveComment: (id: number, resolved: boolean) => patch<Comment>(`/api/comments/${id}`, { resolved }),
  selectVideo: (id: number, assetId?: number) => post<{ scene: Scene }>(`/api/scenes/${id}/select-video`, { asset_id: assetId }),
  resetScene: (id: number) => post<{ scene: Scene }>(`/api/scenes/${id}/reset`),
  setVerdict: (assetId: number, verdict: Verdict | null, note?: string | null) =>
    post<{ asset: Asset; scene: Scene }>(`/api/assets/${assetId}/verdict`, { verdict, verdict_note: note ?? null }),

  // ---- duyệt hàng loạt ----
  approvePreview: (projectId: number, stage: Stage) =>
    get<ApprovePreview>(`/api/projects/${projectId}/approve-all/preview${qs({ stage })}`),
  approveAll: (projectId: number, stage: Stage, expectedCredits: number) =>
    post<ApproveAllResult>(`/api/projects/${projectId}/approve-all`, { stage, expectedCredits }),

  // ---- hàng đợi ----
  listJobs: (q: JobsQuery = {}) => get<Job[]>(`/api/jobs${qs({ projectId: q.projectId, status: q.status, type: q.type, limit: q.limit })}`),
  cancelJob: (id: number) => post<{ job: Job; scene: Scene | null }>(`/api/jobs/${id}/cancel`),
  workerStatus: () => get<WorkerStatus>('/api/worker/status'),
  resumeQueue: () => post<WorkerStatus>('/api/queue/resume'),
  pauseQueue: (reason?: string) => post<WorkerStatus>('/api/queue/pause', reason ? { reason } : {}),
  meta: () => get<Meta>('/api/meta'),

  // ---- bản hoàn chỉnh ----
  listFinalCuts: (projectId: number) => get<FinalCut[]>(`/api/projects/${projectId}/final-cuts`),
  getFinalCut: (id: number) => get<FinalCut>(`/api/final-cuts/${id}`),
  createFinalCut: async (projectId: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/projects/${projectId}/final-cuts`)),
  rerenderFinalCut: async (id: number, edl: Edl, note?: string) =>
    unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/rerender`, { edl, ...(note ? { note } : {}) })),
  cancelFinalCut: async (id: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/cancel`)),
  /** Chạy lại riêng bước xoá logo Veo (không render lại, không tốn credit). */
  cleanFinalCut: async (id: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/clean`)),

  // ---- sổ cái, nhật ký ----
  ledger: (projectId: number) => get<Ledger>(`/api/projects/${projectId}/ledger`),
  events: (projectId: number, opts: { sceneId?: number; before?: number; limit?: number } = {}) =>
    get<AppEvent[]>(`/api/projects/${projectId}/events${qs({ sceneId: opts.sceneId, before: opts.before, limit: opts.limit })}`),
  ledgerCsvUrl: (projectId: number) => `/api/projects/${projectId}/ledger.csv`,
  logMdUrl: (projectId: number) => `/api/projects/${projectId}/log.md`,
};
