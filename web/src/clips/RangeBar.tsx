import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { clock, MAX_CLIP_PARTS, MAX_CLIP_S, MIN_CLIP_S, MIN_PART_S, spokenDuration } from './lib';
import type { WordIndex } from './wordIndex';

/** Một đoạn đang soạn (chỉ số từ, gồm cả hai đầu). */
export interface DraftPart {
  start: number | null;
  end: number | null;
}

export interface Draft {
  /** null: clip thủ công mới. */
  clipId: number | null;
  code?: string;
  /** Các đoạn theo THỨ TỰ PHÁT. Clip thường có đúng một đoạn; clip ghép có 2–6 đoạn. */
  parts: DraftPart[];
  /** Đoạn đang sửa: hai thẻ Điểm đầu/Điểm cuối, bấm từ hoặc kéo chọn trong lời thoại đều áp vào đoạn này. */
  active: number;
  picking: 'start' | 'end' | null;
  title: string;
  originalTitle?: string;
}

export const PAD_BEFORE = 0.15;
export const PAD_AFTER = 0.3;

export const activePart = (d: Draft): DraftPart => d.parts[d.active] ?? d.parts[0] ?? { start: null, end: null };
/** Đổi đoạn đang sửa (và các trường khác của bản soạn nếu cần). */
export const withActive = (d: Draft, p: Partial<DraftPart>, extra: Partial<Draft> = {}): Draft => ({ ...d, ...extra, parts: d.parts.map((x, k) => (k === d.active ? { ...x, ...p } : x)) });

/** Khoảng thời gian (giây) của một đoạn, tính như server: lùi 0,15 s ở đầu và thêm 0,3 s ở cuối. */
export function partTimes(idx: WordIndex, p: DraftPart): { start: number; end: number } | null {
  if (p.start === null || p.end === null) return null;
  const a = idx.word(p.start);
  const b = idx.word(p.end);
  if (!a || !b) return null;
  return { start: Math.max(0, a.start - PAD_BEFORE), end: b.end + PAD_AFTER };
}

const decimal = (n: number) => String(n).replace('.', ',');
const mmss = (s: number) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

/** Kiểm tra bản soạn như server: mỗi đoạn ≥ 1,5 s, các đoạn không chồng nhau, tổng 3–300 s, tối đa 6 đoạn. */
export function checkDraft(idx: WordIndex, d: Draft) {
  const multi = d.parts.length > 1;
  const times = d.parts.map((p) => partTimes(idx, p));
  const complete = times.every((t) => t !== null);
  const total = complete ? times.reduce((n, t) => n + t!.end - t!.start, 0) : null;
  const overlaps = d.parts.map((p, k) =>
    multi && p.start !== null && p.end !== null && d.parts.some((q, j) => j !== k && q.start !== null && q.end !== null && p.start! <= q.end && q.start <= p.end!),
  );
  const short = times.map((t) => multi && !!t && t.end - t.start < MIN_PART_S);
  const missing = d.parts.findIndex((p, k) => p.start === null || p.end === null || !times[k]);
  const shortAt = short.indexOf(true);
  const reason =
    missing >= 0
      ? multi ? `Chọn đủ điểm đầu và điểm cuối của Đoạn ${missing + 1}` : 'Chọn đủ điểm đầu và điểm cuối'
      : shortAt >= 0
        ? `Đoạn ${shortAt + 1} ngắn quá, mỗi đoạn cần từ ${decimal(MIN_PART_S)} giây`
        : overlaps.some(Boolean)
          ? 'Các đoạn không được chồng lên nhau'
          : total !== null && total < MIN_CLIP_S
            ? `Clip ngắn quá, ${multi ? 'tổng các đoạn ' : ''}cần từ ${MIN_CLIP_S} giây`
            : total !== null && total > MAX_CLIP_S
              ? `Clip dài quá, ${multi ? 'tổng các đoạn ' : ''}tối đa ${spokenDuration(MAX_CLIP_S)}`
              : d.parts.length > MAX_CLIP_PARTS
                ? `Tối đa ${MAX_CLIP_PARTS} đoạn`
                : null;
  return { multi, times, complete, total, bad: d.parts.map((_, k) => !times[k] || short[k] || overlaps[k]), reason };
}

const stepBtn =
  'grid min-h-8 min-w-8 place-items-center px-1.5 text-[11px] font-semibold text-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-40';

/** Một đầu của vùng cắt: từ đang chọn kèm ngữ cảnh, nút chọn bằng lời thoại, nhích theo câu / theo từ. */
function Edge({ edge, wordIdx, active, idx, part, onPick, onNudge }: { edge: 'start' | 'end'; wordIdx: number | null; active: boolean; idx: WordIndex; part?: number; onPick: () => void; onNudge: (unit: 'sentence' | 'word', dir: -1 | 1) => void }) {
  const label = `${edge === 'start' ? 'Điểm đầu' : 'Điểm cuối'}${part ? ` đoạn ${part}` : ''}`;
  const w = wordIdx === null ? null : idx.word(wordIdx);
  const context = w
    ? edge === 'start'
      ? <><strong className="rounded bg-violet-bg px-1 font-semibold text-violet-fg">{w.w}</strong> {idx.text(wordIdx! + 1, wordIdx! + 6, 6)}</>
      : <>{idx.text(Math.max(0, wordIdx! - 6), wordIdx! - 1, 7)} <strong className="rounded bg-violet-bg px-1 font-semibold text-violet-fg">{w.w}</strong></>
    : null;
  const none = wordIdx === null;
  return (
    <div className={`flex min-w-0 flex-col gap-2 rounded-lg border bg-surface p-2.5 transition-shadow ${active ? 'border-violet-fg shadow-[0_0_0_3px_var(--violet-bg)]' : 'border-line'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
        <span className="font-mono text-xs font-semibold tabular-nums">{w ? clock(w.start) : '—'}</span>
      </div>
      <p className={`line-clamp-2 text-[13px] sm:min-h-10 leading-5 ${active ? 'text-violet-fg' : 'text-fg/80'}`} title={w ? idx.text(Math.max(0, wordIdx! - 6), wordIdx! + 8, 16) : undefined}>
        {active ? (
          <span className="flex items-center gap-1.5 font-medium"><Icon name="arrowLeft" size={13} className="rotate-[-90deg]" />Bấm vào một từ trong lời thoại</span>
        ) : context ? (
          <>{edge === 'end' && '…'}{context}</>
        ) : (
          <span className="text-muted">Chưa chọn</span>
        )}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={active ? 'primary' : 'secondary'} className="flex-1" onClick={onPick} aria-pressed={active}>
          {active ? 'Đang chọn…' : w ? 'Chọn lại' : 'Chọn từ'}
        </Button>
        <div className="flex overflow-hidden rounded-md border border-line-strong bg-surface" role="group" aria-label={`Nhích ${label.toLowerCase()}`}>
          <button type="button" className={stepBtn} disabled={none} onClick={() => onNudge('sentence', -1)} aria-label={`${label}: lùi một câu`} title="Lùi một câu">«</button>
          <button type="button" className={`${stepBtn} border-l border-line`} disabled={none} onClick={() => onNudge('word', -1)} aria-label={`${label}: lùi một từ`} title="Lùi một từ"><Icon name="chevronLeft" size={13} /></button>
          <button type="button" className={`${stepBtn} border-l border-line`} disabled={none} onClick={() => onNudge('word', 1)} aria-label={`${label}: tiến một từ`} title="Tiến một từ"><Icon name="chevronRight" size={13} /></button>
          <button type="button" className={`${stepBtn} border-l border-line`} disabled={none} onClick={() => onNudge('sentence', 1)} aria-label={`${label}: tiến một câu`} title="Tiến một câu">»</button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  draft: Draft;
  idx: WordIndex;
  onChange: (d: Draft) => void;
  /** Phát thử các đoạn theo thứ tự phát. */
  onPreview: (segments: { start: number; end: number }[], label: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Cuộn lời thoại tới một từ (khi chuyển sang sửa đoạn khác). */
  onShowWord?: (i: number) => void;
  saving: boolean;
  lan?: boolean;
  quotaReason?: string | null;
}

const chipBase = 'inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors';

/**
 * Thanh soạn vùng cắt phía trên transcript: chọn từ đầu/cuối (bấm vào lời thoại), nhích theo câu/từ, phát thử, lưu.
 * Clip ghép: hàng «Đoạn 1 · Đoạn 2 · + Thêm đoạn» chọn đoạn đang sửa; thứ tự các đoạn là thứ tự phát.
 */
export function RangeBar({ draft, idx, onChange, onPreview, onSave, onCancel, onShowWord, saving, quotaReason }: Props) {
  const check = checkDraft(idx, draft);
  const { multi, times, total } = check;
  const part = activePart(draft);
  const n = draft.active + 1;
  const tooShort = total !== null && total < MIN_CLIP_S;
  const tooLong = total !== null && total > MAX_CLIP_S;
  const reason = check.reason ?? quotaReason ?? null;
  const nudge = (which: 'start' | 'end', unit: 'sentence' | 'word', dir: -1 | 1) => {
    const cur = which === 'start' ? part.start : part.end;
    if (cur === null) return;
    let target: number | null;
    if (unit === 'word') {
      target = cur + dir;
      if (target < 0 || target > idx.lastWord || !idx.word(target)) return;
    } else {
      const si = idx.sentenceOf(cur);
      const first = idx.firstOf(si);
      const last = idx.lastOf(si);
      if (which === 'start') {
        // lùi: về đầu câu hiện tại (nếu đang giữa câu) hoặc đầu câu trước; tiến: đầu câu sau
        target = dir === -1 ? (first !== null && cur > first ? first : idx.firstOf(si - 1)) : idx.firstOf(si + 1);
      } else {
        target = dir === 1 ? (last !== null && cur < last ? last : idx.lastOf(si + 1)) : idx.lastOf(si - 1);
      }
    }
    if (target === null) return;
    const next = { ...part, [which]: target };
    if (next.start !== null && next.end !== null && next.start > next.end) return;
    onChange(withActive(draft, next));
  };
  const choose = (k: number) => {
    const p = draft.parts[k];
    if (!p) return;
    onChange({ ...draft, active: k, picking: p.start === null ? 'start' : p.end === null ? 'end' : null });
    if (p.start !== null) onShowWord?.(p.start);
  };
  const addPart = () => {
    if (draft.parts.length >= MAX_CLIP_PARTS) return;
    onChange({ ...draft, parts: [...draft.parts, { start: null, end: null }], active: draft.parts.length, picking: 'start' });
  };
  const movePart = (dir: -1 | 1) => {
    const k = draft.active;
    const j = k + dir;
    if (j < 0 || j >= draft.parts.length) return;
    const parts = [...draft.parts];
    [parts[k], parts[j]] = [parts[j]!, parts[k]!];
    onChange({ ...draft, parts, active: j });
  };
  const removePart = () => {
    if (draft.parts.length < 2) return;
    const parts = draft.parts.filter((_, k) => k !== draft.active);
    onChange({ ...draft, parts, active: Math.min(draft.active, parts.length - 1), picking: null });
  };
  const isNew = draft.clipId === null;
  const target = multi ? ` đoạn ${n}` : ' clip';
  const pickHint = draft.picking === 'start' ? `Bấm vào từ mở đầu${target} trong lời thoại bên dưới.` : draft.picking === 'end' ? `Bấm vào từ kết thúc${target}.` : null;
  const idleHint = multi
    ? 'Chọn một đoạn để sửa. Thứ tự các đoạn là thứ tự phát trong clip.'
    : isNew && part.start === null
      ? 'Bấm từ đầu rồi từ cuối, hoặc kéo chuột qua các từ.'
      : 'Chọn lại hoặc nhích điểm đầu/cuối, nghe thử rồi lưu.';
  const segments = check.complete ? (times as { start: number; end: number }[]) : null;
  const first = times[0];
  const lastT = times.at(-1);
  return (
    <div className="space-y-2.5 border-b border-violet-fg/25 bg-violet-bg/30 p-2.5 sm:p-3" role="group" aria-label="Soạn điểm cắt">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-violet-fg text-surface" aria-hidden="true"><Icon name="scissors" size={14} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-bold leading-tight">{isNew ? (multi ? 'Tạo clip ghép từ lời thoại' : 'Tạo clip mới từ lời thoại') : `Sửa điểm cắt ${draft.code ?? ''}`}</h3>
          <p className="truncate text-[11px] text-muted" aria-live="polite">{pickHint ?? idleHint}</p>
        </div>
        {total !== null && first && lastT && (
          <span
            className={`shrink-0 rounded-md px-2 py-1 text-right text-xs font-semibold leading-tight tabular-nums ${tooShort || tooLong ? 'bg-danger-bg text-danger-fg' : 'bg-surface text-fg'}`}
            title={multi ? times.map((t, k) => `Đoạn ${k + 1}: ${clock(t!.start)} → ${clock(t!.end)}`).join('\n') : `${clock(first.start)} → ${clock(first.end)}`}
          >
            {spokenDuration(total)}
            <span className="block font-mono text-[10px] font-normal text-muted max-sm:hidden">{multi ? `ghép ${draft.parts.length} đoạn` : `${clock(first.start)} → ${clock(first.end)}`}</span>
          </span>
        )}
        <button type="button" onClick={onCancel} aria-label="Đóng trình sửa điểm cắt" className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg">
          <Icon name="x" />
        </button>
      </div>
      {multi && (
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Các đoạn của clip theo thứ tự phát">
            {draft.parts.map((p, k) => {
              const t = times[k];
              const on = k === draft.active;
              const bad = check.bad[k] && (p.start !== null || !on);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => choose(k)}
                  aria-label={`Đoạn ${k + 1}${t ? `, ${spokenDuration(t.end - t.start)}, từ ${clock(t.start)}` : ', chưa chọn đủ'}${bad && t ? ', cần sửa' : ''}`}
                  title={t ? `${clock(t.start)} → ${clock(t.end)}` : 'Chưa chọn đủ điểm đầu/cuối'}
                  className={`${chipBase} ${on ? 'border-violet-fg bg-violet-fg text-surface' : bad ? 'border-danger-fg/60 bg-danger-bg text-danger-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-2'}`}
                >
                  Đoạn {k + 1}
                  <span className={`font-mono font-normal tabular-nums ${on ? 'text-surface/80' : 'text-muted'}`}>{t ? mmss(t.end - t.start) : '—'}</span>
                </button>
              );
            })}
            {draft.parts.length < MAX_CLIP_PARTS && (
              <button type="button" onClick={addPart} className={`${chipBase} border-dashed border-violet-fg/50 bg-surface font-medium text-violet-fg hover:bg-violet-bg`} title={`Ghép thêm một đoạn (tối đa ${MAX_CLIP_PARTS})`}>
                <Icon name="plus" size={12} />Thêm đoạn
              </button>
            )}
          </div>
          <div className="ml-auto flex overflow-hidden rounded-md border border-line-strong bg-surface" role="group" aria-label={`Sắp xếp đoạn ${n}`}>
            <button type="button" className={stepBtn} disabled={draft.active === 0} onClick={() => movePart(-1)} aria-label={`Cho đoạn ${n} phát sớm hơn`} title="Phát sớm hơn"><Icon name="chevronLeft" size={13} /></button>
            <button type="button" className={`${stepBtn} border-l border-line`} disabled={draft.active >= draft.parts.length - 1} onClick={() => movePart(1)} aria-label={`Cho đoạn ${n} phát muộn hơn`} title="Phát muộn hơn"><Icon name="chevronRight" size={13} /></button>
            <button type="button" className={`${stepBtn.replace('hover:bg-surface-3 hover:text-fg', 'hover:bg-danger-bg hover:text-danger-fg')} border-l border-line`} onClick={removePart} aria-label={`Bỏ đoạn ${n} khỏi clip`} title="Bỏ đoạn này"><Icon name="trash" size={13} /></button>
          </div>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Edge edge="start" wordIdx={part.start} part={multi ? n : undefined} active={draft.picking === 'start'} idx={idx} onPick={() => onChange({ ...draft, picking: draft.picking === 'start' ? null : 'start' })} onNudge={(u, d) => nudge('start', u, d)} />
        <Edge edge="end" wordIdx={part.end} part={multi ? n : undefined} active={draft.picking === 'end'} idx={idx} onPick={() => onChange({ ...draft, picking: draft.picking === 'end' ? null : 'end' })} onNudge={(u, d) => nudge('end', u, d)} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          <label htmlFor="range-title" className="mb-1 block text-xs font-semibold text-muted">
            Tiêu đề <span className="font-normal">(tuỳ chọn)</span>
          </label>
          <input id="range-title" value={draft.title} maxLength={120} onChange={(e) => onChange({ ...draft, title: e.target.value })} className="min-h-8 py-1 text-[13px]" placeholder="Vd: Công dụng chính của sản phẩm" />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
          {!multi && (
            <Button size="sm" variant="ghost" icon={<Icon name="plus" size={13} />} onClick={addPart} disabledReason={times[0] ? null : 'Chọn xong đoạn đầu tiên trước'} title="Ghép thêm một đoạn khác của video vào clip này" aria-label="Ghép thêm đoạn">
              <span className="max-[420px]:sr-only">Ghép đoạn</span>
            </Button>
          )}
          <Button size="sm" icon={<Icon name="play" size={12} />} disabled={!segments} onClick={() => segments && onPreview(segments, `${isNew ? 'clip mới' : `${draft.code ?? ''} · điểm cắt đang sửa`}${multi ? ` · ${draft.parts.length} đoạn` : ''}`)}>
            Nghe thử
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Hủy
          </Button>
          <Button size="sm" variant="primary" loading={saving} disabledReason={reason} onClick={onSave} icon={<Icon name="check" size={14} />}>
            {isNew ? 'Tạo clip' : 'Lưu'}
          </Button>
        </div>
      </div>
      {reason && check.complete && <p className="text-xs text-danger-fg" role="status">{reason}</p>}
    </div>
  );
}
