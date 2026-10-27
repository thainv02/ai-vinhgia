import { ApiError } from '../api/errors';
import { makeClipApi, type ClipIo } from '../clips/api';
import type { LibraryEntry } from '../components/LibraryPickerDialog';
import type { ColorRef, ColorRefList, Edl, FinalCut, Grade, GradePreview } from '../api/types';
import type { LanFinalCut, LanLibraryItem, PlanDetail, PlanRefInfo, PlanSummary, PlannerStatus, SceneVideo, SceneVideos, ToolJob, ToolStatus } from './types';

/** Phản hồi 401 UNAUTHENTICATED: phiên hết hạn hoặc chưa đăng nhập → App hiện lại màn nhập mã. */
const unauthListeners = new Set<() => void>();
export const onUnauthenticated = (fn: () => void) => {
  unauthListeners.add(fn);
  return () => void unauthListeners.delete(fn);
};

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
  try {
    body = await res.json();
  } catch {
    /* không phải JSON */
  }
  if (body?.error?.message) return new ApiError(body.error.code ?? 'ERROR', body.error.message, res.status, body.error.details);
  return new ApiError('HTTP_' + res.status, `Máy chủ trả về lỗi ${res.status}`, res.status);
}

export async function request<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError('NETWORK', 'Không kết nối được máy chủ. Kiểm tra mạng và địa chỉ trang.', 0);
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (err.code === 'UNAUTHENTICATED') for (const fn of unauthListeners) fn();
    throw err;
  }
  return (await res.json()) as T;
}

/**
 * Tải lên có tiến độ (XMLHttpRequest, vì fetch không báo tiến độ gửi): video tới 200 MB. Trình duyệt tự stream thân multipart từ đĩa,
 * không đọc cả file vào bộ nhớ. `abort()` hủy lượt tải.
 */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (loaded: number, total: number) => void): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new ApiError('NETWORK', 'Không kết nối được máy chủ. Kiểm tra mạng và địa chỉ trang.', 0));
    xhr.onabort = () => reject(new ApiError('ABORTED', 'Đã hủy tải lên', 0));
    xhr.ontimeout = () => reject(new ApiError('NETWORK', 'Hết thời gian chờ máy chủ', 0));
    xhr.onload = () => {
      let body: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* không phải JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
      const err = body?.error?.message ? new ApiError(body.error.code ?? 'ERROR', body.error.message, xhr.status, body.error.details) : new ApiError('HTTP_' + xhr.status, `Máy chủ trả về lỗi ${xhr.status}`, xhr.status);
      if (err.code === 'UNAUTHENTICATED') for (const fn of unauthListeners) fn();
      reject(err);
    };
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);

export interface CreatePlanInput {
  name: string;
  created_by_name: string;
  brief: string;
  style_lock: string;
}

const P = '/lan/api';

export const planner = {
  /**
   * Công khai. Không cần mã (mặc định, LAN_REQUIRE_CODE=false): luôn `{authenticated:true, code_required:false, expires_at:null}`.
   * Cần mã: `{authenticated:false, code_required:true}` khi chưa có phiên (không phải 401). Server cũ không có `code_required` (coi là cần mã).
   */
  session: () => get<{ authenticated: boolean; code_required?: boolean; expires_at?: string | null }>(`${P}/session`),
  login: (code: string) => post<{ ok: true; code_required?: boolean; expires_at: string | null }>(`${P}/login`, { code }),
  logout: () => post<{ ok: true }>(`${P}/logout`),
  status: () => get<PlannerStatus>(`${P}/status`),
  listPlans: () => get<PlanSummary[]>(`${P}/plans`),
  createPlan: (input: CreatePlanInput) => post<{ plan: PlanSummary }>(`${P}/plans`, input),
  getPlan: (id: number) => get<PlanDetail>(`${P}/plans/${id}`),
  /** Trường `label` đứng ngay trước `file` mà nó gắn nhãn. */
  uploadRefs: (planId: number, items: { file: File; label: string }[]) => {
    const form = new FormData();
    for (const it of items) {
      form.append('label', it.label);
      form.append('file', it.file, it.file.name);
    }
    return request<PlanRefInfo[]>('POST', `${P}/plans/${planId}/refs`, undefined, form);
  },
  addRefsFromLibrary: (planId: number, refIds: number[], labels?: Record<number, string>) =>
    post<PlanRefInfo[]>(`${P}/plans/${planId}/refs/from-library`, { ref_ids: refIds, ...(labels ? { labels } : {}) }),
  library: (planId?: number) => get<LanLibraryItem[]>(`${P}/ref-library${planId ? `?planId=${planId}` : ''}`),
  analyze: (planId: number, input: { brief?: string; style_lock?: string } = {}) =>
    post<{ plan: PlanSummary; rate: { analyze_remaining: number } }>(`${P}/plans/${planId}/analyze`, input),
  uploadStoryboard: (planId: number, sceneId: number, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ storyboard: { url: string; attempt: number; uploaded_at: string } }>('POST', `${P}/plans/${planId}/scenes/${sceneId}/storyboard`, undefined, form);
  },
  /** Bước 3: tải video cảnh (multipart, một file; stream xuống đĩa trên server). */
  uploadSceneVideo: (planId: number, sceneId: number, file: File, onProgress: (loaded: number, total: number) => void) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return uploadWithProgress<{ video: SceneVideo; videos: SceneVideos; rate: { upload_video_remaining: number } }>(`${P}/plans/${planId}/scenes/${sceneId}/video`, form, onProgress);
  },
  selectSceneVideo: (planId: number, sceneId: number, assetId: number) =>
    post<{ video: SceneVideo; videos: SceneVideos }>(`${P}/plans/${planId}/scenes/${sceneId}/video/select`, { asset_id: assetId }),
  // ---- bản hoàn chỉnh ----
  finalCuts: (planId: number) => get<LanFinalCut[]>(`${P}/plans/${planId}/final-cuts`),
  createFinalCut: (planId: number) => post<{ final_cut: LanFinalCut; rate: { create_final_remaining: number } }>(`${P}/plans/${planId}/final-cuts`),
  rerenderFinalCut: (planId: number, cutId: number, edl: Edl, note?: string) =>
    post<{ final_cut: LanFinalCut }>(`${P}/plans/${planId}/final-cuts/${cutId}/rerender`, { edl, ...(note ? { note } : {}) }).then((r) => r.final_cut as FinalCut),
  cancelFinalCut: (planId: number, cutId: number) => post<{ final_cut: LanFinalCut }>(`${P}/plans/${planId}/final-cuts/${cutId}/cancel`),
  /** Góp ý cho AI trên một bản `ready`: phiên bản mới + job edit_plan (20 lần/giờ/IP). */
  feedbackFinalCut: (planId: number, cutId: number, feedback: string) =>
    post<{ final_cut: LanFinalCut }>(`${P}/plans/${planId}/final-cuts/${cutId}/feedback`, { feedback }).then((r) => r.final_cut as FinalCut),
  /** Chỉnh màu tay (không AI): phiên bản mới chỉ chạy bước chỉnh màu (30 lần/giờ/IP). */
  gradeFinalCut: (planId: number, cutId: number, grade: Grade, note?: string) =>
    post<{ final_cut: LanFinalCut }>(`${P}/plans/${planId}/final-cuts/${cutId}/grade`, { grade, ...(note ? { note } : {}) }).then((r) => r.final_cut as FinalCut),
  /** Ảnh trước/sau ở 3 mốc thời gian (60 lần/giờ/IP). */
  previewGrade: (planId: number, cutId: number, grade: Grade) => post<GradePreview>(`${P}/plans/${planId}/final-cuts/${cutId}/grade-preview`, { grade }),
  // ---- ảnh mẫu / LUT cho "Màu theo ảnh mẫu" (tải lên 20 lần/giờ/IP) ----
  listColorRefs: (planId: number) => get<ColorRefList>(`${P}/plans/${planId}/color-refs`),
  uploadColorRef: (planId: number, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ color_ref: ColorRef }>('POST', `${P}/plans/${planId}/color-refs`, undefined, form).then((r) => r.color_ref);
  },
  colorRefFromSource: (planId: number, src: { ref_id: number } | { asset_id: number }) => post<{ color_ref: ColorRef }>(`${P}/plans/${planId}/color-refs/from-asset`, src).then((r) => r.color_ref),
  deleteColorRef: (planId: number, id: number) => request<{ ok: boolean }>('DELETE', `${P}/plans/${planId}/color-refs/${id}`).then(() => undefined),
  regradeFinalCut: (planId: number, cutId: number) =>
    post<{ final_cut: LanFinalCut }>(`${P}/plans/${planId}/final-cuts/${cutId}/regrade`).then((r) => r.final_cut as FinalCut),
  cleanFinalCut: (planId: number, cutId: number) => post<{ final_cut: LanFinalCut }>(`${P}/plans/${planId}/final-cuts/${cutId}/clean`),
  // ---- công cụ xoá logo Veo ----
  toolStatus: () => get<ToolStatus>(`${P}/tools/status`),
  toolJobs: () => get<ToolJob[]>(`${P}/tools/jobs`),
  createToolJob: (file: File, createdByName: string, onProgress: (loaded: number, total: number) => void) => {
    const form = new FormData();
    if (createdByName.trim()) form.append('created_by_name', createdByName.trim());
    form.append('file', file, file.name);
    return uploadWithProgress<{ job: ToolJob }>(`${P}/tools/jobs`, form, onProgress);
  },
  cancelToolJob: (id: number) => post<{ job: ToolJob }>(`${P}/tools/jobs/${id}/cancel`),
  retryToolJob: (id: number) => post<{ job: ToolJob }>(`${P}/tools/jobs/${id}/retry`),
  /** Xoá kế hoạch (chỉ trình duyệt đã tạo): chuyển vào thùng rác của chủ máy, chủ máy khôi phục được trong 30 ngày. */
  deletePlan: (planId: number) => request<{ ok: true; restorable_days: number }>('DELETE', `${P}/plans/${planId}`),
  planMdUrl: (planId: number) => `${P}/plans/${planId}/plan.md`,
  refsZipUrl: (planId: number) => `${P}/plans/${planId}/refs.zip`,
};

/** Nguồn thư viện ảnh cho RefUploader / LibraryPickerDialog: chỉ ảnh của các kế hoạch LAN. */
export const lanLibrarySource = {
  key: 'lan-ref-library',
  load: (planId?: number): Promise<LibraryEntry[]> => planner.library(planId),
};

const lanIo: ClipIo = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  upload: (p, form, onProgress) => uploadWithProgress(p, form, onProgress),
};

/** API cắt clip của trang LAN (`/lan/api/...`, cùng hợp đồng với app chính). */
export const lanClipApi = makeClipApi('/lan/api', lanIo);

/** Xoá dự án cắt clip (chỉ trình duyệt đã tạo): vào thùng rác của chủ máy. */
export const lanDeleteClipProject = (id: number) => request<{ ok: true; restorable_days: number }>('DELETE', `/lan/api/clip-projects/${id}`);
