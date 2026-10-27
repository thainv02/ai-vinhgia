import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type ApiError, type PatchProjectInput } from '../api/client';
import { aiRequest } from '../api/ai';
import type { CommentAction, Edl, FinalCut, ProjectDetail, ReconcileOutcome, Ref, Scene, Stage, Verdict } from '../api/types';
import { qk } from './queries';
import type { RevisionApi } from '../lib/revisionApi';
import { upsertFinalCut, upsertScene } from './useSSE';

/** Mọi mutation tự báo lỗi bằng toast, trừ khi gọi với `meta: { silent: true }` (nơi gọi tự hiển thị lỗi). */
const SILENT = { silent: true } as const;

function syncScene(qc: QueryClient, scene: Scene) {
  upsertScene(qc, scene);
  void qc.invalidateQueries({ queryKey: qk.scene(scene.id) });
  void qc.invalidateQueries({ queryKey: ['jobs'] });
  void qc.invalidateQueries({ queryKey: qk.budget(scene.project_id) });
  void qc.invalidateQueries({ queryKey: qk.projects });
}

function refreshProject(qc: QueryClient, projectId: number) {
  void qc.invalidateQueries({ queryKey: qk.project(projectId) });
  void qc.invalidateQueries({ queryKey: qk.scenes(projectId) });
  void qc.invalidateQueries({ queryKey: qk.budget(projectId) });
  void qc.invalidateQueries({ queryKey: ['approve-preview', projectId] });
  void qc.invalidateQueries({ queryKey: qk.projects });
  void qc.invalidateQueries({ queryKey: ['jobs'] });
  void qc.invalidateQueries({ queryKey: ['scene'] });
}

/** Duyệt storyboard / video cho một cảnh. Gọi với `silent` để hộp xác nhận tự hiển thị lỗi. */
export function useApproveScene(opts: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation<{ scene: Scene }, ApiError, { sceneId: number; stage: Stage }>({
    mutationFn: ({ sceneId, stage }) => api.approve(sceneId, stage),
    onSuccess: ({ scene }) => syncScene(qc, scene),
    meta: opts.silent ? SILENT : undefined,
  });
}

export function useCancelJob(opts: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.cancelJob(jobId),
    onSuccess: ({ scene, job }) => {
      if (scene) syncScene(qc, scene);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: qk.project(job.project_id) });
    },
    meta: opts.silent ? SILENT : undefined,
  });
}

/** Đối soát job chờ kết quả tạo ngoài. Nơi gọi tự hiển thị lỗi (silent). */
export function useReconcileJob() {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.reconcileJob>>, ApiError, { jobId: number; outcome: ReconcileOutcome; note?: string }>({
    mutationFn: ({ jobId, outcome, note }) => api.reconcileJob(jobId, outcome, note),
    onSuccess: ({ scene, job }) => {
      if (scene) syncScene(qc, scene);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: qk.project(job.project_id) });
    },
    meta: SILENT,
  });
}

/** "Thử lại ngay" cho job đang chờ tài khoản AI/trình duyệt (không áp dụng cho chờ đối soát). */
export function useResumeJob() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, number>({
    mutationFn: (jobId) => aiRequest(`/api/ai/jobs/${jobId}/resume`, 'POST', {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['jobs'] }); void qc.invalidateQueries({ queryKey: ['scenes'] }); },
  });
}

export function useResetScene() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (sceneId: number) => api.resetScene(sceneId), onSuccess: ({ scene }) => syncScene(qc, scene) });
}

export function useSelectVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sceneId, assetId }: { sceneId: number; assetId?: number }) => api.selectVideo(sceneId, assetId),
    onSuccess: ({ scene }) => syncScene(qc, scene),
  });
}

export function useSetVerdict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, verdict, note }: { assetId: number; verdict: Verdict | null; note?: string | null }) =>
      api.setVerdict(assetId, verdict, note),
    onSuccess: ({ scene }) => syncScene(qc, scene),
  });
}

export function usePatchPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sceneId, prompt, reason }: { sceneId: number; prompt: string; reason?: string }) =>
      api.patchPrompt(sceneId, prompt, reason),
    onSuccess: ({ scene }) => syncScene(qc, scene),
  });
}

export function useAddComment(opts: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sceneId, ...input }: { sceneId: number; body: string; timecode?: number; action: CommentAction; asset_id?: number }) =>
      api.addComment(sceneId, input),
    onSuccess: ({ scene }) => syncScene(qc, scene),
    meta: opts.silent ? SILENT : undefined,
  });
}

export function useResolveComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: number; sceneId: number; resolved: boolean }) => api.resolveComment(commentId, resolved),
    onSuccess: (_c, vars) => {
      void qc.invalidateQueries({ queryKey: qk.scene(vars.sceneId) });
    },
  });
}

export function useApproveAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, stage, expectedCredits }: { projectId: number; stage: Stage; expectedCredits: number }) =>
      api.approveAll(projectId, stage, expectedCredits),
    onSuccess: (_r, vars) => refreshProject(qc, vars.projectId),
    onError: (_e, vars) => refreshProject(qc, vars.projectId),
    meta: SILENT,
  });
}

export function usePatchProject(opts: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, input }: { projectId: number; input: PatchProjectInput }) => api.patchProject(projectId, input),
    onSuccess: (_p, vars) => refreshProject(qc, vars.projectId),
    meta: opts.silent ? SILENT : undefined,
  });
}

export function useSubmitBrief() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, brief }: { projectId: number; brief?: string }) => api.submitBrief(projectId, brief),
    onSuccess: (_r, vars) => refreshProject(qc, vars.projectId),
  });
}

export function useQueueControl() {
  const qc = useQueryClient();
  const onSuccess = (status: Awaited<ReturnType<typeof api.resumeQueue>>) => {
    qc.setQueryData(qk.worker, status);
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    void qc.invalidateQueries({ queryKey: ['scenes'] });
  };
  const resume = useMutation({ mutationFn: () => api.resumeQueue(), onSuccess });
  const pause = useMutation({ mutationFn: (reason?: string) => api.pauseQueue(reason), onSuccess });
  return { resume, pause };
}

// ---- ảnh tham chiếu của dự án đã tạo ----
function refreshRefs(qc: QueryClient, projectId: number) {
  void qc.invalidateQueries({ queryKey: qk.project(projectId) });
  void qc.invalidateQueries({ queryKey: ['ref-library'] });
  // Xóa ảnh gỡ id khỏi upload_refs của các cảnh.
  void qc.invalidateQueries({ queryKey: qk.scenes(projectId) });
  void qc.invalidateQueries({ queryKey: ['scene'] });
}

export function useUploadRefs() {
  const qc = useQueryClient();
  return useMutation<Ref[], ApiError, { projectId: number; items: { file: File; label: string }[] }>({
    mutationFn: ({ projectId, items }) => api.uploadRefs(projectId, items),
    onSuccess: (_r, vars) => refreshRefs(qc, vars.projectId),
  });
}

/** Thêm ảnh từ thư viện. Gọi với `silent` để hộp thư viện tự hiển thị lỗi. */
export function useAddRefsFromLibrary(opts: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation<Ref[], ApiError, { projectId: number; refIds: number[] }>({
    mutationFn: ({ projectId, refIds }) => api.addRefsFromLibrary(projectId, refIds),
    onSuccess: (_r, vars) => refreshRefs(qc, vars.projectId),
    meta: opts.silent ? SILENT : undefined,
  });
}

export function useRelabelRef() {
  const qc = useQueryClient();
  return useMutation<Ref, ApiError, { projectId: number; refId: number; label: string }>({
    mutationFn: ({ refId, label }) => api.patchRef(refId, label),
    onSuccess: (_r, vars) => refreshRefs(qc, vars.projectId),
  });
}

/** Đổi thứ tự: cập nhật ngay trên giao diện, lỗi thì tải lại từ server. */
export function useReorderRefs() {
  const qc = useQueryClient();
  return useMutation<Ref[], ApiError, { projectId: number; ids: number[] }>({
    mutationFn: ({ projectId, ids }) => api.reorderRefs(projectId, ids),
    onMutate: ({ projectId, ids }) => {
      qc.setQueryData<ProjectDetail>(qk.project(projectId), (old) => {
        if (!old) return old;
        const byId = new Map(old.refs.map((r) => [r.id, r]));
        return { ...old, refs: ids.map((id) => byId.get(id)).filter((r): r is Ref => !!r) };
      });
    },
    onSettled: (_r, _e, vars) => refreshRefs(qc, vars.projectId),
  });
}

export function useDeleteRef() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, ApiError, { projectId: number; refId: number }>({
    mutationFn: ({ refId }) => api.deleteRef(refId),
    onSuccess: (_r, vars) => refreshRefs(qc, vars.projectId),
    meta: SILENT,
  });
}

// ---- bản hoàn chỉnh ----
function syncFinalCut(qc: QueryClient, fc: FinalCut) {
  upsertFinalCut(qc, fc);
  void qc.invalidateQueries({ queryKey: qk.projects });
  void qc.invalidateQueries({ queryKey: qk.project(fc.project_id) });
  void qc.invalidateQueries({ queryKey: ['jobs'] });
}

/** Dựng bản mới (tạo version mới + job chọn điểm cắt cho Claude). Không tốn credit. */
export function useCreateFinalCut() {
  const qc = useQueryClient();
  return useMutation<FinalCut, ApiError, number>({
    mutationFn: (projectId) => api.createFinalCut(projectId),
    onSuccess: (fc) => syncFinalCut(qc, fc),
  });
}

/** Render lại với EDL người dùng sửa: tạo version mới, render ngay. Lỗi INVALID_EDL do nơi gọi hiển thị (silent). */
export function useRerenderFinalCut() {
  const qc = useQueryClient();
  return useMutation<FinalCut, ApiError, { id: number; edl: Edl; note?: string }>({
    mutationFn: ({ id, edl, note }) => api.rerenderFinalCut(id, edl, note),
    onSuccess: (fc) => syncFinalCut(qc, fc),
    meta: SILENT,
  });
}

export function useCancelFinalCut() {
  const qc = useQueryClient();
  return useMutation<FinalCut, ApiError, number>({
    mutationFn: (id) => api.cancelFinalCut(id),
    onSuccess: (fc) => syncFinalCut(qc, fc),
  });
}

/** Xoá logo Veo cho bản dựng: "Xoá logo Veo" (bản cũ còn logo) / "Thử xoá logo lại" (lỗi ở bước xoá logo). */
export function useCleanFinalCut() {
  const qc = useQueryClient();
  return useMutation<FinalCut, ApiError, number>({
    mutationFn: (id) => api.cleanFinalCut(id),
    onSuccess: (fc) => syncFinalCut(qc, fc),
  });
}

/** Cập nhật bộ nhớ đệm sau khi tạo phiên bản mới (góp ý / chỉnh màu): hàm dùng cho `onCreated`. */
export function useSyncFinalCut() {
  const qc = useQueryClient();
  return (fc: FinalCut) => syncFinalCut(qc, fc);
}

/** Thao tác góp ý / chỉnh màu của app chính (xem `lib/revisionApi.ts`). */
export const mainRevisionApi: RevisionApi = {
  feedback: (id, text) => api.feedbackFinalCut(id, text),
  grade: (id, grade, note) => api.gradeFinalCut(id, grade, note),
  preview: (id, grade) => api.previewGrade(id, grade),
  regrade: (id) => api.regradeFinalCut(id),
  colorRefs: {
    scope: 'app',
    list: (projectId) => api.listColorRefs(projectId),
    upload: (projectId, file) => api.uploadColorRef(projectId, file),
    fromSource: (projectId, src) => api.colorRefFromSource(projectId, src),
    remove: (projectId, id) => api.deleteColorRef(projectId, id),
  },
};

/** Chạy lại bước chỉnh màu của bản lỗi/hủy giữa bước chỉnh màu. */
export function useRegradeFinalCut() {
  const qc = useQueryClient();
  return useMutation<FinalCut, ApiError, number>({
    mutationFn: (id) => api.regradeFinalCut(id),
    onSuccess: (fc) => syncFinalCut(qc, fc),
  });
}

export function useOpenInShotcut() {
  return useMutation<unknown, ApiError, number>({ mutationFn: (id) => api.openInShotcut(id) });
}

// ---- thùng rác ----
function refreshTrash(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: qk.projects });
  void qc.invalidateQueries({ queryKey: qk.trash });
  void qc.invalidateQueries({ queryKey: ['jobs'] });
  void qc.invalidateQueries({ queryKey: ['ref-library'] });
}

/** Chuyển dự án vào thùng rác. Nơi gọi tự hiển thị lỗi (silent: có lý do bị chặn). */
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.deleteProject>>, ApiError, { projectId: number; confirmName: string }>({
    mutationFn: ({ projectId, confirmName }) => api.deleteProject(projectId, confirmName),
    onSuccess: (_r, vars) => {
      qc.removeQueries({ queryKey: qk.project(vars.projectId) });
      qc.removeQueries({ queryKey: qk.scenes(vars.projectId) });
      refreshTrash(qc);
    },
    onError: (_e, vars) => void qc.invalidateQueries({ queryKey: qk.project(vars.projectId) }),
    meta: SILENT,
  });
}

export function useRestoreProject() {
  const qc = useQueryClient();
  return useMutation<ProjectDetail, ApiError, number>({ mutationFn: (id) => api.restoreProject(id), onSuccess: () => refreshTrash(qc), meta: SILENT });
}

export function usePurgeProject() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, ApiError, { projectId: number; confirmName: string }>({
    mutationFn: ({ projectId, confirmName }) => api.purgeProject(projectId, confirmName),
    onSuccess: () => refreshTrash(qc),
    meta: SILENT,
  });
}
