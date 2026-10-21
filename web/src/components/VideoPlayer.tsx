import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { fmtTimecode } from '../lib/format';
import { Icon } from './Icon';

export interface PlayerHandle {
  getTime(): number;
}

export interface TimeMarker {
  id: number;
  time: number;
  label: string;
}

interface Props {
  src: string;
  markers: TimeMarker[];
  /** Yêu cầu tua tới một mốc (nonce đổi mỗi lần bấm để tua lại cùng một mốc được). */
  seekRequest: { t: number; nonce: number } | null;
  /** Gọi mỗi khi video dừng/tua xong/đang phát, để trang biết "thời điểm đang dừng". */
  onTimeChange: (t: number, playing: boolean) => void;
  /** Gọi liên tục khi video đang chạy (khoảng 4 lần/giây): để vẽ đầu phát trên timeline ngoài. */
  onTick?: (t: number) => void;
  /** Chiều cao khung video (CSS), mặc định ~66% chiều cao màn hình tối đa 640px. */
  height?: string;
  ref?: Ref<PlayerHandle>;
}

const FRAME = 1 / 24;
const RATES = [1, 0.5, 0.25];

/** Trình phát 9:16 có thanh thời gian tự vẽ, đánh dấu comment trên thanh, tua từng khung và đổi tốc độ. */
export function VideoPlayer({ src, markers, seekRequest, onTimeChange, onTick, height = 'min(66vh, 640px)', ref }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({ getTime: () => videoRef.current?.currentTime ?? 0 }), []);

  const applyPending = () => {
    const v = videoRef.current;
    if (!v || pendingSeek.current === null || v.readyState < 1) return;
    v.pause();
    v.currentTime = Math.min(pendingSeek.current, Number.isFinite(v.duration) ? v.duration : pendingSeek.current);
    pendingSeek.current = null;
  };

  // Đổi video: đặt lại trạng thái.
  useEffect(() => {
    setFailed(false);
    setCurrent(0);
    setDuration(0);
    setPlaying(false);
  }, [src]);

  useEffect(() => {
    if (!seekRequest) return;
    pendingSeek.current = seekRequest.t;
    applyPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest?.nonce]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, src]);

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, duration || t));
  };

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const step = (dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    seekTo(v.currentTime + dir * FRAME);
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-center">
      <div className="relative overflow-hidden rounded-lg bg-black" style={{ height, aspectRatio: '9 / 16', maxWidth: '100%' }}>
        <video
          ref={videoRef}
          key={src}
          src={src}
          playsInline
          preload="metadata"
          className="absolute inset-0 size-full object-contain"
          onClick={toggle}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            e.currentTarget.playbackRate = rate;
            applyPending();
          }}
          onTimeUpdate={(e) => {
            setCurrent(e.currentTarget.currentTime);
            onTick?.(e.currentTarget.currentTime);
          }}
          onPlay={(e) => {
            setPlaying(true);
            onTimeChange(e.currentTarget.currentTime, true);
          }}
          onPause={(e) => {
            setPlaying(false);
            onTimeChange(e.currentTarget.currentTime, false);
          }}
          onSeeked={(e) => {
            setCurrent(e.currentTarget.currentTime);
            onTick?.(e.currentTarget.currentTime);
            onTimeChange(e.currentTarget.currentTime, !e.currentTarget.paused);
          }}
          onEnded={() => setPlaying(false)}
          onError={() => setFailed(true)}
          aria-label="Video cảnh"
        />
        {failed ? (
          <div role="alert" className="absolute inset-0 grid place-content-center gap-1 px-4 text-center text-sm text-white/80">
            <Icon name="alert" size={22} className="mx-auto" />
            Không phát được video này. File có thể đã bị xóa hoặc chưa ghi xong.
          </div>
        ) : (
          !playing && (
            <button
              type="button"
              onClick={toggle}
              aria-label="Phát video"
              className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white hover:bg-black/75"
            >
              <Icon name="play" size={24} />
            </button>
          )
        )}
      </div>
      </div>

      <div className="space-y-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-2">
        <div className="relative pt-3">
          {/* Mốc comment trên thanh thời gian */}
          {duration > 0 &&
            markers.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.label}
                aria-label={`Nhận xét tại ${fmtTimecode(m.time)}`}
                onClick={() => {
                  pendingSeek.current = m.time;
                  applyPending();
                }}
                className="absolute top-0 size-3 -translate-x-1/2 rounded-full border-2 border-surface bg-warn-fg hover:scale-125"
                style={{ left: `${Math.min(100, (m.time / duration) * 100)}%` }}
              />
            ))}
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.01}
            value={Math.min(current, duration || 1)}
            disabled={!duration}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Thanh thời gian video"
            className="block h-5 w-full"
          />
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={toggle} disabled={failed} aria-label={playing ? 'Tạm dừng' : 'Phát'} className="grid size-8 place-items-center rounded-md bg-ink text-ink-fg hover:bg-ink-hover disabled:opacity-40">
            <Icon name={playing ? 'pause' : 'play'} size={14} />
          </button>
          <button type="button" onClick={() => step(-1)} disabled={!duration} aria-label="Lùi 1 khung hình" title="Lùi 1 khung hình" className="grid size-8 place-items-center rounded-md hover:bg-surface-3 disabled:opacity-40">
            <Icon name="chevronLeft" size={14} />
          </button>
          <button type="button" onClick={() => step(1)} disabled={!duration} aria-label="Tiến 1 khung hình" title="Tiến 1 khung hình" className="grid size-8 place-items-center rounded-md hover:bg-surface-3 disabled:opacity-40">
            <Icon name="chevronRight" size={14} />
          </button>
          <span className="ml-1 text-[13px] font-medium">
            {fmtTimecode(current)} <span className="text-muted">/ {fmtTimecode(duration)}</span>
          </span>
          <button
            type="button"
            onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]!)}
            className="ml-auto rounded-md px-2 py-1 text-xs font-semibold hover:bg-surface-3"
            title="Đổi tốc độ phát"
          >
            {rate}×
          </button>
        </div>
      </div>
    </div>
  );
}
