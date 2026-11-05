import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { fmtRelative } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { PlanStatusBadge } from './parts';
import { LAN_NAME_KEY, readLanName } from './preferences';
import { hrefOf, navigate } from './useHashRoute';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLocaleLowerCase('vi').trim();

export function PlanListPage() {
  useDocumentTitle('Kế hoạch prompt');
  const now = useNow();
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState(false);
  const [name, setName] = useState(readLanName);
  useEffect(() => { const update = (e: StorageEvent) => { if (e.key === LAN_NAME_KEY) setName(readLanName()); }; window.addEventListener('storage', update); return () => window.removeEventListener('storage', update); }, []);
  const q = useQuery({ queryKey: ['plans'], queryFn: () => planner.listPlans().then((l) => l.filter((p) => p.kind !== 'clips')), refetchInterval: (r) => r.state.data?.some((p) => p.status === 'analyzing') ? 3000 : 15000 });
  const rows = q.data?.filter((p) => (!mine || (!!name.trim() && fold(p.created_by_name ?? '') === fold(name))) && (!query.trim() || fold(`${p.name} ${p.created_by_name ?? ''}`).includes(fold(query)))) ?? [];
  const create = <Button variant="primary" icon={<Icon name="plus" />} onClick={() => navigate({ name: 'new' })}>Tạo kế hoạch mới</Button>;
  return <div>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-bold tracking-tight">Kế hoạch prompt</h1><p className="text-[13px] text-muted">Theo dõi storyboard, video và bước tiếp theo của từng kế hoạch.</p></div>{create}</div>
    {!!q.data?.length && <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="flex gap-1 rounded-lg border border-line bg-surface p-1" aria-label="Lọc người tạo"><Button size="sm" variant={!mine ? 'primary' : 'ghost'} aria-pressed={!mine} onClick={() => setMine(false)}>Tất cả ({q.data.length})</Button><Button size="sm" variant={mine ? 'primary' : 'ghost'} aria-pressed={mine} disabledReason={!name.trim() ? 'Nhập tên của bạn khi tạo kế hoạch để dùng bộ lọc này' : null} title={`Theo tên đã lưu: ${name}`} onClick={() => setMine(true)}>Của tôi{name ? ` · ${name}` : ''}</Button></div>
      {(q.data.length >= 6 || query) && <input className="ml-auto w-full max-w-xs" type="search" aria-label="Tìm kế hoạch" placeholder="Tìm tên kế hoạch hoặc người tạo…" value={query} onChange={(e) => setQuery(e.target.value)} />}
      <span className="text-xs text-muted">{rows.length} kế hoạch</span>
    </div>}
    {q.isLoading ? <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((n) => <Skeleton key={n} className="h-24" />)}</div> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? <EmptyState icon="film" title="Chưa có kế hoạch nào" action={create}>Nhập yêu cầu kịch bản và ảnh sản phẩm để bắt đầu.</EmptyState> : !rows.length ? <EmptyState icon="film" title="Không có kế hoạch phù hợp" action={<Button onClick={() => { setMine(false); setQuery(''); }}>Xem tất cả</Button>}>Thử đổi tên tìm kiếm hoặc bộ lọc người tạo.</EmptyState> : <ul className="space-y-2" aria-label="Danh sách kế hoạch">{rows.map((p) => <li key={p.id}>
      <a href={hrefOf({ name: 'plan', id: p.id })} className="group grid items-center gap-4 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-surface-2 md:grid-cols-[64px_minmax(160px,1fr)_230px_minmax(190px,250px)]">
        <div className="hidden size-16 overflow-hidden rounded-md border border-line bg-surface-2 md:grid md:place-items-center">{p.thumbnail_url ? <img src={p.thumbnail_url} alt="" loading="lazy" className="size-full object-cover" /> : <Icon name="image" size={24} className="text-muted" />}</div>
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-semibold group-hover:underline">{p.name}</h2>{p.status !== 'ready' && <PlanStatusBadge status={p.status} />}</div><p className="mt-1 text-xs text-muted">{p.created_by_name || 'Chưa rõ người tạo'} · {fmtRelative(p.created_at, now)} · {p.scene_count} cảnh</p></div>
        <div className="space-y-1 text-xs"><p>Storyboard <strong>{p.progress?.storyboards ?? 0}/{p.scene_count}</strong><span className="mx-2 text-muted">·</span>Video <strong>{p.progress?.videos ?? 0}/{p.scene_count}</strong></p>{p.progress?.final_status === 'ready' && p.progress.final_current ? <Badge tone="ok">Đã có bản hoàn chỉnh</Badge> : p.progress?.final_status === 'ready' ? <span className="text-warn-fg">Bản hoàn chỉnh cần dựng lại</span> : <span className="text-muted">{p.analysis.waiting ?? `${p.ref_count} ảnh tham chiếu`}</span>}</div>
        <div className="flex items-center justify-between gap-2 text-[13px] font-medium"><span>{p.status === 'analyzing' ? 'Đang phân tích…' : p.next_action?.label ?? 'Mở kế hoạch'}</span><Icon name="chevronRight" size={16} className="shrink-0 text-muted" /></div>
      </a>
    </li>)}</ul>}
  </div>;
}
