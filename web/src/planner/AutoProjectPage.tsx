import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import type { VideoGenerator } from '../api/types';
import { GeneratorOptions, generatorBlockReason, useGeneratorChoice } from '../components/GeneratorPicker';
import { Icon } from '../components/Icon';
import { ImageLightbox } from '../components/ImageLightbox';
import { ConfirmDialog } from '../components/Modal';
import { Alert, EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { fmtDateTimeYear, fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { AutoSceneCard } from './AutoSceneCard';
import { FinalBlock } from './FinalBlock';
import { PlanStatusBadge, WorkspaceTabs } from './parts';
import { AnalysisBanner, DeleteDialog, ReanalyzeDialog } from './PlanPage';
import { ProjectAssets } from './PlanWorkspace';
import type { AutoDetail, AutoMediaStatus } from './types';
import { hrefOf } from './useHashRoute';

/** Thông báo về máy tạo ảnh/video của chủ máy: tắt, tạm dừng, chưa chạy. `null` khi mọi thứ sẵn sàng. */
export function MediaBanner({ media }: { media: AutoMediaStatus | undefined }) {
  if (!media) return null;
  if (!media.enabled) return <Alert tone="warn">Chủ máy đang tắt tạo ảnh/video tự động cho trang LAN. Bạn vẫn xem được dự án và dựng bản hoàn chỉnh từ video đã có.</Alert>;
  if (media.paused) return <Alert tone="warn"><strong>Hàng đợi tạo ảnh/video đang tạm dừng.</strong> {media.pause_text}</Alert>;
  if (!media.online) return <Alert tone="warn"><strong>Máy tạo ảnh/video chưa chạy.</strong> Việc bạn gửi vẫn xếp hàng và sẽ chạy khi chủ máy bật lại; nếu chờ lâu, báo chủ máy.</Alert>;
  return null;
}

/** Tạo storyboard hoặc video cho mọi cảnh đủ điều kiện, có hộp xác nhận (video tốn credit của chủ máy). */
function BulkActions({ d, gen, sbLabel }: { d: AutoDetail; gen: VideoGenerator | undefined; sbLabel: string }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 10_000 });
  const [confirm, setConfirm] = useState<'storyboard' | 'video' | null>(null);
  const sbScenes = d.scenes.filter((s) => s.status === 'awaiting_approval' && !s.blocks.storyboard);
  const vScenes = d.scenes.filter((s) => s.status === 'storyboard_review' && !s.blocks.video);
  const vTooMany = gen ? vScenes.filter((s) => generatorBlockReason(gen, s.image_count)) : [];
  const m = useMutation({
    mutationFn: (stage: 'storyboard' | 'video') => planner.autoApproveAll(d.project.id, stage, stage === 'video' ? gen?.id : undefined),
    meta: { silent: true },
    onSuccess: (r) => {
      toast.success(`Đã gửi tạo ${r.stage === 'video' ? 'video' : 'storyboard'} cho ${r.count} cảnh`);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['auto', d.project.id] });
      void qc.invalidateQueries({ queryKey: ['status'] });
    },
  });
  const left = status.data?.remaining;
  const off = !d.media.enabled ? 'Chủ máy đang tắt tạo ảnh/video tự động' : null;
  const sbLeft = left?.auto_storyboard;
  const vLeft = left?.auto_video;
  const sbReason = off ?? (sbScenes.length === 0 ? 'Không có cảnh nào đang chờ tạo storyboard' : sbLeft !== undefined && sbLeft < sbScenes.length ? `Bạn chỉ còn ${sbLeft} lượt storyboard trong giờ này` : null);
  const vReason =
    off ??
    (vScenes.length === 0
      ? 'Không có cảnh nào đã có storyboard mà chưa tạo video'
      : vTooMany.length
        ? `${vTooMany.map((s) => s.code).join(', ')} cần gửi nhiều ảnh hơn ${gen!.label} nhận; chọn dịch vụ khác hoặc tạo từng cảnh`
        : vLeft !== undefined && vLeft < vScenes.length
          ? `Bạn chỉ còn ${vLeft} lượt video trong giờ này`
          : null);
  const credits = gen?.flow_credits ? gen.flow_credits * vScenes.length : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button icon={<Icon name="image" size={15} />} disabledReason={sbReason} onClick={() => setConfirm('storyboard')}>
        Tạo storyboard {sbScenes.length > 0 ? `(${sbScenes.length} cảnh)` : ''}
      </Button>
      <Button variant="primary" icon={<Icon name="film" size={15} />} disabledReason={vReason} onClick={() => setConfirm('video')}>
        Tạo video {vScenes.length > 0 ? `(${vScenes.length} cảnh)` : ''}
      </Button>
      {left && (
        <span className="text-xs text-muted">
          Còn {sbLeft ?? '?'} lượt storyboard, {vLeft ?? '?'} lượt video trong giờ này
        </span>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'video' ? `Tạo video cho ${vScenes.length} cảnh?` : `Tạo storyboard cho ${sbScenes.length} cảnh?`}
        confirmLabel={confirm === 'video' ? 'Tạo video' : 'Tạo storyboard'}
        pending={m.isPending}
        error={m.isError ? errorMessage(m.error) : undefined}
        onConfirm={() => confirm && m.mutate(confirm)}
        onClose={() => {
          setConfirm(null);
          m.reset();
        }}
      >
        <div className="space-y-2 text-sm">
          <p>
            Cảnh: <strong>{(confirm === 'video' ? vScenes : sbScenes).map((s) => s.code).join(', ')}</strong>.
          </p>
          {confirm === 'video' ? (
            <p>
              Dịch vụ: <strong>{gen?.label}</strong>
              {credits ? ` · khoảng ${credits} credit Google Flow của chủ máy` : ''}. Mỗi cảnh dùng 1 trong {d.project.max_attempts_per_scene} lượt video.
            </p>
          ) : (
            <p>
              Dịch vụ: <strong>{sbLabel}</strong>.
            </p>
          )}
          <p className="text-muted">Việc xếp hàng sau việc của chủ máy, mỗi lần một việc. Trang tự cập nhật khi xong.</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

/**
 * MỘT lựa chọn dịch vụ cho cả dự án: chọn Muse thì storyboard và video đều tạo bằng Muse; chọn một model Google Flow thì storyboard tạo bằng
 * ảnh Google Flow và video bằng model đó. Hãng lưu theo dự án (dịch vụ storyboard), model Flow nhớ trên trình duyệt này.
 */
function ServicePicker({ d, list, gen, sbLabel, setGenerator }: { d: AutoDetail; list: VideoGenerator[]; gen: VideoGenerator | undefined; sbLabel: string; setGenerator: (id: string) => void }) {
  const qc = useQueryClient();
  const gens = useQuery({ queryKey: ['auto-generators'], queryFn: planner.autoGenerators, staleTime: Infinity });
  const m = useMutation({
    mutationFn: (id: string) => planner.setAutoStoryboardGenerator(d.project.id, id),
    meta: { silent: true },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auto', d.project.id] }),
  });
  if (!gens.data) return gens.isError ? <InlineError>{errorMessage(gens.error)}</InlineError> : <Skeleton className="h-28" />;
  const busy = d.scenes.some((s) => s.job);
  const pick = (id: string) => {
    const g = list.find((x) => x.id === id);
    if (!g) return;
    setGenerator(id);
    const sb = gens.data.storyboard.find((x) => x.provider === g.provider);
    if (sb && sb.id !== d.project.storyboard_generator) m.mutate(sb.id);
  };
  return (
    <div className="space-y-2">
      <GeneratorOptions list={list} value={gen?.id ?? ''} onChange={pick} name="auto-service" legend="Dịch vụ tạo storyboard và video" disabled={m.isPending || busy} />
      <p className="text-xs text-muted">
        Storyboard tạo bằng <strong>{sbLabel}</strong>, video bằng <strong>{gen?.label ?? '…'}</strong>.
        {busy && ' Đổi dịch vụ khi không còn việc đang chờ/chạy.'}
      </p>
      {m.isError && <InlineError>{errorMessage(m.error)}</InlineError>}
    </div>
  );
}

/** Một dự án Autovideo: phân tích → storyboard → video → chọn video → bản hoàn chỉnh, mọi bước tạo ảnh/video do máy chủ làm. */
export function AutoProjectPage({ id }: { id: number }) {
  const now = useNow();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['auto', id],
    queryFn: () => planner.getAuto(id),
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.project.status === 'analyzing' || d.final.active || d.scenes.some((s) => s.job)) ? 4000 : 20_000;
    },
  });
  const gens = useQuery({ queryKey: ['auto-generators'], queryFn: planner.autoGenerators, staleTime: Infinity });
  const [generator, setGenerator] = useGeneratorChoice();
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const [reanalyze, setReanalyze] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState('scenes');
  useDocumentTitle(q.data?.project.name);
  const worker = q.data?.worker;
  useEffect(() => {
    if (worker) qc.setQueryData(['status'], (old: unknown) => (old ? { ...(old as object), worker } : old));
  }, [worker, qc]);

  const back = (
    <a href={hrefOf({ name: 'auto' })} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
      <Icon name="arrowLeft" size={14} /> Danh sách Autovideo
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
        <ErrorState title="Không mở được dự án" error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const d = q.data;
  const p = d.project;
  const analyzing = p.status === 'analyzing';
  const hasScenes = d.scenes.length > 0;
  const all = gens.data?.generators ?? [];
  const sbGen = gens.data?.storyboard.find((g) => g.id === p.storyboard_generator);
  // chỉ các model cùng hãng với dịch vụ storyboard của dự án (Muse hoặc Google Flow)
  const list = sbGen ? all.filter((g) => g.provider === sbGen.provider) : [];
  const gen = list.find((g) => g.id === generator) ?? list[0];
  const sbLabel = sbGen?.label ?? p.storyboard_generator;
  const selected = d.scenes.filter((s) => s.selected_video_id !== null).length;
  const finalReady = d.final.latest?.status === 'ready';
  // FinalBlock/ProjectAssets/hộp thoại dùng chung với kế hoạch prompt: chúng chỉ đọc id, tên, yêu cầu kịch bản của dự án
  const asPlan = { ...d, plan: { id: p.id, name: p.name, brief: p.brief, style_lock: p.style_lock } };
  const tabs = [
    { value: 'scenes', label: 'Cảnh', icon: 'film' as const, meta: hasScenes ? `${selected}/${d.scenes.length} video` : undefined },
    { value: 'final', label: 'Bản hoàn chỉnh', icon: 'play' as const, meta: d.final.active ? 'Đang dựng' : finalReady ? 'Sẵn sàng' : undefined },
    { value: 'assets', label: 'Tài liệu dự án', icon: 'image' as const, meta: String(d.refs.length) },
  ];

  return (
    <div className="plan-page">
      {back}
      <section className="plan-overview" aria-label="Tổng quan dự án">
        <div className="plan-heading-row">
          <div className="min-w-0">
            <div className="plan-eyebrow">
              AUTOVIDEO <span>/</span> DỰ ÁN #{p.id}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="plan-title">{p.name}</h1>
              <PlanStatusBadge status={p.status} />
            </div>
            <p className="plan-metadata">
              <span className="creator-avatar" aria-hidden="true">
                {(p.created_by_name || '?').slice(0, 1)}
              </span>
              <strong>{p.created_by_name || 'Chưa rõ người tạo'}</strong>
              <span aria-hidden="true">·</span>
              <time dateTime={p.created_at} title={fmtDateTimeYear(p.created_at)}>
                Tạo {fmtRelative(p.created_at, now)}
              </time>
            </p>
          </div>
          <div className="plan-actions">
            <Button icon={<Icon name="edit" size={15} />} disabledReason={analyzing ? 'Đang phân tích, hãy đợi kết quả' : null} onClick={() => setReanalyze(true)}>
              Sửa yêu cầu
            </Button>
            {p.can_delete && (
              <Button variant="danger" icon={<Icon name="trash" size={15} />} disabledReason={p.delete_block ?? null} onClick={() => setDeleting(true)}>
                Xoá dự án
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted">
          {d.scenes.length} cảnh · storyboard {p.progress.storyboards}/{d.scenes.length} · video đã chọn {selected}/{d.scenes.length}
          {gen ? ` · video tạo bằng ${gen.label} (${gen.duration_s} giây)` : ''}
        </p>
      </section>

      <div className="space-y-3">
        <MediaBanner media={d.media} />
        <AnalysisBanner detail={d} onReanalyze={() => setReanalyze(true)} />
      </div>

      <div className="plan-view-bar">
        <WorkspaceTabs id="auto-view" label="Nội dung dự án" items={tabs} value={view} onChange={setView} />
      </div>

      <section id="auto-view-panel-scenes" role="tabpanel" aria-labelledby="auto-view-tab-scenes" hidden={view !== 'scenes'} tabIndex={0} className="space-y-4">
        {hasScenes ? (
          <>
            <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
              <ServicePicker d={d} list={all} gen={gen} sbLabel={sbLabel} setGenerator={setGenerator} />
              <div className="border-t border-line pt-4">
                <BulkActions d={d} gen={gen} sbLabel={sbLabel} />
              </div>
            </div>
            {d.scenes.map((s) => (
              <AutoSceneCard key={s.id} projectId={p.id} scene={s} generators={list} generator={gen?.id ?? ''} onZoom={(src, title) => setZoom({ src, title })} />
            ))}
            {selected === d.scenes.length && (
              <Alert tone="info" icon="check" actions={<Button size="sm" variant="primary" onClick={() => setView('final')}>Mở Bản hoàn chỉnh</Button>}>
                Mọi cảnh đã có video được chọn. Sang tab Bản hoàn chỉnh để AI chọn điểm cắt và dựng video cuối.
              </Alert>
            )}
          </>
        ) : analyzing ? (
          <Skeleton className="h-96" />
        ) : (
          <EmptyState
            icon="film"
            title={p.status === 'failed' ? 'Chưa có cảnh nào' : 'Dự án chưa được phân tích'}
            action={
              <Button variant="primary" icon={<Icon name="send" />} onClick={() => setReanalyze(true)}>
                {p.status === 'failed' ? 'Phân tích lại' : 'Gửi phân tích'}
              </Button>
            }
          >
            Gửi yêu cầu cho AI để chia cảnh và viết prompt.
          </EmptyState>
        )}
      </section>
      <section id="auto-view-panel-final" role="tabpanel" aria-labelledby="auto-view-tab-final" hidden={view !== 'final'} tabIndex={0}>
        {hasScenes ? (
          <FinalBlock detail={asPlan} />
        ) : (
          <EmptyState icon="film" title="Bắt đầu từ kịch bản">
            Phân tích yêu cầu và tạo video từng cảnh trước khi dựng bản hoàn chỉnh.
          </EmptyState>
        )}
      </section>
      <section id="auto-view-panel-assets" role="tabpanel" aria-labelledby="auto-view-tab-assets" hidden={view !== 'assets'} tabIndex={0}>
        <ProjectAssets detail={asPlan} onZoom={(src, title) => setZoom({ src, title })} />
      </section>

      <ImageLightbox src={zoom?.src ?? null} title={zoom?.title ?? ''} onClose={() => setZoom(null)} />
      {reanalyze && <ReanalyzeDialog detail={asPlan} open onClose={() => setReanalyze(false)} />}
      {deleting && <DeleteDialog detail={asPlan} auto onClose={() => setDeleting(false)} />}
    </div>
  );
}
