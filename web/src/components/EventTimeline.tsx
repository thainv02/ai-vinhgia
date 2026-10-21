import { useEvents } from '../hooks/queries';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { humanizeEventMessage } from '../lib/status';
import { useNow } from '../lib/useNow';
import { Button } from './Button';
import { EmptyState, ErrorState, LoadingBlock } from './States';

function dotClass(type: string): string {
  if (type === 'job.failed' || type === 'queue.paused') return 'bg-danger-fg';
  if (type === 'job.requeued' || type === 'job.cancelled') return 'bg-warn-fg';
  if (type === 'scene.video_selected' || type === 'project.analyzed') return 'bg-ok-fg';
  if (type === 'comment.created' || type === 'asset.verdict') return 'bg-violet-fg';
  return 'bg-muted';
}

/** Dòng thời gian sự kiện (toàn dự án hoặc một cảnh). Sự kiện mới xuất hiện trực tiếp qua SSE. */
export function EventTimeline({ projectId, sceneId, showScene }: { projectId: number; sceneId?: number; showScene?: boolean }) {
  const q = useEvents(projectId, sceneId);
  const now = useNow();
  const events = q.data?.pages.flat() ?? [];

  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (events.length === 0) return <EmptyState icon="clock" title="Chưa có sự kiện nào" />;

  return (
    <div>
      <ol className="relative space-y-3 border-l border-line pl-4">
        {events.map((e) => (
          <li key={e.id} className="relative">
            <span aria-hidden="true" className={`absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface ${dotClass(e.type)}`} />
            <p className="text-[13px] leading-snug">
              {showScene && e.scene_code && <strong className="mr-1">{e.scene_code}</strong>}
              {humanizeEventMessage(e.message)}
            </p>
            <p className="text-xs text-muted" title={fmtDateTime(e.created_at)}>
              {fmtDateTime(e.created_at)} · {fmtRelative(e.created_at, now)}
            </p>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <Button size="sm" className="mt-3" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          Xem thêm sự kiện cũ hơn
        </Button>
      )}
    </div>
  );
}
