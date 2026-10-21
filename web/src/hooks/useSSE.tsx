import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { FinalCut, Scene, SseEventMap } from '../api/types';
import { qk } from './queries';

export type SseState = 'connecting' | 'open' | 'reconnecting';

const SseContext = createContext<SseState>('connecting');
export const useSseState = () => useContext(SseContext);

/** Ghi đè (hoặc thêm) cảnh vào danh sách cảnh đã cache của dự án. */
export function upsertScene(qc: QueryClient, scene: Scene) {
  qc.setQueryData<Scene[]>(qk.scenes(scene.project_id), (old) => {
    if (!old) return old;
    const idx = old.findIndex((s) => s.id === scene.id);
    const next = idx >= 0 ? old.map((s) => (s.id === scene.id ? scene : s)) : [...old, scene];
    return next.sort((a, b) => a.order_index - b.order_index || a.id - b.id);
  });
}

/** Ghi đè (hoặc thêm) một bản dựng vào danh sách đã cache của dự án (mới nhất trước) và vào truy vấn chi tiết. */
export function upsertFinalCut(qc: QueryClient, fc: FinalCut) {
  qc.setQueryData<FinalCut[]>(qk.finalCuts(fc.project_id), (old) => {
    if (!old) return old;
    const idx = old.findIndex((x) => x.id === fc.id);
    const next = idx >= 0 ? old.map((x) => (x.id === fc.id ? fc : x)) : [...old, fc];
    return next.sort((a, b) => b.version - a.version);
  });
  qc.setQueryData(qk.finalCut(fc.id), fc);
}

const EVENT_NAMES: (keyof SseEventMap)[] = [
  'ai.updated',
  'scene.updated',
  'job.updated',
  'asset.created',
  'asset.updated',
  'comment.created',
  'comment.updated',
  'worker.status',
  'budget.updated',
  'event.created',
  'project.updated',
  'final_cut.updated',
];

/**
 * Một kết nối SSE duy nhất tới /api/stream (nhận mọi dự án), ánh xạ sự kiện thành cập nhật cache react-query.
 * Tự nối lại với backoff; sau khi nối lại thì làm mới toàn bộ dữ liệu vì sự kiện lỡ không được phát lại.
 */
export function LiveUpdates({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<SseState>('connecting');

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: number | undefined;
    let flushTimer: number | undefined;
    let attempt = 0;
    let needsRefresh = false; // đã từng mất kết nối: sự kiện lỡ không được phát lại nên phải làm mới dữ liệu
    let disposed = false;
    const pending = new Map<string, QueryKey>();

    // Gom các lệnh làm mới trong 150ms để không gọi API dồn dập khi có nhiều sự kiện liên tiếp.
    const invalidateSoon = (key: QueryKey) => {
      pending.set(JSON.stringify(key), key);
      if (flushTimer === undefined) {
        flushTimer = window.setTimeout(() => {
          flushTimer = undefined;
          const keys = [...pending.values()];
          pending.clear();
          for (const k of keys) void qc.invalidateQueries({ queryKey: k });
        }, 150);
      }
    };

    const handle = <K extends keyof SseEventMap>(name: K, data: SseEventMap[K]) => {
      switch (name) {
        case 'ai.updated': {
          invalidateSoon(['ai-accounts']);
          invalidateSoon(['jobs']);
          break;
        }
        case 'scene.updated': {
          const { scene } = data as SseEventMap['scene.updated'];
          upsertScene(qc, scene);
          invalidateSoon(qk.scene(scene.id));
          invalidateSoon(qk.projects);
          invalidateSoon(['approve-preview', scene.project_id]);
          // Đổi video được chọn làm bản hoàn chỉnh đã dựng thành "đã cũ"; final_cut_block của dự án cũng đổi theo.
          invalidateSoon(qk.finalCuts(scene.project_id));
          invalidateSoon(qk.project(scene.project_id));
          break;
        }
        case 'job.updated': {
          const { job } = data as SseEventMap['job.updated'];
          invalidateSoon(['jobs']);
          invalidateSoon(qk.project(job.project_id));
          if (job.scene_id) invalidateSoon(qk.scene(job.scene_id));
          break;
        }
        case 'asset.created':
        case 'asset.updated': {
          const { asset } = data as SseEventMap['asset.created'];
          invalidateSoon(qk.scene(asset.scene_id));
          break;
        }
        case 'comment.created':
        case 'comment.updated': {
          const { comment } = data as SseEventMap['comment.created'];
          invalidateSoon(qk.scene(comment.scene_id));
          break;
        }
        case 'worker.status': {
          qc.setQueryData(qk.worker, data as SseEventMap['worker.status']);
          break;
        }
        case 'budget.updated': {
          const { project_id } = data as SseEventMap['budget.updated'];
          invalidateSoon(qk.budget(project_id));
          invalidateSoon(qk.project(project_id));
          invalidateSoon(qk.projects);
          invalidateSoon(qk.ledger(project_id));
          invalidateSoon(['approve-preview', project_id]);
          // Job video tạo/hủy/xong đổi attempts_used và video_block; làm mới danh sách cảnh để các cảnh khác không bị lệch.
          invalidateSoon(qk.scenes(project_id));
          invalidateSoon(['scene']);
          break;
        }
        case 'event.created': {
          const { event } = data as SseEventMap['event.created'];
          invalidateSoon(['events', event.project_id]);
          if (event.type.startsWith('job.') || event.type.startsWith('queue.')) invalidateSoon(['jobs']);
          if (event.type === 'job.requeued') invalidateSoon(qk.project(event.project_id));
          break;
        }
        case 'final_cut.updated': {
          const { final_cut } = data as SseEventMap['final_cut.updated'];
          upsertFinalCut(qc, final_cut);
          // Bản tóm tắt dự án có latest_final_cut; job edit_plan đổi trạng thái theo.
          invalidateSoon(qk.projects);
          invalidateSoon(qk.project(final_cut.project_id));
          if (final_cut.status !== 'rendering') invalidateSoon(['jobs']);
          break;
        }
        case 'project.updated': {
          const { project } = data as SseEventMap['project.updated'];
          qc.setQueryData(qk.project(project.id), (old: object | undefined) => (old ? { ...old, ...project } : old));
          // Bản tóm tắt không có refs: làm mới chi tiết dự án (ảnh có thể vừa đổi) và thư viện ảnh.
          invalidateSoon(qk.project(project.id));
          invalidateSoon(['ref-library']);
          invalidateSoon(qk.projects);
          invalidateSoon(qk.scenes(project.id));
          break;
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource('/api/stream');
      es.onopen = () => {
        setState('open');
        if (needsRefresh) void qc.invalidateQueries(); // nối lại: làm mới mọi truy vấn đang dùng (kể cả truy vấn đang lỗi)
        needsRefresh = false;
        attempt = 0;
      };
      es.onerror = () => {
        // EventSource không tự nối lại khi nhận phản hồi lỗi (vd 502 lúc server khởi động lại), nên tự quản lý.
        es?.close();
        es = null;
        if (disposed) return;
        needsRefresh = true;
        setState('reconnecting');
        const delay = Math.min(15000, 1000 * 2 ** attempt++);
        retryTimer = window.setTimeout(connect, delay);
      };
      for (const name of EVENT_NAMES) {
        es.addEventListener(name, (e) => {
          try {
            handle(name, JSON.parse((e as MessageEvent<string>).data) as never);
          } catch {
            /* bỏ qua sự kiện hỏng */
          }
        });
      }
    };

    connect();
    return () => {
      disposed = true;
      es?.close();
      window.clearTimeout(retryTimer);
      window.clearTimeout(flushTimer);
    };
  }, [qc]);

  return <SseContext.Provider value={state}>{children}</SseContext.Provider>;
}
