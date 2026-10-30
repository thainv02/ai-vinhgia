import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../api/errors';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ErrorState, Skeleton } from '../components/States';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CaptionEditor } from './CaptionEditor';
import { useClipEnv } from './env';
import { useClipActions, useClipProject, useClipStatus, useTranscript } from './hooks';
import { clock, cutIsActive, pct100, readyClipCount, SOURCE_STATUS_LABEL, spokenDuration } from './lib';
import { createPlayerStore } from './playerStore';
import { PlanForm } from './PlanForm';
import { ProjectSettings } from './ProjectSettings';
import { RangeBar, type Draft } from './RangeBar';
import { SourceInfo, UploadCard } from './SourceBlocks';
import { SourcePlayer, type SourcePlayerHandle } from './SourcePlayer';
import { SubtitleStage } from './SubtitleStage';
import type { CaptionLayout } from './subtitleBox';
import { Transcript, type ClipMark, type TranscriptHandle } from './Transcript';
import type { CaptionPreset, Clip } from './types';
import { makeWordIndex } from './wordIndex';
import './clips-desktop.css';

const codeNum = (c: string) => Number(c.replace(/\D/g, '')) || 0;
const COMMIT_DEBOUNCE_MS = 350;
const PRESET_LABEL: Record<CaptionPreset, string> = { highlight: 'Tô từng từ', karaoke: 'Karaoke', minimal: 'Tối giản', none: 'Không' };

/** Nhãn trạng thái của clip trong danh sách bên trái. */
function clipBadge(c: Clip): { tone: string; label: string } {
  const cut = c.latest_cut;
  if (c.status === 'rejected') return { tone: 'neutral', label: 'Bỏ qua' };
  if (cut && cutIsActive(cut)) return { tone: 'info', label: `Đang dựng${pct100(cut.progress) !== null ? ` ${Math.round(pct100(cut.progress)!)}%` : ''}` };
  if (cut?.status === 'failed') return { tone: 'danger', label: 'Dựng lỗi' };
  if (cut?.status === 'ready') return c.captions_outdated ? { tone: 'warn', label: `Cần dựng lại (v${cut.version})` } : { tone: 'ok', label: `Đã dựng v${cut.version}` };
  return c.status === 'approved' ? { tone: 'info', label: 'Đã duyệt' } : { tone: 'warn', label: 'Chờ duyệt' };
}

/**
 * Không gian làm việc của một dự án cắt clip (app desktop): trái = danh sách clip, giữa = video nguồn + thanh vị trí + lời thoại,
 * phải = khung 9:16 có hộp phụ đề kéo-thả, kiểu chữ, xem thử khung hình và dựng lại.
 */
export function DesktopClipWorkspace({ projectId, crumb, onDeleted }: { projectId: number; crumb: ReactNode; onDeleted: () => void }) {
  const { api } = useClipEnv();
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

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [captionId, setCaptionId] = useState<number | null>(null);
  const [wordsStale, setWordsStale] = useState<Set<number>>(new Set());
  const [settings, setSettings] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  // kiểu phụ đề đang chỉnh của clip đang chọn (hộp HTML cập nhật tức thì; lưu khi thả chuột)
  const [style, setStyle] = useState<{ preset: CaptionPreset; layout: CaptionLayout | null }>({ preset: 'highlight', layout: null });
  const [frame, setFrame] = useState<{ clipId: number; url: string } | null>(null);
  const commitTimer = useRef<number | null>(null);
  const pendingCommit = useRef<Promise<unknown> | null>(null);

  useDocumentTitle(detail ? `${detail.project.name} · Cắt clip` : 'Cắt clip');

  const clips = useMemo(() => [...(detail?.clips ?? [])].sort((a, b) => codeNum(a.code) - codeNum(b.code)), [detail?.clips]);
  // mở sẵn clip đầu tiên
  useEffect(() => {
    if (selectedId === null && clips.length) setSelectedId(clips[0]!.id);
  }, [clips, selectedId]);
  const selected = clips.find((c) => c.id === selectedId) ?? null;

  // đồng bộ kiểu đang chỉnh với kiểu đã lưu khi đổi clip hoặc server trả giá trị mới (không ghi đè khi đang chờ lưu)
  const savedKey = selected ? JSON.stringify(selected.captions ?? { preset: 'highlight', layout: null }) : '';
  useEffect(() => {
    if (commitTimer.current !== null) return;
    const s = selected?.captions;
    setStyle({ preset: s?.preset ?? 'highlight', layout: s?.layout ?? null });
  }, [selected?.id, savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setFrame(null), [selected?.id]);
  useEffect(() => () => void (commitTimer.current !== null && window.clearTimeout(commitTimer.current)), []);

  const marks = useMemo<ClipMark[]>(() => clips.filter((c) => c.status !== 'rejected').map((c) => ({ code: c.code, startWord: c.start_word, tone: c.status === 'approved' ? 'approved' : 'proposed' })), [clips]);
  const draftRange = draft && draft.start !== null ? { start: draft.start, end: draft.end ?? draft.start } : null;
  const selectedRange = selected ? { start: selected.start_word, end: selected.end_word } : null;

  const selectClip = (c: Clip) => {
    setSelectedId(c.id);
    tr.current?.scrollToWord(c.start_word, 'center');
    player.current?.seek(c.start_s);
  };
  const editRange = (c: Clip) => {
    setSelectedId(c.id);
    setDraft({ clipId: c.id, code: c.code, start: c.start_word, end: c.end_word, picking: null, title: c.title ?? '', originalTitle: c.title ?? '' });
    window.setTimeout(() => tr.current?.scrollToWord(c.start_word, 'center'), 80);
  };
  const startManual = () => setDraft({ clipId: null, start: null, end: null, picking: 'start', title: '' });
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
  const onDragRange = (a: number, b: number) => setDraft((d) => (d && d.clipId !== null ? { ...d, start: a, end: b, picking: null } : { clipId: null, start: a, end: b, picking: null, title: d?.title ?? '' }));

  const saveDraft = () => {
    if (!draft || draft.start === null || draft.end === null) return;
    const title = draft.title.trim();
    if (draft.clipId === null) {
      actions.createClip.mutate(
        { start_word: draft.start, end_word: draft.end, ...(title ? { title } : {}) },
        {
          onSuccess: (clip) => {
            toast.success('Đã tạo clip');
            setDraft(null);
            if (clip && typeof clip === 'object' && 'id' in clip) setSelectedId(clip.id);
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
          },
        },
      );
    }
  };

  // ---- lưu kiểu phụ đề ----
  const patchStyle = useCallback(
    (id: number, captions: { preset?: CaptionPreset; layout?: CaptionLayout | null }) => {
      const p = actions.patchClip.mutateAsync({ id, captions }).catch(() => undefined);
      pendingCommit.current = p;
      return p;
    },
    [actions.patchClip],
  );
  const onLayout = useCallback((l: CaptionLayout) => {
    setStyle((s) => ({ ...s, layout: l }));
    setFrame(null);
  }, []);
  const onCommit = useCallback(
    (l: CaptionLayout) => {
      const id = selectedIdRef.current;
      if (id === null) return;
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(() => {
        commitTimer.current = null;
        void patchStyle(id, { layout: l });
      }, COMMIT_DEBOUNCE_MS);
    },
    [patchStyle],
  );
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  /** Đẩy ngay thay đổi vị trí còn chờ lưu (trước khi dựng/xem thử). */
  const flush = async () => {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
      if (selected) await patchStyle(selected.id, { layout: style.layout });
    }
    await pendingCommit.current;
  };

  const setPreset = (preset: CaptionPreset) => {
    if (!selected) return;
    setStyle((s) => ({ ...s, preset }));
    setFrame(null);
    void patchStyle(selected.id, { preset });
  };

  const preview = useMutation({
    mutationFn: async (c: Clip) => {
      const t = store.getTime();
      const at = t >= c.start_s && t <= c.end_s ? t - c.start_s : undefined;
      return api.previewFrame(c.id, { ...(at !== undefined ? { at } : {}), captions: { preset: style.preset, layout: style.layout } });
    },
    meta: { silent: true },
    onSuccess: (r, c) => setFrame({ clipId: c.id, url: r.url }),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PREVIEW_STALE') return;
      toast.error(e instanceof Error ? e.message : 'Không dựng được khung xem thử');
    },
  });

  const renderBlock = source?.source_deleted ? 'Video gốc đã bị xoá nên không dựng được clip mới' : null;
  const doRender = async (c: Clip) => {
    await flush();
    actions.render.mutate(
      { id: c.id, reframe_mode: c.latest_cut?.reframe?.mode },
      {
        onSuccess: () => {
          toast.success(`Đã xếp hàng dựng ${c.code}`);
          setWordsStale((s) => {
            const n = new Set(s);
            n.delete(c.id);
            return n;
          });
        },
      },
    );
  };

  if (q.isLoading) {
    return (
      <div className="cd-ws" aria-busy="true">
        <div className="av-page-head">
          <Skeleton className="h-10 w-64" />
        </div>
        <div className="cd-body">
          <Skeleton className="m-4 h-64 w-full" />
        </div>
      </div>
    );
  }
  if (q.error || !detail) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Không tải được dự án cắt clip" />;

  const transcribed = source?.status === 'transcribed';
  const ready = readyClipCount(clips);
  const planBlock = !source ? 'Tải video lên trước' : !transcribed ? 'Chờ nhận dạng lời nói xong' : transcript.error ? 'Chưa tải được lời thoại' : null;
  const captionClip = clips.find((c) => c.id === captionId) ?? null;
  const cut = selected?.latest_cut ?? null;
  const rendering = cutIsActive(cut);
  const outdated = !!selected && (selected.captions_outdated || wordsStale.has(selected.id)) && cut?.status === 'ready';
  const captionsOk = serverStatus ? serverStatus.captions.available : true;
  const sourceBadge = source ? (transcribed ? `Đã nhận dạng lời nói${source.duration_s ? ` · ${clock(source.duration_s)}` : ''}` : (SOURCE_STATUS_LABEL[source.status] ?? source.status)) : 'Chưa tải video';
  const draftReady = !!draft && draft.clipId === null && draft.start !== null && draft.end !== null;
  const dur = source?.duration_s ?? 0;

  return (
    <div className="cd-ws">
      <header className="cd-head">
        <div className="av-page-head">
          <div className="cd-title">
            <nav className="av-crumb" aria-label="Đường dẫn">
              {crumb}
              <span className="av-muted"> / {detail.project.name}</span>
            </nav>
            <div className="cd-title-row">
              <h1>{detail.project.name}</h1>
              <span className={`av-badge ${transcribed ? 'av-badge-ok' : source?.status === 'failed' ? 'av-badge-danger' : 'av-badge-warn'}`}>{sourceBadge}</span>
            </div>
          </div>
          <button type="button" className="av-btn av-btn-sm" disabled={!!planBlock} title={planBlock ?? undefined} onClick={() => setPlanOpen(true)}>
            AI chọn thêm đoạn
          </button>
          <button
            type="button"
            className="av-btn av-btn-sm"
            disabled={!transcribed}
            onClick={() => (draftReady ? saveDraft() : startManual())}
          >
            Tạo clip từ đoạn đang chọn
          </button>
          {ready > 0 ? (
            <a className="av-btn av-btn-sm" href={api.zipUrl(projectId)} download>
              Tải tất cả .zip
            </a>
          ) : (
            <button type="button" className="av-btn av-btn-sm" disabled title="Chưa có clip nào dựng xong">
              Tải tất cả .zip
            </button>
          )}
          <button type="button" className="av-btn av-btn-sm av-btn-ghost" aria-label="Cài đặt dự án" onClick={() => setSettings(true)}>
            <Icon name="gear" size={15} />
          </button>
        </div>
      </header>

      {!source ? (
        <div className="cd-center">
          <UploadCard projectId={projectId} onUploaded={() => void actions.refresh()} />
        </div>
      ) : (
        <div className="cd-body">
          <nav className="cd-list" aria-label="Danh sách clip">
            <span className="cd-list-label">Clip · {clips.length}</span>
            {clips.length === 0 && <span className="cd-sub-line av-muted" style={{ padding: '0 6px', fontSize: 12.5 }}>Chưa có clip.</span>}
            {clips.map((c) => {
              const b = clipBadge(c);
              return (
                <button key={c.id} type="button" className="cd-clip" aria-current={c.id === selectedId} onClick={() => selectClip(c)}>
                  <strong>
                    {c.code}
                    {c.title ? ` · ${c.title}` : ''}
                  </strong>
                  <span className="cd-sub-line">
                    {clock(c.start_s)}–{clock(c.end_s)} · {spokenDuration(c.duration_s)}
                  </span>
                  <span className={`av-badge av-badge-${b.tone}`}>{b.label}</span>
                </button>
              );
            })}
          </nav>

          <section className="cd-center">
            <div className="cd-player">
              <SourcePlayer ref={player} source={source} store={store} />
            </div>
            {dur > 0 && clips.length > 0 && (
              <div className="cd-overview" role="group" aria-label="Vị trí các clip trên video gốc">
                {clips.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={`${c.code} · ${clock(c.start_s)}–${clock(c.end_s)}`}
                    aria-current={c.id === selectedId}
                    style={{ left: `${(c.start_s / dur) * 100}%`, width: `${Math.max(0.4, ((c.end_s - c.start_s) / dur) * 100)}%` }}
                    onClick={() => selectClip(c)}
                  />
                ))}
              </div>
            )}
            {!transcribed && <SourceInfo projectId={projectId} source={source} hasClips={clips.length > 0} />}
            {selected && (
              <div className="cd-actions">
                <button type="button" className="av-btn av-btn-sm" onClick={() => player.current?.playRange(selected.start_s, selected.end_s, selected.code)}>
                  <Icon name="play" size={13} /> Phát {selected.code}
                </button>
                {selected.status !== 'approved' ? (
                  <button type="button" className="av-btn av-btn-sm" onClick={() => actions.patchClip.mutate({ id: selected.id, status: 'approved' })}>
                    Duyệt
                  </button>
                ) : null}
                {selected.status !== 'rejected' ? (
                  <button type="button" className="av-btn av-btn-sm" onClick={() => actions.patchClip.mutate({ id: selected.id, status: 'rejected' })}>
                    Bỏ qua
                  </button>
                ) : (
                  <button type="button" className="av-btn av-btn-sm" onClick={() => actions.patchClip.mutate({ id: selected.id, status: 'proposed' })}>
                    Khôi phục
                  </button>
                )}
                <button type="button" className="av-btn av-btn-sm" onClick={() => editRange(selected)}>
                  Sửa điểm cắt
                </button>
                <button
                  type="button"
                  className="av-btn av-btn-sm"
                  onClick={() => (!transcribed || idx.lastWord < 0 ? toast.info('Lời thoại chưa tải xong, đợi một chút rồi thử lại.') : setCaptionId(selected.id))}
                >
                  Sửa chữ phụ đề
                </button>
                {cut?.status === 'ready' && cut.video_url && (
                  <a className="av-btn av-btn-sm" href={cut.video_url} download>
                    Tải v{cut.version} (.mp4)
                  </a>
                )}
              </div>
            )}
            {transcribed ? (
              <div className="cd-transcript">
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
                  className={draft ? 'h-[min(70vh,640px)]' : 'h-[min(52vh,520px)]'}
                  toolbar={
                    draft ? (
                      <RangeBar
                        draft={draft}
                        idx={idx}
                        onChange={setDraft}
                        onPreview={(a, b, label) => player.current?.playRange(a, b, label)}
                        onSave={saveDraft}
                        onCancel={() => setDraft(null)}
                        saving={actions.createClip.isPending || actions.patchClip.isPending}
                        quotaReason={null}
                      />
                    ) : null
                  }
                />
              </div>
            ) : (
              <div className="cd-empty">Lời thoại hiện ở đây khi nhận dạng xong.</div>
            )}
          </section>

          <aside className="cd-right" aria-label="Xem trước phụ đề">
            {selected ? (
              <>
                <SubtitleStage
                  clip={selected}
                  idx={idx}
                  store={store}
                  preset={style.preset}
                  fontFamily={serverStatus?.captions.font ?? 'Arial'}
                  layout={style.layout}
                  frameUrl={frame && frame.clipId === selected.id ? frame.url : null}
                  disabled={rendering}
                  onLayout={onLayout}
                  onCommit={onCommit}
                />
                <div className="av-seg cd-seg" role="group" aria-label="Kiểu phụ đề">
                  {(['highlight', 'karaoke', 'minimal', 'none'] as const).map((p) => (
                    <button key={p} type="button" aria-pressed={style.preset === p} disabled={!captionsOk && p !== 'none'} title={!captionsOk && p !== 'none' ? (serverStatus?.captions.reason ?? undefined) : undefined} onClick={() => setPreset(p)}>
                      {PRESET_LABEL[p]}
                    </button>
                  ))}
                </div>
                <div className="cd-right-actions">
                  <button type="button" className="av-btn" disabled={preview.isPending || style.preset === 'none' || !captionsOk} onClick={() => void flush().then(() => preview.mutate(selected))}>
                    {preview.isPending ? 'Đang dựng khung...' : 'Xem thử khung hình'}
                  </button>
                  {rendering ? (
                    <>
                      <button type="button" className="av-btn av-btn-primary" disabled>
                        Đang dựng {Math.round(pct100(cut?.progress) ?? 0)}%
                      </button>
                      <button type="button" className="av-btn av-btn-ghost" onClick={() => cut && actions.cancelCut.mutate(cut.id)}>
                        Hủy
                      </button>
                    </>
                  ) : (
                    <button type="button" className="av-btn av-btn-primary" disabled={!!renderBlock || selected.status === 'rejected' || actions.render.isPending} title={renderBlock ?? undefined} onClick={() => void doRender(selected)}>
                      {selected.cuts_count > 0 ? 'Dựng lại' : 'Dựng'} {selected.code}
                    </button>
                  )}
                </div>
                {cut?.status === 'failed' && cut.error && <span className="av-badge av-badge-danger cd-note">{cut.error}</span>}
                {outdated && cut && (
                  <div className="av-badge av-badge-warn cd-note">
                    Đã đổi phụ đề so với bản v{cut.version}. Bản v{cut.version} vẫn giữ, bấm Dựng lại để ra v{cut.version + 1}.
                  </div>
                )}
              </>
            ) : (
              <div className="cd-empty">{clips.length ? 'Chọn một clip' : 'Chưa có clip'}</div>
            )}
          </aside>
        </div>
      )}

      <Modal open={planOpen} onClose={() => setPlanOpen(false)} title="AI chọn thêm đoạn" wide>
        <PlanForm detail={detail} canPlan={planBlock} />
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
          canRender={renderBlock}
          onClose={() => setCaptionId(null)}
          onSave={async (words, thenRender) => {
            await actions.putCaptions.mutateAsync({ id: captionClip.id, words });
            if (thenRender) {
              await actions.render.mutateAsync({ id: captionClip.id, reframe_mode: captionClip.latest_cut?.reframe?.mode });
              toast.success(`Đã lưu phụ đề và xếp hàng dựng lại ${captionClip.code}`);
            } else {
              toast.success('Đã lưu phụ đề.');
              setWordsStale((s) => new Set(s).add(captionClip.id));
            }
          }}
        />
      )}
    </div>
  );
}
