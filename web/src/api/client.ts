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
  ColorRef,
  ColorRefList,
  Grade,
  GradePreview,
  Job,
  LanInfo,
  Ledger,
  LibraryRef,
  Meta,
  ReconcileOutcome,
  ProjectDetail,
  ProjectSummary,
  Ref,
  Scene,
  SceneDetail,
  Stage,
  TrashItem,
  Verdict,
  WorkerStatus,
} from './types';

export { ApiError, errorMessage } from './errors';
import { ApiError } from './errors';

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

export async function request<T>(method: string, path: string, body?: unknown, init?: { form?: FormData }): Promise<T> {
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
const del = <T>(path: string, body?: unknown) => request<T>('DELETE', path, body);

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
  /** Chuyển dự án vào thùng rác (khôi phục được trong 30 ngày). `confirmName` phải trùng tên dự án. */
  deleteProject: (id: number, confirmName: string) => del<{ ok: boolean; restorable_days: number }>(`/api/projects/${id}`, { confirm_name: confirmName }),

  // ---- thùng rác ----
  listTrash: () => get<TrashItem[]>('/api/trash'),
  restoreProject: (id: number) => post<ProjectDetail>(`/api/trash/${id}/restore`),
  purgeProject: (id: number, confirmName: string) => del<{ ok: boolean }>(`/api/trash/${id}`, { confirm_name: confirmName }),

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
  /** Đối soát job managed đã gửi lệnh tạo bên ngoài mà chưa rõ kết quả. */
  reconcileJob: (id: number, outcome: ReconcileOutcome, note?: string) =>
    post<{ job: Job; scene: Scene | null; replay: boolean }>(`/api/jobs/${id}/reconcile`, { outcome, ...(note ? { note } : {}) }),
  workerStatus: () => get<WorkerStatus>('/api/worker/status'),
  resumeQueue: () => post<WorkerStatus>('/api/queue/resume'),
  pauseQueue: (reason?: string) => post<WorkerStatus>('/api/queue/pause', reason ? { reason } : {}),
  meta: () => get<Meta>('/api/meta'),
  /** Trạng thái chia sẻ qua LAN (URL, mã truy cập). Chỉ app chính có route này. */
  lanInfo: () => get<LanInfo>('/api/lan'),

  // ---- bản hoàn chỉnh ----
  listFinalCuts: (projectId: number) => get<FinalCut[]>(`/api/projects/${projectId}/final-cuts`),
  getFinalCut: (id: number) => get<FinalCut>(`/api/final-cuts/${id}`),
  createFinalCut: async (projectId: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/projects/${projectId}/final-cuts`)),
  rerenderFinalCut: async (id: number, edl: Edl, note?: string) =>
    unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/rerender`, { edl, ...(note ? { note } : {}) })),
  /** Góp ý cho AI: phiên bản mới (parent = bản đang xem) + job chọn lại điểm cắt/màu. */
  feedbackFinalCut: async (id: number, feedback: string) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/feedback`, { feedback })),
  /** Chỉnh màu tay (không AI): phiên bản mới chỉ chạy bước chỉnh màu. */
  gradeFinalCut: async (id: number, grade: Grade, note?: string) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/grade`, { grade, ...(note ? { note } : {}) })),
  previewGrade: (id: number, grade: Grade) => post<GradePreview>(`/api/final-cuts/${id}/grade-preview`, { grade }),
  // ---- ảnh mẫu / LUT cho "Màu theo ảnh mẫu" ----
  listColorRefs: (projectId: number) => get<ColorRefList>(`/api/projects/${projectId}/color-refs`),
  uploadColorRef: async (projectId: number, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return (await request<{ color_ref: ColorRef }>('POST', `/api/projects/${projectId}/color-refs`, undefined, { form })).color_ref;
  },
  colorRefFromSource: async (projectId: number, src: { ref_id: number } | { asset_id: number }) => (await post<{ color_ref: ColorRef }>(`/api/projects/${projectId}/color-refs/from-asset`, src)).color_ref,
  deleteColorRef: async (projectId: number, id: number) => {
    await del<{ ok: boolean }>(`/api/projects/${projectId}/color-refs/${id}`);
  },
  regradeFinalCut: async (id: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/regrade`)),
  cancelFinalCut: async (id: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/cancel`)),
  /** Chạy lại riêng bước xoá logo Veo (không render lại, không tốn credit). */
  cleanFinalCut: async (id: number) => unwrapFinalCut(await post<FinalCut | { final_cut: FinalCut }>(`/api/final-cuts/${id}/clean`)),
  openInShotcut: (id: number) => post<unknown>(`/api/final-cuts/${id}/open-in-shotcut`),

  // ---- sổ cái, nhật ký ----
  ledger: (projectId: number) => get<Ledger>(`/api/projects/${projectId}/ledger`),
  events: (projectId: number, opts: { sceneId?: number; before?: number; limit?: number } = {}) =>
    get<AppEvent[]>(`/api/projects/${projectId}/events${qs({ sceneId: opts.sceneId, before: opts.before, limit: opts.limit })}`),
  ledgerCsvUrl: (projectId: number) => `/api/projects/${projectId}/ledger.csv`,
  logMdUrl: (projectId: number) => `/api/projects/${projectId}/log.md`,
};
