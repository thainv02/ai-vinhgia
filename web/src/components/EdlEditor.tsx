import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { EdlScene, EdlSegment, FinalCut } from '../api/types';
import { useRerenderFinalCut } from '../hooks/mutations';
import { computeRemoved, fmtSeconds, round2, validateSegments } from '../lib/finalCut';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';
import { InlineError } from './States';
import { VideoPlayer, type PlayerHandle } from './VideoPlayer';

interface DraftScene extends EdlScene {
  code: string;
  attempt: number;
  videoUrl: string | null;
  duration: number | null;
}

interface EdlError {
  code: string;
  message: string;
  /** Mã cảnh và số thứ tự đoạn (từ 1) server chỉ ra trong details, nếu xác định được. */
  scene?: string;
  segment?: number;
}

const fmtNum = (n: number) => String(round2(n)).replace('.', ',');

function toDraft(fc: FinalCut): DraftScene[] {
  const info = new Map(fc.selection.map((s, i) => [s.scene_id, { code: s.code, attempt: s.attempt, order: i, videoUrl: s.video_url, duration: s.duration_s }]));
  return [...(fc.edl?.scenes ?? [])]
    .sort((a, b) => (info.get(a.scene_id)?.order ?? 0) - (info.get(b.scene_id)?.order ?? 0))
    .map((s) => ({
      ...s,
      segments: s.segments.map((g) => ({ ...g })),
      removed: s.removed.map((r) => ({ ...r })),
      code: info.get(s.scene_id)?.code ?? `#${s.scene_id}`,
      attempt: info.get(s.scene_id)?.attempt ?? 0,
      videoUrl: info.get(s.scene_id)?.videoUrl ?? null,
      duration: info.get(s.scene_id)?.duration ?? null,
    }));
}

/** Ô nhập giây: nhận dấu phẩy hoặc chấm, mũi tên lên/xuống chỉnh 0,1 giây, ghi nhận khi rời ô hoặc Enter. */
function NumField({ value, onCommit, label, invalid }: { value: number; onCommit: (n: number) => void; label: string; invalid: boolean }) {
  const [text, setText] = useState(fmtNum(value));
  useEffect(() => setText(fmtNum(value)), [value]);
  const commit = () => {
    const n = Number(text.trim().replace(',', '.'));
    if (text.trim() === '' || Number.isNaN(n)) setText(fmtNum(value));
    else if (round2(n) !== value) onCommit(round2(n));
    else setText(fmtNum(value));
  };
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const base = Number(text.trim().replace(',', '.'));
          const cur = Number.isNaN(base) ? value : base;
          onCommit(round2(Math.max(0, cur + (e.key === 'ArrowUp' ? 0.1 : -0.1))));
        }
      }}
      className={`w-[4.5rem]! min-h-8! px-2! py-1! text-right ${invalid ? 'border-danger-fg!' : ''}`}
    />
  );
}

function SceneEditor({ scene, onChange, serverMessage, badSegment }: { scene: DraftScene; onChange: (segments: EdlSegment[]) => void; serverMessage: string | null; badSegment: number | null }) {
  // #t=0.5: hiện một khung hình thật thay vì khung đầu (thường đen) khi chưa phát.
  const asset = scene.videoUrl ? { url: `${scene.videoUrl}#t=0.5` } : null;
  const duration = scene.duration;
  const playerRef = useRef<PlayerHandle>(null);
  const [seek, setSeek] = useState<{ t: number; nonce: number } | null>(null);
  const segs = scene.segments;
  const errors = validateSegments(segs, duration);
  const kept = segs.reduce((a, s) => a + Math.max(0, s.out_s - s.in_s), 0);
  const now = () => round2(playerRef.current?.getTime() ?? 0);
  const set = (i: number, patch: Partial<EdlSegment>) => onChange(segs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const markers = segs.flatMap((s, i) => [
    { id: i * 2, time: s.in_s, label: `Đoạn ${i + 1}: in` },
    { id: i * 2 + 1, time: s.out_s, label: `Đoạn ${i + 1}: out` },
  ]);

  const add = () => {
    const start = segs.length ? segs[segs.length - 1]!.out_s : 0;
    const end = duration !== null ? Math.min(duration, start + 1) : start + 1;
    onChange([...segs, { in_s: round2(start), out_s: round2(end) }]);
  };
  const split = () => {
    const t = now();
    const i = segs.findIndex((s) => t > s.in_s && t < s.out_s);
    if (i < 0) {
      toast.info('Tạm dừng video bên trong một đoạn đang giữ rồi bấm «Tách» để chia đoạn đó làm hai.');
      return;
    }
    const s = segs[i]!;
    onChange([...segs.slice(0, i), { in_s: s.in_s, out_s: t }, { in_s: t, out_s: s.out_s }, ...segs.slice(i + 1)]);
  };

  return (
    <section className={`rounded-lg border bg-surface p-3 ${serverMessage ? 'border-danger-fg' : 'border-line'}`} aria-label={`Điểm cắt ${scene.code}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-bold">{scene.code}</h3>
        <span className="text-xs text-muted">
          bản v{scene.attempt}
          {duration !== null ? ` · dài ${fmtSeconds(duration)}` : ''} · giữ {fmtSeconds(kept)}
        </span>
      </div>
      {serverMessage && (
        <p role="alert" className="mb-2 flex items-start gap-1.5 rounded-md bg-danger-bg px-2.5 py-1.5 text-xs text-danger-fg">
          <Icon name="alert" size={13} className="mt-px" />
          <span>{serverMessage}</span>
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
        <div className="mx-auto w-full max-w-[170px]">
          {asset ? (
            <VideoPlayer ref={playerRef} src={asset.url} markers={markers} seekRequest={seek} onTimeChange={() => undefined} height="min(34vh, 260px)" />
          ) : (
            <p className="rounded-md bg-surface-2 px-2 py-6 text-center text-xs text-muted">Không có video nguồn để xem</p>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <ol className="space-y-1.5">
            {segs.map((s, i) => (
              <li key={i} className={`rounded-md border bg-surface-2 px-2 py-1.5 ${badSegment === i + 1 ? 'border-danger-fg ring-1 ring-danger-fg' : 'border-line'}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
                  <span className="w-5 text-xs font-semibold text-muted">#{i + 1}</span>
                  <span className="text-xs text-muted">In</span>
                  <NumField label={`${scene.code} đoạn ${i + 1}: in (giây)`} value={s.in_s} invalid={!!errors[i]} onCommit={(n) => set(i, { in_s: n })} />
                  <Button size="sm" disabled={!asset} title="Đặt in tại vị trí đang phát" onClick={() => set(i, { in_s: now() })}>
                    Đặt in
                  </Button>
                  <span className="text-xs text-muted">Out</span>
                  <NumField label={`${scene.code} đoạn ${i + 1}: out (giây)`} value={s.out_s} invalid={!!errors[i]} onCommit={(n) => set(i, { out_s: n })} />
                  <Button size="sm" disabled={!asset} title="Đặt out tại vị trí đang phát" onClick={() => set(i, { out_s: now() })}>
                    Đặt out
                  </Button>
                  <span className="ml-auto text-xs text-muted">{fmtSeconds(Math.max(0, s.out_s - s.in_s))}</span>
                  <button
                    type="button"
                    aria-label={`Xóa đoạn ${i + 1} của ${scene.code}`}
                    disabled={segs.length <= 1}
                    title={segs.length <= 1 ? 'Mỗi cảnh cần ít nhất 1 đoạn' : 'Xóa đoạn này (phần này sẽ bị cắt)'}
                    onClick={() => onChange(segs.filter((_, j) => j !== i))}
                    className="rounded p-1.5 text-muted hover:bg-danger-bg hover:text-danger-fg disabled:opacity-30"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                {errors[i] && <p className="mt-1 text-xs text-warn-fg">{errors[i]}</p>}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={add}>
              Thêm đoạn
            </Button>
            <Button size="sm" disabled={!asset} title="Chia đoạn đang chứa vị trí phát làm hai" onClick={split}>
              Tách tại vị trí đang phát
            </Button>
            {segs.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSeek({ t: segs[0]!.in_s, nonce: (seek?.nonce ?? 0) + 1 })} disabled={!asset}>
                Tới đoạn đầu
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Trình chỉnh EDL: sửa các đoạn giữ của từng cảnh, rồi "Render lại" tạo version mới (không tốn credit). */
export function EdlEditor({ fc, onRendered }: { fc: FinalCut; onRendered: (fc: FinalCut) => void }) {
  const rerender = useRerenderFinalCut();
  const [scenes, setScenes] = useState<DraftScene[]>(() => toDraft(fc));
  const [note, setNote] = useState('');
  const [error, setError] = useState<EdlError | null>(null);

  const total = useMemo(() => scenes.reduce((a, s) => a + s.segments.reduce((b, g) => b + Math.max(0, g.out_s - g.in_s), 0), 0), [scenes]);
  // Lỗi INVALID_EDL nói rõ cảnh nào: đánh dấu đúng cảnh được nhắc tới trong thông báo.
  const mentioned = useMemo(() => new Set(error?.scene ? [error.scene] : (error?.message.match(/\bC\d+\b/g) ?? [])), [error]);

  if (!fc.edl) {
    return <p className="rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">Bản này chưa có điểm cắt (Claude chưa chọn xong) nên chưa chỉnh được.</p>;
  }

  const submit = () => {
    setError(null);
    const edl = {
      scenes: scenes.map((s) => {
        const segments = [...s.segments].sort((a, b) => a.in_s - b.in_s).map((g) => ({ in_s: round2(g.in_s), out_s: round2(g.out_s) }));
        const maxEnd = Math.max(0, ...segments.map((g) => g.out_s), ...s.removed.map((r) => r.to_s));
        return {
          scene_id: s.scene_id,
          asset_id: s.asset_id,
          segments,
          removed: computeRemoved(segments, maxEnd, s.removed, 'Người dùng chỉnh tay'),
          note: s.note ?? '',
        };
      }),
    };
    rerender.mutate(
      { id: fc.id, edl, note: note.trim() || undefined },
      {
        onSuccess: (created) => {
          toast.success(`Đã tạo v${created.version}, đang render`);
          onRendered(created);
        },
        onError: (e) => {
          const d = e instanceof ApiError && e.details && typeof e.details === 'object' ? (e.details as { scene?: unknown; segment?: unknown }) : {};
          setError({
            code: e instanceof ApiError ? e.code : 'ERROR',
            message: errorMessage(e),
            scene: typeof d.scene === 'string' ? d.scene : undefined,
            segment: typeof d.segment === 'number' ? d.segment : undefined,
          });
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Sửa các đoạn được giữ của từng cảnh (đơn vị giây, bước 0,1). Dùng trình phát nhỏ để tìm khung rồi bấm «Đặt in/out». Phần nằm ngoài các đoạn giữ sẽ bị cắt. Chuyển cảnh luôn là cắt thẳng.
      </p>
      {scenes.map((s, i) => (
        <SceneEditor
          key={s.scene_id}
          scene={s}
          serverMessage={error && mentioned.has(s.code) ? error.message : null}
          badSegment={error && error.scene === s.code ? (error.segment ?? null) : null}
          onChange={(segments) => setScenes((cur) => cur.map((x, j) => (j === i ? { ...x, segments } : x)))}
        />
      ))}
      <div className="rounded-lg border border-line bg-surface-2 p-3">
        <div className="mb-2 text-[13px]">
          Thời lượng dự kiến: <strong>{fmtSeconds(total)}</strong>
          {fc.duration_s !== null && <span className="text-muted"> (bản v{fc.version}: {fmtSeconds(fc.duration_s)})</span>}
        </div>
        <label htmlFor="edl-note" className="mb-1 block text-xs font-semibold text-muted">
          Ghi chú cho bản mới (tuỳ chọn)
        </label>
        <input id="edl-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Vd: bỏ đoạn tay chưa vào khung ở C2" />
        {error && (
          <div className="mt-2">
            <InlineError>
              {scenes.some((x) => mentioned.has(x.code)) ? 'Chưa render được: xem cảnh được đánh dấu đỏ ở trên và sửa đoạn bị báo lỗi.' : error.message}
            </InlineError>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={rerender.isPending} icon={<Icon name="refresh" size={14} />} onClick={submit}>
            Render lại (không tốn credit)
          </Button>
          <span className="text-xs text-muted">Tạo một version mới, các bản cũ vẫn được giữ.</span>
        </div>
      </div>
    </div>
  );
}
