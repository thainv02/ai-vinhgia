import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Edl, FinalCut } from '../api/types';
import { errorMessage } from '../api/errors';
import { Button, buttonClass } from '../components/Button';
import { CleanLogoView } from '../components/CleanLogoView';
import { EdlEditor, type RerenderApi } from '../components/EdlEditor';
import { FeedbackBox } from '../components/FeedbackBox';
import { GradePanel } from '../components/GradePanel';
import { hasRevisions, VersionThread } from '../components/VersionThread';
import { FinalTimeline } from '../components/FinalTimeline';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { Alert, InlineError } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { VideoPlayer, type PlayerHandle, type TimeMarker } from '../components/VideoPlayer';
import { aiQueueNote, buildTimeline, cleanAction, creatorText, finalStatusLabel, fmtSeconds, isWaitingToRender, logoStatusText, renderQueueNote, revisionBlockReason, stageProgressLabel } from '../lib/finalCut';
import { gradeChips } from '../lib/grade';
import type { RevisionApi } from '../lib/revisionApi';
import { fmtDateTime } from '../lib/format';
import { FINAL_STATUS } from '../lib/status';
import { toast } from '../lib/toast';
import { planner } from './api';
import { ProgressBar } from './parts';
import type { LanFinalCut, PlanDetail } from './types';

const isActive = (c: LanFinalCut | undefined): boolean => !!c && (c.status === 'planning' || c.status === 'rendering');

type StepState = 'todo' | 'active' | 'done' | 'failed' | 'skipped';
type StepKey = 'plan' | 'render' | 'clean' | 'grade' | 'ready';

/**
 * Các bước của một bản dựng và trạng thái từng bước (suy ra từ status/stage/failed_stage). Bản dựng gốc: AI chọn điểm cắt → render → xoá logo Veo → sẵn sàng.
 * Phiên bản góp ý: AI đọc góp ý → render → xoá logo Veo → chỉnh màu → sẵn sàng (chỉ đổi màu thì render và xoá logo được bỏ qua). Chỉnh màu tay: chỉnh màu → sẵn sàng.
 * Chỉnh màu luôn chạy SAU xoá logo.
 */
function stepsOf(fc: LanFinalCut, watermarkActive: boolean): { label: string; state: StepState; detail: string | null }[] {
  const manual = fc.revision?.kind === 'manual';
  const revision = !!fc.parent_id;
  const keys: StepKey[] = manual ? ['grade', 'ready'] : revision ? ['plan', 'render', 'clean', 'grade', 'ready'] : ['plan', 'render', 'clean', 'ready'];
  const labels: Record<StepKey, string> = {
    plan: revision ? 'AI đọc góp ý' : 'AI chọn điểm cắt',
    render: 'Render',
    clean: 'Xoá logo Veo',
    grade: 'Chỉnh màu',
    ready: fc.status === 'failed' ? 'Lỗi' : fc.status === 'cancelled' ? 'Đã hủy' : 'Sẵn sàng',
  };
  const order: StepKey[] = ['plan', 'render', 'clean', 'grade', 'ready'];
  const idx = (k: StepKey) => order.indexOf(k);
  // bước đang chạy / bị lỗi
  const hadEdl = !!fc.edl;
  const active: StepKey =
    fc.status === 'planning'
      ? 'plan'
      : fc.status === 'rendering'
        ? (fc.stage ?? 'render')
        : fc.status === 'ready'
          ? 'ready'
          : (fc.failed_stage ?? (hadEdl ? 'render' : 'plan'));
  // phiên bản chỉ đổi màu: không render, không xoá logo lại
  const colorOnly = revision && !manual && !!fc.revision && !fc.revision.edl_changed;
  const pct = fc.progress !== null ? `${Math.round(fc.progress)}%` : null;
  const wait = renderQueueNote(fc);
  const waitShort = wait ? `xếp hàng (vị trí ${fc.queue_position}${fc.running_count !== null && fc.running_count !== undefined && fc.concurrency ? ` · đang chạy ${fc.running_count}/${fc.concurrency}` : ''})` : null;
  const out = keys.map((k) => {
    let state: StepState = 'todo';
    let detail: string | null = null;
    if ((k === 'render' || k === 'clean') && colorOnly) {
      state = 'skipped';
      detail = 'giữ nguyên điểm cắt';
    } else if (fc.status === 'ready') {
      state = 'done';
      if (k === 'clean' && !fc.watermark_removed) {
        state = 'skipped';
        detail = 'chưa xoá logo';
      }
    } else if (idx(k) < idx(active)) state = 'done';
    else if (k === active) state = fc.status === 'failed' || fc.status === 'cancelled' ? 'failed' : 'active';
    if (state === 'active') {
      if (k === 'plan') detail = aiQueueNote(fc.ai_queue, undefined, revision ? 'feedback' : 'cut').waiting && fc.ai_queue?.position ? `xếp hàng chờ AI (vị trí ${fc.ai_queue.position})` : revision ? 'AI đang đọc' : 'AI đang chọn';
      else detail = waitShort ?? pct;
    }
    if (state === 'todo' && k === 'clean' && !watermarkActive) detail = 'tool tắt';
    return { label: labels[k], state, detail };
  });
  return out;
}

const STEP_DOT: Record<StepState, string> = {
  todo: 'border-line-strong bg-surface text-muted',
  active: 'border-info-fg bg-info-bg text-info-fg',
  done: 'border-ok-fg bg-ok-fg text-surface',
  failed: 'border-danger-fg bg-danger-fg text-surface',
  skipped: 'border-line-strong bg-surface-2 text-muted',
};

function Stepper({ fc, watermarkActive }: { fc: LanFinalCut; watermarkActive: boolean }) {
  const steps = stepsOf(fc, watermarkActive);
  return (
    <ol className={`grid grid-cols-2 gap-x-3 gap-y-2 ${steps.length === 5 ? 'sm:grid-cols-5' : steps.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-4'}`} aria-label="Tiến trình dựng bản hoàn chỉnh">
      {steps.map((st, i) => (
        <li key={st.label} className="flex min-w-0 items-start gap-2" aria-current={st.state === 'active' ? 'step' : undefined}>
          <span aria-hidden="true" className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold ${STEP_DOT[st.state]} ${st.state === 'active' ? 'pulse-dot' : ''}`}>
            {st.state === 'done' ? <Icon name="check" size={12} /> : st.state === 'failed' ? <Icon name="x" size={12} /> : i + 1}
          </span>
          <span className="min-w-0 text-[13px] leading-tight">
            <span className={`block font-semibold ${st.state === 'todo' || st.state === 'skipped' ? 'text-muted' : ''}`}>{st.label}</span>
            <span className="block text-xs text-muted">
              {st.state === 'active' ? (st.detail ?? 'đang chạy') : st.state === 'failed' ? 'lỗi' : st.state === 'skipped' ? (st.detail ?? 'bỏ qua') : st.state === 'done' ? 'xong' : (st.detail ?? 'chờ')}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Khung 9:16 thay cho trình phát khi bản dựng chưa sẵn sàng. */
function PlayerPlaceholder({ fc, workerOnline }: { fc: LanFinalCut; workerOnline: boolean }) {
  const label = stageProgressLabel(fc.stage);
  const aiNote = aiQueueNote(fc.ai_queue, workerOnline, fc.parent_id ? 'feedback' : 'cut');
  const waitNote = renderQueueNote(fc);
  return (
    <div className="mx-auto flex flex-col items-center justify-center gap-3 rounded-lg border border-line-strong bg-surface-2 px-5 text-center" style={{ height: 'min(60vh, 520px)', aspectRatio: '9 / 16', maxWidth: '100%' }}>
      {fc.status === 'planning' && (
        <>
          <span className="shimmer grid size-14 place-items-center rounded-full bg-surface-3 text-muted">
            <Icon name={aiNote.waiting ? 'clock' : 'film'} size={24} />
          </span>
          <p className="font-semibold">{aiNote.title}</p>
          <p className={`text-[13px] ${aiNote.warn ? 'text-warn-fg' : 'text-muted'}`}>
            {aiNote.detail ?? (workerOnline ? (fc.parent_id ? 'Máy chủ AI đang đọc góp ý của bạn.' : 'Máy chủ AI đang xử lý. Video sẽ tự render khi AI gửi điểm cắt.') : 'Máy chủ AI chưa sẵn sàng: việc xếp hàng và chạy khi máy chủ sẵn sàng.')}
          </p>
        </>
      )}
      {fc.status === 'rendering' && waitNote && (
        <>
          <span className="shimmer grid size-14 place-items-center rounded-full bg-surface-3 text-muted">
            <Icon name="clock" size={24} />
          </span>
          <p className="font-semibold">{waitNote.title}</p>
          <p className="text-[13px] text-muted">{waitNote.detail}</p>
        </>
      )}
      {fc.status === 'rendering' && !waitNote && (
        <>
          <p className="text-3xl font-extrabold tracking-tight">{fc.progress !== null ? `${Math.round(fc.progress)}%` : '…'}</p>
          <div className="w-full max-w-[220px]">
            <ProgressBar value={fc.progress} label={label} />
          </div>
          {fc.stage === 'grade' ? (
            <>
              <p className="font-semibold">Đang chỉnh màu</p>
              <p className="text-[13px] text-muted">Chỉ chỉnh màu trên bản sạch, không render lại. Video hiện ra ở đây khi xong.</p>
            </>
          ) : fc.stage === 'clean' ? (
            <>
              <p className="font-semibold">Đang xoá logo Veo</p>
              <p className="text-[13px] text-muted">Đã render xong. Video hiện ra ở đây khi logo được xoá xong.</p>
            </>
          ) : (
            <>
              <p className="font-semibold">Đang render</p>
              <p className="text-[13px] text-muted">Sau đó sẽ tự xoá logo Veo.</p>
            </>
          )}
        </>
      )}
      {fc.status === 'failed' && (
        <>
          <span className="grid size-12 place-items-center rounded-full bg-danger-bg text-danger-fg">
            <Icon name="alert" size={22} />
          </span>
          <p className="font-semibold">{fc.failed_stage === 'clean' ? 'Xoá logo Veo không thành công' : fc.failed_stage === 'grade' ? 'Chỉnh màu không thành công' : fc.parent_id ? 'Góp ý không thành công' : 'Edit tự động không thành công'}</p>
          <p className="text-[13px] text-muted">{fc.error ?? 'Không có chi tiết.'}</p>
          {fc.failed_stage === 'clean' && <p className="text-[13px] text-muted">Bản render còn nguyên nên không cần dựng lại.</p>}
          {fc.failed_stage === 'grade' && <p className="text-[13px] text-muted">Bản sạch còn nguyên: bấm «Thử chỉnh màu lại» trong lịch sử phiên bản bên dưới.</p>}
        </>
      )}
      {fc.status === 'cancelled' && <p className="font-semibold text-muted">{fc.failed_stage === 'clean' ? 'Đã hủy giữa bước xoá logo Veo' : fc.failed_stage === 'grade' ? 'Đã hủy giữa bước chỉnh màu' : 'Bản dựng đã bị hủy'}</p>}
      {fc.status === 'ready' && <p className="text-[13px] text-muted">Không tìm thấy file video của bản này.</p>}
    </div>
  );
}

/**
 * Khối "Bản hoàn chỉnh" của kế hoạch LAN: dựng bản hoàn chỉnh từ video các cảnh đã tải lên (AI chọn điểm cắt → server render → xoá logo Veo),
 * xem/tải, timeline cắt kèm lý do, chỉnh điểm cắt rồi render lại, các phiên bản. Dùng lại FinalTimeline/EdlEditor của app chính.
 * Cập nhật bằng polling 3 giây khi có bản đang chạy.
 */
export function FinalBlock({ detail }: { detail: PlanDetail }) {
  const planId = detail.plan.id;
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 10_000 });
  const cuts = useQuery({
    queryKey: ['final-cuts', planId],
    queryFn: () => planner.finalCuts(planId),
    refetchInterval: (q) => (isActive(q.state.data?.[0]) || detail.final.active ? 3000 : false),
  });
  const list = useMemo(() => cuts.data ?? [], [cuts.data]);
  const [selId, setSelId] = useState<number | null>(null);
  const followLatest = useRef(true);
  const fc = list.find((x) => x.id === selId) ?? list[0];
  const latestId = list[0]?.id;
  useEffect(() => {
    if (followLatest.current) setSelId(latestId ?? null);
  }, [latestId]);
  const [editing, setEditing] = useState(false);
  const [fbIntent, setFbIntent] = useState<{ nonce: number; text?: string }>({ nonce: 0 });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [playT, setPlayT] = useState<number | null>(null);
  const [seekReq, setSeekReq] = useState<{ t: number; nonce: number } | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  useEffect(() => {
    setPlayT(null);
    setSeekReq(null);
    setEditing(false);
  }, [fc?.id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['final-cuts', planId] });
    void qc.invalidateQueries({ queryKey: ['plan', planId] });
    void qc.invalidateQueries({ queryKey: ['status'] });
  };
  const create = useMutation({
    mutationFn: () => planner.createFinalCut(planId),
    meta: { silent: true },
    onSuccess: (r) => {
      followLatest.current = true;
      setSelId(r.final_cut.id);
      toast.success(`Đã tạo bản dựng v${r.final_cut.version}, AI sẽ chọn điểm cắt`);
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (id: number) => planner.cancelFinalCut(planId, id),
    meta: { silent: true },
    onSuccess: () => {
      setConfirmCancel(false);
      refresh();
    },
  });
  const clean = useMutation({
    mutationFn: (id: number) => planner.cleanFinalCut(planId, id),
    meta: { silent: true },
    onSuccess: (r) => {
      toast.success(`Đang xoá logo Veo cho v${r.final_cut.version}`);
      refresh();
    },
  });
  const rerenderM = useMutation({
    mutationFn: (v: { id: number; edl: Edl; note?: string }) => planner.rerenderFinalCut(planId, v.id, v.edl, v.note),
    meta: { silent: true },
    onSuccess: () => refresh(),
  });
  const rerender: RerenderApi = rerenderM;
  const regrade = useMutation({
    mutationFn: (id: number) => planner.regradeFinalCut(planId, id),
    meta: { silent: true },
    onSuccess: (c) => {
      toast.success(`Đang chỉnh màu lại v${c.version}`);
      refresh();
    },
  });
  // góp ý / chỉnh màu dùng chung khối giao diện với app chính; ở đây gọi API LAN (có hạn mức riêng)
  const revApi: RevisionApi = useMemo(
    () => ({
      feedback: (id, text) => planner.feedbackFinalCut(planId, id, text),
      grade: (id, grade, note) => planner.gradeFinalCut(planId, id, grade, note),
      preview: (id, grade) => planner.previewGrade(planId, id, grade),
      regrade: (id) => planner.regradeFinalCut(planId, id),
      colorRefs: {
        scope: 'lan',
        list: () => planner.listColorRefs(planId),
        upload: (_projectId, file) => planner.uploadColorRef(planId, file),
        fromSource: (_projectId, src) => planner.colorRefFromSource(planId, src),
        remove: (_projectId, id) => planner.deleteColorRef(planId, id),
      },
    }),
    [planId],
  );
  const onRevisionCreated = (created: FinalCut) => {
    followLatest.current = true;
    setSelId(created.id);
    refresh();
  };
  const feedbackOn = (id: number, text?: string) => {
    pickVersion(id);
    setFbIntent((i) => ({ nonce: i.nonce + 1, text }));
  };

  const tl = useMemo(() => (fc?.edl ? buildTimeline(fc) : null), [fc]);
  const markers: TimeMarker[] = useMemo(() => (tl ? tl.scenes.filter((s) => s.outStart > 0).map((s, i) => ({ id: i, time: s.outStart, label: `Bắt đầu ${s.code}` })) : []), [tl]);
  const seekOut = (t: number) => setSeekReq({ t, nonce: (seekReq?.nonce ?? 0) + 1 });
  const pickVersion = (id: number) => {
    followLatest.current = id === list[0]?.id;
    setSelId(id);
  };

  const st = status.data;
  const buildReason =
    detail.final.block?.message ??
    (st && st.remaining.create_final <= 0 ? `Bạn đã dựng hoặc render lại ${st.rate.createFinal.max} lần trong giờ này, hãy thử lại sau` : null) ??
    (st && st.queue.total >= st.queue.cap ? 'Hàng đợi đang đầy, thử lại sau' : null);
  const wm = detail.final.watermark;
  const queueFull = !!st && st.queue.total >= st.queue.cap;
  const baseRevisionBlock = fc ? revisionBlockReason(fc, list, wm.active) : null;
  const feedbackBlock = baseRevisionBlock ?? (st && st.remaining.feedback !== undefined && st.remaining.feedback <= 0 ? `Bạn đã gửi ${st.rate.feedback?.max ?? 20} góp ý trong giờ này, hãy thử lại sau` : queueFull ? 'Hàng đợi đang đầy, thử lại sau' : null);
  const gradeBlock = baseRevisionBlock ?? (st && st.remaining.grade !== undefined && st.remaining.grade <= 0 ? `Bạn đã chỉnh màu ${st.rate.grade?.max ?? 30} lần trong giờ này, hãy thử lại sau` : queueFull ? 'Hàng đợi đang đầy, thử lại sau' : null);
  const videoUrl = fc?.status === 'ready' ? fc.video_url : null;
  const info = fc ? FINAL_STATUS[fc.status] : null;
  const action = fc ? cleanAction(fc) : null;
  const active = isActive(fc);
  const planName = detail.plan.name.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'ban-hoan-chinh';

  return (
    <section className="mb-4 rounded-lg border border-line bg-surface" aria-labelledby="final-h">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line bg-surface-2 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="film" size={17} className="text-muted" />
            <h2 id="final-h" className="text-[16px] font-bold tracking-tight">
              Edit tự động · video không logo
            </h2>
            {fc && info && (
              <Badge tone={info.tone} live={info.live}>
                {fc.status === 'rendering' && fc.progress !== null && !isWaitingToRender(fc) ? `${finalStatusLabel(fc)} ${Math.round(fc.progress)}%` : finalStatusLabel(fc)}
              </Badge>
            )}
            {fc?.outdated && <Badge tone="warn">Đã cũ vì đổi video</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">Tải video từng cảnh ở Bước 3 rồi bấm «Edit tự động»: AI cắt bỏ đoạn thừa, ghép các cảnh, tự xoá logo Veo. Xong là xem và tải ngay bản không logo, rồi góp ý để AI chỉnh màu hoặc điểm cắt (tạo phiên bản mới, bản cũ được giữ). Không tốn credit Flow.</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button variant="primary" icon={<Icon name="film" size={15} />} loading={create.isPending} disabledReason={buildReason} onClick={() => create.mutate()}>
            {list.length ? 'Edit lại tự động' : 'Edit tự động'}
          </Button>
          {buildReason && (
            <p className="flex max-w-xs items-start gap-1 text-xs text-warn-fg sm:text-right">
              <Icon name="alert" size={13} className="mt-px shrink-0" />
              <span>{buildReason}</span>
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3 p-4">
        {!wm.active && (
          <Alert tone="warn" icon="alert">
            <strong>Tool xoá logo Veo đang tắt.</strong> {wm.reason}. Bản dựng vẫn tạo được nhưng video sẽ còn logo.
          </Alert>
        )}
        {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
        {cuts.isError && <InlineError>{errorMessage(cuts.error)}</InlineError>}

        {!fc ? (
          <div className="rounded-md bg-surface-2 px-4 py-6 text-center text-[13px] text-muted">
            <p className="font-medium text-fg">Chưa có video hoàn chỉnh.</p>
            <p className="mt-1">Tải video của MỌI cảnh ở Bước 3 bên dưới, rồi bấm «Edit tự động». Video không logo hiện ra ở đây để xem và tải về.</p>
          </div>
        ) : (
          <>
            {action === 'clean' && (
              <Alert tone="warn" icon="alert">
                <strong>Bản v{fc.version} còn logo Veo.</strong> Bấm «Xoá logo Veo» để xử lý, không cần render lại.
              </Alert>
            )}
            {fc.outdated && (
              <Alert tone="warn" icon="refresh">
                <strong>Bản v{fc.version} đã cũ.</strong> Bạn đã đổi video của một cảnh sau khi dựng. Bấm «Edit lại tự động» để AI chọn lại điểm cắt theo video hiện tại.
              </Alert>
            )}
            <Stepper fc={fc} watermarkActive={wm.active} />

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
              <div>
                {videoUrl ? <VideoPlayer ref={playerRef} src={videoUrl} markers={markers} seekRequest={seekReq} onTimeChange={() => undefined} onTick={setPlayT} height="min(60vh, 520px)" /> : <PlayerPlaceholder fc={fc} workerOnline={detail.worker.online} />}
              </div>

              <div className="min-w-0 space-y-3">
                <div>
                  <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Các phiên bản bản hoàn chỉnh">
                    {[...list].reverse().map((v) => {
                      const sel = v.id === fc.id;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          role="tab"
                          aria-selected={sel}
                          onClick={() => pickVersion(v.id)}
                          title={`${finalStatusLabel(v)} · ${creatorText(v)}`}
                          className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-semibold ${sel ? 'border-fg bg-ink text-ink-fg' : 'border-line-strong bg-surface hover:bg-surface-2'}`}
                        >
                          <span aria-hidden="true" className={`size-2 rounded-full ${v.status === 'ready' ? 'bg-ok-fg' : v.status === 'failed' ? 'bg-danger-fg' : v.status === 'cancelled' ? 'bg-neutral-fg' : 'pulse-dot bg-info-fg'}`} />v{v.version}
                          <span className="text-[11px] font-normal opacity-80">{v.created_by !== 'user' ? 'AI' : 'Bạn'}</span>
                          {v.outdated && <span className="text-[11px] font-normal text-warn-fg">cũ</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted">Điểm cắt</dt>
                  <dd>{creatorText(fc)}</dd>
                  {fc.parent_id && (
                    <>
                      <dt className="text-muted">Từ bản</dt>
                      <dd>
                        v{fc.parent_version ?? '?'} · {fc.revision ? (fc.revision.edl_changed ? 'đã đổi điểm cắt' : 'giữ nguyên điểm cắt') : 'đang chờ AI'}
                      </dd>
                    </>
                  )}
                  {gradeChips(fc).length > 0 && (
                    <>
                      <dt className="text-muted">Màu</dt>
                      <dd className="flex flex-wrap gap-1.5">
                        {gradeChips(fc).map((c) => (
                          <span key={c} className="rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-xs font-medium">
                            {c}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted">Logo Veo</dt>
                  <dd>{logoStatusText(fc)}</dd>
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
                      <dt className="text-muted">Tóm tắt của AI</dt>
                      <dd className="whitespace-pre-wrap">{fc.summary}</dd>
                    </>
                  )}
                </dl>
                {fc.error && fc.status !== 'ready' && (
                  <Alert tone="danger">
                    <strong>Lỗi:</strong> {fc.error}
                  </Alert>
                )}
                {(clean.isError || cancel.isError) && <InlineError>{errorMessage(clean.error ?? cancel.error)}</InlineError>}

                <div className="flex flex-wrap items-center gap-2">
                  {videoUrl && (
                    <a href={videoUrl} download={`${planName}_v${fc.version}.mp4`} className={buttonClass('primary', 'md')}>
                      <Icon name="download" /> Tải video không logo
                    </a>
                  )}
                  <CleanLogoView
                    fc={fc}
                    loading={clean.isPending}
                    disabledReason={!wm.active ? `Tool xoá logo Veo đang tắt: ${wm.reason}` : st && st.remaining.remove_logo <= 0 ? 'Bạn đã hết lượt xoá logo trong giờ này' : null}
                    onClick={() => clean.mutate(fc.id)}
                  />
                  <Button icon={<Icon name="edit" size={14} />} onClick={() => setEditing((v) => !v)} disabledReason={fc.edl ? null : 'Chưa có điểm cắt để chỉnh'}>
                    {editing ? 'Đóng trình chỉnh' : 'Chỉnh điểm cắt'}
                  </Button>
                  {fc.raw_video_url && fc.status !== 'rendering' && (fc.watermark_removed || action === 'retry') && (
                    <a href={fc.raw_video_url} download={`${planName}_v${fc.version}_con-logo.mp4`} className="text-xs text-muted underline hover:text-fg">
                      Tải bản gốc còn logo
                    </a>
                  )}
                  {active && (
                    <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                      Hủy bản dựng
                    </Button>
                  )}
                </div>
                {fc.status === 'ready' && (
                  <>
                    <FeedbackBox fc={fc} api={revApi} blockReason={feedbackBlock} onCreated={onRevisionCreated} intent={fbIntent} />
                    <GradePanel key={fc.id} fc={fc} api={revApi} blockReason={gradeBlock} onCreated={onRevisionCreated} />
                  </>
                )}
              </div>
            </div>

            {hasRevisions(list) && (
              <div className="rounded-lg border border-line p-3">
                <h3 className="mb-2 text-[14px] font-semibold">Lịch sử góp ý và phiên bản</h3>
                <VersionThread
                  list={list}
                  selectedId={fc.id}
                  onSelect={pickVersion}
                  onFeedbackOn={feedbackOn}
                  onRegrade={(c) => regrade.mutate(c.id)}
                  regradePending={regrade.isPending}
                  downloadName={(c) => `${planName}_v${c.version}.mp4`}
                  workerOnline={detail.worker.online}
                />
                {regrade.isError && (
                  <div className="mt-2">
                    <InlineError>{errorMessage(regrade.error)}</InlineError>
                  </div>
                )}
              </div>
            )}

            {tl && (fc.status === 'ready' || fc.status === 'rendering' || fc.edl) && (
              <div className="rounded-lg border border-line p-3">
                <h3 className="mb-2 text-[14px] font-semibold">Điểm cắt theo cảnh</h3>
                <FinalTimeline tl={tl} currentOut={fc.status === 'ready' ? playT : null} onSeek={seekOut} />
              </div>
            )}
            {!tl && fc.status === 'planning' && (
              <p className="rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">AI đang xem video từng cảnh để chọn khoảng thừa và đoạn không hợp lý. Điểm cắt kèm lý do hiện ở đây khi xong.</p>
            )}

            {editing && (
              <div className="rounded-lg border border-line p-3">
                <h3 className="mb-2 text-[14px] font-semibold">Chỉnh điểm cắt</h3>
                <EdlEditor
                  key={fc.id}
                  fc={fc}
                  rerender={rerender}
                  onRendered={(created) => {
                    followLatest.current = true;
                    setSelId(created.id);
                    setEditing(false);
                    refresh();
                  }}
                />
              </div>
            )}

            {fc.contact_sheet_url && (
              <details className="rounded-lg border border-line p-3">
                <summary className="w-fit cursor-pointer text-[13px] font-semibold hover:underline">Lưới khung hình</summary>
                <a href={fc.contact_sheet_url} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-md border border-line bg-surface-2">
                  <img src={fc.contact_sheet_url} alt={`Lưới khung hình bản hoàn chỉnh v${fc.version}`} loading="lazy" className="mx-auto max-h-64 w-auto max-w-full object-contain" />
                </a>
              </details>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={fc ? `Hủy bản dựng v${fc.version}?` : 'Hủy bản dựng?'}
        confirmLabel="Hủy bản dựng"
        cancelLabel="Giữ lại"
        danger
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => fc && cancel.mutate(fc.id)}
      >
        <p>
          {fc?.status === 'planning'
            ? 'Việc chọn điểm cắt của AI sẽ bị hủy. Bạn có thể bấm «Edit lại tự động» để làm lại.'
            : fc?.stage === 'clean'
              ? 'Việc xoá logo Veo sẽ bị dừng. Bản render còn logo được giữ lại để bấm «Thử xoá logo lại».'
              : fc?.stage === 'grade'
                ? 'Việc chỉnh màu sẽ bị dừng. Bản sạch được giữ lại để bấm «Thử chỉnh màu lại» trong lịch sử phiên bản.'
                : 'Việc render đang chạy sẽ bị dừng. Bạn có thể bấm «Edit lại tự động» để làm lại.'}{' '}
          Không mất credit.
        </p>
      </ConfirmDialog>
    </section>
  );
}
