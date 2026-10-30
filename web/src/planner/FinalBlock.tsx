import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Edl, FinalCut } from '../api/types';
import { errorMessage } from '../api/errors';
import { CleanLogoView } from '../components/CleanLogoView';
import { EdlEditor, type RerenderApi } from '../components/EdlEditor';
import { GradePanel } from '../components/GradePanel';
import { hasRevisions, VersionThread } from '../components/VersionThread';
import { FinalTimeline } from '../components/FinalTimeline';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { InlineError } from '../components/States';
import { VideoPlayer, type PlayerHandle, type TimeMarker } from '../components/VideoPlayer';
import { aiQueueNote, buildTimeline, cleanAction, creatorText, finalStatusLabel, isWaitingToRender, renderQueueNote, revisionBlockReason, stageProgressLabel, outputToSource } from '../lib/finalCut';
import type { Timeline } from '../lib/finalCut';
import { appendSuggestion, FEEDBACK_MAX_CHARS, FEEDBACK_SUGGESTIONS, gradeChips } from '../lib/grade';
import type { RevisionApi } from '../lib/revisionApi';
import { fmtDateTime, fmtTimecode } from '../lib/format';
import { FINAL_STATUS } from '../lib/status';
import { toast } from '../lib/toast';
import { planner } from './api';
import { ProgressBar } from './parts';
import { Btn, LinkBtn } from './ws-ui';
import type { LanFinalCut, PlanDetail } from './types';
import './workspace.css';

const isActive = (c: LanFinalCut | undefined): boolean => !!c && (c.status === 'planning' || c.status === 'rendering');

const TONE_CLS: Record<string, string> = { ok: 'av-badge-ok', info: 'av-badge-info', danger: 'av-badge-danger', neutral: 'av-badge-neutral', warn: 'av-badge-warn' };
const toneCls = (t: string): string => TONE_CLS[t] ?? 'av-badge-neutral';
const SCENE_COLORS = ['#2a6fb8', '#207d79', '#7a5bb5', '#b8722a', '#2b7f60', '#b8456a'];
const dur = (s: number | null | undefined): string => {
  if (s === null || s === undefined) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

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

/** Các bước dựng dạng một dòng gọn (xong / đang chạy / lỗi). */
function Stages({ fc, watermarkActive }: { fc: LanFinalCut; watermarkActive: boolean }) {
  const steps = stepsOf(fc, watermarkActive);
  return (
    <ol className="ws-stages" aria-label="Tiến trình dựng bản hoàn chỉnh">
      {steps.map((st) => (
        <li key={st.label} className={st.state} aria-current={st.state === 'active' ? 'step' : undefined}>
          <Icon name={st.state === 'done' ? 'check' : st.state === 'failed' ? 'x' : st.state === 'active' ? 'clock' : 'plus'} size={12} />
          {st.label}
          {st.state === 'active' && st.detail ? ` · ${st.detail}` : st.state === 'skipped' && st.detail ? ` · ${st.detail}` : ''}
        </li>
      ))}
    </ol>
  );
}

/** Khung 9:16 thay cho trình phát khi bản dựng chưa sẵn sàng (không kèm giải thích dài). */
function PlayerPlaceholder({ fc, workerOnline }: { fc: LanFinalCut; workerOnline: boolean }) {
  const label = stageProgressLabel(fc.stage);
  const aiNote = aiQueueNote(fc.ai_queue, workerOnline, fc.parent_id ? 'feedback' : 'cut');
  const waitNote = renderQueueNote(fc);
  return (
    <div className="ws-ph">
      {fc.status === 'planning' && (
        <>
          <Icon name={aiNote.waiting ? 'clock' : 'film'} size={28} />
          <p style={{ fontWeight: 600 }}>{aiNote.title}</p>
          {aiNote.warn && aiNote.detail && <p className="muted">{aiNote.detail}</p>}
        </>
      )}
      {fc.status === 'rendering' && waitNote && (
        <>
          <Icon name="clock" size={28} />
          <p style={{ fontWeight: 600 }}>{waitNote.title}</p>
        </>
      )}
      {fc.status === 'rendering' && !waitNote && (
        <>
          <p className="big">{fc.progress !== null ? `${Math.round(fc.progress)}%` : '…'}</p>
          <ProgressBar value={fc.progress} label={label} />
          <p style={{ fontWeight: 600 }}>{fc.stage === 'grade' ? 'Đang chỉnh màu' : fc.stage === 'clean' ? 'Đang xoá logo Veo' : 'Đang render'}</p>
        </>
      )}
      {fc.status === 'failed' && (
        <>
          <Icon name="alert" size={26} />
          <p style={{ fontWeight: 600 }}>{fc.failed_stage === 'clean' ? 'Xoá logo Veo không thành công' : fc.failed_stage === 'grade' ? 'Chỉnh màu không thành công' : fc.parent_id ? 'Góp ý không thành công' : 'Edit tự động không thành công'}</p>
          <p className="muted">{fc.error ?? 'Không có chi tiết.'}</p>
          {fc.failed_stage === 'clean' && <p className="muted">Bản render còn nguyên, không cần dựng lại.</p>}
          {fc.failed_stage === 'grade' && <p className="muted">Bản sạch còn nguyên: bấm «Thử chỉnh màu lại» ở lịch sử phiên bản.</p>}
        </>
      )}
      {fc.status === 'cancelled' && <p style={{ fontWeight: 600 }}>{fc.failed_stage === 'clean' ? 'Đã hủy giữa bước xoá logo Veo' : fc.failed_stage === 'grade' ? 'Đã hủy giữa bước chỉnh màu' : 'Bản dựng đã bị hủy'}</p>}
      {fc.status === 'ready' && <p className="muted">Không tìm thấy file video của bản này.</p>}
    </div>
  );
}

/** Ô "Góp ý cho AI": tạo phiên bản mới từ góp ý, bản đang xem được giữ nguyên. */
function Feedback({ fc, api, blockReason, onCreated, intent }: { fc: FinalCut; api: RevisionApi; blockReason: string | null; onCreated: (c: FinalCut) => void; intent: { nonce: number; text?: string } }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);
  const send = useMutation({
    mutationFn: (t: string) => api.feedback(fc.id, t),
    meta: { silent: true },
    onSuccess: (created) => {
      setText('');
      toast.success(`Đã gửi góp ý, AI đang tạo bản v${created.version}`);
      onCreated(created);
    },
  });
  useEffect(() => {
    if (!intent.nonce) return;
    if (intent.text !== undefined) setText(intent.text);
    box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ref.current?.focus({ preventScroll: true });
  }, [intent.nonce, intent.text]);
  const trimmed = text.trim();
  const reason = blockReason ?? (trimmed ? null : 'Nhập góp ý trước');
  const submit = () => {
    if (!reason && !send.isPending) send.mutate(trimmed);
  };
  return (
    <section ref={box} className="av-card ws-fcard ws-fb" aria-labelledby={`fb-h-${fc.id}`}>
      <h3 id={`fb-h-${fc.id}`}>Góp ý cho AI để tạo bản v{fc.version + 1}</h3>
      <textarea
        id={`fb-text-${fc.id}`}
        ref={ref}
        className="av-input"
        rows={3}
        maxLength={FEEDBACK_MAX_CHARS}
        value={text}
        disabled={send.isPending}
        aria-label="Góp ý cho AI"
        placeholder="Ví dụ: cảnh C4 kết hơi nhanh, giữ hộp sản phẩm thêm 1 giây"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="ws-fb-foot">
        <div className="ws-sugs" role="group" aria-label="Gợi ý nhanh">
          {FEEDBACK_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="ws-sug" disabled={send.isPending} onClick={() => { setText((t) => appendSuggestion(t, s)); ref.current?.focus({ preventScroll: true }); }}>
              + {s}
            </button>
          ))}
        </div>
        <Btn size="sm" variant="primary" icon="send" loading={send.isPending} disabledReason={reason} onClick={submit}>Gửi góp ý</Btn>
      </div>
      {send.isError && <InlineError>{errorMessage(send.error)}</InlineError>}
      {blockReason && <p className="ws-warn">{blockReason}</p>}
    </section>
  );
}

/** Timeline màu theo cảnh: khối đặc là đoạn giữ, gạch chéo là đoạn bị cắt. Bấm để tua video. */
function SceneTimeline({ tl, currentOut, onSeek }: { tl: Timeline; currentOut: number | null; onSeek: (t: number) => void }) {
  const sum = tl.scenes.reduce((a, s) => a + s.sourceDuration, 0) || 1;
  const playhead = currentOut === null ? null : outputToSource(tl, currentOut);
  const cutBg = 'repeating-linear-gradient(135deg, var(--surface-3) 0 6px, var(--surface-2) 6px 12px)';
  return (
    <div className="ws-col">
      <div className="ws-tl" role="group" aria-label="Điểm cắt theo cảnh">
        {tl.scenes.map((sc, i) => {
          const color = SCENE_COLORS[i % SCENE_COLORS.length];
          return (
            <div key={sc.scene_id} className="ws-tl-scene" style={{ flex: `${sc.sourceDuration / sum} 1 0` }}>
              <div className="ws-tl-label"><strong style={{ color: 'var(--fg)' }}>{sc.code}</strong><span>{dur(sc.outStart)}–{dur(sc.outStart + sc.outDuration)}</span></div>
              <div className="ws-tl-track" style={{ background: cutBg }}>
                {sc.removed.map((r, ri) => (
                  <button key={`r${ri}`} type="button" className="ws-tl-cut" onClick={() => onSeek(r.seekOut)} title={`Cắt ${fmtTimecode(r.from_s)}–${fmtTimecode(r.to_s)}: ${r.reason}`} aria-label={`Đoạn bị cắt ${sc.code} ${fmtTimecode(r.from_s)} đến ${fmtTimecode(r.to_s)}`} style={{ left: `${(r.from_s / sc.sourceDuration) * 100}%`, width: `${((r.to_s - r.from_s) / sc.sourceDuration) * 100}%` }} />
                ))}
                {sc.kept.map((k, ki) => (
                  <button key={`k${ki}`} type="button" className="ws-tl-seg" onClick={() => onSeek(k.outStart)} title={`Giữ ${fmtTimecode(k.in_s)}–${fmtTimecode(k.out_s)} (tại ${fmtTimecode(k.outStart)} trong bản hoàn chỉnh)`} aria-label={`Đoạn giữ ${sc.code} ${fmtTimecode(k.in_s)} đến ${fmtTimecode(k.out_s)}`} style={{ left: `${(k.in_s / sc.sourceDuration) * 100}%`, width: `${((k.out_s - k.in_s) / sc.sourceDuration) * 100}%`, background: color }}>
                    {sc.kept.length === 1 && <span>{dur(k.out_s - k.in_s)}</span>}
                  </button>
                ))}
                {playhead && playhead.sceneIdx === i && <span aria-hidden="true" className="ws-tl-play" style={{ left: `${(playhead.sourceT / sc.sourceDuration) * 100}%` }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="ws-tl-legend"><span>Phần gạch chéo đã bị cắt bỏ</span><span style={{ marginLeft: 'auto' }}>Tổng {dur(tl.total)}</span></div>
    </div>
  );
}

/**
 * Tab "Bản hoàn chỉnh" của kế hoạch: dựng bản hoàn chỉnh từ video các cảnh đã tải lên (AI chọn điểm cắt → server render → xoá logo Veo),
 * xem/tải, timeline cắt kèm lý do, chỉnh điểm cắt rồi render lại, góp ý, chỉnh màu, các phiên bản. Dùng lại EdlEditor/GradePanel/VersionThread của app chính.
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
  const [grading, setGrading] = useState(false);
  const gradeBox = useRef<HTMLDivElement>(null);
  const [fbIntent, setFbIntent] = useState<{ nonce: number; text?: string }>({ nonce: 0 });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [playT, setPlayT] = useState<number | null>(null);
  const [seekReq, setSeekReq] = useState<{ t: number; nonce: number } | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  useEffect(() => {
    setPlayT(null);
    setSeekReq(null);
    setEditing(false);
    setGrading(false);
  }, [fc?.id]);
  // GradePanel tự thu gọn khi mới gắn: bấm "Chỉnh màu" thì mở luôn phần thanh trượt
  useEffect(() => {
    if (grading) gradeBox.current?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
  }, [grading]);

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
  // góp ý / chỉnh màu dùng chung khối giao diện với app chính; ở đây gọi API của kế hoạch
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
  const pickVersion = (id: number) => {
    followLatest.current = id === list[0]?.id;
    setSelId(id);
  };
  const feedbackOn = (id: number, text?: string) => {
    pickVersion(id);
    setFbIntent((i) => ({ nonce: i.nonce + 1, text }));
  };

  const tl = useMemo(() => (fc?.edl ? buildTimeline(fc) : null), [fc]);
  const markers: TimeMarker[] = useMemo(() => (tl ? tl.scenes.filter((s) => s.outStart > 0).map((s, i) => ({ id: i, time: s.outStart, label: `Bắt đầu ${s.code}` })) : []), [tl]);
  const seekOut = (t: number) => setSeekReq({ t, nonce: (seekReq?.nonce ?? 0) + 1 });

  const st = status.data;
  const queueFull = !!st && st.queue.total >= st.queue.cap;
  const buildReason =
    detail.final.block?.message ??
    (st && st.remaining.create_final <= 0 ? 'Đã hết lượt dựng, thử lại sau' : null) ??
    (queueFull ? 'Hàng đợi đang đầy, thử lại sau' : null);
  const wm = detail.final.watermark;
  const baseRevisionBlock = fc ? revisionBlockReason(fc, list, wm.active) : null;
  const feedbackBlock = baseRevisionBlock ?? (st && st.remaining.feedback !== undefined && st.remaining.feedback <= 0 ? 'Đã hết lượt góp ý, thử lại sau' : queueFull ? 'Hàng đợi đang đầy, thử lại sau' : null);
  const gradeBlock = baseRevisionBlock ?? (st && st.remaining.grade !== undefined && st.remaining.grade <= 0 ? 'Đã hết lượt chỉnh màu, thử lại sau' : queueFull ? 'Hàng đợi đang đầy, thử lại sau' : null);
  const videoUrl = fc?.status === 'ready' ? fc.video_url : null;
  const info = fc ? FINAL_STATUS[fc.status] : null;
  const action = fc ? cleanAction(fc) : null;
  const active = isActive(fc);
  const planName = detail.plan.name.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'ban-hoan-chinh';
  const waiting = fc ? (fc.status === 'planning' ? aiQueueNote(fc.ai_queue, detail.worker.online, fc.parent_id ? 'feedback' : 'cut') : renderQueueNote(fc)) : null;
  const createBtn = (
    <Btn variant={!fc || fc.outdated ? 'primary' : undefined} size={fc ? 'sm' : undefined} icon="film" loading={create.isPending} disabledReason={buildReason} onClick={() => create.mutate()}>
      {list.length ? 'Edit lại tự động' : 'Edit tự động'}
    </Btn>
  );

  return (
    <section className="ws-final" aria-label="Bản hoàn chỉnh">
      <div className="ws-final-main">
        {!wm.active && (
          <div className="ws-note warn" role="status"><Icon name="alert" size={15} /><span><strong>Tool xoá logo Veo đang tắt.</strong> {wm.reason}. Bản dựng vẫn tạo được nhưng video sẽ còn logo.</span></div>
        )}
        {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
        {cuts.isError && <InlineError>{errorMessage(cuts.error)}</InlineError>}

        {!fc ? (
          <div className="ws-empty">
            <strong>Chưa có bản hoàn chỉnh</strong>
            {createBtn}
            {buildReason && <p className="ws-warn">{buildReason}</p>}
          </div>
        ) : (
          <>
            <div className="ws-final-top">
              <div className="ws-player">
                {videoUrl ? <VideoPlayer ref={playerRef} src={videoUrl} markers={markers} seekRequest={seekReq} onTimeChange={() => undefined} onTick={setPlayT} height="min(60vh, 520px)" /> : <PlayerPlaceholder fc={fc} workerOnline={detail.worker.online} />}
              </div>

              <div className="ws-final-info">
                <div className="av-card ws-fcard">
                  <div className="ws-fhead">
                    <h2>Bản v{fc.version}{fc.duration_s !== null || tl ? ` · ${dur(fc.duration_s ?? tl?.total ?? null)}` : ''}</h2>
                    {info && fc.status !== 'ready' && (
                      <span className={`av-badge ${toneCls(info.tone)}`}>{fc.status === 'rendering' && fc.progress !== null && !isWaitingToRender(fc) ? `${finalStatusLabel(fc)} ${Math.round(fc.progress)}%` : finalStatusLabel(fc)}</span>
                    )}
                    {fc.status === 'ready' && <span className={`av-badge ${fc.watermark_removed ? 'av-badge-ok' : 'av-badge-warn'}`}>{fc.watermark_removed ? 'Đã xoá logo Veo' : 'Còn logo Veo'}</span>}
                    {gradeChips(fc).map((c) => <span key={c} className="av-badge av-badge-info">Màu: {c}</span>)}
                    {fc.outdated && <span className="av-badge av-badge-warn">Cũ vì đổi video</span>}
                  </div>
                  {fc.status !== 'ready' && <Stages fc={fc} watermarkActive={wm.active} />}
                  {waiting && fc.status !== 'ready' && <span className="ws-warn" style={{ color: waiting.warn ? 'var(--warn-fg)' : 'var(--muted)' }}>{waiting.title}</span>}
                  {fc.parent_id && <span className="av-muted" style={{ fontSize: 12.5 }}>Từ bản v{fc.parent_version ?? '?'} · {fc.revision ? (fc.revision.edl_changed ? 'đã đổi điểm cắt' : 'giữ nguyên điểm cắt') : 'đang chờ AI'}</span>}
                  {fc.error && fc.status !== 'ready' && <div className="ws-note danger"><span><strong>Lỗi:</strong> {fc.error}</span></div>}
                  {fc.outdated && <div className="ws-note warn"><span>Bạn đã đổi video của một cảnh sau khi dựng, bấm «Edit lại tự động» để AI chọn lại điểm cắt.</span></div>}
                  {(clean.isError || cancel.isError) && <InlineError>{errorMessage(clean.error ?? cancel.error)}</InlineError>}
                  <div className="ws-actions">
                    {videoUrl && <LinkBtn href={videoUrl} download={`${planName}_v${fc.version}.mp4`} icon="download" primary small={false}>Tải video</LinkBtn>}
                    <Btn icon="edit" onClick={() => setEditing((v) => !v)} disabledReason={fc.edl ? null : 'Chưa có điểm cắt để chỉnh'}>{editing ? 'Đóng trình chỉnh' : 'Chỉnh điểm cắt'}</Btn>
                    {fc.status === 'ready' && <Btn icon="image" onClick={() => setGrading((v) => !v)}>{grading ? 'Đóng chỉnh màu' : 'Chỉnh màu'}</Btn>}
                    <CleanLogoView
                      fc={fc}
                      loading={clean.isPending}
                      disabledReason={!wm.active ? `Tool xoá logo Veo đang tắt: ${wm.reason}` : st && st.remaining.remove_logo <= 0 ? 'Đã hết lượt xoá logo, thử lại sau' : null}
                      onClick={() => clean.mutate(fc.id)}
                    />
                    {fc.status !== 'planning' && fc.status !== 'rendering' && createBtn}
                    {active && <Btn variant="danger" onClick={() => setConfirmCancel(true)}>Hủy bản dựng</Btn>}
                    {fc.raw_video_url && fc.status !== 'rendering' && (fc.watermark_removed || action === 'retry') && (
                      <a href={fc.raw_video_url} download={`${planName}_v${fc.version}_con-logo.mp4`} className="av-muted" style={{ fontSize: 12, textDecoration: 'underline' }}>Tải bản gốc còn logo</a>
                    )}
                  </div>
                </div>

                {fc.summary && (
                  <div className="av-card ws-fcard">
                    <h3>Tóm tắt của AI</h3>
                    <p className="ws-summary">{fc.summary}</p>
                  </div>
                )}
                {fc.note && (
                  <div className="av-card ws-fcard">
                    <h3>Ghi chú</h3>
                    <p className="ws-summary">{fc.note}</p>
                  </div>
                )}

                {fc.status === 'ready' && <Feedback fc={fc} api={revApi} blockReason={feedbackBlock} onCreated={onRevisionCreated} intent={fbIntent} />}
                {grading && fc.status === 'ready' && (
                  <div ref={gradeBox}>
                    <GradePanel key={fc.id} fc={fc} api={revApi} blockReason={gradeBlock} onCreated={onRevisionCreated} />
                  </div>
                )}
              </div>
            </div>

            {editing && (
              <div className="av-card ws-sec-card">
                <h3>Chỉnh điểm cắt</h3>
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

            {tl && (fc.status === 'ready' || fc.status === 'rendering' || fc.edl) && (
              <div className="av-card ws-sec-card">
                <h3>Điểm cắt theo cảnh</h3>
                <SceneTimeline tl={tl} currentOut={fc.status === 'ready' ? playT : null} onSeek={seekOut} />
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, width: 'fit-content' }}>Chi tiết đoạn bị cắt</summary>
                  <div style={{ marginTop: 10 }}>
                    <FinalTimeline tl={tl} currentOut={fc.status === 'ready' ? playT : null} onSeek={seekOut} />
                  </div>
                </details>
              </div>
            )}

            {hasRevisions(list) && (
              <div className="av-card ws-sec-card">
                <h3>Lịch sử góp ý</h3>
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
                {regrade.isError && <InlineError>{errorMessage(regrade.error)}</InlineError>}
              </div>
            )}

            {fc.contact_sheet_url && (
              <details className="av-card ws-sec-card">
                <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, width: 'fit-content' }}>Lưới khung hình</summary>
                <a href={fc.contact_sheet_url} target="_blank" rel="noreferrer">
                  <img src={fc.contact_sheet_url} alt={`Lưới khung hình bản hoàn chỉnh v${fc.version}`} loading="lazy" style={{ maxHeight: 256, maxWidth: '100%', objectFit: 'contain', borderRadius: 8, margin: '0 auto', display: 'block' }} />
                </a>
              </details>
            )}
          </>
        )}
      </div>

      {fc && (
        <aside className="ws-vers" aria-label="Các phiên bản">
          <span className="ws-rail-label">CÁC PHIÊN BẢN</span>
          {list.map((v, i) => {
            const sel = v.id === fc.id;
            const tone = v.status === 'failed' ? 'av-badge-danger' : v.status === 'cancelled' ? 'av-badge-neutral' : v.status === 'ready' ? (i === 0 ? 'av-badge-ok' : 'av-badge-neutral') : 'av-badge-info';
            return (
              <button key={v.id} type="button" className={`av-list-item ws-ver ${sel ? 'on' : ''}`} aria-current={sel} onClick={() => pickVersion(v.id)}>
                <span className={`av-badge ${tone}`}>v{v.version}</span>
                <span className="ws-ver-copy">
                  <strong>{creatorText(v)}</strong>
                  <span>{fmtDateTime(v.created_at)}{v.duration_s !== null ? ` · ${dur(v.duration_s)}` : ''}{v.status === 'ready' && v.watermark_removed ? ' · đã xoá logo' : ''}</span>
                  {v.status !== 'ready' && <span>{finalStatusLabel(v)}</span>}
                  {v.outdated && <span className="av-badge av-badge-warn">Cũ vì đổi video</span>}
                </span>
              </button>
            );
          })}
        </aside>
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
