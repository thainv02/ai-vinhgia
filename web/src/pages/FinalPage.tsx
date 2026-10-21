import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { FinalCut } from '../api/types';
import { Button, buttonClass } from '../components/Button';
import { CleanLogoButton } from '../components/CleanLogoButton';
import { EdlEditor } from '../components/EdlEditor';
import { FinalTimeline } from '../components/FinalTimeline';
import { Icon } from '../components/Icon';
import { ImageLightbox } from '../components/ImageLightbox';
import { ConfirmDialog } from '../components/Modal';
import { Alert, EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { VideoPlayer, type PlayerHandle, type TimeMarker } from '../components/VideoPlayer';
import { useCancelFinalCut, useCreateFinalCut, useOpenInShotcut } from '../hooks/mutations';
import { useFinalCuts, useMeta, useProject, useScenes, useWorkerStatus } from '../hooks/queries';
import { buildTimeline, cleanAction, finalBlockReason, finalContactUrl, finalStatusLabel, finalVideoUrl, fmtSeconds } from '../lib/finalCut';
import { fmtDateTime } from '../lib/format';
import { FINAL_STATUS } from '../lib/status';
import { toast } from '../lib/toast';
import { errorMessage } from '../api/client';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const RENDERER_LABEL: Record<string, string> = { shotcut: 'Shotcut', ffmpeg: 'ffmpeg' };

function Card({ title, id, children, aside }: { title: string; id: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby={id}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id={id} className="text-[15px] font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StatusBadgeFinal({ fc }: { fc: FinalCut }) {
  const info = FINAL_STATUS[fc.status];
  const label = finalStatusLabel(fc);
  return (
    <Badge tone={info.tone} live={info.live}>
      {fc.status === 'rendering' && fc.progress !== null ? `${label} ${Math.round(fc.progress)}%` : label}
    </Badge>
  );
}

/** Khung 9:16 thay cho trình phát khi bản dựng chưa sẵn sàng. */
function PlayerPlaceholder({ fc, workerOnline }: { fc: FinalCut; workerOnline: boolean }) {
  return (
    <div
      className="mx-auto flex flex-col items-center justify-center gap-3 rounded-lg border border-line-strong bg-surface-2 px-5 text-center"
      style={{ height: 'min(66vh, 640px)', aspectRatio: '9 / 16', maxWidth: '100%' }}
    >
      {fc.status === 'planning' && (
        <>
          <span className="shimmer grid size-14 place-items-center rounded-full bg-surface-3 text-muted">
            <Icon name="film" size={24} />
          </span>
          <p className="font-semibold">AI đang chọn điểm cắt</p>
          <p className="text-[13px] text-muted">
            {workerOnline ? 'Worker đang xử lý. Video sẽ tự render khi AI gửi điểm cắt.' : 'Worker đang offline: việc này đợi tới khi mở phiên worker AI.'}
          </p>
        </>
      )}
      {fc.status === 'rendering' && (
        <>
          <p className="text-3xl font-extrabold tracking-tight">{fc.progress !== null ? `${Math.round(fc.progress)}%` : '...'}</p>
          <div className="h-2 w-full max-w-[220px] overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(fc.progress ?? 0)} aria-valuemin={0} aria-valuemax={100} aria-label={fc.stage === 'clean' ? 'Tiến độ xoá logo Veo' : 'Tiến độ render'}>
            <div className="h-full bg-info-fg transition-[width] duration-500" style={{ width: `${Math.max(3, fc.progress ?? 0)}%` }} />
          </div>
          {fc.stage === 'clean' ? (
            <>
              <p className="font-semibold">Đang xoá logo Veo</p>
              <p className="text-[13px] text-muted">Đã render xong. Video hiện ra ở đây khi logo được xoá xong (khoảng 2 giây xử lý cho mỗi giây video).</p>
            </>
          ) : (
            <p className="text-[13px] text-muted">Đang render bằng {fc.renderer ? RENDERER_LABEL[fc.renderer] : 'trình dựng'}. Sau đó sẽ tự xoá logo Veo.</p>
          )}
        </>
      )}
      {fc.status === 'failed' && (
        <>
          <span className="grid size-12 place-items-center rounded-full bg-danger-bg text-danger-fg">
            <Icon name="alert" size={22} />
          </span>
          <p className="font-semibold">{fc.failed_stage === 'clean' ? 'Xoá logo Veo không thành công' : 'Dựng không thành công'}</p>
          <p className="text-[13px] text-muted">{fc.error ?? 'Không có chi tiết.'}</p>
          {fc.failed_stage === 'clean' && (
            <>
              <p className="text-[13px] text-muted">Bản render vẫn còn nên không cần dựng lại.</p>
              <CleanLogoButton fc={fc} size="sm" />
            </>
          )}
        </>
      )}
      {fc.status === 'cancelled' && (
        <>
          <p className="font-semibold text-muted">{fc.failed_stage === 'clean' ? 'Đã hủy giữa bước xoá logo Veo' : 'Bản dựng đã bị hủy'}</p>
          {fc.failed_stage === 'clean' && <CleanLogoButton fc={fc} size="sm" />}
        </>
      )}
      {fc.status === 'ready' && <p className="text-[13px] text-muted">Không tìm thấy file video của bản này.</p>}
    </div>
  );
}

export default function FinalPage() {
  const projectId = Number(useParams().projectId);
  const valid = Number.isInteger(projectId) && projectId > 0;
  const project = useProject(valid ? projectId : 0);
  const scenes = useScenes(valid ? projectId : 0);
  const cuts = useFinalCuts(valid ? projectId : 0);
  const worker = useWorkerStatus();
  const meta = useMeta();
  const create = useCreateFinalCut();
  const cancel = useCancelFinalCut();
  const openShotcut = useOpenInShotcut();
  useDocumentTitle(project.data ? `Bản hoàn chỉnh · ${project.data.name}` : 'Bản hoàn chỉnh');

  const [selId, setSelId] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [playT, setPlayT] = useState<number | null>(null);
  const [seekReq, setSeekReq] = useState<{ t: number; nonce: number } | null>(null);
  const playerRef = useRef<PlayerHandle>(null);

  const list = useMemo(() => cuts.data ?? [], [cuts.data]);
  const fc = list.find((x) => x.id === selId) ?? list[0];

  // Bản mới xuất hiện (vd AI vừa gửi điểm cắt tạo version mới): nếu đang xem bản mới nhất thì tự theo.
  const latestId = list[0]?.id;
  const followLatest = useRef(true);
  useEffect(() => {
    if (followLatest.current) setSelId(latestId ?? null);
  }, [latestId]);

  const tl = useMemo(() => (fc?.edl ? buildTimeline(fc) : null), [fc]);
  const markers: TimeMarker[] = useMemo(() => (tl ? tl.scenes.filter((s) => s.outStart > 0).map((s, i) => ({ id: i, time: s.outStart, label: `Bắt đầu ${s.code}` })) : []), [tl]);

  useEffect(() => {
    setPlayT(null);
    setSeekReq(null);
    setEditing(false);
  }, [fc?.id]);

  if (!valid) return <ErrorState title="Mã dự án không hợp lệ" error={new Error('Đường dẫn dự án sai.')} />;
  if (project.error && !project.data) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;

  const blockReason = finalBlockReason(scenes.data, list[0], project.data?.final_cut_block);
  const videoUrl = fc ? finalVideoUrl(fc) : null;
  const contactUrl = fc ? finalContactUrl(fc) : null;
  const active = fc && (fc.status === 'planning' || fc.status === 'rendering');
  const fr = meta.data?.final_renderer;
  const wm = meta.data?.watermark_remover;
  const rendererText = fr ? `${fr.active === 'shotcut' ? 'Shotcut' : fr.active === 'ffmpeg' ? 'ffmpeg' : 'chưa có trình dựng khả dụng'}${fr.reason ? ` (${fr.reason})` : ''}` : null;

  const seekOut = (t: number) => setSeekReq({ t, nonce: (seekReq?.nonce ?? 0) + 1 });
  const pickVersion = (id: number) => {
    followLatest.current = id === list[0]?.id;
    setSelId(id);
  };

  return (
    <div>
      <Link to={`/projects/${projectId}`} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <Icon name="arrowLeft" size={14} /> {project.data?.name ?? 'Dự án'}
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Bản hoàn chỉnh</h1>
          {rendererText && <p className="text-xs text-muted">Trình dựng: {rendererText}</p>}
          {wm && <p className="text-xs text-muted">Xoá logo Veo: {wm.active ? 'bật' : 'tắt'}{wm.reason ? ` (${wm.reason})` : ''}</p>}
        </div>
        <Button
          variant="primary"
          loading={create.isPending}
          disabledReason={blockReason}
          onClick={() =>
            create.mutate(projectId, {
              onSuccess: (created) => {
                followLatest.current = true;
                setSelId(created.id);
                toast.success(`Đã tạo bản dựng v${created.version}, AI sẽ chọn điểm cắt`);
              },
            })
          }
        >
          Dựng bản mới
        </Button>
      </div>
      {blockReason && (
        <p className="-mt-2 mb-3 flex items-start gap-1 text-xs text-warn-fg">
          <Icon name="alert" size={13} className="mt-px" />
          <span>{blockReason}</span>
        </p>
      )}

      {cuts.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]" aria-busy="true">
          <Skeleton className="h-[560px]" />
          <div className="space-y-4">
            <Skeleton className="h-40" />
            <Skeleton className="h-52" />
          </div>
        </div>
      ) : cuts.error ? (
        <ErrorState error={cuts.error} onRetry={() => void cuts.refetch()} />
      ) : !fc ? (
        <EmptyState icon="film" title="Chưa có bản hoàn chỉnh">
          Khi mọi cảnh đã chọn video, hệ thống tự nhờ AI chọn điểm cắt rồi render thành một video 9:16 (chuyển cảnh cắt thẳng). Bạn cũng có thể bấm «Dựng bản mới».
          {blockReason && <span className="mt-2 block font-medium text-warn-fg">{blockReason}.</span>}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {cleanAction(fc) === 'clean' && (
            <Alert tone="warn" icon="alert">
              <strong>Bản v{fc.version} còn logo Veo.</strong> Bản này render trước khi có bước xoá logo (hoặc lúc tool xoá logo đang tắt). Bấm «Xoá logo Veo» để xử lý, không cần render lại và không tốn credit.
            </Alert>
          )}
          {fc.outdated && (
            <Alert tone="warn" icon="refresh">
              <strong>Bản v{fc.version} đã cũ.</strong> Bạn đã đổi video được chọn của một cảnh sau khi dựng. Bấm «Dựng bản mới» để AI chọn lại điểm cắt theo các video hiện tại.
            </Alert>
          )}

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-16">
              {fc.status === 'ready' && videoUrl ? (
                <VideoPlayer ref={playerRef} src={videoUrl} markers={markers} seekRequest={seekReq} onTimeChange={() => undefined} onTick={setPlayT} />
              ) : (
                <PlayerPlaceholder fc={fc} workerOnline={!!worker.data?.online} />
              )}
            </div>

            <div className="min-w-0 space-y-4">
              <Card title="Các phiên bản" id="fv-h">
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Các phiên bản bản hoàn chỉnh">
                  {[...list].reverse().map((v) => {
                    const isSel = v.id === fc.id;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        role="tab"
                        aria-selected={isSel}
                        onClick={() => pickVersion(v.id)}
                        title={`${finalStatusLabel(v)} · ${v.created_by !== 'user' ? 'AI' : 'Bạn'}${v.renderer ? ` · ${RENDERER_LABEL[v.renderer]}` : ''}`}
                        className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-semibold ${isSel ? 'border-fg bg-ink text-ink-fg' : 'border-line-strong bg-surface hover:bg-surface-2'}`}
                      >
                        <span aria-hidden="true" className={`size-2 rounded-full ${v.status === 'ready' ? 'bg-ok-fg' : v.status === 'failed' ? 'bg-danger-fg' : v.status === 'cancelled' ? 'bg-neutral-fg' : 'pulse-dot bg-info-fg'}`} />v{v.version}
                        <span className="text-[11px] font-normal opacity-80">{v.created_by !== 'user' ? 'AI' : 'Bạn'}</span>
                        {v.outdated && <span className="text-[11px] font-normal text-warn-fg">cũ</span>}
                      </button>
                    );
                  })}
                </div>

                <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted">Trạng thái</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <StatusBadgeFinal fc={fc} />
                    {fc.outdated && <Badge tone="warn">Đã cũ vì đổi video</Badge>}
                  </dd>
                  <dt className="text-muted">Người tạo</dt>
                  <dd>{fc.created_by !== 'user' ? 'AI chọn điểm cắt' : 'Bạn chỉnh điểm cắt'}</dd>
                  <dt className="text-muted">Trình dựng</dt>
                  <dd>{fc.renderer ? RENDERER_LABEL[fc.renderer] : '—'} · chuyển cảnh cắt thẳng</dd>
                  <dt className="text-muted">Logo Veo</dt>
                  <dd>
                    {fc.watermark_removed
                      ? 'Đã xoá'
                      : fc.status === 'rendering' && fc.stage === 'clean'
                        ? 'Đang xoá'
                        : fc.status === 'planning' || (fc.status === 'rendering' && fc.stage !== 'clean')
                          ? 'Sẽ xoá sau khi render'
                          : 'Còn logo'}
                  </dd>
                  <dt className="text-muted">Thời lượng</dt>
                  <dd>{fmtSeconds(fc.duration_s ?? tl?.total ?? null)}</dd>
                  <dt className="text-muted">Tạo lúc</dt>
                  <dd>{fmtDateTime(fc.created_at)}</dd>
                  {fc.note && (
                    <>
                      <dt className="text-muted">Ghi chú</dt>
                      <dd className="whitespace-pre-wrap">{fc.note}</dd>
                    </>
                  )}
                  {fc.summary && (
                    <>
                      <dt className="text-muted">Tóm tắt</dt>
                      <dd className="whitespace-pre-wrap">{fc.summary}</dd>
                    </>
                  )}
                </dl>
                {fc.error && (
                  <div className="mt-3">
                    <Alert tone="danger">
                      <strong>Lỗi:</strong> {fc.error}
                    </Alert>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {fc.status === 'ready' && videoUrl && (
                    <a href={videoUrl} download className={buttonClass('primary', 'md')}>
                      <Icon name="download" /> Tải video
                    </a>
                  )}
                  <CleanLogoButton fc={fc} />
                  {fc.project_file_path && (
                    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Button loading={openShotcut.isPending} onClick={() => openShotcut.mutate(fc.id, { onSuccess: () => toast.success('Đã mở dự án trong Shotcut') })}>
                        Mở trong Shotcut
                      </Button>
                      <span className="text-xs text-muted">Dự án Shotcut dùng video gốc nên vẫn còn logo Veo.</span>
                    </span>
                  )}
                  <Button icon={<Icon name="edit" size={14} />} onClick={() => setEditing((v) => !v)} disabledReason={fc.edl ? null : 'Chưa có điểm cắt để chỉnh'}>
                    {editing ? 'Đóng trình chỉnh' : 'Chỉnh điểm cắt'}
                  </Button>
                  {fc.raw_video_url && fc.status !== 'rendering' && (fc.watermark_removed || cleanAction(fc) === 'retry') && (
                    <a href={fc.raw_video_url} download className="text-xs text-muted underline hover:text-fg">
                      Tải bản gốc còn logo
                    </a>
                  )}
                  {active && (
                    <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                      Hủy bản dựng
                    </Button>
                  )}
                </div>
              </Card>

              {tl && (fc.status === 'ready' || fc.status === 'rendering' || fc.edl) && (
                <Card title="Điểm cắt theo cảnh" id="ft-h">
                  <FinalTimeline tl={tl} currentOut={fc.status === 'ready' ? playT : null} onSeek={seekOut} />
                </Card>
              )}
              {!tl && fc.status === 'planning' && (
                <Card title="Điểm cắt theo cảnh" id="ft-h">
                  <p className="rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">AI đang xem video từng cảnh để chọn khoảng thừa và đoạn không hợp lý. Điểm cắt hiện ở đây khi xong.</p>
                </Card>
              )}

              {editing && (
                <Card title="Chỉnh điểm cắt" id="fe-h">
                  <EdlEditor
                    key={fc.id}
                    fc={fc}
                    onRendered={(created) => {
                      followLatest.current = true;
                      setSelId(created.id);
                      setEditing(false);
                    }}
                  />
                </Card>
              )}

              {contactUrl && (
                <Card title="Lưới khung hình" id="fc-h">
                  <button type="button" className="block w-full overflow-hidden rounded-md border border-line bg-surface-2" onClick={() => setLightbox(contactUrl)}>
                    <img src={contactUrl} alt={`Lưới khung hình bản hoàn chỉnh v${fc.version}`} loading="lazy" className="mx-auto max-h-64 w-auto max-w-full object-contain" />
                  </button>
                </Card>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={fc ? `Hủy bản dựng v${fc.version}?` : 'Hủy bản dựng?'}
        confirmLabel="Hủy bản dựng"
        cancelLabel="Giữ lại"
        danger
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => fc && cancel.mutate(fc.id, { onSuccess: () => setConfirmCancel(false) })}
      >
        <p>
          {fc?.status === 'planning'
            ? 'Việc chọn điểm cắt của AI sẽ bị hủy. Bạn có thể bấm «Dựng bản mới» để dựng lại.'
            : fc?.stage === 'clean'
              ? 'Việc xoá logo Veo sẽ bị dừng. Bản render còn logo được giữ lại để bấm «Thử xoá logo lại».'
              : 'Việc render đang chạy sẽ bị dừng. Bạn có thể bấm «Dựng bản mới» để dựng lại.'}{' '}
          Không mất credit.
        </p>
      </ConfirmDialog>
      <ImageLightbox src={lightbox} title="Lưới khung hình bản hoàn chỉnh" onClose={() => setLightbox(null)} />
    </div>
  );
}
