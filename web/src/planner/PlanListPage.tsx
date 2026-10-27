import { useQuery } from '@tanstack/react-query';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { PlanStatusBadge } from './parts';
import { hrefOf, navigate } from './useHashRoute';

/** Danh sách kế hoạch của mọi người dùng trong mạng LAN (chung một mã truy cập). */
export function PlanListPage() {
  useDocumentTitle('Kế hoạch prompt');
  const now = useNow();
  const q = useQuery({
    queryKey: ['plans'],
    queryFn: () => planner.listPlans().then((l) => l.filter((p) => p.kind !== 'clips')),
    refetchInterval: (query) => (query.state.data?.some((p) => p.status === 'analyzing') ? 3000 : 15_000),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Kế hoạch prompt</h1>
          <p className="text-[13px] text-muted">Mỗi kế hoạch: AI chia cảnh, viết sẵn tin nhắn cho ChatGPT (storyboard) và prompt cho Google Flow (video).</p>
        </div>
        <Button variant="primary" icon={<Icon name="plus" />} onClick={() => navigate({ name: 'new' })}>
          Tạo kế hoạch mới
        </Button>
      </div>

      {q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data && q.data.length === 0 ? (
        <EmptyState
          icon="film"
          title="Chưa có kế hoạch nào"
          action={
            <Button variant="primary" icon={<Icon name="plus" />} onClick={() => navigate({ name: 'new' })}>
              Tạo kế hoạch đầu tiên
            </Button>
          }
        >
          Nhập yêu cầu kịch bản và ảnh sản phẩm. AI sẽ chia thành các cảnh, bạn nhận prompt để tự tạo ảnh và video.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data?.map((p) => (
            <li key={p.id}>
              <a
                href={hrefOf({ name: 'plan', id: p.id })}
                className="group flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-[15px] font-semibold leading-snug group-hover:underline">{p.name}</h2>
                  <PlanStatusBadge status={p.status} />
                </div>
                <p className="text-[13px] text-muted">
                  {p.created_by_name || 'Không rõ'} · {fmtRelative(p.created_at, now)}
                </p>
                <dl className="mt-auto flex gap-6 border-t border-line pt-2 text-xs">
                  <div>
                    <dt className="text-muted">Số cảnh</dt>
                    <dd className="text-sm font-semibold">{p.scene_count}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Ảnh tham chiếu</dt>
                    <dd className="text-sm font-semibold">{p.ref_count}</dd>
                  </div>
                </dl>
                {p.status === 'analyzing' && p.analysis.waiting && <p className="text-xs text-info-fg">{p.analysis.waiting}</p>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
