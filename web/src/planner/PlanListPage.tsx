import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { PlanStatusBadge } from './parts';
import { DeleteProjectDialog, RowMenu } from './RowMenu';
import type { PlanSummary } from './types';
import { hrefOf, navigate } from './useHashRoute';
import './plan-design.css';

type Filter = 'all' | 'analyzing' | 'ready' | 'draft';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'analyzing', label: 'Đang phân tích' },
  { value: 'ready', label: 'Đã phân tích' },
  { value: 'draft', label: 'Bản nháp' },
];
// Lỗi phân tích xếp chung với bản nháp: cần làm lại từ đầu.
const bucket = (p: PlanSummary): Filter => (p.status === 'analyzing' ? 'analyzing' : p.status === 'ready' ? 'ready' : 'draft');

type Sort = 'updated' | 'created' | 'name';
const SORTS: { value: Sort; label: string }[] = [
  { value: 'updated', label: 'Cập nhật mới nhất' },
  { value: 'created', label: 'Tạo mới nhất' },
  { value: 'name', label: 'Tên A–Z' },
];
const COMPARE: Record<Sort, (a: PlanSummary, b: PlanSummary) => number> = {
  updated: (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  created: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  name: (a, b) => a.name.localeCompare(b.name, 'vi'),
};

/** Dòng phụ dưới tên kế hoạch: đang ở bước nào, cần làm gì tiếp. */
function progressLine(p: PlanSummary): string {
  if (p.status === 'analyzing') return p.analysis.waiting ?? 'AI đang phân tích yêu cầu';
  if (p.status === 'failed') return `Phân tích lỗi${p.analysis.error ? ` · ${p.analysis.error}` : ''}`;
  if (p.scene_count === 0) return 'Chưa gửi phân tích';
  if (p.video_scene_count === undefined) return `${p.scene_count} cảnh`;
  return p.video_scene_count >= p.scene_count ? `${p.scene_count}/${p.scene_count} cảnh có video · sẵn sàng dựng bản hoàn chỉnh` : `${p.video_scene_count}/${p.scene_count} cảnh đã có video`;
}

/** Danh sách kế hoạch video: tìm, lọc theo trạng thái, mở / xoá. */
export function PlanListPage() {
  useDocumentTitle('Kế hoạch video');
  const now = useNow();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const q = useQuery({
    queryKey: ['plans', 'all'],
    queryFn: planner.listPlans,
    refetchInterval: (query) => (query.state.data?.some((p) => p.status === 'analyzing') ? 3000 : 15_000),
  });
  const [deleting, setDeleting] = useState<PlanSummary | null>(null);

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
      .sort(COMPARE[sort]);
  }, [plans, filter, search, sort]);

  return (
    <>
      <header className="av-header">
        <div className="flex-1"><h1>Kế hoạch video</h1><p className="av-page-intro">Mỗi kế hoạch gồm yêu cầu, ảnh tham chiếu và các cảnh. Bạn tạo ảnh ở ChatGPT, video ở Google Flow; app chuẩn bị nội dung và dựng hậu kỳ.</p></div>
        <button type="button" className="av-btn av-btn-primary" onClick={() => navigate({ name: 'new' })}>
          <Icon name="plus" size={15} /> Tạo kế hoạch
        </button>
      </header>

      <section className="av-page plan-list-page">
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
            <div className="plan-list-top"><h2>Kế hoạch gần đây</h2><label className="av-search"><input className="av-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm kế hoạch…" aria-label="Tìm kế hoạch" /></label>
            <div className="av-seg" role="group" aria-label="Lọc theo trạng thái" style={{ alignSelf: 'flex-start' }}>
              {FILTERS.map((f) => (
                <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                  {f.label} · {counts[f.value]}
                </button>
              ))}
            </div>
            <label className="plan-sort">
              <span className="av-muted">Sắp theo</span>
              <select className="av-input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
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
                          <div className={p.status === 'failed' ? 'plan-row-sub plan-row-sub-bad' : 'plan-row-sub'}>{progressLine(p)}</div>
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
                          <a className="av-btn av-btn-sm" href={hrefOf({ name: 'plan', id: p.id })}>
                            Mở
                          </a>{' '}
                          {p.can_delete && (
                            <RowMenu
                              label={`Thao tác với kế hoạch ${p.name}`}
                              items={[{ label: 'Xoá vĩnh viễn…', danger: true, disabledReason: p.delete_block, onSelect: () => setDeleting(p) }]}
                            />
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="plan-list-note">Xoá kế hoạch trên máy này là xoá vĩnh viễn, không có thùng rác. Kế hoạch lỗi phân tích nằm trong nhóm Bản nháp và giữ nhãn lỗi.</p>
          </>
        )}
      </section>
      <DeleteProjectDialog
        target={deleting}
        what="kế hoạch"
        onDelete={planner.deletePlan}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          setDeleting(null);
          toast.success(`Đã xoá kế hoạch "${name}"`);
          void qc.invalidateQueries({ queryKey: ['plans'] });
        }}
      />
    </>
  );
}
