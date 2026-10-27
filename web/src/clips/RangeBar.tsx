import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { clock, MAX_CLIP_S, MIN_CLIP_S, spokenDuration } from './lib';
import type { WordIndex } from './wordIndex';

export interface Draft {
  /** null: clip thủ công mới. */
  clipId: number | null;
  code?: string;
  start: number | null;
  end: number | null;
  picking: 'start' | 'end' | null;
  title: string;
  originalTitle?: string;
}

export const PAD_BEFORE = 0.15;
export const PAD_AFTER = 0.3;

/** Khoảng thời gian (giây) của vùng soạn, tính như server: lùi 0,15 s ở đầu và thêm 0,3 s ở cuối. */
export function draftTimes(idx: WordIndex, d: Draft): { start: number; end: number } | null {
  if (d.start === null || d.end === null) return null;
  const a = idx.word(d.start);
  const b = idx.word(d.end);
  if (!a || !b) return null;
  return { start: Math.max(0, a.start - PAD_BEFORE), end: b.end + PAD_AFTER };
}

function Edge({ label, wordIdx, active, idx, onPick, onNudge }: { label: string; wordIdx: number | null; active: boolean; idx: WordIndex; onPick: () => void; onNudge: (dir: -1 | 1) => void }) {
  const w = wordIdx === null ? null : idx.word(wordIdx);
  return (
    <div className={`min-w-0 rounded-md border p-2 ${active ? 'border-violet-fg bg-violet-bg/40' : 'border-line bg-surface-2'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{label}</span>
        <span className="font-mono text-[11px] text-muted">{w ? clock(w.start) : '—'}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 min-h-8 text-xs text-muted" title={w ? idx.text(wordIdx!, wordIdx! + 8, 9) : undefined}>
        {active ? 'Bấm vào một từ trong lời thoại bên dưới...' : w ? <>…<strong className="text-fg">{w.w}</strong> {idx.text(wordIdx! + 1, wordIdx! + 7, 7)}</> : 'Chưa chọn'}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Button size="sm" variant={active ? 'primary' : 'secondary'} onClick={onPick}>
          {active ? 'Đang chọn...' : 'Chọn từ'}
        </Button>
        <Button size="sm" aria-label={`${label}: lùi một câu`} title="Lùi một câu" disabled={wordIdx === null} onClick={() => onNudge(-1)}>
          <Icon name="chevronLeft" size={14} />
          <span className="max-[480px]:sr-only">Câu</span>
        </Button>
        <Button size="sm" aria-label={`${label}: tiến một câu`} title="Tiến một câu" disabled={wordIdx === null} onClick={() => onNudge(1)}>
          <span className="max-[480px]:sr-only">Câu</span>
          <Icon name="chevronRight" size={14} />
        </Button>
      </div>
    </div>
  );
}

interface Props {
  draft: Draft;
  idx: WordIndex;
  onChange: (d: Draft) => void;
  onPreview: (start: number, end: number, label: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  lan?: boolean;
  quotaReason?: string | null;
}

/** Thanh soạn vùng cắt phía trên transcript: chọn từ đầu/cuối (bấm vào lời thoại), lùi/tiến theo câu, phát thử, lưu. */
export function RangeBar({ draft, idx, onChange, onPreview, onSave, onCancel, saving, quotaReason }: Props) {
  const times = draftTimes(idx, draft);
  const dur = times ? times.end - times.start : null;
  const reason =
    draft.start === null || draft.end === null
      ? 'Chọn đủ từ đầu và từ cuối'
      : dur !== null && dur < MIN_CLIP_S
        ? `Clip ngắn quá, cần từ ${MIN_CLIP_S} giây`
        : dur !== null && dur > MAX_CLIP_S
          ? `Clip dài quá, tối đa ${MAX_CLIP_S} giây`
          : (quotaReason ?? null);
  const nudge = (which: 'start' | 'end', dir: -1 | 1) => {
    const cur = which === 'start' ? draft.start : draft.end;
    if (cur === null) return;
    const si = idx.sentenceOf(cur);
    const first = idx.firstOf(si);
    const last = idx.lastOf(si);
    let target: number | null;
    if (which === 'start') {
      // lùi: về đầu câu hiện tại (nếu đang giữa câu) hoặc đầu câu trước; tiến: đầu câu sau
      target = dir === -1 ? (first !== null && cur > first ? first : idx.firstOf(si - 1)) : idx.firstOf(si + 1);
    } else {
      target = dir === 1 ? (last !== null && cur < last ? last : idx.lastOf(si + 1)) : idx.lastOf(si - 1);
    }
    if (target === null) return;
    const next = { ...draft, [which]: target } as Draft;
    if (next.start !== null && next.end !== null && next.start > next.end) return;
    onChange(next);
  };
  const dstate = dur === null ? null : dur < MIN_CLIP_S || dur > MAX_CLIP_S ? 'bad' : 'ok';
  return (
    <div className="space-y-2 border-b border-violet-fg/30 bg-violet-bg/25 p-2.5" role="group" aria-label="Soạn điểm cắt">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-bold">{draft.clipId === null ? 'Tạo clip thủ công' : `Sửa điểm cắt ${draft.code ?? ''}`}</h3>
        {times && dur !== null && (
          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${dstate === 'bad' ? 'bg-danger-bg text-danger-fg' : 'bg-violet-bg text-violet-fg'}`}>
            {clock(times.start)} → {clock(times.end)} · {spokenDuration(dur)}
          </span>
        )}
        <button type="button" onClick={onCancel} aria-label="Hủy soạn" className="ml-auto rounded p-1 text-muted hover:bg-surface-3 hover:text-fg">
          <Icon name="x" />
        </button>
      </div>
      <p className={`text-xs text-muted ${draft.start !== null && draft.end !== null ? 'max-[480px]:hidden' : ''}`}>
        {draft.clipId === null && draft.start === null
          ? 'Bấm vào từ đầu của clip trong lời thoại. Trên máy tính cũng có thể kéo chuột qua các từ.'
          : 'Bấm «Chọn từ» rồi bấm vào lời thoại để đổi điểm đầu/cuối, hoặc nhích theo câu.'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Edge label="Từ đầu" wordIdx={draft.start} active={draft.picking === 'start'} idx={idx} onPick={() => onChange({ ...draft, picking: draft.picking === 'start' ? null : 'start' })} onNudge={(d) => nudge('start', d)} />
        <Edge label="Từ cuối" wordIdx={draft.end} active={draft.picking === 'end'} idx={idx} onPick={() => onChange({ ...draft, picking: draft.picking === 'end' ? null : 'end' })} onNudge={(d) => nudge('end', d)} />
      </div>
      <div>
        <label htmlFor="range-title" className="mb-0.5 block text-xs font-semibold text-muted">
          Tiêu đề (tuỳ chọn)
        </label>
        <input id="range-title" value={draft.title} maxLength={120} onChange={(e) => onChange({ ...draft, title: e.target.value })} className="min-h-8 py-1 text-[13px]" placeholder="Vd: Công dụng chính của sản phẩm" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Icon name="play" size={13} />} disabled={!times} onClick={() => times && onPreview(times.start, times.end, draft.clipId === null ? 'mới' : (draft.code ?? ''))}>
          Phát thử
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabledReason={reason} onClick={onSave}>
          {draft.clipId === null ? 'Tạo clip' : 'Lưu điểm cắt'}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={saving}>
          Hủy
        </Button>
        {reason && <span className="text-xs text-warn-fg">{reason}</span>}
      </div>
    </div>
  );
}
