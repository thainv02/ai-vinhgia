import { memo, useMemo, useState } from 'react';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { InlineError } from '../components/States';
import { clock } from './lib';
import type { Clip } from './types';
import type { WordIndex } from './wordIndex';

interface Cell {
  i: number;
  asr: string;
  start: number;
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
  const cells = useMemo<Cell[]>(() => {
    const out: Cell[] = [];
    for (let i = clip.start_word; i <= clip.end_word; i++) {
      const w = idx.word(i);
      if (w) out.push({ i, asr: w.w, start: w.start });
    }
    return out;
  }, [clip.start_word, clip.end_word, idx]);
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

  const groups: Cell[][] = [];
  for (let k = 0; k < cells.length; k += GROUP) groups.push(cells.slice(k, k + GROUP));

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
          {groups.map((g) => (
            <div key={g[0]!.i} className="rounded-md border border-line bg-surface-2 p-1.5">
              <div className="mb-1 font-mono text-[10px] leading-none text-muted">{clock(g[0]!.start)}</div>
              <div className="flex flex-wrap gap-1">
                {g.map((c) => (
                  <WordInput key={c.i} cell={c} value={vals[c.i] ?? c.asr} onChange={(i, v) => setVals((s) => ({ ...s, [i]: v }))} />
                ))}
              </div>
            </div>
          ))}
        </div>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}
