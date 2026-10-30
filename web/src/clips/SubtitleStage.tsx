import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePlayerSelect, type PlayerStore } from './playerStore';
import { DEFAULT_LAYOUT, MIN_WIDTH, OUT_H, OUT_W, clampLayout, contentRect, moveLayout, overlayFontPx, pointToFrame, resizeLayout, type CaptionLayout, type Rect } from './subtitleBox';
import type { CaptionPreset, Clip } from './types';
import type { WordIndex } from './wordIndex';

const ASPECT = OUT_W / OUT_H;
/** Màu từ đang nói giống ASS: vàng (highlight), xanh lá (karaoke). */
const ACTIVE_COLOR: Record<string, string> = { highlight: '#ffff00', karaoke: '#00ff00' };

interface Props {
  clip: Clip;
  idx: WordIndex;
  store: PlayerStore;
  preset: CaptionPreset;
  fontFamily: string;
  /** Vị trí đang dùng (đã lưu hoặc đang kéo). null = mặc định của server. */
  layout: CaptionLayout | null;
  /** Khung thật do ffmpeg dựng (thay nền; chữ HTML ẩn để không trùng chữ cháy sẵn). */
  frameUrl: string | null;
  disabled?: boolean;
  onLayout: (l: CaptionLayout) => void;
  onCommit: (l: CaptionLayout) => void;
}

interface Drag {
  mode: 'move' | 'left' | 'right';
  startX: number;
  startY: number;
  start: CaptionLayout;
  boxH: number;
}

/** Chữ minh hoạ của clip: nhóm từ đang nói (3 từ; "tối giản" 6 từ), từ đang nói được đánh dấu. */
function sampleWords(clip: Clip, idx: WordIndex, t: number, preset: CaptionPreset): { text: string; active: boolean }[] {
  const over = new Map((clip.caption_words ?? []).map((w) => [w.i, w.w]));
  const words: { w: string; start: number; end: number }[] = [];
  for (let i = clip.start_word; i <= clip.end_word && words.length < 4000; i++) {
    const tw = idx.word(i);
    if (!tw) break;
    const text = over.has(i) ? over.get(i)! : tw.w;
    if (text.trim()) words.push({ w: text.trim(), start: tw.start, end: tw.end });
  }
  if (!words.length) return [{ text: 'Phụ đề hiển thị ở đây', active: false }];
  const size = preset === 'minimal' ? 6 : 3;
  let cur = words.findIndex((w) => t >= w.start && t < w.end);
  if (cur < 0) cur = Math.max(0, words.findIndex((w) => w.start > t) - 1);
  if (t < clip.start_s || t > clip.end_s) cur = 0;
  const g = Math.floor(cur / size) * size;
  return words.slice(g, g + size).map((w, k) => ({ text: w.w, active: preset !== 'minimal' && g + k === cur }));
}

/**
 * Khung xem trước 9:16 rộng bằng cột phải, có hộp phụ đề kéo trực tiếp: kéo thân hộp để di chuyển, kéo hai mép trái/phải để đổi bề rộng.
 * Toạ độ quy đổi theo hình chữ nhật NỘI DUNG video trong khung (đo lại khi đổi kích thước), kẹp trong khung. Hộp HTML cập nhật tức thì khi kéo;
 * chỉ khi thả chuột mới lưu (`onCommit`). Không gọi ffmpeg trong lúc kéo.
 */
export function SubtitleStage({ clip, idx, store, preset, fontFamily, layout, frameUrl, disabled, onLayout, onCommit }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef<CaptionLayout | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const t10 = usePlayerSelect(store, (t) => Math.floor(t * 8));
  const rect: Rect = useMemo(() => contentRect(size, ASPECT), [size]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lay = layout ?? DEFAULT_LAYOUT;
  const text = useMemo(() => sampleWords(clip, idx, t10 / 8, preset), [clip, idx, t10, preset]);

  const begin = (mode: Drag['mode']) => (e: React.PointerEvent) => {
    if (disabled || e.button > 0) return;
    e.stopPropagation();
    e.preventDefault();
    stage.current?.setPointerCapture(e.pointerId);
    const bh = box.current ? box.current.getBoundingClientRect().height / Math.max(1, rect.h) : 0;
    drag.current = { mode, startX: e.clientX, startY: e.clientY, start: lay, boxH: bh };
    latest.current = lay;
    setDragging(true);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = stage.current;
    if (!d || !el) return;
    const b = el.getBoundingClientRect();
    const a = pointToFrame({ x: d.startX - b.left, y: d.startY - b.top }, rect);
    const c = pointToFrame({ x: e.clientX - b.left, y: e.clientY - b.top }, rect);
    const dx = c.fx - a.fx;
    const dy = c.fy - a.fy;
    const next = d.mode === 'move' ? moveLayout(d.start, dx, dy, d.boxH) : clampLayout({ ...resizeLayout(d.start, d.mode, dx), bottom: d.start.bottom }, d.boxH);
    latest.current = next;
    onLayout(next);
  };

  const end = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (latest.current) onCommit(latest.current);
  }, [onCommit]);

  // thả chuột ngoài cửa sổ / mất pointer capture
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging, end]);

  const fontPx = overlayFontPx(preset === 'none' ? 'highlight' : preset, rect.h);
  const active = ACTIVE_COLOR[preset];

  return (
    <div ref={stage} className="cd-stage" onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} data-dragging={dragging || undefined}>
      {frameUrl ? (
        <img className="cd-stage-frame" src={frameUrl} alt="Khung hình xem thử" draggable={false} />
      ) : clip.thumb_url ? (
        <>
          <img className="cd-stage-bg" src={clip.thumb_url} alt="" draggable={false} />
          <img className="cd-stage-fg" src={clip.thumb_url} alt="" draggable={false} />
        </>
      ) : null}
      {preset !== 'none' && (
        <div className="cd-stage-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <div
            ref={box}
            className="cd-sub"
            data-disabled={disabled || undefined}
            onPointerDown={begin('move')}
            style={{ left: `${lay.left * 100}%`, width: `${lay.width * 100}%`, bottom: `${lay.bottom * 100}%`, minWidth: `${MIN_WIDTH * 100}%` }}
          >
            {!frameUrl && (
              <span className="cd-sub-text" style={{ fontFamily: `'${fontFamily}', Arial, sans-serif`, fontSize: fontPx, WebkitTextStrokeWidth: Math.max(1, (16 * rect.h) / OUT_H) }}>
                {text.map((w, k) => (
                  <span key={k} style={w.active && active ? { color: active } : undefined}>
                    {k ? ' ' : ''}
                    {w.text}
                  </span>
                ))}
              </span>
            )}
            {!disabled && <span className="cd-handle cd-handle-l" role="separator" aria-label="Kéo mép trái" onPointerDown={begin('left')} />}
            {!disabled && <span className="cd-handle cd-handle-r" role="separator" aria-label="Kéo mép phải" onPointerDown={begin('right')} />}
          </div>
        </div>
      )}
    </div>
  );
}
