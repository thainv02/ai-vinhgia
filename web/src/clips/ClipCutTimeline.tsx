import { Fragment, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { cleanupSegmentsSpans, editCleanupCutsSpans, segmentDuration, type CleanupEdit, type CleanupProposal, type Segment } from '../../../server/src/lib/clip-cleanup';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { clipParts, clock, jobIsActive, partSpans, partWordIndices, spanLabel } from './lib';
import { usePlayerSelect, type PlayerStore } from './playerStore';
import type { Clip, SourceVideo } from './types';
import type { WordIndex } from './wordIndex';

export const preciseTime = (s: number) => { const ms = Math.max(0, Math.round(s * 1000)); return `${clock(Math.floor(ms / 1000))},${String(ms % 1000).padStart(3, '0')}`; };
/** Vùng bị cắt: sọc chéo theo token màu (đúng cả chế độ sáng/tối). */
const hatch: CSSProperties = { backgroundImage: 'repeating-linear-gradient(135deg, var(--del-fg) 0 1.5px, transparent 1.5px 6px)', backgroundColor: 'var(--del-bg)' };
const seconds = (s: number) => `${s.toFixed(2).replace('.', ',')} s`;
/** Mốc trong clip, gọn: 0:13,6. */
const rel = (s: number) => { const t = Math.max(0, s); return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`; };
const KIND = { filler: 'Tiếng đệm', false_start: 'Nói vấp', repetition: 'Nói lặp' };
const EPS = 0.001;

/**
 * Bố cục các đoạn của clip theo THỨ TỰ PHÁT (thời gian của bản dựng): đoạn k chiếm [offs[k], offs[k] + dur[k]] trên trục ra.
 * Clip một đoạn: đúng như trục nguồn [start_s, end_s] cũ.
 */
function partLayout(spans: Segment[]) {
  const offs: number[] = [];
  let acc = 0;
  for (const s of spans) { offs.push(acc); acc += Math.max(0, s.end - s.start); }
  const total = Math.max(0.001, acc);
  const durOf = (k: number) => Math.max(0, spans[k]!.end - spans[k]!.start);
  /** Đoạn chứa mốc nguồn `t` (đoạn phát trước nếu hai đoạn sát nhau cùng chứa), -1 nếu không. */
  const partAt = (t: number) => spans.findIndex((s) => t >= s.start - EPS && t <= s.end + EPS);
  const partOfProposal = (p: Segment) => Math.max(0, spans.findIndex((s) => p.start >= s.start - EPS && p.end <= s.end + EPS));
  /** Mốc nguồn `t` thuộc đoạn `k` → giây trên trục ra. */
  const out = (t: number, k: number) => offs[k]! + Math.max(0, Math.min(durOf(k), t - spans[k]!.start));
  /** Giây trên trục ra → (đoạn, mốc nguồn). */
  const locate = (e: number) => {
    let k = 0;
    while (k < spans.length - 1 && e >= offs[k + 1]!) k++;
    return { k, t: spans[k]!.start + Math.max(0, Math.min(durOf(k), e - offs[k]!)) };
  };
  return { offs, total, durOf, partAt, partOfProposal, out, locate };
}

/** Vị trí các clip trên toàn bộ video dài + vạch đang phát. Bấm một clip để xem. */
export function SourceClipTimeline({ source, clips, selectedId, store, onSelect }: { source: SourceVideo; clips: Clip[]; selectedId: number | null; store: PlayerStore; onSelect: (c: Clip) => void }) {
  const duration = source.duration_s ?? 0;
  const now = usePlayerSelect(store, (t) => Math.round(t));
  if (!duration || !clips.length) return null;
  const at = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  return (
    <section aria-label="Vị trí clip trên video dài" className="rounded-lg border border-line bg-surface px-3 pb-2 pt-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="font-semibold text-fg">Vị trí {clips.length} clip trên video dài</span>
        <span className="flex items-center gap-2.5">
          <span className="flex items-center gap-1"><i className="inline-block size-2 rounded-sm bg-ok-fg" />Đã duyệt</span>
          <span className="flex items-center gap-1"><i className="inline-block size-2 rounded-sm bg-info-fg" />Đề xuất</span>
        </span>
      </div>
      <div className="relative mt-5 h-3 rounded-full bg-surface-3">
        {now > 0 && <span aria-hidden="true" className="pointer-events-none absolute -inset-y-1 z-20 w-0.5 -translate-x-1/2 rounded-full bg-fg/70" style={{ left: at(now) }} />}
        {clips.map((c) => {
          const sel = selectedId === c.id;
          const tone = c.status === 'approved' ? 'bg-ok-fg' : c.status === 'rejected' ? 'bg-line-strong' : 'bg-info-fg';
          const line = c.status === 'approved' ? 'border-ok-fg' : c.status === 'rejected' ? 'border-line-strong' : 'border-info-fg';
          const parts = clipParts(c);
          const multi = parts.length > 1;
          const order = parts.map((p, k) => `đoạn ${k + 1} ${spanLabel(p.start_s, p.end_s)}`).join(', ');
          return (
            <Fragment key={c.id}>
              {/* Clip ghép: một đường nối mảnh cùng màu dưới thanh, trải từ đoạn sớm nhất tới đoạn muộn nhất. */}
              {multi && <span aria-hidden="true" className={`pointer-events-none absolute top-full mt-0.5 border-t-2 border-dotted ${line} ${sel ? 'opacity-100' : 'opacity-60'}`} style={{ left: at(c.start_s), width: `${((c.end_s - c.start_s) / duration) * 100}%` }} />}
              {parts.map((p, k) => (
                <button
                  key={k}
                  type="button"
                  aria-label={multi ? `${c.code} đoạn ${k + 1}/${parts.length}: ${preciseTime(p.start_s)} đến ${preciseTime(p.end_s)} trên video dài` : `${c.code}: ${preciseTime(p.start_s)} đến ${preciseTime(p.end_s)} trên video dài`}
                  aria-pressed={sel}
                  title={`${c.code}${c.title ? ` · ${c.title}` : ''} · ${multi ? `ghép ${parts.length} đoạn: ${order}` : `${clock(p.start_s)} → ${clock(p.end_s)}`}`}
                  onClick={() => onSelect(c)}
                  style={{ left: at(p.start_s), width: `max(${multi ? 4 : 6}px, ${((p.end_s - p.start_s) / duration) * 100}%)` }}
                  className={`group absolute inset-y-0 rounded-full ${tone} ${sel ? 'z-10 ring-2 ring-fg ring-offset-1 ring-offset-surface' : 'hover:brightness-110'}`}
                >
                  {k === 0 ? (
                    <span className={`absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded px-1 text-[10px] font-bold leading-[14px] ${sel ? 'bg-fg text-surface' : 'bg-surface-3 text-fg group-hover:bg-line-strong'}`}>{c.code}</span>
                  ) : (
                    <span className={`absolute bottom-full left-1/2 mb-0.5 -translate-x-1/2 whitespace-nowrap text-[9px] font-semibold leading-3 ${sel ? 'text-fg' : 'text-muted'}`}>{k + 1}</span>
                  )}
                </button>
              ))}
            </Fragment>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted">
        <span>0:00</span>
        {now > 0 && <span className="text-fg">{clock(now)}</span>}
        <span>{clock(duration)}</span>
      </div>
    </section>
  );
}

/** Trình làm gọn lời nói của một clip: các chỗ AI bỏ (tiếng đệm, nói vấp, nói lặp) trên thanh thời gian; bật/tắt từng chỗ, kéo chỉnh theo từ, nghe thử, lưu. */
export function ClipCutTimeline({ clip, idx, store, onSeek, onPreview, onSave, saving }: {
  clip: Clip; idx: WordIndex; store: PlayerStore; onSeek: (t: number) => void;
  onPreview: (segments: Segment[], label: string) => void;
  onSave: (ids: number[], edits: CleanupEdit[]) => Promise<void>; saving: boolean;
}) {
  const plan = clip.cleanup!;
  const running = jobIsActive(clip.cleanup_job);
  const locked = saving || running;
  const [selected, setSelected] = useState(plan.selected_ids);
  const [edits, setEdits] = useState<Record<number, CleanupEdit>>({});
  const [active, setActive] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; edge: 'start' | 'end' } | null>(null);
  const time = usePlayerSelect(store, (t) => Math.round(t * 100));
  const parts = clipParts(clip);
  const partsKey = parts.map((p) => `${p.start_word}-${p.end_word}:${p.start_s}-${p.end_s}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spans = useMemo(() => partSpans(parts), [partsKey]);
  const layout = useMemo(() => partLayout(spans), [spans]);
  const { total, offs } = layout;
  const multi = parts.length > 1;
  const words = useMemo(() => {
    const out = [];
    for (const i of partWordIndices(parts)) { const w = idx.word(i); if (w) out.push(w); }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, partsKey]);
  const loaded = words.length === parts.reduce((n, p) => n + p.end_word - p.start_word + 1, 0);
  const proposals = Object.keys(edits).length ? editCleanupCutsSpans(words, spans, plan.proposals, Object.values(edits)) : plan.proposals;
  const removed = proposals.filter((p) => selected.includes(p.id));
  const unchanged = Object.keys(edits).length === 0 && [...selected].sort().join(',') === [...plan.selected_ids].sort().join(',');
  const segments = unchanged && clip.retained_segments ? clip.retained_segments : cleanupSegmentsSpans(spans, proposals, selected);
  const kept = segmentDuration(segments);
  const changed = Object.keys(edits).length > 0 || [...selected].sort().join(',') !== [...plan.selected_ids].sort().join(',');
  /** Vị trí (%) trên thanh theo thứ tự phát của mốc nguồn `t` thuộc đoạn `k`. */
  const pct = (t: number, k: number) => `${(layout.out(t, k) / total) * 100}%`;
  const partOf = (p: CleanupProposal) => layout.partOfProposal(p);
  const update = (id: number, edge: 'start' | 'end', word: number) => {
    const p = proposals.find((p) => p.id === id)!;
    const next = { id, start_word: edge === 'start' ? Math.min(word, p.end_word) : p.start_word, end_word: edge === 'end' ? Math.max(word, p.start_word) : p.end_word };
    const all = { ...edits, [id]: next };
    try {
      const proposed = editCleanupCutsSpans(words, spans, plan.proposals, Object.values(all));
      cleanupSegmentsSpans(spans, proposed, selected);
      setEdits(all); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Điểm cắt không hợp lệ'); }
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current, rect = track.current?.getBoundingClientRect();
    if (!d || !rect || !loaded) return;
    const p = proposals.find((p) => p.id === d.id);
    if (!p) return;
    // Tay nắm chỉ chạy trong đoạn chứa chỗ cắt.
    const k = partOf(p);
    const e0 = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total;
    const t = spans[k]!.start + Math.max(0, Math.min(layout.durOf(k), e0 - offs[k]!));
    const inPart = words.filter((w) => w.i >= parts[k]!.start_word && w.i <= parts[k]!.end_word);
    if (!inPart.length) return;
    const nearest = inPart.reduce((a, b) => Math.abs((d.edge === 'start' ? a.start : a.end) - t) <= Math.abs((d.edge === 'start' ? b.start : b.end) - t) ? a : b);
    update(d.id, d.edge, nearest.i);
  };
  const toggle = (id: number) => {
    const ids = selected.includes(id) ? selected.filter((i) => i !== id) : [...selected, id];
    try { cleanupSegmentsSpans(spans, proposals, ids); setSelected(ids); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Điểm cắt không hợp lệ'); }
  };
  const focus = (id: number, start: number) => { setActive(id); onSeek(start); };
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const nowK = layout.partAt(time / 100);
  const playhead = nowK >= 0 ? pct(time / 100, nowK) : null;

  return <section className="space-y-3 rounded-lg border border-line bg-surface p-3" aria-label={`Làm gọn lời nói ${clip.code}`}>
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <h4 className="text-[13px] font-semibold">Làm gọn lời nói</h4>
        <p className="text-xs text-muted">
          Giữ <strong className="font-semibold text-fg tabular-nums">{seconds(kept)}</strong> / {seconds(total)} · bỏ <strong className="font-semibold text-del-fg tabular-nums">{seconds(Math.max(0, total - kept))}</strong>
          {multi && <> · ghép {parts.length} đoạn</>}
        </p>
      </div>
      <div className="flex overflow-hidden rounded-md border border-line-strong text-xs" role="group" aria-label="Phóng to thanh thời gian">
        {[1, 4, 12].map((n, k) => <button type="button" key={n} aria-pressed={zoom === n} onClick={() => setZoom(n)} className={`min-h-7 min-w-9 px-2 font-medium tabular-nums transition-colors ${k ? 'border-l border-line' : ''} ${zoom === n ? 'bg-ink text-ink-fg' : 'bg-surface text-muted hover:bg-surface-2 hover:text-fg'}`}>×{n}</button>)}
      </div>
    </div>

    <div>
      <div className="scroll-thin overflow-x-auto rounded-md border border-line-strong bg-surface-2" aria-label={`Thanh thời gian ${clip.code}`}>
        <div style={{ width: `${zoom * 100}%` }} className="min-w-full">
          {multi && (
            <div className="relative h-4 border-b border-line" aria-hidden="true">
              {parts.map((p, k) => (
                <span key={k} className={`absolute inset-y-0 truncate pl-1 text-[10px] font-semibold leading-4 text-muted ${k ? 'border-l-2 border-fg/50' : ''}`} style={{ left: `${(offs[k]! / total) * 100}%`, width: `${(layout.durOf(k) / total) * 100}%` }} title={`Đoạn ${k + 1}: ${spanLabel(p.start_s, p.end_s)} trên video dài`}>
                  Đoạn {k + 1}
                </span>
              ))}
            </div>
          )}
          <div ref={track} className="relative h-11 cursor-pointer" onClick={(e) => { if (e.target !== e.currentTarget) return; const r = e.currentTarget.getBoundingClientRect(); onSeek(layout.locate((e.clientX - r.left) / r.width * total).t); }}>
            {/* Ranh giới giữa hai đoạn ghép (theo thứ tự phát). */}
            {offs.slice(1).map((o, k) => <span key={`d${k}`} aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-[1] w-0.5 -translate-x-1/2 bg-fg/50" style={{ left: `${(o / total) * 100}%` }} />)}
            {proposals.map((p) => {
              const cut = selected.includes(p.id);
              const k = partOf(p);
              return <button type="button" key={p.id} onClick={() => focus(p.id, p.start)} aria-label={`${clip.code}${multi ? ` đoạn ${k + 1}` : ''} chỗ ${cut ? 'bị cắt' : 'giữ lại'}: ${p.text}`} title={`“${p.text}” · ${p.reason}`} style={{ left: pct(p.start, k), width: `max(3px, ${(p.end - p.start) / total * 100}%)`, ...(cut ? hatch : {}) }} className={`absolute inset-y-1.5 rounded-[3px] ${cut ? 'border border-del-fg/70' : 'border border-dashed border-muted/70 bg-surface'} ${active === p.id ? 'z-[5] outline outline-2 outline-offset-1 outline-warn-fg' : ''}`} />;
            })}
            {active !== null && loaded && (() => {
              const p = proposals.find((p) => p.id === active);
              if (!p) return null;
              const k = partOf(p);
              const span = spans[k]!;
              return (['start', 'end'] as const).map((edge) => <button key={edge} type="button" role="slider" aria-label={`${clip.code} điểm ${edge === 'start' ? 'đầu' : 'cuối'} chỗ cắt ${p.id}`} aria-valuemin={span.start} aria-valuemax={span.end} aria-valuenow={p[edge]} aria-valuetext={preciseTime(p[edge])} title="Kéo hoặc dùng phím ← → để chỉnh theo từng từ" disabled={locked} style={{ left: pct(p[edge], k), touchAction: 'none' }} className="absolute inset-y-0 z-10 grid w-3 -translate-x-1/2 cursor-ew-resize place-items-center rounded-[3px] border border-surface bg-warn-fg shadow-sm disabled:cursor-not-allowed disabled:opacity-50" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); drag.current = { id: p.id, edge }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={move} onPointerUp={(e) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={(e) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const i = (edge === 'start' ? p.start_word : p.end_word) + (e.key === 'ArrowLeft' ? -1 : 1); if (idx.word(i) && i >= parts[k]!.start_word && i <= parts[k]!.end_word) update(p.id, edge, i); }}><span aria-hidden="true" className="h-4 w-px bg-surface/80" /></button>);
            })()}
            {playhead !== null && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-fg" style={{ left: playhead }} />}
          </div>
          <div className="relative h-4 border-t border-line" aria-hidden="true">
            {ticks.map((f) => <span key={f} className={`absolute top-0 whitespace-nowrap font-mono text-[10px] tabular-nums leading-4 text-muted ${f === 0 ? 'pl-1' : f === 1 ? '-translate-x-full pr-1' : '-translate-x-1/2'}`} style={{ left: `${f * 100}%` }}>{rel(f * total)}</span>)}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-3.5 rounded-sm border border-del-fg/70" style={hatch} />Bị cắt</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-3.5 rounded-sm border border-dashed border-muted/70 bg-surface" />Giữ lại</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-0.5 bg-fg" />Đang phát</span>
        <span className="ml-auto">{loaded ? 'Bấm một chỗ cắt, kéo hai tay nắm để chỉnh theo từng từ' : 'Đang tải mốc từ…'}</span>
      </div>
    </div>

    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted">
        Cắt {removed.length}/{proposals.length} chỗ <span className="font-normal">· bỏ chọn để giữ lại chỗ đó</span>
      </p>
      {proposals.length === 0 && <p className="rounded-md bg-surface-2 px-2.5 py-2 text-xs text-muted">AI không tìm thấy lời thừa cần bỏ trong clip này.</p>}
      <ul className="space-y-1.5">
        {proposals.map((p) => {
          const cut = selected.includes(p.id);
          const k = partOf(p);
          return <li key={p.id} className={`flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-xs transition-colors ${cut ? 'border-line bg-surface-2' : 'border-dashed border-line-strong bg-surface'} ${active === p.id ? 'outline outline-2 -outline-offset-1 outline-warn-fg' : ''}`}>
            <input type="checkbox" checked={cut} disabled={locked} onChange={() => toggle(p.id)} aria-label={`Cắt “${p.text}”`} className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--del-fg)]" />
            <button type="button" onClick={() => focus(p.id, p.start)} className="min-w-0 flex-1 text-left" title="Tua tới chỗ này">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className={`text-[13px] font-semibold ${cut ? 'text-del-fg line-through decoration-1' : 'text-fg'}`}>“{p.text}”</span>
                <span className="rounded bg-surface-3 px-1.5 text-[10px] font-semibold leading-4 text-muted">{KIND[p.kind]}</span>
                {multi && <span className="rounded bg-violet-bg px-1.5 text-[10px] font-semibold leading-4 text-violet-fg">Đoạn {k + 1}</span>}
                {p.edited && <span className="rounded bg-warn-bg px-1.5 text-[10px] font-semibold leading-4 text-warn-fg">Đã chỉnh tay</span>}
                <span className="font-mono text-[11px] tabular-nums text-muted" title={`${preciseTime(p.start)} → ${preciseTime(p.end)} trên video dài`}>{rel(layout.out(p.start, k))} · {(p.end - p.start).toFixed(2).replace('.', ',')}s</span>
              </span>
              <span className="mt-0.5 block leading-relaxed text-muted">{p.reason}</span>
            </button>
            <div className="-my-0.5 -mr-1.5 shrink-0">
              <Button size="sm" variant="ghost" className="min-h-7 px-2" icon={<Icon name="volume" size={13} />} disabled={locked} aria-label={`Nghe chỗ cắt “${p.text}”`} onClick={() => { setActive(p.id); onPreview([{ start: Math.max(spans[k]!.start, p.start - 0.5), end: Math.min(spans[k]!.end, (p.replacement?.end ?? p.end) + 0.5) }], `${clip.code} · nghe chỗ cắt`); }}><span className="max-[420px]:sr-only">Nghe</span></Button>
            </div>
          </li>;
        })}
      </ul>
    </div>

    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <Button size="sm" icon={<Icon name="play" size={12} />} onClick={() => onPreview(segments, `${clip.code} · đã làm gọn`)}>Xem bản đã làm gọn</Button>
      {changed && <>
        <span className="ml-auto text-xs font-medium text-warn-fg">Chưa lưu</span>
        <Button size="sm" variant="ghost" disabled={locked} onClick={() => { setSelected(plan.selected_ids); setEdits({}); setError(null); }}>Hoàn tác</Button>
        <Button size="sm" variant="primary" loading={saving} disabled={running} icon={<Icon name="check" size={14} />} onClick={() => { setError(null); void onSave(selected, Object.values(edits)).catch((e) => setError(e instanceof Error ? e.message : 'Chưa lưu được')); }}>Lưu</Button>
      </>}
    </div>
    {running && <p className="text-xs text-muted" role="status">AI đang làm gọn lại clip; chờ xử lý xong trước khi lưu chỉnh sửa.</p>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
}
