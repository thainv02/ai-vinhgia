import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { Alert, EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { ImageLightbox } from '../components/ImageLightbox';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Button';
import { aiQueueNote } from '../lib/finalCut';
import { fmtDateTimeYear, fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { CopyButton, PlanStatusBadge, WorkspaceTabs } from './parts';
import { FinalBlock } from './FinalBlock';
import { PlanWorkspace, ProjectAssets } from './PlanWorkspace';
import type { PlanDetail } from './types';
import { hrefOf, navigate } from './useHashRoute';

function ReanalyzeDialog({ detail, open, onClose }: { detail: PlanDetail; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, enabled: open });
  const [brief, setBrief] = useState(detail.plan.brief);
  const [styleLock, setStyleLock] = useState(detail.plan.style_lock);
  const m = useMutation({
    mutationFn: () => planner.analyze(detail.plan.id, { brief: brief.trim(), style_lock: styleLock.trim() }),
    meta: { silent: true },
    onSuccess: () => {
      toast.success('Đã gửi phân tích lại');
      void qc.invalidateQueries({ queryKey: ['plan', detail.plan.id] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['status'] });
      onClose();
    },
  });
  const remaining = status.data?.analyze_remaining;
  const reason = !brief.trim() ? 'Nhập yêu cầu kịch bản' : remaining === 0 ? 'Bạn đã hết lượt phân tích trong giờ này' : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sửa yêu cầu và phân tích lại"
      wide
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {remaining !== undefined && status.data ? `Còn ${remaining}/${status.data.rate.analyze.max} lượt phân tích trong giờ này.` : ''}
          </span>
          <Button onClick={onClose} disabled={m.isPending}>
            Hủy
          </Button>
          <Button variant="primary" loading={m.isPending} disabledReason={reason} icon={<Icon name="refresh" />} onClick={() => m.mutate()}>
            Phân tích lại
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label htmlFor="re-brief" className="mb-1 block text-[13px] font-semibold">
            Yêu cầu kịch bản
          </label>
          <textarea id="re-brief" rows={8} value={brief} onChange={(e) => setBrief(e.target.value)} disabled={m.isPending} />
        </div>
        <div>
          <label htmlFor="re-style" className="mb-1 block text-[13px] font-semibold">
            Khóa nhất quán
          </label>
          <textarea id="re-style" rows={3} value={styleLock} onChange={(e) => setStyleLock(e.target.value)} disabled={m.isPending} />
        </div>
        <p className="text-xs text-muted">
          Các cảnh được thay bằng kết quả mới. Storyboard bạn đã tải lên của cảnh còn lại được giữ (có cảnh báo nếu prompt của cảnh đó đổi); cảnh đã có video tải lên luôn được giữ. Ảnh tham chiếu giữ nguyên. Mỗi lần phân tích lại tính vào giới hạn lượt trong giờ.
        </p>
        {m.isError && <InlineError>{errorMessage(m.error)}</InlineError>}
      </div>
    </Modal>
  );
}

function DeleteDialog({ detail, onClose }: { detail: PlanDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => planner.deletePlan(detail.plan.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`Đã xoá kế hoạch "${detail.plan.name}"`);
      qc.removeQueries({ queryKey: ['plan', detail.plan.id] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
      navigate({ name: 'list' });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Xoá kế hoạch?"
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            Giữ lại
          </Button>
          <Button variant="danger" icon={<Icon name="trash" size={15} />} loading={m.isPending} onClick={() => m.mutate()}>
            Xoá kế hoạch
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          Kế hoạch <strong>{detail.plan.name}</strong>, các video bạn đã tải lên và bản hoàn chỉnh sẽ <strong>biến mất khỏi trang này</strong>.
        </p>
        <p className="text-muted">Chủ máy vẫn khôi phục được trong 30 ngày; sau đó kế hoạch bị xoá vĩnh viễn. Bạn không tự khôi phục được từ trang này.</p>
        {m.isError && <InlineError>{errorMessage(m.error)}</InlineError>}
      </div>
    </Modal>
  );
}

function AnalysisBanner({ detail, onReanalyze }: { detail: PlanDetail; onReanalyze: () => void }) {
  const a = detail.analysis;
  const now = useNow();
  if (a.state === 'queued' || a.state === 'running') {
    const text = a.state === 'running' ? 'AI đang phân tích kịch bản và viết prompt từng cảnh. Thường mất 1–3 phút.' : (a.waiting ?? 'Yêu cầu đang xếp hàng.');
    const warn = a.state === 'queued' && !detail.worker.online;
    // vị trí trong hàng đợi của máy chủ AI (một worker, tuần tự)
    const q = a.state === 'queued' ? a.queue : null;
    const qNote = q ? aiQueueNote(q, detail.worker.online) : null;
    return (
      <Alert tone={warn ? 'warn' : 'info'} icon={warn ? 'alert' : 'clock'}>
        <span className="flex items-start gap-2">
          {!warn && <Spinner size={14} />}
          <span>
            <strong>{a.state === 'running' ? 'Đang phân tích' : qNote?.waiting ? qNote.title : 'Đang xếp hàng'}.</strong> {qNote?.waiting ? (qNote.detail ?? text) : text}
            <span className="mt-0.5 block text-xs opacity-80">Trang tự cập nhật, bạn có thể rời đi và quay lại sau. Gửi lúc {fmtRelative(a.created_at, now)}.</span>
          </span>
        </span>
      </Alert>
    );
  }
  if (a.state === 'failed') {
    return (
      <Alert tone="danger" icon="alert" actions={<Button size="sm" onClick={onReanalyze}>Phân tích lại</Button>}>
        {a.error ?? 'Phân tích không thành công.'}
        {detail.scenes.length > 0 && <span className="block text-xs opacity-80">Các cảnh bên dưới là kết quả của lần phân tích trước.</span>}
      </Alert>
    );
  }
  return null;
}

/** Kết quả một kế hoạch: khóa nhất quán, ảnh tham chiếu và từng cảnh với Bước 1 (ChatGPT) / Bước 2 (Flow). */
export function PlanPage({ id }: { id: number }) {
  const now = useNow();
  const q = useQuery({
    queryKey: ['plan', id],
    queryFn: () => planner.getPlan(id),
    refetchInterval: (query) => (query.state.data?.plan.status === 'analyzing' || query.state.data?.final.active ? 3000 : false),
  });
  const qc = useQueryClient();
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const [reanalyze, setReanalyze] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState('workspace');
  useDocumentTitle(q.data?.plan.name);
  // Chi tiết kế hoạch đã kèm trạng thái worker mới nhất: đồng bộ vào chỉ báo ở header để không hiện số liệu cũ.
  const worker = q.data?.worker;
  useEffect(() => {
    if (worker) qc.setQueryData(['status'], (old: unknown) => (old ? { ...(old as object), worker } : old));
  }, [worker, qc]);

  const back = (
    <a href={hrefOf({ name: 'list' })} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
      <Icon name="arrowLeft" size={14} /> Danh sách kế hoạch
    </a>
  );

  if (q.isLoading) {
    return (
      <div aria-busy="true">
        {back}
        <Skeleton className="mb-3 h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div>
        {back}
        <ErrorState title="Không mở được kế hoạch" error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const d = q.data;
  const p = d.plan;
  const analyzing = p.status === 'analyzing';
  const hasScenes = d.scenes.length > 0;

  const uploaded = d.scenes.filter((s) => s.videos.selected_id !== null).length;
  const storyboards = d.scenes.filter((s) => !!s.storyboard).length;
  const finalReady = d.final.latest?.status === 'ready';
  const tabs = [
    { value: 'workspace', label: 'Cảnh & prompt', icon: 'film' as const, meta: String(d.scenes.length) },
    { value: 'final', label: 'Bản hoàn chỉnh', icon: 'play' as const, meta: d.final.active ? 'Đang dựng' : finalReady ? 'Sẵn sàng' : undefined },
    { value: 'assets', label: 'Tài liệu dự án', icon: 'image' as const, meta: String(d.refs.length) },
  ];

  return (
    <div className="plan-page">
      {back}
      <section className="plan-overview" aria-label="Tổng quan kế hoạch">
        <div className="plan-heading-row">
          <div className="min-w-0">
            <div className="plan-eyebrow">KHÔNG GIAN DỰ ÁN <span>/</span> KẾ HOẠCH #{p.id}</div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="plan-title">{p.name}</h1>
              <PlanStatusBadge status={p.status} />
            </div>
            <p className="plan-metadata">
              <span className="creator-avatar" aria-hidden="true">{(p.created_by_name || '?').slice(0, 1)}</span>
              <strong>{p.created_by_name || 'Chưa rõ người tạo'}</strong>
              <span aria-hidden="true">·</span>
              <time dateTime={p.created_at} title={fmtDateTimeYear(p.created_at)}>Tạo {fmtRelative(p.created_at, now)}</time>
            </p>
          </div>
          <div className="plan-actions">
            {hasScenes && <CopyButton text={d.markdown} label="Sao chép kế hoạch" size="md" />}
            <Button icon={<Icon name="edit" size={15} />} disabledReason={analyzing ? 'Đang phân tích, hãy đợi kết quả' : null} onClick={() => setReanalyze(true)}>Sửa yêu cầu</Button>
            {p.can_delete && <Button variant="danger" icon={<Icon name="trash" size={15} />} disabledReason={p.delete_block ?? null} onClick={() => setDeleting(true)}>Xoá kế hoạch</Button>}
            {hasScenes && <Button variant="primary" icon={<Icon name={finalReady ? 'play' : 'film'} size={15} />} onClick={() => setView('final')}>
              {d.final.active ? 'Xem tiến trình dựng' : finalReady ? 'Xem bản hoàn chỉnh' : 'Dựng bản hoàn chỉnh'}
            </Button>}
          </div>
        </div>

        <div className="plan-stat-row">
          <div className="plan-stat"><span className="stat-icon"><Icon name="film" size={18} /></span><div><strong>{d.scenes.length} <span>cảnh</span></strong><small>Kịch bản đã phân cảnh</small></div></div>
          <div className="plan-stat"><span className="stat-icon"><Icon name="image" size={18} /></span><div><strong>{storyboards}<span> / {d.scenes.length}</span></strong><small>Storyboard đã tải lên</small></div></div>
          <div className="plan-stat"><span className={`stat-icon ${hasScenes && uploaded === d.scenes.length ? 'is-complete' : ''}`}><Icon name="check" size={18} /></span><div><strong>{uploaded}<span> / {d.scenes.length}</span></strong><small>Cảnh đã chọn video</small></div></div>
          <div className="plan-stat plan-format"><span className="stat-icon"><Icon name="gear" size={18} /></span><div><strong>{d.settings.aspect} <span>· {d.settings.resolution}</span></strong><small>{d.settings.duration_s} giây / clip · x{d.settings.count}</small></div></div>
        </div>
      </section>

      <div className="space-y-3">
        <AnalysisBanner detail={d} onReanalyze={() => setReanalyze(true)} />
        {!d.worker.online && analyzing && d.analysis.state === 'running' && <Alert tone="warn">Máy chủ AI chưa sẵn sàng. Nếu phân tích không tiến triển, báo chủ máy.</Alert>}
      </div>

      <div className="plan-view-bar">
        <WorkspaceTabs id="plan-view" label="Nội dung kế hoạch" items={tabs} value={view} onChange={setView} />
        {hasScenes && <a href={planner.planMdUrl(p.id)} download className="plan-export"><Icon name="download" size={14} /> Xuất kế hoạch</a>}
      </div>

      <section id="plan-view-panel-workspace" role="tabpanel" aria-labelledby="plan-view-tab-workspace" hidden={view !== 'workspace'} tabIndex={0}>
        {hasScenes ? <PlanWorkspace detail={d} onZoom={(src, title) => setZoom({ src, title })} onFinal={() => setView('final')} /> : analyzing ? (
          <div className="grid gap-4 lg:grid-cols-[260px_1fr]" aria-busy="true"><Skeleton className="h-80" /><Skeleton className="h-96" /></div>
        ) : <EmptyState icon="film" title={p.status === 'failed' ? 'Chưa có cảnh nào' : 'Kế hoạch chưa được phân tích'} action={<Button variant="primary" icon={<Icon name="send" />} onClick={() => setReanalyze(true)}>{p.status === 'failed' ? 'Phân tích lại' : 'Gửi phân tích'}</Button>}>Gửi yêu cầu cho AI để chia cảnh và viết prompt.</EmptyState>}
      </section>
      <section id="plan-view-panel-final" role="tabpanel" aria-labelledby="plan-view-tab-final" hidden={view !== 'final'} tabIndex={0}>
        {hasScenes ? <FinalBlock detail={d} /> : <EmptyState icon="film" title="Bắt đầu từ kịch bản">Phân tích yêu cầu và tải video từng cảnh trước khi dựng bản hoàn chỉnh.</EmptyState>}
      </section>
      <section id="plan-view-panel-assets" role="tabpanel" aria-labelledby="plan-view-tab-assets" hidden={view !== 'assets'} tabIndex={0}>
        <ProjectAssets detail={d} onZoom={(src, title) => setZoom({ src, title })} />
      </section>

      <ImageLightbox src={zoom?.src ?? null} title={zoom?.title ?? ''} onClose={() => setZoom(null)} />
      {reanalyze && <ReanalyzeDialog detail={d} open onClose={() => setReanalyze(false)} />}
      {deleting && <DeleteDialog detail={d} onClose={() => setDeleting(false)} />}
    </div>
  );
}
