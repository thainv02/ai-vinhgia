import { fmtTimecode } from '../lib/format';
import { outputToSource, type Timeline } from '../lib/finalCut';

const dec = (n: number) => n.toFixed(1).replace('.', ',');

const HATCH = 'repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--danger-fg) 45%, transparent) 4px 6px)';

/**
 * Dải timeline theo cảnh (chiều rộng theo độ dài video nguồn): phần giữ (đặc) và phần bị cắt (gạch chéo).
 * Bấm đoạn giữ để tua video kết quả tới đó; bấm phần bị cắt để tua tới chỗ cắt. Vạch đứng là vị trí đang phát.
 */
export function FinalTimeline({ tl, currentOut, onSeek }: { tl: Timeline; currentOut: number | null; onSeek: (outT: number) => void }) {
  const sumSource = tl.scenes.reduce((a, s) => a + s.sourceDuration, 0) || 1;
  const playhead = currentOut === null ? null : outputToSource(tl, currentOut);
  const removedCount = tl.scenes.reduce((a, s) => a + s.removed.length, 0);

  return (
    <div className="space-y-3">
      <div className="flex gap-1" role="group" aria-label="Timeline các cảnh">
        {tl.scenes.map((sc, i) => {
          const keptSum = sc.kept.reduce((a, k) => a + (k.out_s - k.in_s), 0);
          return (
            <div key={sc.scene_id} className="min-w-0" style={{ flex: `${sc.sourceDuration / sumSource} 1 0` }}>
              <div className="mb-0.5 flex items-baseline justify-between gap-1 text-[11px]">
                <strong>{sc.code}</strong>
                <span className="truncate text-muted" title={`Giữ ${dec(keptSum)} / ${dec(sc.sourceDuration)} giây`}>
                  {dec(keptSum)}/{dec(sc.sourceDuration)}s
                </span>
              </div>
              <div className="relative h-10 overflow-hidden rounded-md border border-line bg-danger-bg" style={{ backgroundImage: HATCH }}>
                {sc.removed.map((r, ri) => (
                  <button
                    key={`r${ri}`}
                    type="button"
                    onClick={() => onSeek(r.seekOut)}
                    title={`Cắt ${fmtTimecode(r.from_s)}–${fmtTimecode(r.to_s)}: ${r.reason}`}
                    aria-label={`Đoạn bị cắt ${sc.code} ${fmtTimecode(r.from_s)} đến ${fmtTimecode(r.to_s)}`}
                    className="absolute inset-y-0 cursor-pointer hover:bg-danger-fg/20"
                    style={{ left: `${(r.from_s / sc.sourceDuration) * 100}%`, width: `${((r.to_s - r.from_s) / sc.sourceDuration) * 100}%` }}
                  />
                ))}
                {sc.kept.map((k, ki) => (
                  <button
                    key={`k${ki}`}
                    type="button"
                    onClick={() => onSeek(k.outStart)}
                    title={`Giữ ${fmtTimecode(k.in_s)}–${fmtTimecode(k.out_s)} (tại ${fmtTimecode(k.outStart)} trong bản hoàn chỉnh)`}
                    aria-label={`Đoạn giữ ${sc.code} ${fmtTimecode(k.in_s)} đến ${fmtTimecode(k.out_s)}`}
                    className="absolute inset-y-0 cursor-pointer border-x border-surface bg-ink hover:bg-ink-hover"
                    style={{ left: `${(k.in_s / sc.sourceDuration) * 100}%`, width: `${((k.out_s - k.in_s) / sc.sourceDuration) * 100}%` }}
                  />
                ))}
                {playhead && playhead.sceneIdx === i && (
                  <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-warn-fg shadow-[0_0_0_1px_var(--surface)]" style={{ left: `${(playhead.sourceT / sc.sourceDuration) * 100}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] bg-ink" aria-hidden="true" /> Giữ
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border border-line bg-danger-bg" style={{ backgroundImage: HATCH }} aria-hidden="true" /> Bị cắt
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-0.5 bg-warn-fg" aria-hidden="true" /> Đang phát
        </span>
        <span className="ml-auto">Tổng {dec(tl.total)} giây</span>
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-semibold text-muted">Phần bị cắt ({removedCount})</h3>
        {removedCount === 0 ? (
          <p className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-muted">Không cắt đoạn nào: giữ nguyên toàn bộ video của các cảnh.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {tl.scenes.flatMap((sc) =>
              sc.removed.map((r, ri) => (
                <li key={`${sc.scene_id}-${ri}`}>
                  <button type="button" onClick={() => onSeek(r.seekOut)} className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-left text-[13px] hover:bg-surface-2" title="Tua video tới chỗ cắt">
                    <strong>{sc.code}</strong>
                    <span className="rounded bg-danger-bg px-1.5 text-xs font-semibold text-danger-fg">
                      {fmtTimecode(r.from_s)} – {fmtTimecode(r.to_s)} ({dec(r.to_s - r.from_s)}s)
                    </span>
                    <span className="min-w-0 flex-1 basis-48">{r.reason}</span>
                  </button>
                </li>
              )),
            )}
          </ul>
        )}
        {tl.scenes.some((s) => s.note) && (
          <ul className="mt-2 space-y-0.5 text-xs text-muted">
            {tl.scenes
              .filter((s) => s.note)
              .map((s) => (
                <li key={s.scene_id}>
                  <strong className="text-fg">{s.code}:</strong> {s.note}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
