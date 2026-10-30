import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, InlineError, Skeleton } from '../components/States';
import { clock, foldText, sentenceAtTime, sentenceOfWord } from './lib';
import { usePlayerPlaying, usePlayerSelect, type PlayerStore } from './playerStore';
import type { TranscriptState } from './hooks';
import type { TranscriptSentence, TranscriptWord } from './types';

export interface WordRange {
  start: number;
  end: number;
}
export interface ClipMark {
  code: string;
  startWord: number;
  tone: 'proposed' | 'approved';
}

export interface TranscriptHandle {
  scrollToWord(i: number, where?: 'start' | 'center'): void;
}

interface Props {
  state: TranscriptState;
  store: PlayerStore;
  /** Vùng của clip đang chọn (tô nhạt). */
  selected: WordRange | null;
  /** Vùng đang soạn (tô đậm): clip đang sửa hoặc clip thủ công mới. */
  draft: WordRange | null;
  /** Đang chờ bấm từ đầu/từ cuối của vùng soạn. */
  picking: 'start' | 'end' | null;
  marks: ClipMark[];
  onSeek: (t: number) => void;
  onPick: (wordIdx: number) => void;
  /** Kéo chuột qua các từ (máy tính): tạo vùng soạn mới. */
  onDragRange: (start: number, end: number) => void;
  toolbar?: ReactNode;
  className?: string;
  ref?: Ref<TranscriptHandle>;
}

const LINE_H = 26;
const ROW_PAD = 10;
const OVERSCAN = 6;

/**
 * Transcript ảo hoá (chỉ dựng các câu đang thấy): video 3 giờ có tới ~30 nghìn từ.
 * Chiều cao câu đo thật sau khi dựng; câu chưa dựng dùng chiều cao ước lượng theo số ký tự.
 */
export function Transcript({ state, store, selected, draft, picking, marks, onSeek, onPick, onDragRange, toolbar, className = '', ref }: Props) {
  const { sentences } = state;
  const box = useRef<HTMLDivElement | null>(null);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const setBox = useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    setBoxEl(el);
  }, []);
  const [scrollTop, setScrollTop] = useState(0);
  const [view, setView] = useState({ h: 400, w: 400 });
  const heights = useRef(new Map<number, number>());
  const [hv, setHv] = useState(0);
  const [follow, setFollow] = useState(true);

  // ---- chỉ mục dùng chung ----
  const index = useMemo(() => {
    const starts: number[] = [];
    const wordI: number[] = [];
    const fold: string[] = [];
    const sOf: number[] = [];
    sentences.forEach((s, si) => {
      starts.push(s.words[0]?.i ?? (starts.length ? starts[starts.length - 1]! : 0));
      for (const w of s.words) {
        wordI.push(w.i);
        fold.push(foldText(w.w));
        sOf.push(si);
      }
    });
    return { starts, wordI, fold, sOf };
  }, [sentences]);

  // ---- tìm kiếm ----
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(0);
  const hits = useMemo(() => {
    const tokens = foldText(query).split(/\s+/).filter(Boolean);
    if (!tokens.length || (tokens.length === 1 && tokens[0]!.length < 2)) return [] as { a: number; b: number }[];
    const out: { a: number; b: number }[] = [];
    const last = tokens.length - 1;
    const f = index.fold;
    for (let p = 0; p + last < f.length && out.length < 3000; p++) {
      let ok = true;
      for (let k = 0; k <= last; k++) {
        const w = f[p + k]!;
        if (k === last ? !w.startsWith(tokens[k]!) : w !== tokens[k]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ a: p, b: p + last });
    }
    return out;
  }, [query, index]);
  const matchSet = useMemo(() => {
    const set = new Set<number>();
    for (const h of hits) for (let p = h.a; p <= h.b; p++) set.add(index.wordI[p]!);
    return set;
  }, [hits, index]);
  const curHit = hits.length ? hits[Math.min(cur, hits.length - 1)]! : null;
  const curMatch = useMemo(() => (curHit ? { start: index.wordI[curHit.a]!, end: index.wordI[curHit.b]! } : null), [curHit, index]);
  useEffect(() => setCur(0), [query]);

  // ---- vị trí các câu ----
  const estimate = useCallback(
    (s: TranscriptSentence) => {
      const chars = s.words.reduce((n, w) => n + w.w.length + 1, 0);
      const avail = Math.max(120, view.w - 16 - 52 - 8 - 14);
      return Math.max(1, Math.ceil((chars * 7.2) / avail)) * LINE_H + ROW_PAD;
    },
    [view.w],
  );
  const offsets = useMemo(() => {
    void hv;
    const o = new Array<number>(sentences.length + 1);
    o[0] = 0;
    for (let k = 0; k < sentences.length; k++) o[k + 1] = o[k]! + (heights.current.get(k) ?? estimate(sentences[k]!));
    return o;
  }, [sentences, estimate, hv]);
  const total = offsets[sentences.length] ?? 0;

  const firstVisible = useMemo(() => {
    let lo = 0;
    let hi = sentences.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid + 1] ?? 0) > scrollTop) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }, [offsets, scrollTop, sentences.length]);
  let lastVisible = firstVisible;
  while (lastVisible < sentences.length - 1 && (offsets[lastVisible + 1] ?? 0) < scrollTop + view.h) lastVisible++;
  const from = Math.max(0, firstVisible - OVERSCAN);
  const to = Math.min(sentences.length - 1, lastVisible + OVERSCAN);

  // chiều rộng đổi → ước lượng lại
  useEffect(() => {
    heights.current.clear();
    setHv((v) => v + 1);
  }, [view.w]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let delta = 0;
    let changed = false;
    el.querySelectorAll<HTMLElement>('[data-s]').forEach((row) => {
      const idx = Number(row.dataset.s);
      const h = row.offsetHeight;
      const prev = heights.current.get(idx);
      const was = prev ?? estimate(sentences[idx]!);
      if (prev === undefined || Math.abs(prev - h) > 0.5) {
        heights.current.set(idx, h);
        changed = true;
        if (idx < firstVisible) delta += h - was;
      }
    });
    if (changed) {
      if (delta !== 0) el.scrollTop += delta;
      setHv((v) => v + 1);
    }
  });

  // Vùng cuộn chỉ có khi đã có lời thoại: gắn bộ đo kích thước ngay khi phần tử xuất hiện.
  useLayoutEffect(() => {
    const el = boxEl;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ h: el.clientHeight, w: el.clientWidth }));
    ro.observe(el);
    setView({ h: el.clientHeight, w: el.clientWidth });
    return () => ro.disconnect();
  }, [boxEl]);

  const scrollToSentence = useCallback(
    (si: number, where: 'start' | 'center' = 'center') => {
      const el = box.current;
      if (!el) return;
      const y = (offsets[si] ?? 0) - (where === 'center' ? el.clientHeight * 0.3 : 6);
      el.scrollTop = Math.max(0, y);
      setScrollTop(el.scrollTop);
    },
    [offsets],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToWord(i, where = 'center') {
        if (!index.starts.length) return;
        scrollToSentence(sentenceOfWord(index.starts, i), where);
      },
    }),
    [index, scrollToSentence],
  );

  // ---- đang phát: từ/câu hiện tại, tự cuộn theo ----
  const playing = usePlayerPlaying(store);
  const activeSentence = usePlayerSelect(store, (t) => (sentences.length ? sentenceAtTime(sentences, t) : -1));
  const activeWord = usePlayerSelect(store, (t) => {
    if (!sentences.length) return -1;
    const s = sentences[sentenceAtTime(sentences, t)];
    if (!s || !s.words.length || t < s.start - 0.05 || t > s.end + 0.6) return -1;
    let ans = s.words[0]!.i;
    for (const w of s.words) {
      if (w.start <= t) ans = w.i;
      else break;
    }
    return ans;
  });
  useEffect(() => {
    if (!follow || !playing || activeSentence < 0) return;
    if (activeSentence < firstVisible || activeSentence > lastVisible - 1) scrollToSentence(activeSentence, 'center');
    // chỉ phản ứng khi câu đang phát đổi
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSentence, playing, follow]);

  // ---- kéo chuột để chọn vùng (máy tính) ----
  const [drag, setDrag] = useState<WordRange | null>(null);
  const dragRef = useRef<{ anchor: number; last: number; moved: boolean; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const scrollDir = useRef(0);
  const wordAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-w]');
    return el ? Number(el.dataset.w) : null;
  };
  useEffect(() => {
    const id = window.setInterval(() => {
      const el = box.current;
      if (el && scrollDir.current !== 0) el.scrollTop += scrollDir.current * 18;
    }, 30);
    return () => window.clearInterval(id);
  }, []);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' || e.button !== 0 || picking) return;
    const i = wordAt(e.clientX, e.clientY);
    if (i === null) return;
    // Chưa chiếm con trỏ: bấm thường vẫn ra sự kiện click trên từ; chỉ chiếm khi thật sự kéo.
    dragRef.current = { anchor: i, last: i, moved: false, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = box.current;
    if (!d || !el) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    d.moved = true;
    const r = el.getBoundingClientRect();
    scrollDir.current = e.clientY < r.top + 28 ? -1 : e.clientY > r.bottom - 28 ? 1 : 0;
    const i = wordAt(e.clientX, Math.max(r.top + 2, Math.min(r.bottom - 2, e.clientY)));
    if (i !== null) d.last = i;
    setDrag({ start: Math.min(d.anchor, d.last), end: Math.max(d.anchor, d.last) });
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    scrollDir.current = 0;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d?.moved) {
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      const a = Math.min(d.anchor, d.last);
      const b = Math.max(d.anchor, d.last);
      setDrag(null);
      if (b > a) onDragRange(a, b);
    }
  };

  const onWordClick = useCallback(
    (w: TranscriptWord) => {
      if (suppressClick.current) return;
      if (picking) onPick(w.i);
      else onSeek(w.start);
    },
    [picking, onPick, onSeek],
  );

  const goHit = (k: number) => {
    if (!hits.length) return;
    const n = (k + hits.length) % hits.length;
    setCur(n);
    const h = hits[n]!;
    const wi = index.wordI[h.a]!;
    scrollToSentence(index.sOf[h.a]!, 'center');
    const s = sentences[index.sOf[h.a]!];
    const w = s?.words.find((x) => x.i === wi);
    if (w) onSeek(w.start);
  };

  const markMap = useMemo(() => {
    const m = new Map<number, ClipMark[]>();
    if (!index.starts.length) return m;
    for (const mk of marks) {
      const si = sentenceOfWord(index.starts, mk.startWord);
      m.set(si, [...(m.get(si) ?? []), mk]);
    }
    return m;
  }, [marks, index]);

  const rows: ReactNode[] = [];
  for (let k = from; k <= to; k++) {
    const s = sentences[k]!;
    const first = s.words[0]?.i ?? -1;
    const last = s.words[s.words.length - 1]?.i ?? -1;
    rows.push(
      <Row
        key={s.id}
        s={s}
        idx={k}
        selected={selected}
        draft={drag ?? draft}
        dragging={!!drag}
        matchSet={matchSet.size ? matchSet : null}
        curMatch={curMatch}
        activeWord={activeWord >= first && activeWord <= last ? activeWord : -1}
        picking={picking}
        marks={markMap.get(k)}
        onWord={onWordClick}
        onSeek={onSeek}
      />,
    );
  }

  const empty = !state.loading && !state.error && sentences.length === 0;

  return (
    <div className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <div className="relative min-w-0 flex-1 basis-40">
          <Icon name="eye" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                goHit(cur + (e.shiftKey ? -1 : 1));
              }
            }}
            placeholder="Tìm trong lời thoại (không cần gõ dấu)"
            aria-label="Tìm trong lời thoại"
            className="min-h-8 py-1 pl-8 text-[13px]"
          />
        </div>
        {query.trim() && (
          <div className="flex items-center gap-1 text-xs text-muted" aria-live="polite">
            <span className="whitespace-nowrap">{hits.length ? `${Math.min(cur, hits.length - 1) + 1}/${hits.length}${hits.length >= 3000 ? '+' : ''}` : 'Không thấy'}</span>
            <Button size="sm" variant="ghost" aria-label="Kết quả trước" disabled={!hits.length} onClick={() => goHit(cur - 1)} icon={<Icon name="chevronLeft" size={14} className="rotate-90" />} />
            <Button size="sm" variant="ghost" aria-label="Kết quả sau" disabled={!hits.length} onClick={() => goHit(cur + 1)} icon={<Icon name="chevronRight" size={14} className="rotate-90" />} />
          </div>
        )}
        <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Cuộn theo video
        </label>
      </div>
      {toolbar}
      {state.loading && sentences.length > 0 && (
        <p className="border-b border-line bg-surface-2 px-3 py-1 text-xs text-muted" role="status">
          Đang tải lời thoại: {sentences.length.toLocaleString('vi-VN')}/{state.total.toLocaleString('vi-VN')} câu...
        </p>
      )}
      {state.error ? (
        <div className="space-y-2 p-3">
          <InlineError>{state.error.message || 'Không tải được lời thoại'}</InlineError>
          <Button size="sm" onClick={state.retry} icon={<Icon name="refresh" size={14} />}>
            Thử lại
          </Button>
        </div>
      ) : state.loading && sentences.length === 0 ? (
        <div className="space-y-2 p-3" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-5" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState icon="comment" title="Không có lời thoại">
          Dịch vụ nhận dạng không tìm thấy lời nói trong video này. Thử video khác có tiếng nói rõ hơn.
        </EmptyState>
      ) : (
        <div
          ref={setBox}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onMouseDown={(e) => {
            if (!picking && (e.target as HTMLElement).closest('[data-w]')) e.preventDefault();
          }}
          tabIndex={0}
          role="region"
          aria-label="Lời thoại của video"
          className={`scroll-thin min-h-0 flex-1 select-none overflow-y-auto overscroll-contain ${picking ? 'cursor-crosshair' : ''}`}
          style={{ minHeight: 160 }}
        >
          <div style={{ height: total, position: 'relative' }}>
            <div style={{ position: 'absolute', top: offsets[from] ?? 0, left: 0, right: 0 }}>{rows}</div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  s: TranscriptSentence;
  idx: number;
  selected: WordRange | null;
  draft: WordRange | null;
  dragging: boolean;
  matchSet: Set<number> | null;
  curMatch: WordRange | null;
  activeWord: number;
  picking: 'start' | 'end' | null;
  marks: ClipMark[] | undefined;
  onWord: (w: TranscriptWord) => void;
  onSeek: (t: number) => void;
}

const inRange = (i: number, r: WordRange | null) => !!r && i >= r.start && i <= r.end;

const Row = memo(function Row({ s, idx, selected, draft, dragging, matchSet, curMatch, activeWord, picking, marks, onWord, onSeek }: RowProps) {
  const sentenceDraft = draft && s.words.length && draft.end >= s.words[0]!.i && draft.start <= s.words[s.words.length - 1]!.i;
  return (
    <div data-s={idx} className={`flex gap-2 px-2 py-[5px] ${sentenceDraft ? 'bg-violet-bg/30' : ''}`}>
      <button
        type="button"
        onClick={() => onSeek(s.start)}
        title="Tua video tới câu này"
        className="mt-[5px] h-[16px] w-[52px] shrink-0 rounded text-left font-mono text-[11px] leading-[16px] text-muted hover:bg-surface-3 hover:text-fg"
      >
        {clock(s.start)}
      </button>
      <p className="min-w-0 flex-1 text-[13.5px]" style={{ lineHeight: `${LINE_H}px` }}>
        {marks?.map((m) => (
          <span key={m.code} className={`mr-1 inline-block rounded px-1.5 align-middle text-[10px] font-bold leading-[16px] ${m.tone === 'approved' ? 'bg-ok-bg text-ok-fg' : 'bg-info-bg text-info-fg'}`}>
            {m.code}
          </span>
        ))}
        {s.words.map((w) => {
          const isDraft = inRange(w.i, draft);
          const isSel = !isDraft && inRange(w.i, selected);
          const isCur = !!curMatch && w.i >= curMatch.start && w.i <= curMatch.end;
          const isHit = !!matchSet && matchSet.has(w.i);
          const isActive = w.i === activeWord;
          let cls = 'rounded-[3px] ';
          if (isActive) cls += 'bg-ink text-ink-fg ';
          else if (isCur) cls += 'bg-warn-fg text-surface ';
          else if (isHit) cls += 'bg-warn-bg text-warn-fg ';
          else if (isDraft) cls += `${dragging ? 'bg-violet-fg text-surface' : 'bg-violet-bg text-violet-fg'} `;
          else if (isSel) cls += 'bg-info-bg text-info-fg ';
          if (isDraft && draft && (w.i === draft.start || w.i === draft.end)) cls += 'font-bold underline decoration-2 underline-offset-2 ';
          if (!isActive && !isCur && !isHit && !isDraft && !isSel) cls += picking ? 'hover:bg-violet-bg ' : 'hover:bg-surface-3 ';
          return (
            <span key={w.i} data-w={w.i} onClick={() => onWord(w)} className={cls}>
              {w.w}{' '}
            </span>
          );
        })}
      </p>
    </div>
  );
});
