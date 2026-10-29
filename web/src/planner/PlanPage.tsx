import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { ErrorState, InlineError, Skeleton } from '../components/States';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { ImageLightbox } from '../components/ImageLightbox';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Button';
import { aiQueueNote } from '../lib/finalCut';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { planner } from './api';
import { FinalBlock } from './FinalBlock';
import { BriefTab, PlanWorkspace, RefsTab } from './PlanWorkspace';
import { Btn, LinkBtn } from './ws-ui';
import './workspace.css';
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
  const reason = !brief.trim() ? 'Nhập yêu cầu kịch bản' : remaining === 0 ? 'Đã hết lượt phân tích, thử lại sau' : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sửa yêu cầu và phân tích lại"
      wide
      footer={
        <>
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
        {m.isError && <InlineError>{errorMessage(m.error)}</InlineError>}
      </div>
    </Modal>
  );
}

function AnalysisNote({ detail, onReanalyze }: { detail: PlanDetail; onReanalyze: () => void }) {
  const a = detail.analysis;
  if (a.state === 'queued' || a.state === 'running') {
    const warn = a.state === 'queued' && !detail.worker.online;
    const qNote = a.state === 'queued' && a.queue ? aiQueueNote(a.queue, detail.worker.online) : null;
    const title = a.state === 'running' ? 'AI đang phân tích kịch bản và viết prompt từng cảnh' : qNote?.waiting ? qNote.title : (a.waiting ?? 'Đang xếp hàng');
    return (
      <div className={`ws-note ${warn ? 'warn' : 'info'}`} role="status">
        {warn ? <Icon name="alert" size={15} /> : <Spinner size={14} />}
        <span><strong>{title}.</strong>{warn || qNote?.warn ? ` ${qNote?.detail ?? 'Máy chủ AI chưa sẵn sàng.'}` : ''}</span>
      </div>
    );
  }
  if (a.state === 'failed') {
    return (
      <div className="ws-note danger" role="status">
        <Icon name="alert" size={15} />
        <span>{a.error ?? 'Phân tích không thành công.'}{detail.scenes.length > 0 ? ' Các cảnh bên dưới là kết quả của lần phân tích trước.' : ''}</span>
        <Btn size="sm" onClick={onReanalyze}>Phân tích lại</Btn>
      </div>
    );
  }
  return null;
}

type View = 'scenes' | 'final' | 'refs' | 'brief';

/** Chi tiết một kế hoạch: đầu trang + 4 tab Cảnh · Bản hoàn chỉnh · Ảnh tham chiếu · Yêu cầu. */
export function PlanPage({ id }: { id: number }) {
  const q = useQuery({
    queryKey: ['plan', id],
    queryFn: () => planner.getPlan(id),
    refetchInterval: (query) => (query.state.data?.plan.status === 'analyzing' || query.state.data?.final.active ? 3000 : false),
  });
  const qc = useQueryClient();
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const [reanalyze, setReanalyze] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<View>('scenes');
  useDocumentTitle(q.data?.plan.name);
  // Chi tiết kế hoạch đã kèm trạng thái worker mới nhất: đồng bộ vào chỉ báo trạng thái để không hiện số liệu cũ.
  const worker = q.data?.worker;
  useEffect(() => {
    if (worker) qc.setQueryData(['status'], (old: unknown) => (old ? { ...(old as object), worker } : old));
  }, [worker, qc]);

  const crumb = (name: string) => (
    <nav className="av-crumb" aria-label="Đường dẫn"><a href={hrefOf({ name: 'list' })}>Kế hoạch video</a><span> / {name}</span></nav>
  );

  if (q.isLoading) {
    return (
      <div className="ws-page" aria-busy="true">
        <div className="av-page-head">{crumb('…')}</div>
        <div className="ws-pad"><Skeleton className="h-24" /><Skeleton className="h-96" /></div>
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="ws-page">
        <div className="av-page-head">{crumb('Không mở được')}</div>
        <div className="ws-pad"><ErrorState title="Không mở được kế hoạch" error={q.error} onRetry={() => void q.refetch()} /></div>
      </div>
    );
  }

  const d = q.data;
  const p = d.plan;
  const analyzing = p.status === 'analyzing';
  const hasScenes = d.scenes.length > 0;
  const withVideo = d.scenes.filter((s) => s.videos.selected_id !== null).length;
  const badge = analyzing
    ? { cls: 'info', text: 'Đang phân tích' }
    : p.status === 'failed'
      ? { cls: 'danger', text: 'Lỗi phân tích' }
      : !hasScenes
        ? { cls: 'neutral', text: p.status === 'draft' ? 'Nháp' : 'Chưa có cảnh' }
        : { cls: withVideo === d.scenes.length ? 'ok' : withVideo > 0 ? 'warn' : 'neutral', text: `${withVideo}/${d.scenes.length} cảnh có video` };

  const tabs: { value: View; label: string; count?: number }[] = [
    { value: 'scenes', label: 'Cảnh', count: d.scenes.length },
    { value: 'final', label: 'Bản hoàn chỉnh' },
    { value: 'refs', label: 'Ảnh tham chiếu', count: d.refs.length },
    { value: 'brief', label: 'Yêu cầu' },
  ];
  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : null;
    if (next === null) return;
    e.preventDefault();
    setView(tabs[next].value);
    document.getElementById(`plan-tab-${tabs[next].value}`)?.focus();
  };
  const onZoom = (src: string, title: string) => setZoom({ src, title });

  return (
    <div className="ws-page">
      <header className="av-page-head">
        <div className="ws-head-main">
          {crumb(p.name)}
          <div className="ws-head-title">
            <h1>{p.name}</h1>
            <span className={`av-badge av-badge-${badge.cls}`}>{badge.text}</span>
          </div>
        </div>
        {hasScenes && <LinkBtn href={planner.planMdUrl(p.id)} download>Tải kế hoạch .md</LinkBtn>}
        {d.refs.length > 0 && <LinkBtn href={planner.refsZipUrl(p.id)} download>Ảnh tham chiếu .zip</LinkBtn>}
        <Btn size="sm" disabledReason={analyzing ? 'Đang phân tích, hãy đợi kết quả' : null} onClick={() => setReanalyze(true)}>Phân tích lại</Btn>
        {p.can_delete && <Btn size="sm" variant="ghost" icon="trash" aria-label="Xoá kế hoạch" title="Xoá kế hoạch" disabledReason={p.delete_block ?? null} onClick={() => setDeleting(true)} />}
      </header>

      <div className="av-tabs" role="tablist" aria-label="Phần của kế hoạch">
        {tabs.map((t, i) => (
          <button key={t.value} type="button" role="tab" id={`plan-tab-${t.value}`} className="av-tab" aria-selected={view === t.value} aria-controls={`plan-pane-${t.value}`} tabIndex={view === t.value ? 0 : -1} onClick={() => setView(t.value)} onKeyDown={(e) => onTabKey(e, i)}>
            {t.label}
            {t.count !== undefined && <span className="ws-tab-cnt">{t.count}</span>}
          </button>
        ))}
      </div>

      {(analyzing || p.status === 'failed' || d.analysis.state === 'failed') && (
        <div className="ws-pad" style={{ paddingBottom: 0 }}>
          <AnalysisNote detail={d} onReanalyze={() => setReanalyze(true)} />
        </div>
      )}

      <section id="plan-pane-scenes" role="tabpanel" aria-labelledby="plan-tab-scenes" className="ws-pane" hidden={view !== 'scenes'}>
        {hasScenes ? (
          <PlanWorkspace detail={d} onZoom={onZoom} onFinal={() => setView('final')} />
        ) : analyzing ? (
          <div className="ws-pad" aria-busy="true"><Skeleton className="h-80" /></div>
        ) : (
          <div className="ws-empty">
            <strong>{p.status === 'failed' ? 'Chưa có cảnh nào' : 'Kế hoạch chưa được phân tích'}</strong>
            <Btn variant="primary" icon="send" onClick={() => setReanalyze(true)}>{p.status === 'failed' ? 'Phân tích lại' : 'Gửi phân tích'}</Btn>
          </div>
        )}
      </section>
      <section id="plan-pane-final" role="tabpanel" aria-labelledby="plan-tab-final" className="ws-pane" hidden={view !== 'final'}>
        {hasScenes ? <FinalBlock detail={d} /> : <div className="ws-empty"><strong>Phân tích kịch bản và tải video từng cảnh trước khi dựng</strong></div>}
      </section>
      <section id="plan-pane-refs" role="tabpanel" aria-labelledby="plan-tab-refs" className="ws-pane" hidden={view !== 'refs'}>
        <RefsTab detail={d} onZoom={onZoom} />
      </section>
      <section id="plan-pane-brief" role="tabpanel" aria-labelledby="plan-tab-brief" className="ws-pane" hidden={view !== 'brief'}>
        <BriefTab detail={d} />
      </section>

      <ImageLightbox src={zoom?.src ?? null} title={zoom?.title ?? ''} onClose={() => setZoom(null)} />
      {reanalyze && <ReanalyzeDialog detail={d} open onClose={() => setReanalyze(false)} />}
      {deleting && <DeleteDialog detail={d} onClose={() => setDeleting(false)} />}
    </div>
  );
}
