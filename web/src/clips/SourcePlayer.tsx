import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { clock } from './lib';
import type { PlayerStore } from './playerStore';
import type { SourceVideo } from './types';

export interface SourcePlayerHandle {
  seek(t: number): void;
  /** Phát đúng khoảng [start, end] rồi tự dừng. */
  playRange(start: number, end: number, label: string): void;
  stopRange(): void;
}

interface Props {
  source: SourceVideo;
  store: PlayerStore;
  ref?: Ref<SourcePlayerHandle>;
}

/** Player video nguồn: tua theo mốc, phát thử một đoạn (dừng đúng `end`), báo thời điểm phát cho transcript. */
export function SourcePlayer({ source, store, ref }: Props) {
  const v = useRef<HTMLVideoElement>(null);
  const rangeRef = useRef<{ start: number; end: number } | null>(null);
  const [range, setRange] = useState<{ start: number; end: number; label: string } | null>(null);
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

  useImperativeHandle(
    ref,
    () => ({
      seek(t) {
        rangeRef.current = null;
        setRange(null);
        pending.current = { t, play: false };
        apply();
      },
      playRange(start, end, label) {
        rangeRef.current = { start, end };
        setRange({ start, end, label });
        pending.current = { t: start, play: true };
        apply();
      },
      stopRange() {
        rangeRef.current = null;
        setRange(null);
        v.current?.pause();
      },
    }),
    [],
  );

  // Nhịp đọc thời gian: video phát thì đọc ~8 lần/giây để bám từ đang nói và dừng đúng cuối đoạn.
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const tick = () => {
      const r = rangeRef.current;
      if (r && el.currentTime >= r.end) {
        el.pause();
        el.currentTime = r.end;
        rangeRef.current = null;
        setRange(null);
      }
      store.set(el.currentTime, !el.paused && !el.ended);
    };
    const id = window.setInterval(tick, 120);
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
    setRange(null);
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
      <div className="relative overflow-hidden rounded-lg bg-black">
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
          className="aspect-video max-h-[40vh] w-full bg-black object-contain"
        />
        {failed && (
          <div role="alert" className="absolute inset-0 grid place-items-center bg-black/80 p-4 text-center text-[13px] text-white">
            Trình duyệt không phát được video này (định dạng hoặc mã hoá không được hỗ trợ). Lời thoại và việc cắt clip vẫn dùng được.
          </div>
        )}
      </div>
      {range && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-info-bg px-2.5 py-1.5 text-[13px] text-info-fg" role="status">
          <Icon name="play" size={13} />
          <span className="min-w-0 flex-1">
            Đang xem đoạn <strong>{range.label}</strong> · {clock(range.start)} → {clock(range.end)}
          </span>
          <Button size="sm" variant="secondary" onClick={() => {
              rangeRef.current = null;
              setRange(null);
              v.current?.pause();
            }}>
            Dừng
          </Button>
        </div>
      )}
    </div>
  );
}
