import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, buttonClass } from '../components/Button';
import { Modal } from '../components/Modal';
import { errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CaptionEditor } from './CaptionEditor';
import { ClipCutTimeline, SourceClipTimeline } from './ClipCutTimeline';
import { ClipCard } from './ClipCard';
import { useClipEnv } from './env';
import { useClipActions, useClipProject, useClipStatus, useTranscript } from './hooks';
import { clipParts, clipPlaySegments, jobIsActive, planQuotaBlock, readyClipCount } from './lib';
import { createPlayerStore } from './playerStore';
import { PlanForm } from './PlanForm';
import { ProjectSettings } from './ProjectSettings';
import { activePart, RangeBar, withActive, type Draft } from './RangeBar';
import { SourceInfo, UploadCard } from './SourceBlocks';
import { SourcePlayer, type SourcePlayerHandle } from './SourcePlayer';
import { Stepper } from './Stepper';
import { Transcript, type ClipMark, type TranscriptHandle, type WordRange } from './Transcript';
import type { Clip, ClipStatus } from './types';
import { makeWordIndex } from './wordIndex';

type Filter = 'all' | ClipStatus;
type Sort = 'score' | 'time' | 'code';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'proposed', label: 'Đề xuất' },
  { value: 'approved', label: 'Đã duyệt' },
  { value: 'rejected', label: 'Đã bỏ' },
];

const codeNum = (c: string) => Number(c.replace(/\D/g, '')) || 0;

/**
 * Trang làm việc của một dự án highlight (dùng cho cả app chính và trang LAN):
 * trái = video nguồn + lời thoại, phải = AI đề xuất + danh sách clip. Trên điện thoại chuyển bằng hai tab.
 */
export function ClipWorkspace({ projectId, back, onDeleted }: { projectId: number; back: ReactNode; onDeleted: () => void }) {
  const { api, scope, quota } = useClipEnv();
  const q = useClipProject(projectId);
  const detail = q.data;
  const source = detail?.source ?? null;
  const transcript = useTranscript(source);
  const serverStatus = useClipStatus().data;
  const idx = useMemo(() => makeWordIndex(transcript.sentences), [transcript.sentences]);
  const actions = useClipActions(projectId);
  const store = useRef(createPlayerStore()).current;
  const player = useRef<SourcePlayerHandle>(null);
  const tr = useRef<TranscriptHandle>(null);
  const playerBox = useRef<HTMLDivElement>(null);
  const trBox = useRef<HTMLDivElement>(null);
  const clipsTop = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<'transcript' | 'clips'>('clips');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [captionId, setCaptionId] = useState<number | null>(null);
  const [stale, setStale] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('score');
  const [settings, setSettings] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [batchCaptions, setBatchCaptions] = useState<'highlight' | 'karaoke' | 'minimal' | 'none'>('highlight');
  const [pendingId, setPendingId] = useState<number | null>(null);

  useDocumentTitle(detail ? `${detail.project.name} · Highlight` : 'Highlight');

  // Lần đầu có clip thì mở tab Clip; chưa có thì mở tab Lời thoại.
  const hadClips = useRef<boolean | null>(null);
  useEffect(() => {
    if (!detail) return;
    const has = detail.clips.length > 0;
    if (hadClips.current === null) setTab(has ? 'clips' : 'transcript');
    hadClips.current = has;
  }, [detail]);

  const allClips = detail?.clips ?? [];
  const pendingClips = allClips.filter((c) => !c.cleanup && c.status !== 'rejected');
  const clips = allClips.filter((c) => !!c.cleanup);
  const selected = clips.find((c) => c.id === selectedId) ?? null;
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: clips.length, proposed: 0, approved: 0, rejected: 0 };
    for (const cl of clips) c[cl.status]++;
    return c;
  }, [clips]);
  const shown = useMemo(() => {
    const list = clips.filter((c) => filter === 'all' || c.status === filter);
    const by = { score: (a: Clip, b: Clip) => (b.score ?? -1) - (a.score ?? -1) || codeNum(a.code) - codeNum(b.code), time: (a: Clip, b: Clip) => a.start_s - b.start_s, code: (a: Clip, b: Clip) => codeNum(a.code) - codeNum(b.code) }[sort];
    return [...list].sort(by);
  }, [clips, filter, sort]);
  // Clip ghép: mỗi đoạn một nhãn ở câu đầu của đoạn (K2, K2·2, K2·3…).
  const marks = useMemo<ClipMark[]>(
    () =>
      clips
        .filter((c) => c.status !== 'rejected')
        .flatMap((c) => clipParts(c).map((p, k) => ({ code: k ? `${c.code}·${k + 1}` : c.code, startWord: p.start_word, tone: c.status === 'approved' ? ('approved' as const) : ('proposed' as const) }))),
    [clips],
  );

  const draftRanges = useMemo<WordRange[]>(() => (draft ? draft.parts.flatMap((p) => (p.start !== null ? [{ start: p.start, end: p.end ?? p.start }] : [])) : []), [draft]);
  // Các đoạn khác (không phải đoạn đang sửa) của clip ghép: vẫn tô khi kéo chọn lại đoạn đang sửa.
  const draftOthers = useMemo<WordRange[]>(() => (draft && draft.parts.length > 1 ? draft.parts.flatMap((p, k) => (k !== draft.active && p.start !== null ? [{ start: p.start, end: p.end ?? p.start }] : [])) : []), [draft]);
  const selectedRanges = useMemo<WordRange[]>(() => (selected ? clipParts(selected).map((p) => ({ start: p.start_word, end: p.end_word })) : []), [selected]);
  /** Từ đầu của đoạn phát trước (clip ghép có thể bắt đầu bằng một đoạn ở sau trong video). */
  const firstWord = (c: Clip) => clipParts(c)[0]?.start_word ?? c.start_word;

  // Màn hình rộng: cột video + lời thoại luôn dính trên màn hình, không cần cuộn trang tới.
  const narrow = () => typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches;
  const focusTranscript = () => {
    setTab('transcript');
    if (narrow()) window.setTimeout(() => trBox.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  };
  const showPlayer = () => { if (narrow()) window.setTimeout(() => playerBox.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30); };

  const selectClip = (c: Clip) => {
    setSelectedId(c.id);
    tr.current?.scrollToWord(firstWord(c), 'center');
  };
  const previewClip = (c: Clip) => {
    setSelectedId(c.id);
    if (!c.cleanup) return;
    player.current?.playSegments(clipPlaySegments(c), `${c.code} · đã làm gọn`);
    tr.current?.scrollToWord(firstWord(c), 'center');
    showPlayer();
  };
  const editRange = (c: Clip) => {
    setSelectedId(c.id);
    setDraft({ clipId: c.id, code: c.code, parts: clipParts(c).map((p) => ({ start: p.start_word, end: p.end_word })), active: 0, picking: null, title: c.title ?? '', originalTitle: c.title ?? '' });
    focusTranscript();
    window.setTimeout(() => tr.current?.scrollToWord(firstWord(c), 'center'), 80);
  };
  const startManual = () => {
    setDraft({ clipId: null, parts: [{ start: null, end: null }], active: 0, picking: 'start', title: '' });
    focusTranscript();
  };

  // Bấm từ / kéo chọn trong lời thoại: áp vào đoạn đang sửa.
  const onPick = (i: number) => {
    setDraft((d) => {
      if (!d?.picking) return d;
      const p = activePart(d);
      if (d.picking === 'start') {
        const end = p.end !== null && p.end >= i ? p.end : null;
        return withActive(d, { start: i, end }, { picking: end === null ? 'end' : null });
      }
      if (p.start === null) return withActive(d, { start: i }, { picking: 'end' });
      return i < p.start ? withActive(d, { start: i, end: p.start }, { picking: null }) : withActive(d, { end: i }, { picking: null });
    });
  };
  const onDragRange = (a: number, b: number) => {
    setDraft((d) => (d ? withActive(d, { start: a, end: b }, { picking: null }) : { clipId: null, parts: [{ start: a, end: b }], active: 0, picking: null, title: '' }));
    setTab('transcript');
  };

  const editBlock = scope === 'lan' && quota?.edit !== undefined && quota.edit !== null && quota.edit <= 0 ? 'Bạn đã hết lượt chỉnh sửa trong giờ này, hãy thử lại sau' : null;
  const saveDraft = () => {
    if (!draft || draft.parts.some((p) => p.start === null || p.end === null)) return;
    const title = draft.title.trim();
    const ranges = draft.parts.map((p) => ({ start_word: p.start!, end_word: p.end! }));
    // Một đoạn: gửi như cũ (start_word/end_word; với clip đang ghép thì đưa về một đoạn). Nhiều đoạn: gửi `parts` theo thứ tự phát.
    const range = ranges.length > 1 ? { parts: ranges } : ranges[0]!;
    if (draft.clipId === null) {
      actions.createClip.mutate(
        { ...range, ...(title ? { title } : {}) },
        {
          onSuccess: (clip) => {
            toast.success('Đã tạo clip thủ công');
            setDraft(null);
            if (clip && typeof clip === 'object' && 'id' in clip) setSelectedId(clip.id);
            setTab('clips');
            window.setTimeout(() => clipsTop.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
          },
        },
      );
    } else {
      actions.patchClip.mutate(
        { id: draft.clipId, ...range, ...(title && title !== draft.originalTitle ? { title } : {}) },
        {
          onSuccess: () => {
            toast.success(`Đã cập nhật điểm cắt ${draft.code ?? ''}`);
            setDraft(null);
            setTab('clips');
          },
        },
      );
    }
  };

  const setStatus = (c: Clip, status: Clip['status']) => {
    setPendingId(c.id);
    actions.patchClip.mutate({ id: c.id, status }, { onSettled: () => setPendingId(null) });
  };

  const renderBlockFor = (): string | null =>
    source?.source_deleted
      ? 'Video gốc đã bị xoá nên không dựng được clip mới (vẫn tải được các bản đã dựng).'
      : scope === 'lan' && quota?.render !== undefined && quota.render !== null && quota.render <= 0
        ? 'Bạn đã hết lượt dựng clip trong giờ này, hãy thử lại sau'
        : null;

  const approveAndRender = async (c: Clip, opts: { reframe_mode?: 'fit' | 'center'; captions_preset: 'highlight' | 'karaoke' | 'minimal' | 'none' }) => {
    setPendingId(c.id);
    try {
      if (c.status !== 'approved') await actions.patchClip.mutateAsync({ id: c.id, status: 'approved' });
      await actions.render.mutateAsync({ id: c.id, ...opts });
      setStale((old) => { const next = new Set(old); next.delete(c.id); return next; });
      toast.success(`Đã xếp hàng dựng clip ${c.code}`);
    } catch { /* Mutation handler displays the API error; successful approval is retained. */ }
    finally { setPendingId(null); }
  };
  const batchEligible = clips.filter((c) => c.status === 'approved' && !jobIsActive(c.cleanup_job) && c.latest_cut?.status !== 'rendering' && (c.latest_cut?.status !== 'ready' || c.latest_cut_stale || stale.has(c.id)));
  const runBatch = async () => {
    const targets = [...batchEligible]; let submitted = 0;
    setBatchRunning(true); setBatchMessage(null);
    try {
      for (const c of targets) {
        setPendingId(c.id);
        await actions.render.mutateAsync({ id: c.id, reframe_mode: 'fit', captions_preset: serverStatus?.captions.available === false ? 'none' : batchCaptions });
        submitted++;
        setStale((old) => { const next = new Set(old); next.delete(c.id); return next; });
      }
      setBatchOpen(false); toast.success(`Đã xếp hàng dựng ${submitted} clip`);
    } catch (e) {
      setBatchMessage(`Đã xếp ${submitted}/${targets.length} clip. ${errorMessage(e)} Kiểm tra trạng thái các clip trước khi tiếp tục.`);
    } finally { setPendingId(null); setBatchRunning(false); }
  };

  if (q.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.error || !detail) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Không tải được dự án highlight" />;

  const ready = readyClipCount(clips);
  const captionClip = clips.find((c) => c.id === captionId) ?? null;
  const transcribed = source?.status === 'transcribed';
  const planBlock = !source ? 'Tải video lên trước' : !transcribed ? 'Chờ nhận dạng lời nói xong' : transcript.error ? 'Chưa tải được lời thoại' : clips.some((c) => jobIsActive(c.cleanup_job)) ? 'Chờ AI làm gọn xong' : null;
  const fileBase = detail.project.slug || `clip-${projectId}`;

  const clipsPanel = (
    <div ref={clipsTop} className="space-y-3">
      <PlanForm detail={detail} canPlan={pendingClips.length ? 'Đợi bước làm gọn bắt buộc hoàn tất' : planBlock} />
      {pendingClips.length > 0 && <section className="space-y-2 rounded-lg border border-info-fg/30 bg-info-bg p-3" aria-label="Đang làm gọn clip bắt buộc">
        <p className="text-sm font-semibold">Đang hoàn tất {pendingClips.length} clip trước khi hiển thị</p>
        <p className="text-xs">AI tự cắt tiếng đệm, nói vấp và phần nói lại. Clip hoàn tất sẽ xuất hiện bên dưới cùng điểm cắt để bạn chỉnh tay.</p>
        {pendingClips.map((c) => <p key={c.id} className="text-xs" role="status">{c.code}: {c.cleanup_job?.error ?? (c.cleanup_state === 'processing' ? c.cleanup_job?.wait_reason === 'ai_quota' ? 'Chờ tài khoản AI khả dụng' : c.cleanup_job?.status === 'queued' ? 'Chờ xử lý' : 'Đang làm gọn lời nói' : source?.source_deleted ? 'Không còn video gốc để xử lý' : 'Chờ bước làm gọn bắt buộc')}</p>)}
        {!pendingClips.some((c) => c.cleanup_state === 'processing') && <Button size="sm" loading={actions.processClips.isPending} disabledReason={source?.source_deleted ? 'Video gốc đã xoá' : serverStatus?.cleanup?.configured === false ? 'Cần managed worker nhận clip_plan' : planQuotaBlock(quota)} onClick={() => actions.processClips.mutate()}>Tiếp tục xử lý clip</Button>}
      </section>}
      <section aria-labelledby="clips-h" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="clips-h" className="mr-auto text-[15px] font-semibold">
            Clip ({clips.length})
          </h2>
          {transcribed && (
            <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={startManual} disabledReason={editBlock}>
              Tạo clip thủ công
            </Button>
          )}
          <Button size="sm" icon={<Icon name="film" size={14} />} loading={batchRunning} disabledReason={renderBlockFor() ?? (!batchEligible.length ? 'Duyệt clip chưa có bản dựng mới để dùng thao tác này' : null)} onClick={() => { setBatchMessage(null); setBatchOpen(true); }}>Dựng tất cả clip đã duyệt{batchEligible.length ? ` (${batchEligible.length})` : ''}</Button>
          {ready > 0 ? (
            <a href={api.zipUrl(projectId)} download className={buttonClass('secondary', 'sm')}>
              <Icon name="download" size={14} /> Tải tất cả (ZIP) · {ready}
            </a>
          ) : (
            <Button size="sm" disabledReason="Chưa có clip nào dựng xong" icon={<Icon name="download" size={14} />}>
              Tải tất cả (ZIP)
            </Button>
          )}
        </div>
        {clips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={`min-h-8 rounded-full border px-3 text-xs font-medium ${filter === f.value ? 'border-ink bg-ink text-ink-fg' : 'border-line-strong bg-surface hover:bg-surface-2'}`}
              >
                {f.label} {counts[f.value]}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
              Sắp xếp
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="min-h-8 w-auto py-0.5 text-xs" aria-label="Sắp xếp clip">
                <option value="score">Điểm cao trước</option>
                <option value="time">Theo thời gian</option>
                <option value="code">Theo mã</option>
              </select>
            </label>
          </div>
        )}
        {clips.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-strong">
            <EmptyState icon="film" title={pendingClips.length ? "Chưa có clip xử lý xong" : "Chưa có clip nào"}>
              {pendingClips.length ? 'Clip đang được làm gọn tự động; xử lý xong mới xuất hiện ở đây.' : transcribed ? 'Nhờ AI đề xuất highlight ở trên, hoặc tự chọn một đoạn lời thoại để tạo clip thủ công.' : 'Clip đề xuất sẽ hiện ở đây sau khi video được nhận dạng lời nói.'}
            </EmptyState>
          </div>
        ) : shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[13px] text-muted">Không có clip nào ở nhóm này.</p>
        ) : (
          <ul className="space-y-3">
            {shown.map((c) => (
              <li key={c.id}>
                <ClipCard
                  clip={c}
                  source={source}
                  fileBase={fileBase}
                  selected={c.id === selectedId}
                  renderBlock={batchRunning ? 'Đang xếp hàng các clip đã duyệt' : renderBlockFor() ?? (c.status !== 'approved' ? editBlock : null)}
                  captionsStale={stale.has(c.id) || !!c.latest_cut_stale}
                  captionsAvailable={serverStatus ? { ok: serverStatus.captions.available, reason: serverStatus.captions.reason } : undefined}
                  busy={{ status: batchRunning || (pendingId === c.id && actions.patchClip.isPending), render: pendingId === c.id && actions.render.isPending, cancel: actions.cancelCut.isPending && actions.cancelCut.variables === c.latest_cut?.id }}
                  onSelect={() => selectClip(c)}
                  onPreview={() => previewClip(c)}
                  onSetStatus={(s) => setStatus(c, s)}
                  onEditRange={() => editRange(c)}
                  timeline={<ClipCutTimeline key={`${c.id}:${c.cleanup!.job_id}:${c.cleanup!.revision}`} clip={c} idx={idx} store={store}
                    onSeek={(t) => { setSelectedId(c.id); player.current?.seek(t); }}
                    onPreview={(segments, label) => { setSelectedId(c.id); player.current?.playSegments(segments, label); showPlayer(); }}
                    saving={actions.applyCleanup.isPending && actions.applyCleanup.variables?.id === c.id}
                    onSave={async (ids, edits) => {
                      await actions.applyCleanup.mutateAsync({ id: c.id, job_id: c.cleanup!.job_id, revision: c.cleanup!.revision, selected_ids: ids, edits });
                      setStale((s) => new Set(s).add(c.id));
                      toast.success('Đã lưu điểm cắt. Dựng lại để cập nhật video tải về.');
                    }} /> }
                  onEditCaptions={() => {
                    if (!transcribed || idx.lastWord < 0) toast.info('Lời thoại chưa tải xong, đợi một chút rồi thử lại.');
                    else setCaptionId(c.id);
                  }}
                  onApproveRender={(o) => void approveAndRender(c, o)}
                  onCancel={(id) => actions.cancelCut.mutate(id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        {back}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-xl font-bold tracking-tight">{detail.project.name}</h1>
          <Badge tone="violet">Highlight</Badge>
          {detail.project.source === 'lan' && detail.project.created_by_name && <span className="text-xs text-muted">tạo bởi {detail.project.created_by_name}</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" icon={<Icon name="gear" size={14} />} onClick={() => setSettings(true)}>
              Cài đặt
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface px-2 py-3 sm:px-4">
        <Stepper detail={detail} />
      </div>
      {scope === 'lan' && quota?.known && ((quota.source != null && quota.source <= 1) || (quota.plan != null && quota.plan <= 1) || (quota.render != null && quota.render <= 3) || (quota.edit != null && quota.edit <= 10)) && (
        <p className="text-xs text-muted" aria-label="Lượt còn lại trong giờ này">
          Lượt còn lại trong giờ này:{' '}
          {[
            ['tải video', quota.source],
            ['nhờ AI đề xuất highlight', quota.plan],
            ['dựng clip', quota.render],
            ['chỉnh sửa', quota.edit],
          ]
            .filter(([k, v]) => v !== null && v !== undefined && (v as number) <= (k === 'dựng clip' ? 3 : k === 'chỉnh sửa' ? 10 : 1))
            .map(([k, v]) => `${k} ${Math.max(0, v as number)}`)
            .join(' · ')}
          .
        </p>
      )}

      {!source ? (
        <UploadCard projectId={projectId} onUploaded={() => void actions.refresh()} disabledReason={scope === 'lan' && quota?.source !== undefined && quota.source !== null && quota.source <= 0 ? 'Bạn đã hết lượt tải video trong giờ này, hãy thử lại sau' : null} />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className={`min-w-0 space-y-3 ${transcribed ? 'lg:sticky lg:top-[4.25rem] lg:flex lg:h-[calc(100dvh-5.25rem)] lg:flex-col lg:gap-3 lg:space-y-0' : ''}`}>
            <div ref={playerBox} className="space-y-2 lg:shrink-0">
              <SourcePlayer ref={player} source={source} store={store} compact={!!draft} />
              <SourceClipTimeline source={source} clips={clips} selectedId={selectedId} store={store} onSelect={previewClip} />
            </div>
            {!transcribed && <SourceInfo projectId={projectId} source={source} hasClips={clips.length > 0} />}

            <div role="tablist" aria-label="Chuyển giữa lời thoại và clip" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-3 p-1 lg:hidden">
              {(['transcript', 'clips'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`min-h-9 rounded-md text-[13px] font-semibold ${tab === t ? 'bg-surface shadow-sm' : 'text-muted'}`}
                >
                  {t === 'transcript' ? 'Lời thoại' : `Clip (${clips.length})`}
                </button>
              ))}
            </div>

            <div ref={trBox} className={`${tab === 'transcript' ? '' : 'hidden'} lg:flex lg:min-h-0 lg:flex-1 lg:flex-col`}>
              {transcribed ? (
                <Transcript
                  ref={tr}
                  state={transcript}
                  store={store}
                  selected={selectedRanges}
                  draft={draftRanges}
                  draftOthers={draftOthers}
                  picking={draft?.picking ?? null}
                  marks={marks}
                  onSeek={(t) => player.current?.seek(t)}
                  onPick={onPick}
                  onDragRange={onDragRange}
                  className={`${draft ? 'h-[min(86vh,780px)]' : 'h-[min(64vh,620px)]'} lg:h-auto lg:min-h-0 lg:flex-1`}
                  toolbar={
                    draft ? (
                      <RangeBar
                        draft={draft}
                        idx={idx}
                        onChange={setDraft}
                        onPreview={(segments, label) => {
                          player.current?.playSegments(segments, label);
                          showPlayer();
                        }}
                        onShowWord={(i) => tr.current?.scrollToWord(i, 'center')}
                        onSave={saveDraft}
                        onCancel={() => setDraft(null)}
                        saving={actions.createClip.isPending || actions.patchClip.isPending}
                        quotaReason={editBlock}
                      />
                    ) : transcript.sentences.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
                        <span className="min-w-0 flex-1 basis-48">Bấm một từ để tua video tới đó.{scope === 'app' ? ' Kéo chuột qua các từ để tạo clip.' : ''}</span>
                        <Button size="sm" icon={<Icon name="scissors" size={13} />} onClick={startManual} disabledReason={editBlock}>
                          Tạo clip từ lời thoại
                        </Button>
                      </div>
                    ) : null
                  }
                />
              ) : (
                <div className="grid h-48 place-items-center rounded-lg border border-dashed border-line-strong bg-surface-2 p-4 text-center text-[13px] text-muted">
                  <div>
                    <Icon name="comment" size={22} className="mx-auto mb-1" />
                    Lời thoại sẽ hiện ở đây khi nhận dạng xong. Bạn có thể bấm vào từ để tua video và bôi chọn để tạo clip.
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={`min-w-0 space-y-3 ${tab === 'clips' ? '' : 'hidden lg:block'}`}>
            {clipsPanel}
            {transcribed && <SourceInfo projectId={projectId} source={source} hasClips={clips.length > 0} />}
          </div>
        </div>
      )}

      {batchMessage && <p role="status" className="rounded-md bg-warn-bg p-3 text-xs text-warn-fg">{batchMessage}</p>}
      <Modal open={batchOpen} onClose={() => setBatchOpen(false)} title="Dựng các clip đã duyệt" footer={<><Button onClick={() => setBatchOpen(false)}>Đóng</Button><Button variant="primary" loading={batchRunning} disabledReason={!batchEligible.length ? 'Các clip đã được xếp hàng' : renderBlockFor() ?? (quota?.render != null && batchEligible.length > quota.render ? `Cần ${batchEligible.length} lượt dựng, còn ${quota.render} lượt` : null)} onClick={() => void runBatch()}>Xếp hàng dựng {batchEligible.length} clip</Button></>}>
        <p className="text-sm">Dựng {batchEligible.length} clip đã duyệt chưa có bản phù hợp. Các clip chạy theo hàng đợi chung.</p>
        <label className="mt-3 block text-xs font-semibold" htmlFor="batch-captions">Phụ đề cho các clip</label><select id="batch-captions" className="mt-1 w-full" disabled={batchRunning || serverStatus?.captions.available === false} value={serverStatus?.captions.available === false ? 'none' : batchCaptions} onChange={(e) => setBatchCaptions(e.target.value as typeof batchCaptions)}><option value="highlight">Tô vàng từng từ</option><option value="karaoke">Karaoke xanh</option><option value="minimal">Tối giản</option><option value="none">Không phụ đề</option></select>
        {batchMessage && <p role="status" className="mt-3 text-xs text-warn-fg">{batchMessage}</p>}
      </Modal>
      <ProjectSettings
        key={settings ? 'open' : 'closed'}
        open={settings}
        detail={detail}
        onClose={() => setSettings(false)}
        onDeleted={onDeleted}
        onRetranscribe={() => source && actions.transcribe.mutate(source.id)}
      />
      {captionClip && (
        <CaptionEditor
          key={captionClip.id}
          open
          clip={captionClip}
          idx={idx}
          canRender={renderBlockFor()}
          onClose={() => setCaptionId(null)}
          onSave={async (words, thenRender) => {
            await actions.putCaptions.mutateAsync({ id: captionClip.id, words });
            if (thenRender) {
              const cut = captionClip.latest_cut;
              await actions.render.mutateAsync({ id: captionClip.id, reframe_mode: cut?.reframe?.mode, captions_preset: cut?.captions?.preset ?? 'highlight' });
              toast.success(`Đã lưu phụ đề và xếp hàng dựng lại ${captionClip.code}`);
            } else {
              toast.success('Đã lưu phụ đề. Bấm «Dựng lại» để áp dụng vào video.');
              setStale((s) => new Set(s).add(captionClip.id));
            }
          }}
        />
      )}
    </div>
  );
}
