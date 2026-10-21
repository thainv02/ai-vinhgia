import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Asset, Verdict } from '../api/types';
import { useSetVerdict } from '../hooks/mutations';
import { TONE_CLASS, VERDICT, VERDICT_ORDER } from '../lib/status';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';
import { InlineError } from './States';

/** Nhận xét của Claude cho video đang xem (lỗi thấy được + kết luận). Người dùng đổi kết luận / sửa ghi chú. */
export function VerdictPanel({ asset }: { asset: Asset | null }) {
  const set = useSetVerdict();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(asset?.verdict_note ?? '');

  useEffect(() => {
    setEditing(false);
    setNote(asset?.verdict_note ?? '');
  }, [asset?.id, asset?.verdict_note]);

  if (!asset) {
    return (
      <section className="rounded-lg border border-dashed border-line-strong bg-surface p-3 text-[13px] text-muted">
        <h2 className="mb-1 text-[15px] font-semibold text-fg">Nhận xét của Claude</h2>
        Chưa có video nên chưa có kết luận. Sau khi worker tạo xong, Claude sẽ ghi lỗi thấy được và kết luận Đạt / Sửa khi dựng / Tạo lại ở đây.
      </section>
    );
  }

  const current = asset.verdict;
  const choose = (v: Verdict | null) =>
    set.mutate(
      { assetId: asset.id, verdict: v, note: asset.verdict_note },
      { onSuccess: () => toast.success(v ? `Đã đổi kết luận: ${VERDICT[v].label}` : 'Đã bỏ kết luận') },
    );

  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby="vd-h">
      <h2 id="vd-h" className="mb-2 text-[15px] font-semibold">
        Nhận xét của Claude <span className="font-normal text-muted">· video v{asset.attempt}</span>
      </h2>

      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Kết luận">
        {VERDICT_ORDER.map((v) => {
          const active = current === v;
          return (
            <button
              key={v}
              type="button"
              aria-pressed={active}
              disabled={set.isPending}
              onClick={() => choose(active ? null : v)}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold ${
                active ? `${TONE_CLASS[VERDICT[v].tone]} ring-2 ring-current` : 'border border-line-strong bg-surface text-muted hover:bg-surface-2 hover:text-fg'
              }`}
            >
              {active && <Icon name="check" size={13} />}
              {VERDICT[v].label}
            </button>
          );
        })}
      </div>
      <p className="mb-2 text-xs text-muted">{current ? 'Bấm lại kết luận đang chọn để bỏ. Mọi thay đổi được ghi vào log.md.' : 'Chưa có kết luận. Chọn một kết luận cho video này.'}</p>

      {editing ? (
        <div className="space-y-2">
          <label htmlFor="vd-note" className="sr-only">
            Lỗi thấy được
          </label>
          <textarea id="vd-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Lỗi thấy được trên video..." />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={set.isPending}
              onClick={() =>
                set.mutate(
                  { assetId: asset.id, verdict: current, note: note.trim() || null },
                  {
                    onSuccess: () => {
                      toast.success('Đã lưu ghi chú');
                      setEditing(false);
                    },
                  },
                )
              }
            >
              Lưu ghi chú
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              Hủy
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md bg-surface-2 px-3 py-2 text-[13px]">
          <div className="mb-0.5 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted">Lỗi thấy được</span>
            <button type="button" className="text-xs text-muted underline hover:text-fg" onClick={() => setEditing(true)}>
              Sửa ghi chú
            </button>
          </div>
          <p className="whitespace-pre-wrap">{asset.verdict_note || <span className="text-muted">Không có ghi chú.</span>}</p>
        </div>
      )}
      {set.isError && (
        <div className="mt-2">
          <InlineError>{errorMessage(set.error)}</InlineError>
        </div>
      )}
    </section>
  );
}
