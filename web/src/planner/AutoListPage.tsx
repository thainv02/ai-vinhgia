import { useQuery } from '@tanstack/react-query';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { fmtRelative } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { MediaBanner } from './AutoProjectPage';
import { PlanStatusBadge } from './parts';
import { hrefOf, navigate } from './useHashRoute';

/** Danh sách dự án Autovideo: storyboard và video do máy chủ tạo bằng Muse / Google Flow của chủ máy. */
export function AutoListPage() {
  useDocumentTitle('Autovideo');
  const now = useNow();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 10_000 });
  const q = useQuery({
    queryKey: ['auto-projects'],
    queryFn: planner.listAuto,
    refetchInterval: (r) => (r.state.data?.some((p) => p.status === 'analyzing' || p.progress.active > 0) ? 4000 : 15_000),
  });
  const create = (
    <Button variant="primary" icon={<Icon name="plus" />} onClick={() => navigate({ name: 'autoNew' })}>
      Tạo dự án mới
    </Button>
  );
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Autovideo</h1>
          <p className="text-[13px] text-muted">Nhập kịch bản và ảnh sản phẩm; máy chủ tạo storyboard, video từng cảnh rồi dựng bản hoàn chỉnh.</p>
        </div>
        {create}
      </div>
      <div className="mb-3">
        <MediaBanner media={status.data?.autovideo} />
      </div>
      {q.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-24" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState icon="film" title="Chưa có dự án Autovideo nào" action={create}>
          Nhập yêu cầu kịch bản và ảnh sản phẩm để bắt đầu.
        </EmptyState>
      ) : (
        <ul className="space-y-2" aria-label="Danh sách dự án Autovideo">
          {q.data.map((p) => (
            <li key={p.id}>
              <a
                href={hrefOf({ name: 'autoProject', id: p.id })}
                className="group grid items-center gap-4 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-surface-2 md:grid-cols-[64px_minmax(160px,1fr)_230px_24px]"
              >
                <div className="hidden size-16 overflow-hidden rounded-md border border-line bg-surface-2 md:grid md:place-items-center">
                  {p.thumbnail_url ? <img src={p.thumbnail_url} alt="" loading="lazy" className="size-full object-cover" /> : <Icon name="image" size={24} className="text-muted" />}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[15px] font-semibold group-hover:underline">{p.name}</h2>
                    {p.status !== 'ready' && <PlanStatusBadge status={p.status} />}
                    {p.progress.active > 0 && (
                      <Badge tone="info" live>
                        Đang tạo {p.progress.active} việc
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {p.created_by_name || 'Chưa rõ người tạo'} · {fmtRelative(p.created_at, now)} · {p.scene_count} cảnh
                  </p>
                </div>
                <div className="space-y-1 text-xs">
                  <p>
                    Storyboard <strong>{p.progress.storyboards}/{p.scene_count}</strong>
                    <span className="mx-2 text-muted">·</span>
                    Video <strong>{p.progress.videos}/{p.scene_count}</strong>
                  </p>
                  {p.progress.final_status === 'ready' ? <Badge tone="ok">Đã có bản hoàn chỉnh</Badge> : <span className="text-muted">{p.analysis.waiting ?? ' '}</span>}
                </div>
                <Icon name="chevronRight" size={16} className="hidden shrink-0 text-muted md:block" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
