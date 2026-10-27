import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, buttonClass } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CaptionEditor } from './CaptionEditor';
import { ClipCard } from './ClipCard';
import { useClipEnv } from './env';
import { useClipActions, useClipProject, useClipStatus, useTranscript } from './hooks';
import { readyClipCount } from './lib';
import { createPlayerStore } from './playerStore';
import { PlanForm } from './PlanForm';
import { ProjectSettings } from './ProjectSettings';
import { RangeBar, type Draft } from './RangeBar';
import { SourceInfo, UploadCard } from './SourceBlocks';
import { SourcePlayer, type SourcePlayerHandle } from './SourcePlayer';
import { Stepper } from './Stepper';
import { Transcript, type ClipMark, type TranscriptHandle } from './Transcript';
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
 * Trang làm việc của một dự án cắt clip (dùng cho cả app chính và trang LAN):
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
  const [pendingId, setPendingId] = useState<number | null>(null);

  useDocumentTitle(detail ? `${detail.project.name} · Cắt clip` : 'Cắt clip');

  // Lần đầu có clip thì mở tab Clip; chưa có thì mở tab Lời thoại.
  const hadClips = useRef<boolean | null>(null);
  useEffect(() => {
    if (!detail) return;
    const has = detail.clips.length > 0;
    if (hadClips.current === null) setTab(has ? 'clips' : 'transcript');
    hadClips.current = has;
  }, [detail]);

  const clips = detail?.clips ?? [];
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
  const marks = useMemo<ClipMark[]>(() => clips.filter((c) => c.status !== 'rejected').map((c) => ({ code: c.code, startWord: c.start_word, tone: c.status === 'approved' ? 'approved' : 'proposed' })), [clips]);

  const draftRange = draft && draft.start !== null ? { start: draft.start, end: draft.end ?? draft.start } : null;
  const selectedRange = selected ? { start: selected.start_word, end: selected.end_word } : null;

  const focusTranscript = () => {
    setTab('transcript');
    window.setTimeout(() => trBox.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  };
  const showPlayer = () => window.setTimeout(() => playerBox.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);

  const selectClip = (c: Clip) => {
    setSelectedId(c.id);
    tr.current?.scrollToWord(c.start_word, 'center');
  };
  const previewClip = (c: Clip) => {
    setSelectedId(c.id);
    player.current?.playRange(c.start_s, c.end_s, c.code);
    tr.current?.scrollToWord(c.start_word, 'center');
    showPlayer();
  };
  const editRange = (c: Clip) => {
    setSelectedId(c.id);
    setDraft({ clipId: c.id, code: c.code, start: c.start_word, end: c.end_word, picking: null, title: c.title ?? '', originalTitle: c.title ?? '' });
    focusTranscript();
    window.setTimeout(() => tr.current?.scrollToWord(c.start_word, 'center'), 80);
  };
  const startManual = () => {
    setDraft({ clipId: null, start: null, end: null, picking: 'start', title: '' });
    focusTranscript();
  };

  const onPick = (i: number) => {
    setDraft((d) => {
      if (!d?.picking) return d;
      if (d.picking === 'start') {
        const end = d.end !== null && d.end >= i ? d.end : null;
        return { ...d, start: i, end, picking: end === null ? 'end' : null };
      }
      if (d.start === null) return { ...d, start: i, picking: 'end' };
      return i < d.start ? { ...d, start: i, end: d.start, picking: null } : { ...d, end: i, picking: null };
    });
  };
  const onDragRange = (a: number, b: number) => {
    setDraft((d) => (d && d.clipId !== null ? { ...d, start: a, end: b, picking: null } : { clipId: null, start: a, end: b, picking: null, title: d?.title ?? '' }));
    setTab('transcript');
  };

  const editBlock = scope === 'lan' && quota?.edit !== undefined && quota.edit !== null && quota.edit <= 0 ? 'Bạn đã hết lượt chỉnh sửa trong giờ này, hãy thử lại sau' : null;
  const saveDraft = () => {
    if (!draft || draft.start === null || draft.end === null) return;
    const title = draft.title.trim();
    if (draft.clipId === null) {
      actions.createClip.mutate(
        { start_word: draft.start, end_word: draft.end, ...(title ? { title } : {}) },
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
        { id: draft.clipId, start_word: draft.start, end_word: draft.end, ...(title && title !== draft.originalTitle ? { title } : {}) },
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

  const doRender = (c: Clip, opts: { reframe_mode?: 'fit' | 'center'; captions_preset: 'highlight' | 'karaoke' | 'minimal' | 'none' }) => {
    setPendingId(c.id);
    actions.render.mutate(
      { id: c.id, ...opts },
      {
        onSuccess: () => {
          toast.success(`Đã xếp hàng dựng clip ${c.code}`);
          setStale((s) => {
            const n = new Set(s);
            n.delete(c.id);
            return n;
          });
        },
        onSettled: () => setPendingId(null),
      },
    );
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
  if (q.error || !detail) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Không tải được dự án cắt clip" />;

  const ready = readyClipCount(clips);
  const captionClip = clips.find((c) => c.id === captionId) ?? null;
  const transcribed = source?.status === 'transcribed';
  const planBlock = !source ? 'Tải video lên trước' : !transcribed ? 'Chờ nhận dạng lời nói xong' : transcript.error ? 'Chưa tải được lời thoại' : null;
  const fileBase = detail.project.slug || `clip-${projectId}`;

  const clipsPanel = (
    <div ref={clipsTop} className="space-y-3">
      <PlanForm detail={detail} canPlan={planBlock} />
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
            <EmptyState icon="film" title="Chưa có clip nào">
              {transcribed ? 'Nhờ AI đề xuất các đoạn hay ở trên, hoặc tự chọn một đoạn lời thoại để tạo clip thủ công.' : 'Clip đề xuất sẽ hiện ở đây sau khi video được nhận dạng lời nói.'}
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
                  renderBlock={renderBlockFor()}
                  captionsStale={stale.has(c.id)}
                  captionsAvailable={serverStatus ? { ok: serverStatus.captions.available, reason: serverStatus.captions.reason } : undefined}
                  busy={{ status: pendingId === c.id && actions.patchClip.isPending, render: pendingId === c.id && actions.render.isPending, cancel: actions.cancelCut.isPending && actions.cancelCut.variables === c.latest_cut?.id }}
                  onSelect={() => selectClip(c)}
                  onPreview={() => previewClip(c)}
                  onSetStatus={(s) => setStatus(c, s)}
                  onEditRange={() => editRange(c)}
                  onEditCaptions={() => {
                    if (!transcribed || idx.lastWord < 0) toast.info('Lời thoại chưa tải xong, đợi một chút rồi thử lại.');
                    else setCaptionId(c.id);
                  }}
                  onRender={(o) => doRender(c, o)}
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
          <Badge tone="violet">Cắt clip</Badge>
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
      {scope === 'lan' && quota?.known && (
        <p className="text-xs text-muted" aria-label="Lượt còn lại trong giờ này">
          Lượt còn lại trong giờ này:{' '}
          {[
            ['tải video', quota.source],
            ['nhờ AI chọn clip', quota.plan],
            ['dựng clip', quota.render],
            ['chỉnh sửa', quota.edit],
          ]
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => `${k} ${Math.max(0, v as number)}`)
            .join(' · ')}
          .
        </p>
      )}

      {!source ? (
        <UploadCard projectId={projectId} onUploaded={() => void actions.refresh()} disabledReason={scope === 'lan' && quota?.source !== undefined && quota.source !== null && quota.source <= 0 ? 'Bạn đã hết lượt tải video trong giờ này, hãy thử lại sau' : null} />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <div ref={playerBox} className="space-y-3 lg:sticky lg:top-14 lg:z-10 lg:bg-bg lg:pb-1">
              <SourcePlayer ref={player} source={source} store={store} />
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

            <div ref={trBox} className={tab === 'transcript' ? '' : 'hidden lg:block'}>
              {transcribed ? (
                <Transcript
                  ref={tr}
                  state={transcript}
                  store={store}
                  selected={selectedRange}
                  draft={draftRange}
                  picking={draft?.picking ?? null}
                  marks={marks}
                  onSeek={(t) => player.current?.seek(t)}
                  onPick={onPick}
                  onDragRange={onDragRange}
                  className={draft ? 'h-[min(86vh,780px)]' : 'h-[min(64vh,620px)]'}
                  toolbar={
                    draft ? (
                      <RangeBar
                        draft={draft}
                        idx={idx}
                        onChange={setDraft}
                        onPreview={(a, b, label) => {
                          player.current?.playRange(a, b, label);
                          showPlayer();
                        }}
                        onSave={saveDraft}
                        onCancel={() => setDraft(null)}
                        saving={actions.createClip.isPending || actions.patchClip.isPending}
                        quotaReason={editBlock}
                      />
                    ) : transcript.sentences.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
                        <span className="min-w-0 flex-1 basis-48">Bấm một từ để tua video tới đó. {scope === 'app' ? 'Kéo chuột qua các từ để tạo clip.' : ''}</span>
                        <Button size="sm" icon={<Icon name="plus" size={13} />} onClick={startManual} disabledReason={editBlock}>
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
            {transcribed && <SourceInfo projectId={projectId} source={source} hasClips={clips.length > 0} />}
          </div>

          <div className={`min-w-0 ${tab === 'clips' ? '' : 'hidden lg:block'}`}>{clipsPanel}</div>
        </div>
      )}

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
