import { Fragment, memo, useMemo, useState } from 'react';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { InlineError } from '../components/States';
import { clipParts, clock } from './lib';
import type { Clip } from './types';
import type { WordIndex } from './wordIndex';

interface Cell {
  i: number;
  asr: string;
  start: number;
  /** Đoạn (theo thứ tự phát) chứa từ này. */
  part: number;
}

const GROUP = 3;

const WordInput = memo(function WordInput({ cell, value, onChange }: { cell: Cell; value: string; onChange: (i: number, v: string) => void }) {
  const hidden = value.trim() === '';
  return (
    <input
      value={value}
      onChange={(e) => onChange(cell.i, e.target.value)}
      aria-label={`Từ ${cell.i} lúc ${clock(cell.start)}, bản nhận dạng: ${cell.asr}`}
      placeholder={cell.asr}
      title={hidden ? `Đã ẩn (bản nhận dạng: ${cell.asr})` : cell.asr !== value ? `Bản nhận dạng: ${cell.asr}` : undefined}
      size={Math.max(3, value.length || cell.asr.length)}
      className={`min-h-8 w-auto px-1.5 py-0.5 text-[13px] ${hidden ? 'border-dashed bg-surface-3 italic' : ''}`}
    />
  );
});

interface Props {
  open: boolean;
  clip: Clip;
  idx: WordIndex;
  onClose: () => void;
  onSave: (words: { i: number; w: string }[], thenRender: boolean) => Promise<void>;
  canRender: string | null;
}

/** Sửa chữ phụ đề của clip: mỗi từ một ô, mốc thời gian giữ nguyên, ô trống = ẩn từ. */
export function CaptionEditor({ open, clip, idx, onClose, onSave, canRender }: Props) {
  // Clip ghép: các từ của từng đoạn, nối theo thứ tự phát.
  const parts = clipParts(clip);
  const partsKey = parts.map((p) => `${p.start_word}-${p.end_word}`).join(',');
  const cells = useMemo<Cell[]>(() => {
    const out: Cell[] = [];
    parts.forEach((p, part) => {
      for (let i = p.start_word; i <= p.end_word; i++) {
        const w = idx.word(i);
        if (w) out.push({ i, asr: w.w, start: w.start, part });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partsKey, idx]);
  const multi = parts.length > 1;
  const initial = useMemo(() => {
    const m: Record<number, string> = {};
    for (const c of cells) m[c.i] = c.asr;
    for (const cw of clip.caption_words ?? []) if (cw.i in m) m[cw.i] = cw.w;
    return m;
  }, [cells, clip.caption_words]);
  const [vals, setVals] = useState<Record<number, string>>(initial);
  const [busy, setBusy] = useState<'save' | 'render' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = cells.some((c) => (vals[c.i] ?? c.asr) !== (initial[c.i] ?? c.asr));
  const hiddenCount = cells.filter((c) => (vals[c.i] ?? '').trim() === '').length;

  // Nhóm 3 từ một ô, không nhóm vắt qua ranh giới hai đoạn.
  const groups: Cell[][] = [];
  for (const c of cells) {
    const g = groups.at(-1);
    if (g && g.length < GROUP && g[0]!.part === c.part) g.push(c);
    else groups.push([c]);
  }

  const run = async (thenRender: boolean) => {
    setBusy(thenRender ? 'render' : 'save');
    setError(null);
    try {
      // Server gộp với chữ hiện có nên chỉ gửi những từ đã đổi so với lúc mở.
      await onSave(
        cells.filter((c) => (vals[c.i] ?? c.asr) !== (initial[c.i] ?? c.asr)).map((c) => ({ i: c.i, w: vals[c.i] ?? c.asr })),
        thenRender,
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={`Sửa phụ đề ${clip.code}`}
      wide
      footer={
        <>
          <Button onClick={() => setVals(Object.fromEntries(cells.map((c) => [c.i, c.asr])))} disabled={!!busy} className="mr-auto">
            Về bản nhận dạng
          </Button>
          <Button onClick={onClose} disabled={!!busy}>
            Đóng
          </Button>
          <Button loading={busy === 'save'} disabled={!!busy && busy !== 'save'} disabledReason={changed ? null : 'Chưa sửa gì'} onClick={() => void run(false)}>
            Lưu
          </Button>
          <Button variant="primary" loading={busy === 'render'} disabled={!!busy && busy !== 'render'} disabledReason={!changed ? 'Chưa sửa gì' : canRender} onClick={() => void run(true)}>
            Lưu và dựng lại
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-[13px] text-muted">
          Sửa chữ từng từ, mốc thời gian giữ nguyên. <strong className="text-fg">Để trống một ô là ẩn từ đó.</strong> Nếu một từ bị nhận dạng tách thành nhiều từ (vd «ca cao a tiso»), sửa từ đầu thành «Cacao», «Actiso» và để trống các ô thừa.
        </p>
        <p className="text-xs text-muted">
          {cells.length} từ · {hiddenCount} từ đang ẩn · chữ mờ trong ô trống là bản nhận dạng gốc.
        </p>
        {cells.length === 0 && <InlineError>Chưa tải được lời thoại của clip này. Đợi transcript tải xong rồi mở lại.</InlineError>}
        <div className="flex flex-wrap gap-x-3 gap-y-2.5">
          {groups.map((g, k) => (
            <Fragment key={g[0]!.i}>
            {multi && (k === 0 || groups[k - 1]![0]!.part !== g[0]!.part) && (
              <div className={`flex basis-full items-center gap-2 text-[11px] font-semibold text-violet-fg ${k ? 'mt-1' : ''}`} role="separator" aria-label={`Đoạn ${g[0]!.part + 1}`}>
                <span className="rounded bg-violet-bg px-1.5 leading-[18px]">Đoạn {g[0]!.part + 1}</span>
                <span className="font-mono font-normal text-muted">{clock(parts[g[0]!.part]!.start_s)}–{clock(parts[g[0]!.part]!.end_s)}</span>
                <span aria-hidden="true" className="h-px flex-1 bg-line" />
              </div>
            )}
            <div className="rounded-md border border-line bg-surface-2 p-1.5">
              <div className="mb-1 font-mono text-[10px] leading-none text-muted">{clock(g[0]!.start)}</div>
              <div className="flex flex-wrap gap-1">
                {g.map((c) => (
                  <WordInput key={c.i} cell={c} value={vals[c.i] ?? c.asr} onChange={(i, v) => setVals((s) => ({ ...s, [i]: v }))} />
                ))}
              </div>
            </div>
            </Fragment>
          ))}
        </div>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}
