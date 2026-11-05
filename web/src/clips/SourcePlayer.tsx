import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { Icon } from '../components/Icon';
import { clock } from './lib';
import { usePlayerPlaying, usePlayerSelect, type PlayerStore } from './playerStore';
import type { SourceVideo } from './types';

export interface SourcePlayerHandle {
  seek(t: number): void;
  /** Phát đúng khoảng [start, end] rồi tự dừng. */
  playRange(start: number, end: number, label: string): void;
  playSegments(segments: { start: number; end: number }[], label: string): void;
  stopRange(): void;
}

interface Props {
  source: SourceVideo;
  store: PlayerStore;
  /** Thu nhỏ video (đang soạn điểm cắt) để lời thoại có thêm chỗ. */
  compact?: boolean;
  ref?: Ref<SourcePlayerHandle>;
}

type Seg = { start: number; end: number };
/** Đoạn đang xem: các khoảng được giữ theo THỨ TỰ PHÁT (nhiều khoảng nếu clip đã làm gọn hoặc ghép nhiều đoạn, có thể không theo thời gian). */
interface Focus { start: number; end: number; label: string; segments: Seg[] }

/** Giây (theo thời lượng đoạn) → m:ss. */
const mmss = (s: number) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
/** Mốc bắt đầu (giây đã xem) của từng khoảng. */
const offsetsOf = (segs: Seg[]) => { const o: number[] = []; let acc = 0; for (const s of segs) { o.push(acc); acc += s.end - s.start; } return o; };
/** Số giây đã xem → (khoảng, thời điểm nguồn). */
function locate(segs: Seg[], offs: number[], e: number): { index: number; t: number } {
  let k = 0;
  while (k < segs.length - 1 && e >= offs[k + 1]!) k++;
  const s = segs[k]!;
  return { index: k, t: s.start + Math.max(0, Math.min(s.end - s.start, e - offs[k]!)) };
}
/** Hai khoảng liền nhau thuộc hai đoạn ghép khác nhau (nhảy lùi hoặc cách nhau > 5 s), không phải chỗ bỏ khi làm gọn. */
const isPartJump = (prev: Seg, next: Seg) => next.start < prev.end - 0.01 || next.start - prev.end > 5;
const cutHatch: CSSProperties = { backgroundImage: 'repeating-linear-gradient(135deg, var(--del-fg) 0 1px, transparent 1px 4px)', backgroundColor: 'var(--del-bg)' };

/**
 * Thanh thời gian riêng của đoạn đang xem, trải theo THỜI GIAN XEM (thứ tự phát), không theo video dài: các khoảng nối liền nhau,
 * chỗ bỏ khi làm gọn là vạch sọc đỏ, ranh giới giữa hai đoạn ghép là vạch đậm. Tua được bằng chuột/phím.
 */
function FocusBar({ focus, store, ended, currentIndex, onSeek, onToggle, onRestart, onClose }: { focus: Focus; store: PlayerStore; ended: boolean; currentIndex: () => number | null; onSeek: (index: number, t: number) => void; onToggle: () => void; onRestart: () => void; onClose: () => void }) {
  const t = usePlayerSelect(store, (x) => Math.round(x * 20)) / 20;
  const playing = usePlayerPlaying(store);
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const { segments } = focus;
  const offs = offsetsOf(segments);
  const total = Math.max(0.001, segments.reduce((n, s) => n + s.end - s.start, 0));
  // Khoảng đang phát: lấy từ player (thứ tự phát), không suy từ thời điểm nguồn vì các đoạn có thể không theo thời gian.
  const ri = currentIndex();
  const k = ri ?? Math.max(0, segments.findIndex((s) => t >= s.start - 0.05 && t <= s.end + 0.05));
  const seg = segments[k]!;
  // Vừa nhảy sang khoảng mới mà player chưa báo thời điểm mới: tạm coi là đầu khoảng.
  const within = t >= seg.start - 0.3 && t <= seg.end + 0.3;
  const elapsed = ended ? total : Math.min(total, offs[k]! + (within ? Math.max(0, Math.min(seg.end - seg.start, t - seg.start)) : 0));
  const frac = (e: number) => `${Math.max(0, Math.min(1, e / total)) * 100}%`;
  const joins = segments.slice(1).map((s, j) => ({ at: offs[j + 1]!, jump: isPartJump(segments[j]!, s), cut: s.start - segments[j]!.end > 0.01 }));
  const cuts = joins.filter((g) => !g.jump && g.cut).length;
  const parts = joins.filter((g) => g.jump).length + 1;
  const seekTo = (e: number) => {
    const loc = locate(segments, offs, Math.max(0, Math.min(total, e)));
    const s = segments[loc.index]!;
    onSeek(loc.index, Math.max(s.start, Math.min(loc.t, s.end - 0.05)));
  };
  const seekAtX = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    seekTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -2 : e.key === 'ArrowRight' ? 2 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0;
    if (!step) return;
    e.preventDefault();
    seekTo(Math.min(total - 0.05, Math.max(0, elapsed + step)));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekAtX(e.clientX); };
  const move = (e: PointerEvent<HTMLDivElement>) => { if (dragging.current) seekAtX(e.clientX); };
  const up = (e: PointerEvent<HTMLDivElement>) => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); };
  const ctl = 'grid size-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-violet-fg/15';
  const note = [parts > 1 ? `ghép ${parts} đoạn` : '', cuts ? `đã bỏ ${cuts} chỗ khi làm gọn` : ''].filter(Boolean).join(' · ');

  return (
    <div className="rounded-lg border border-violet-fg/30 bg-violet-bg/40 px-2.5 py-2" role="group" aria-label={`Đang xem đoạn ${focus.label}`}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className={`${ctl} bg-violet-fg text-surface hover:bg-violet-fg/85`} aria-label={playing ? 'Tạm dừng' : ended ? 'Phát lại đoạn' : 'Phát tiếp'}>
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="min-w-0 truncate font-semibold text-violet-fg">Đang xem {focus.label}</span>
            <span className="ml-auto shrink-0 font-mono tabular-nums">
              <strong className="font-semibold">{mmss(elapsed)}</strong><span className="text-muted"> / {mmss(total)}</span>
            </span>
          </div>
          <div
            ref={bar}
            role="slider"
            tabIndex={0}
            aria-label={`Vị trí trong đoạn ${focus.label}`}
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(elapsed)}
            aria-valuetext={`${mmss(elapsed)} trên ${mmss(total)}`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={onKey}
            className="group relative mt-1 h-5 cursor-pointer touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-violet-fg/15">
              <span className="absolute inset-y-0 left-0 bg-violet-fg" style={{ width: frac(elapsed) }} />
              {joins.map((g, j) =>
                g.jump ? null : g.cut ? <span key={j} title="Chỗ bỏ khi làm gọn" className="absolute inset-y-0 w-[3px] -translate-x-1/2" style={{ left: frac(g.at), ...cutHatch }} /> : null,
              )}
            </div>
            {/* Ranh giới giữa hai đoạn ghép: vạch đậm, cao hơn thanh. */}
            {joins.map((g, j) => (g.jump ? <span key={`p${j}`} aria-hidden="true" title="Chuyển sang đoạn ghép tiếp theo" className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-fg/70" style={{ left: frac(g.at) }} /> : null))}
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-violet-fg shadow transition-transform group-hover:scale-110" style={{ left: frac(elapsed) }} />
          </div>
          <div className="flex justify-between gap-2 font-mono text-[10px] tabular-nums text-muted">
            <span>{clock(segments[0]!.start)}</span>
            {note && <span className="truncate font-sans">{note}</span>}
            <span>{clock(segments.at(-1)!.end)}</span>
          </div>
        </div>
        <button type="button" onClick={onRestart} className={`${ctl} text-violet-fg`} aria-label="Phát lại từ đầu đoạn" title="Phát lại từ đầu">
          <Icon name="refresh" size={14} />
        </button>
        <button type="button" onClick={onClose} className={`${ctl} text-muted hover:text-fg`} aria-label="Thoát xem đoạn" title="Thoát xem đoạn (về video đầy đủ)">
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  );
}

/** Player video nguồn: tua theo mốc, phát thử một đoạn (dừng đúng `end`), báo thời điểm phát cho transcript. */
export function SourcePlayer({ source, store, compact, ref }: Props) {
  const v = useRef<HTMLVideoElement>(null);
  /** Đoạn đang phát (đang canh để nhảy qua phần bị cắt / dừng ở cuối). null: đã hết đoạn hoặc không xem đoạn. */
  const rangeRef = useRef<{ start: number; end: number; segments?: Seg[]; index?: number } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const focusRef = useRef<Focus | null>(null);
  focusRef.current = focus;
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<{ t: number; play: boolean } | null>(null);

  const apply = () => {
    const el = v.current;
    const p = pending.current;
    if (!el || !p || el.readyState < 1) return;
    pending.current = null;
    el.currentTime = Math.max(0, Math.min(p.t, Number.isFinite(el.duration) ? el.duration : p.t));
    if (p.play) void el.play().catch(() => undefined);
  };

  const startFocus = (segments: Seg[], label: string) => {
    if (!segments.length) return;
    const first = segments[0]!;
    rangeRef.current = { ...first, segments, index: 0 };
    // Khung bao (sớm nhất – muộn nhất): các khoảng có thể không theo thời gian khi clip ghép nhiều đoạn.
    setFocus({ start: Math.min(...segments.map((s) => s.start)), end: Math.max(...segments.map((s) => s.end)), label, segments });
    setEnded(false);
    pending.current = { t: first.start, play: true };
    apply();
  };
  const clearFocus = () => {
    rangeRef.current = null;
    setFocus(null);
    setEnded(false);
  };
  /** Tua trong đoạn đang xem tới khoảng `index`, thời điểm nguồn `t` (giữ chế độ xem đoạn, tiếp tục phát nếu đang phát). */
  const seekWithin = (index: number, t: number) => {
    const f = focusRef.current;
    const el = v.current;
    if (!f || !el || !f.segments[index]) return;
    rangeRef.current = { ...f.segments[index]!, segments: f.segments, index };
    setEnded(false);
    pending.current = { t, play: !el.paused };
    apply();
  };
  const toggle = () => {
    const el = v.current;
    const f = focusRef.current;
    if (!el || !f) return;
    if (!el.paused) { el.pause(); return; }
    if (!rangeRef.current) startFocus(f.segments, f.label);
    else void el.play().catch(() => undefined);
  };

  useImperativeHandle(
    ref,
    () => ({
      seek(t) {
        clearFocus();
        pending.current = { t, play: false };
        apply();
      },
      playRange(start, end, label) {
        startFocus([{ start, end }], label);
      },
      playSegments(segments, label) {
        startFocus(segments, label);
      },
      stopRange() {
        clearFocus();
        v.current?.pause();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Nhịp đọc thời gian: video phát thì đọc ~25 lần/giây để bám từ đang nói, nhảy qua phần bị cắt và dừng đúng cuối đoạn.
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const tick = () => {
      const r = rangeRef.current;
      if (r && el.currentTime >= r.end) {
        const index = (r.index ?? 0) + 1;
        const next = r.segments?.[index];
        if (next) {
          el.currentTime = next.start;
          rangeRef.current = { ...next, segments: r.segments, index };
          if (el.paused) void el.play().catch(() => undefined);
        } else {
          el.pause(); el.currentTime = r.end; rangeRef.current = null; setEnded(true);
        }
      }
      // Hết đoạn rồi người dùng tự phát/tua ra ngoài bằng thanh của trình duyệt: thoát chế độ xem đoạn.
      const f = focusRef.current;
      if (f && !rangeRef.current && !el.paused && (el.currentTime < f.start - 0.5 || el.currentTime > f.end + 0.5)) { setFocus(null); setEnded(false); }
      store.set(el.currentTime, !el.paused && !el.ended);
    };
    const id = window.setInterval(tick, 40);
    const ev = ['timeupdate', 'seeked', 'play', 'pause', 'ended', 'loadedmetadata'] as const;
    for (const e of ev) el.addEventListener(e, tick);
    return () => {
      window.clearInterval(id);
      for (const e of ev) el.removeEventListener(e, tick);
    };
  }, [store, source.video_url]);

  useEffect(() => {
    setFailed(false);
    rangeRef.current = null;
    setFocus(null);
    setEnded(false);
  }, [source.video_url]);

  if (!source.video_url) {
    return (
      <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-line-strong bg-surface-2 p-4 text-center text-[13px] text-muted">
        <div>
          <Icon name="film" size={22} className="mx-auto mb-1" />
          {source.source_deleted ? 'Video gốc đã bị xoá sau thời hạn lưu.' : 'Bản xem thử chưa sẵn sàng, đang tạo...'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className={`relative overflow-hidden rounded-lg bg-black ${focus ? 'ring-2 ring-violet-fg' : ''}`}>
        <video
          ref={v}
          key={source.video_url}
          src={source.video_url}
          poster={source.poster_url ?? undefined}
          controls
          preload="metadata"
          playsInline
          aria-label={`Video nguồn: ${source.original_name}`}
          onLoadedMetadata={apply}
          onCanPlay={apply}
          onError={() => setFailed(true)}
          className={`aspect-video w-full bg-black object-contain transition-[max-height] duration-200 ${compact ? 'max-h-[30vh] lg:max-h-[26vh]' : 'max-h-[40vh] lg:max-h-[36vh]'}`}
        />
        {focus && (
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-violet-fg px-1.5 py-0.5 text-[11px] font-bold text-surface shadow">
            {focus.label}
          </span>
        )}
        {failed && (
          <div role="alert" className="absolute inset-0 grid place-items-center bg-black/80 p-4 text-center text-[13px] text-white">
            Trình duyệt không phát được video này (định dạng hoặc mã hoá không được hỗ trợ). Lời thoại và việc chọn highlight vẫn dùng được.
          </div>
        )}
      </div>
      {focus && (
        <FocusBar
          focus={focus}
          store={store}
          ended={ended}
          currentIndex={() => rangeRef.current?.index ?? null}
          onSeek={seekWithin}
          onToggle={toggle}
          onRestart={() => startFocus(focus.segments, focus.label)}
          onClose={clearFocus}
        />
      )}
    </div>
  );
}
