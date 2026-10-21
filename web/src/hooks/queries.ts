import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ApiError } from '../api/client';
import type { Stage } from '../api/types';

// Khóa truy vấn tập trung để SSE và mutation cùng dùng.
export const qk = {
  projects: ['projects'] as const,
  project: (id: number) => ['project', id] as const,
  scenes: (projectId: number) => ['scenes', projectId] as const,
  scene: (id: number) => ['scene', id] as const,
  budget: (projectId: number) => ['budget', projectId] as const,
  preview: (projectId: number, stage: Stage) => ['approve-preview', projectId, stage] as const,
  jobs: (filter: object) => ['jobs', filter] as const,
  ledger: (projectId: number) => ['ledger', projectId] as const,
  events: (projectId: number, sceneId?: number) => ['events', projectId, sceneId ?? 'all'] as const,
  finalCuts: (projectId: number) => ['final-cuts', projectId] as const,
  finalCut: (id: number) => ['final-cut', id] as const,
  refLibrary: (projectId?: number) => ['ref-library', projectId ?? 'all'] as const,
  worker: ['worker-status'] as const,
  meta: ['meta'] as const,
};

export function useProjects() {
  return useQuery<Awaited<ReturnType<typeof api.listProjects>>, ApiError>({ queryKey: qk.projects, queryFn: api.listProjects });
}

export function useProject(id: number) {
  return useQuery<Awaited<ReturnType<typeof api.getProject>>, ApiError>({ queryKey: qk.project(id), queryFn: () => api.getProject(id), enabled: id > 0 });
}

export function useScenes(projectId: number) {
  return useQuery<Awaited<ReturnType<typeof api.listScenes>>, ApiError>({
    queryKey: qk.scenes(projectId),
    queryFn: () => api.listScenes(projectId),
    enabled: projectId > 0,
  });
}

export function useSceneDetail(id: number) {
  return useQuery<Awaited<ReturnType<typeof api.getScene>>, ApiError>({ queryKey: qk.scene(id), queryFn: () => api.getScene(id), enabled: id > 0 });
}

export function useBudget(projectId: number) {
  return useQuery<Awaited<ReturnType<typeof api.getBudget>>, ApiError>({
    queryKey: qk.budget(projectId),
    queryFn: () => api.getBudget(projectId),
    enabled: projectId > 0,
  });
}

export function useApprovePreview(projectId: number, stage: Stage, enabled = true) {
  return useQuery<Awaited<ReturnType<typeof api.approvePreview>>, ApiError>({
    queryKey: qk.preview(projectId, stage),
    queryFn: () => api.approvePreview(projectId, stage),
    enabled: enabled && projectId > 0,
  });
}

export function useJobs(filter: { projectId?: number; status?: string; limit?: number }) {
  return useQuery<Awaited<ReturnType<typeof api.listJobs>>, ApiError>({
    queryKey: qk.jobs(filter),
    queryFn: () => api.listJobs(filter),
    placeholderData: keepPreviousData,
  });
}

export function useLedger(projectId: number) {
  return useQuery<Awaited<ReturnType<typeof api.ledger>>, ApiError>({
    queryKey: qk.ledger(projectId),
    queryFn: () => api.ledger(projectId),
    enabled: projectId > 0,
  });
}

const EVENT_PAGE = 50;

export function useEvents(projectId: number, sceneId?: number) {
  return useInfiniteQuery<Awaited<ReturnType<typeof api.events>>, ApiError, { pages: Awaited<ReturnType<typeof api.events>>[] }, ReturnType<typeof qk.events>, number | undefined>({
    queryKey: qk.events(projectId, sceneId),
    queryFn: ({ pageParam }) => api.events(projectId, { sceneId, before: pageParam, limit: EVENT_PAGE }),
    initialPageParam: undefined,
    enabled: projectId > 0,
    getNextPageParam: (last) => (last.length >= EVENT_PAGE ? last[last.length - 1]?.id : undefined),
  });
}

export function useWorkerStatus() {
  return useQuery<Awaited<ReturnType<typeof api.workerStatus>>, ApiError>({
    queryKey: qk.worker,
    queryFn: api.workerStatus,
    refetchInterval: 30_000,
  });
}

export function useMeta() {
  return useQuery<Awaited<ReturnType<typeof api.meta>>, ApiError>({ queryKey: qk.meta, queryFn: api.meta, staleTime: 5 * 60_000 });
}

export function useRefLibrary(projectId: number | undefined, enabled = true) {
  return useQuery<Awaited<ReturnType<typeof api.refLibrary>>, ApiError>({
    queryKey: qk.refLibrary(projectId),
    queryFn: () => api.refLibrary(projectId),
    enabled,
    staleTime: 0,
  });
}

export function useFinalCuts(projectId: number) {
  return useQuery<Awaited<ReturnType<typeof api.listFinalCuts>>, ApiError>({
    queryKey: qk.finalCuts(projectId),
    queryFn: () => api.listFinalCuts(projectId),
    enabled: projectId > 0,
  });
}
