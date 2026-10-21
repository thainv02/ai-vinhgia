import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Asset, SceneDetail } from '../api/types';
import { Button } from '../components/Button';
import { CommentsPanel } from '../components/CommentsPanel';
import { ElapsedTime } from '../components/ElapsedTime';
import { EventTimeline } from '../components/EventTimeline';
import { Icon } from '../components/Icon';
import { ImageLightbox } from '../components/ImageLightbox';
import { PromptPanel } from '../components/PromptPanel';
import { SceneActions } from '../components/SceneActions';
import { Alert, ErrorState, Skeleton } from '../components/States';
import { Badge, JobStatusBadge, SceneStatusBadge } from '../components/StatusBadge';
import { VerdictPanel } from '../components/VerdictPanel';
import { VideoPlayer, type PlayerHandle, type TimeMarker } from '../components/VideoPlayer';
import { useSelectVideo } from '../hooks/mutations';
import { useProject, useSceneDetail } from '../hooks/queries';
import { fmtDateTime } from '../lib/format';
import { FAIL_CODE_LABEL, JOB_TYPE_LABEL, TONE_SOLID, VERDICT } from '../lib/status';
import { useDocumentTitle } from '../lib/useDocumentTitle';

function Card({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby={id}>
      <h2 id={id} className="mb-2 text-[15px] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function VersionStrip({ scene, videos, active, onPick }: { scene: SceneDetail; videos: Asset[]; active: Asset | null; onPick: (id: number) => void }) {
  const select = useSelectVideo();
  const canSelect = scene.status === 'done' && active && scene.selected_video_id !== active.id;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Các bản video">
      {videos.map((v) => {
        const isActive = active?.id === v.id;
        const selected = scene.selected_video_id === v.id;
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onPick(v.id)}
            title={v.verdict ? `Kết luận: ${VERDICT[v.verdict].label}` : 'Chưa đánh giá'}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-semibold ${
              isActive ? 'border-fg bg-ink text-ink-fg' : 'border-line-strong bg-surface hover:bg-surface-2'
            }`}
          >
            <span aria-hidden="true" className={`size-2 rounded-full ${v.verdict ? TONE_SOLID[VERDICT[v.verdict].tone] : 'border border-current'}`} />v{v.attempt}
            {selected && <Icon name="star" size={12} aria-label="Đang được chọn" />}
          </button>
        );
      })}
      {canSelect && (
        <Button size="sm" className="ml-auto" loading={select.isPending} onClick={() => select.mutate({ sceneId: scene.id, assetId: active!.id })}>
          Chọn video này
        </Button>
      )}
    </div>
  );
}

export default function SceneDetailPage() {
  const params = useParams();
  const sceneId = Number(params.sceneId);
  const valid = Number.isInteger(sceneId) && sceneId > 0;
  const q = useSceneDetail(valid ? sceneId : 0);
  const scene = q.data;
  const project = useProject(scene?.project_id ?? 0);
  const navigate = useNavigate();
  useDocumentTitle(scene ? `${scene.code} · ${scene.project.name}` : undefined);

  const playerRef = useRef<PlayerHandle>(null);
  const [viewId, setViewId] = useState<number | null>(null);
  const [stopTime, setStopTime] = useState<number | null>(0);
  const [seekReq, setSeekReq] = useState<{ t: number; nonce: number } | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; title: string } | null>(null);

  // Đổi cảnh: bỏ ghim phiên bản đang xem.
  useEffect(() => {
    setViewId(null);
    setStopTime(0);
    setSeekReq(null);
  }, [sceneId]);

  const videos = useMemo(() => (scene?.assets ?? []).filter((a) => a.kind === 'video').sort((a, b) => a.attempt - b.attempt || a.id - b.id), [scene?.assets]);
  const active = videos.find((v) => v.id === viewId) ?? videos.find((v) => v.id === scene?.video?.id) ?? videos[videos.length - 1] ?? null;
  const grid = active ? [...(scene?.assets ?? [])].reverse().find((a) => a.kind === 'grid' && a.attempt === active.attempt) ?? null : null;
  const storyboards = (scene?.assets ?? []).filter((a) => a.kind === 'storyboard');
  const markers: TimeMarker[] = useMemo(
    () =>
      (scene?.comments ?? [])
        .filter((c) => c.timecode !== null && (c.asset_id === null || c.asset_id === active?.id))
        .map((c) => ({ id: c.id, time: c.timecode!, label: c.body.slice(0, 80) })),
    [scene?.comments, active?.id],
  );

  if (!valid) return <ErrorState title="Mã cảnh không hợp lệ" error={new Error('Đường dẫn cảnh sai.')} />;
  if (q.error && !scene) return <ErrorState title="Không mở được cảnh" error={q.error} onRetry={() => void q.refetch()} />;
  if (!scene) {
    return (
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]" aria-busy="true">
        <Skeleton className="h-[560px]" />
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }

  const pid = scene.project_id;
  const job = scene.active_job;
  const jobRunning = job && (job.status === 'claimed' || job.status === 'running');
  const lastFailed = scene.jobs.find((j) => j.status === 'failed');
  const lastJob = scene.jobs[0];
  const showFailure = (scene.status === 'failed' || scene.status === 'blocked_budget') && lastFailed;
  const refs = (project.data?.refs ?? []);
  const usedRefs = scene.upload_refs.map((id) => refs.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);

  const seek = (assetId: number | null, t: number) => {
    if (assetId && assetId !== active?.id && videos.some((v) => v.id === assetId)) setViewId(assetId);
    setSeekReq({ t, nonce: (seekReq?.nonce ?? 0) + 1 });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link to={`/projects/${pid}`} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
          <Icon name="arrowLeft" size={14} /> {scene.project.name}
        </Link>
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={!scene.prev_scene_id} onClick={() => navigate(`/projects/${pid}/scenes/${scene.prev_scene_id}`)} icon={<Icon name="chevronLeft" size={14} />}>
            Cảnh trước
          </Button>
          <Button size="sm" disabled={!scene.next_scene_id} onClick={() => navigate(`/projects/${pid}/scenes/${scene.next_scene_id}`)}>
            Cảnh sau <Icon name="chevronRight" size={14} />
          </Button>
        </div>
      </div>

      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight">{scene.code}</h1>
        <span className="text-lg text-muted">{scene.title}</span>
        <SceneStatusBadge status={scene.status} />
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        {/* Cột trái: video, dính khi cuộn để vừa xem vừa nhận xét */}
        <div className="lg:sticky lg:top-16">
          {videos.length > 0 && active ? (
            <>
              <VersionStrip scene={scene} videos={videos} active={active} onPick={(id) => { setViewId(id); setSeekReq(null); }} />
              <VideoPlayer
                ref={playerRef}
                src={active.url}
                markers={markers}
                seekRequest={seekReq}
                onTimeChange={(t, playing) => setStopTime(playing ? null : t)}
              />
            </>
          ) : (
            <div className="grid aspect-[9/16] max-h-[60vh] w-full place-content-center gap-1 rounded-lg border border-dashed border-line-strong bg-surface px-6 text-center text-muted">
              <Icon name="film" size={24} className="mx-auto" />
              <p className="font-semibold text-fg">Chưa có video</p>
              <p className="text-[13px]">Video hiện ở đây khi worker tạo xong. Bạn sẽ thấy trình phát với thanh thời gian và các bản v1, v2...</p>
            </div>
          )}
        </div>

        {/* Cột phải */}
        <div className="min-w-0 space-y-4">
          <VerdictPanel asset={active} />

          <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-label="Trạng thái và hành động">
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span className="inline-flex items-center gap-1.5">
                Lượt video
                <strong className={scene.attempts_used >= scene.max_attempts ? 'text-danger-fg' : ''}>
                  {scene.attempts_used}/{scene.max_attempts}
                </strong>
              </span>
              <span className="text-muted">Prompt v{scene.prompt_version}</span>
              {job && (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Icon name="clock" size={13} />
                  Job {JOB_TYPE_LABEL[job.type].toLowerCase()} <JobStatusBadge status={job.status} />
                  {jobRunning ? <ElapsedTime since={job.claimed_at} className="font-semibold" /> : <span className="text-muted">{scene.waiting_reason ?? 'chờ worker nhận'}</span>}
                  {job.requeue_count > 0 && <Badge tone="warn">bị trả về {job.requeue_count} lần</Badge>}
                </span>
              )}
            </div>
            {showFailure && (
              <div className="mb-3">
                <Alert tone="danger">
                  <strong>
                    Job {JOB_TYPE_LABEL[lastFailed.type].toLowerCase()} lỗi
                    {lastFailed.error_code ? ` (${FAIL_CODE_LABEL[lastFailed.error_code] ?? lastFailed.error_code})` : ''}:
                  </strong>{' '}
                  {lastFailed.error ?? 'Không có chi tiết.'}
                  {scene.status === 'blocked_budget' && (
                    <span className="mt-1 block text-xs">Tài khoản Google Flow đã hết credit thật. Nạp thêm credit trên Flow rồi bấm «Về chờ duyệt» để duyệt lại.</span>
                  )}
                  <span className="block text-xs opacity-80">{fmtDateTime(lastFailed.finished_at)}</span>
                </Alert>
              </div>
            )}
            <SceneActions
              scene={scene}
              creditPerVideo={scene.project.credit_per_video}
              variant="detail"
              lastJobType={lastJob?.type}
              viewingVideoId={active?.id}
            />
          </section>

          <CommentsPanel scene={scene} videos={videos} activeVideo={active} stopTime={stopTime} getTime={() => playerRef.current?.getTime() ?? 0} onSeek={seek} />

          <Card title="Hình ảnh" id="media-h">
            <div className="space-y-4">
              <div>
                <h3 className="mb-1.5 text-xs font-semibold text-muted">Lưới khung hình{active ? ` · v${active.attempt}` : ''}</h3>
                {grid ? (
                  <button type="button" className="block w-full overflow-hidden rounded-md border border-line" onClick={() => setLightbox({ src: grid.url, title: `Lưới khung hình ${scene.code} v${grid.attempt}` })}>
                    <img src={grid.url} alt={`Lưới khung hình ${scene.code} v${grid.attempt}`} loading="lazy" className="max-h-56 w-full object-contain" />
                  </button>
                ) : (
                  <p className="rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">{active ? 'Video này chưa có ảnh lưới khung hình.' : 'Chưa có video nên chưa có ảnh lưới.'}</p>
                )}
              </div>
              <div>
                <h3 className="mb-1.5 text-xs font-semibold text-muted">Storyboard ({storyboards.length})</h3>
                {storyboards.length === 0 ? (
                  <p className="rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">Chưa có storyboard.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {storyboards.map((s) => (
                      <li key={s.id} className="w-24">
                        <button type="button" onClick={() => setLightbox({ src: s.url, title: `Storyboard ${scene.code} lượt ${s.attempt}` })} className="block w-full overflow-hidden rounded-md border border-line">
                          <img src={s.url} alt={`Storyboard ${scene.code} lượt ${s.attempt}`} loading="lazy" className="aspect-[9/16] w-full object-cover" />
                        </button>
                        <span className="mt-0.5 block text-center text-[11px] text-muted" title={s.verdict_note ?? undefined}>
                          Lượt {s.attempt}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          <PromptPanel scene={scene} />

          <Card title="Thông tin cảnh" id="info-h">
            <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
              <dt className="text-muted">Khung đầu</dt>
              <dd>{scene.first_frame_desc || '—'}</dd>
              <dt className="text-muted">Ảnh upload</dt>
              <dd>
                {usedRefs.length === 0 && !scene.use_prev_storyboard ? (
                  '—'
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {usedRefs.map((r, i) => (
                      <li key={r.id} className="w-16 text-center">
                        <img src={r.url} alt={r.label} className="aspect-square w-full rounded border border-line object-cover" />
                        <span className="block truncate text-[11px] text-muted" title={r.label}>
                          {i + 1}. {r.label}
                        </span>
                      </li>
                    ))}
                    {scene.use_prev_storyboard && <li className="self-center text-muted">+ storyboard cảnh đầu</li>}
                  </ul>
                )}
              </dd>
            </dl>
          </Card>

          <Card title="Job của cảnh" id="jobs-h">
            {scene.jobs.length === 0 ? (
              <p className="text-[13px] text-muted">Chưa có job nào.</p>
            ) : (
              <ul className="divide-y divide-line text-[13px]">
                {scene.jobs.slice(0, 8).map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                    <span className="text-muted">#{j.id}</span>
                    <strong>{JOB_TYPE_LABEL[j.type]}</strong>
                    <JobStatusBadge status={j.status} />
                    {j.credits_cost > 0 && <span className="text-spend">{j.credits_cost} credit</span>}
                    <span className="ml-auto text-xs text-muted">{fmtDateTime(j.created_at)}</span>
                    {j.error && <p className="basis-full text-xs text-danger-fg">{j.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Dòng thời gian" id="tl-h">
            <EventTimeline projectId={pid} sceneId={scene.id} />
          </Card>
        </div>
      </div>

      <ImageLightbox src={lightbox?.src ?? null} title={lightbox?.title ?? ''} onClose={() => setLightbox(null)} />
    </div>
  );
}
