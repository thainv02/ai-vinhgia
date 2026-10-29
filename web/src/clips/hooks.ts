import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ApiError } from '../api/errors';
import { useClipEnv } from './env';
import { projectNeedsPolling } from './lib';
import type { CaptionLayout } from './subtitleBox';
import type { CaptionPreset, Clip, ClipCut, ClipProjectDetail, SourceVideo, TranscriptSentence } from './types';

export const clipKeys = {
  project: (scope: string, id: number) => ['clip-project', scope, id] as const,
  list: (scope: string) => ['clip-projects', scope] as const,
};

export function useClipProject(id: number) {
  const { api, scope } = useClipEnv();
  return useQuery<ClipProjectDetail, ApiError>({
    queryKey: clipKeys.project(scope, id),
    queryFn: () => api.getProject(id),
    enabled: id > 0,
    refetchInterval: (q) => (projectNeedsPolling(q.state.data) ? 4000 : false),
  });
}

/** Giới hạn tải lên, trạng thái dịch vụ nhận dạng, hỗ trợ phụ đề của máy chủ (không có thì dùng mặc định). */
export function useClipStatus() {
  const { api, scope } = useClipEnv();
  return useQuery({ queryKey: ['clip-status', scope], queryFn: api.clipStatus, staleTime: 60_000, retry: false });
}

export function useClipProjectList() {
  const { api, scope } = useClipEnv();
  return useQuery({
    queryKey: clipKeys.list(scope),
    queryFn: api.listProjects,
    refetchInterval: (q) => (q.state.data?.some((p) => p.source_video && ['uploaded', 'transcribing'].includes(p.source_video.status)) ? 5000 : 20_000),
  });
}

/** Ghi đè một clip vào bản chi tiết dự án đã cache (nếu chưa có thì thêm). */
export function upsertClip(qc: QueryClient, scope: string, projectId: number, clip: Clip) {
  qc.setQueryData<ClipProjectDetail>(clipKeys.project(scope, projectId), (old) => {
    if (!old) return old;
    const has = old.clips.some((c) => c.id === clip.id);
    const clips = has ? old.clips.map((c) => (c.id === clip.id ? { ...c, ...clip } : c)) : [...old.clips, clip];
    return { ...old, clips };
  });
}

export function upsertCut(qc: QueryClient, scope: string, projectId: number, clipId: number, cut: ClipCut) {
  qc.setQueryData<ClipProjectDetail>(clipKeys.project(scope, projectId), (old) => {
    if (!old) return old;
    return {
      ...old,
      clips: old.clips.map((c) => {
        if (c.id !== clipId) return c;
        const isNew = !c.latest_cut || cut.version > c.latest_cut.version;
        if (!isNew && c.latest_cut?.id !== cut.id) return c;
        return { ...c, latest_cut: cut, cuts_count: isNew && c.latest_cut?.id !== cut.id ? Math.max(c.cuts_count + 1, cut.version) : c.cuts_count };
      }),
    };
  });
}

export function patchSource(qc: QueryClient, scope: string, projectId: number, source: SourceVideo) {
  qc.setQueryData<ClipProjectDetail>(clipKeys.project(scope, projectId), (old) => (old ? { ...old, source: { ...(old.source ?? {}), ...source } } : old));
}

/** Tập hợp các thao tác ghi của một dự án cắt clip. Lỗi hiện toast (mặc định của app), trừ khi nơi gọi tự xử lý. */
export function useClipActions(projectId: number) {
  const { api, scope, refreshQuota } = useClipEnv();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: clipKeys.project(scope, projectId) });
    refreshQuota?.();
  };

  const patchClip = useMutation({
    mutationFn: (v: { id: number; status?: Clip['status']; title?: string; start_word?: number; end_word?: number; captions?: { preset?: CaptionPreset; layout?: CaptionLayout | null } }) => {
      const { id, ...rest } = v;
      return api.patchClip(id, rest);
    },
    onSuccess: (clip) => {
      if (clip && typeof clip === 'object' && 'id' in clip) upsertClip(qc, scope, projectId, clip);
      refresh();
    },
  });
  const createClip = useMutation({
    mutationFn: (v: { start_word: number; end_word: number; title?: string }) => api.createClip(projectId, v),
    onSuccess: (clip) => {
      if (clip && typeof clip === 'object' && 'id' in clip) upsertClip(qc, scope, projectId, clip);
      refresh();
    },
  });
  const putCaptions = useMutation({
    mutationFn: (v: { id: number; words: { i: number; w: string }[] }) => api.putCaptions(v.id, v.words),
    onSuccess: (clip) => {
      if (clip && typeof clip === 'object' && 'id' in clip) upsertClip(qc, scope, projectId, clip);
      refresh();
    },
    meta: { silent: true },
  });
  const render = useMutation({
    mutationFn: (v: { id: number; reframe_mode?: 'fit' | 'center'; captions_preset?: 'highlight' | 'karaoke' | 'minimal' | 'none' }) => {
      const { id, ...rest } = v;
      return api.renderClip(id, { aspect: '9:16', ...rest });
    },
    onSuccess: (cut, v) => {
      if (cut && typeof cut === 'object' && 'id' in cut) upsertCut(qc, scope, projectId, v.id, cut);
      refresh();
    },
  });
  const cancelCut = useMutation({ mutationFn: (id: number) => api.cancelCut(id), onSuccess: refresh });
  const plan = useMutation({ mutationFn: (v: Parameters<typeof api.clipPlan>[1]) => api.clipPlan(projectId, v), onSuccess: refresh });
  const transcribe = useMutation({
    mutationFn: (sourceId: number) => api.transcribe(sourceId),
    onSuccess: (_r, sourceId) => {
      forgetTranscript(scope, sourceId);
      refresh();
    },
  });
  const cancelSource = useMutation({ mutationFn: (sourceId: number) => api.cancelSource(sourceId), onSuccess: refresh });
  const patchProject = useMutation({ mutationFn: (v: { name?: string; stt_terms?: string }) => api.patchProject(projectId, v), onSuccess: refresh });

  return { patchClip, createClip, putCaptions, render, cancelCut, plan, transcribe, cancelSource, patchProject, refresh };
}

// ---- transcript ----

const PAGE = 500;
const transcriptCache = new Map<string, { sentences: TranscriptSentence[]; total: number }>();

/** Bỏ transcript đã cache của một nguồn (sau khi nhận dạng lại). */
export function forgetTranscript(scope: string, sourceId: number) {
  for (const k of [...transcriptCache.keys()]) if (k.startsWith(`${scope}:${sourceId}:`)) transcriptCache.delete(k);
}

export interface TranscriptState {
  sentences: TranscriptSentence[];
  total: number;
  loading: boolean;
  error: ApiError | Error | null;
  retry: () => void;
}

/**
 * Tải transcript theo trang (theo câu) cho tới hết: video 3 giờ có thể tới ~30 nghìn từ. Hiển thị được ngay từ trang đầu.
 * Cache theo (phạm vi, nguồn, số từ) để mở lại trang không phải tải lại.
 */
export function useTranscript(source: SourceVideo | null | undefined): TranscriptState {
  const { api, scope } = useClipEnv();
  const ready = !!source && source.status === 'transcribed';
  const sid = source?.id ?? 0;
  const cacheKey = `${scope}:${sid}:${source?.word_count ?? 0}`;
  const [state, setState] = useState<{ key: string; sentences: TranscriptSentence[]; total: number; loading: boolean; error: Error | null }>(() => {
    const c = transcriptCache.get(cacheKey);
    return { key: cacheKey, sentences: c?.sentences ?? [], total: c?.total ?? 0, loading: false, error: null };
  });
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(0);

  useEffect(() => {
    if (!ready) return;
    const cached = transcriptCache.get(cacheKey);
    if (cached && nonce === 0) {
      setState({ key: cacheKey, sentences: cached.sentences, total: cached.total, loading: false, error: null });
      return;
    }
    const run = ++runRef.current;
    let acc: TranscriptSentence[] = [];
    let total = 0;
    setState({ key: cacheKey, sentences: [], total: 0, loading: true, error: null });
    void (async () => {
      try {
        for (;;) {
          const page = await api.transcript(sid, acc.length, PAGE);
          if (run !== runRef.current) return;
          total = page.total;
          if (page.sentences.length === 0) break;
          acc = acc.concat(page.sentences);
          setState({ key: cacheKey, sentences: acc, total, loading: acc.length < total, error: null });
          if (acc.length >= total) break;
        }
        transcriptCache.set(cacheKey, { sentences: acc, total });
        if (transcriptCache.size > 4) transcriptCache.delete(transcriptCache.keys().next().value as string);
        setState({ key: cacheKey, sentences: acc, total, loading: false, error: null });
      } catch (e) {
        if (run === runRef.current) setState((s) => ({ ...s, loading: false, error: e as Error }));
      }
    })();
    return () => {
      runRef.current++;
    };
  }, [api, ready, sid, cacheKey, nonce]);

  return useMemo(
    () => ({
      sentences: state.key === cacheKey ? state.sentences : [],
      total: state.key === cacheKey ? state.total : 0,
      loading: ready && (state.key !== cacheKey || state.loading),
      error: state.error,
      retry: () => setNonce((n) => n + 1),
    }),
    [state, cacheKey, ready],
  );
}
