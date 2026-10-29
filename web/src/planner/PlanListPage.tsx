import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { PlanStatusBadge } from './parts';
import type { PlanSummary } from './types';
import { hrefOf, navigate } from './useHashRoute';

type Filter = 'all' | 'analyzing' | 'ready' | 'draft';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'analyzing', label: 'Đang phân tích' },
  { value: 'ready', label: 'Đã phân tích' },
  { value: 'draft', label: 'Bản nháp' },
];
// Lỗi phân tích xếp chung với bản nháp: cần làm lại từ đầu.
const bucket = (p: PlanSummary): Filter => (p.status === 'analyzing' ? 'analyzing' : p.status === 'ready' ? 'ready' : 'draft');

/** Danh sách kế hoạch video: tìm, lọc theo trạng thái, mở / xoá. */
export function PlanListPage() {
  useDocumentTitle('Kế hoạch video');
  const now = useNow();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['plans', 'all'],
    queryFn: planner.listPlans,
    refetchInterval: (query) => (query.state.data?.some((p) => p.status === 'analyzing') ? 3000 : 15_000),
  });
  const del = useMutation({
    mutationFn: (id: number) => planner.deletePlan(id),
    onSuccess: () => {
      toast.success('Đã xoá kế hoạch');
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const plans = useMemo(() => (q.data ?? []).filter((p) => p.kind !== 'clips'), [q.data]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: plans.length, analyzing: 0, ready: 0, draft: 0 };
    for (const p of plans) c[bucket(p)]++;
    return c;
  }, [plans]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return plans
      .filter((p) => (filter === 'all' || bucket(p) === filter) && (!s || p.name.toLowerCase().includes(s)))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }, [plans, filter, search]);

  return (
    <>
      <header className="av-header">
        <h1 className="flex-1">Kế hoạch video</h1>
        <label className="av-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input className="av-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm kế hoạch…" aria-label="Tìm kế hoạch" />
        </label>
        <button type="button" className="av-btn av-btn-primary" onClick={() => navigate({ name: 'new' })}>
          <Icon name="plus" size={15} /> Tạo kế hoạch
        </button>
      </header>

      <section className="av-page">
        {q.isLoading ? (
          <Skeleton className="h-48" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : plans.length === 0 ? (
          <EmptyState
            icon="film"
            title="Chưa có kế hoạch nào"
            action={
              <button type="button" className="av-btn av-btn-primary" onClick={() => navigate({ name: 'new' })}>
                <Icon name="plus" size={15} /> Tạo kế hoạch
              </button>
            }
          />
        ) : (
          <>
            <div className="av-seg" role="group" aria-label="Lọc theo trạng thái" style={{ alignSelf: 'flex-start' }}>
              {FILTERS.map((f) => (
                <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                  {f.label} · {counts[f.value]}
                </button>
              ))}
            </div>
            <div className="av-card av-table-wrap">
              <table className="av-table">
                <thead>
                  <tr>
                    <th>Kế hoạch</th>
                    <th>Số cảnh</th>
                    <th>Ảnh tham chiếu</th>
                    <th>Trạng thái</th>
                    <th>Cập nhật</th>
                    <th>
                      <span className="av-sr">Thao tác</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="av-muted">
                        Không có kế hoạch phù hợp.
                      </td>
                    </tr>
                  ) : (
                    rows.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <a href={hrefOf({ name: 'plan', id: p.id })} className="av-link-strong">
                            {p.name}
                          </a>
                          {p.status === 'analyzing' && p.analysis.waiting && <div className="av-muted" style={{ fontSize: 12, marginTop: 3 }}>{p.analysis.waiting}</div>}
                        </td>
                        <td>{p.scene_count || <span className="av-muted">—</span>}</td>
                        <td>{p.ref_count}</td>
                        <td>
                          <PlanStatusBadge status={p.status} />
                        </td>
                        <td className="av-muted" style={{ fontSize: 12.5 }}>
                          {fmtRelative(p.updated_at, now)}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {p.can_delete && (
                            <button
                              type="button"
                              className="av-btn av-btn-sm av-btn-ghost"
                              aria-label={`Xoá kế hoạch ${p.name}`}
                              title={p.delete_block ?? 'Xoá kế hoạch'}
                              disabled={!!p.delete_block || del.isPending}
                              onClick={() => {
                                if (window.confirm(`Xoá kế hoạch "${p.name}"?`)) del.mutate(p.id);
                              }}
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          )}{' '}
                          <a className="av-btn av-btn-sm" href={hrefOf({ name: 'plan', id: p.id })}>
                            Mở
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}
