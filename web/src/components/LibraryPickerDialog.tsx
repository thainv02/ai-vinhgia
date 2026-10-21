import { useEffect, useMemo, useState } from 'react';
import type { LibraryRef } from '../api/types';
import { useRefLibrary } from '../hooks/queries';
import { Button } from './Button';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { EmptyState, ErrorState, InlineError, LoadingBlock } from './States';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Dự án đang thêm ảnh: ảnh dự án đã có hiện "Đã có" và không chọn được. */
  projectId?: number;
  /** Ảnh (ref_id) đã nằm trong danh sách đang soạn nên không chọn lại. */
  disabledRefIds?: number[];
  pending?: boolean;
  error?: string | null;
  /** Nhận các ảnh đã chọn theo đúng thứ tự chọn. */
  onConfirm: (refs: LibraryRef[]) => void;
}

/** Hộp thư viện ảnh tham chiếu: ảnh của mọi dự án (gom theo nội dung), chọn nhiều, đánh số theo thứ tự chọn. */
export function LibraryPickerDialog({ open, onClose, projectId, disabledRefIds = [], pending, error, onConfirm }: Props) {
  const q = useRefLibrary(projectId, open);
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open) {
      setSelected([]);
      setFilter('');
    }
  }, [open]);

  const items = q.data ?? [];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return items;
    return items.filter((r) => [r.label, r.original_name, ...r.projects.map((p) => p.name)].some((t) => t.toLowerCase().includes(f)));
  }, [items, filter]);

  const unavailable = (r: LibraryRef) => r.in_project || disabledRefIds.includes(r.ref_id);
  const toggle = (r: LibraryRef) => {
    if (unavailable(r)) return;
    setSelected((cur) => (cur.includes(r.ref_id) ? cur.filter((id) => id !== r.ref_id) : [...cur, r.ref_id]));
  };
  const chosen = selected.map((id) => items.find((r) => r.ref_id === id)).filter((r): r is LibraryRef => !!r);
  const reason = chosen.length === 0 ? 'Chọn ít nhất 1 ảnh' : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chọn ảnh từ thư viện"
      wide
      footer={
        <>
          <span className="mr-auto text-xs text-muted">{chosen.length > 0 ? `Đã chọn ${chosen.length} ảnh, thêm theo thứ tự chọn.` : 'Bấm vào ảnh để chọn, có thể chọn nhiều.'}</span>
          <Button onClick={onClose} disabled={pending}>
            Hủy
          </Button>
          <Button variant="primary" loading={pending} disabledReason={reason} onClick={() => onConfirm(chosen)}>
            {chosen.length > 0 ? `Thêm ${chosen.length} ảnh` : 'Thêm ảnh'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {q.isLoading ? (
          <LoadingBlock label="Đang tải thư viện..." />
        ) : q.error ? (
          <ErrorState title="Không tải được thư viện ảnh" error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon="image" title="Thư viện đang trống">
            Ảnh tham chiếu bạn tải lên ở bất kỳ dự án nào sẽ xuất hiện ở đây để dùng lại cho dự án khác. Hãy tải ảnh lên trước.
          </EmptyState>
        ) : (
          <>
            {items.length > 6 && (
              <>
                <label htmlFor="lib-filter" className="sr-only">
                  Lọc ảnh theo nhãn hoặc dự án
                </label>
                <input id="lib-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Lọc theo nhãn hoặc tên dự án..." />
              </>
            )}
            {shown.length === 0 ? (
              <p className="rounded-md bg-surface-2 px-3 py-4 text-center text-[13px] text-muted">Không có ảnh nào khớp bộ lọc.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4" aria-label="Ảnh trong thư viện">
                {shown.map((r) => {
                  const idx = selected.indexOf(r.ref_id);
                  const isSel = idx >= 0;
                  const off = unavailable(r);
                  const names = r.projects.map((p) => p.name).join(', ');
                  return (
                    <li key={r.content_hash}>
                      <button
                        type="button"
                        aria-pressed={isSel}
                        disabled={off}
                        onClick={() => toggle(r)}
                        title={off ? (r.in_project ? 'Dự án này đã có ảnh này' : 'Ảnh này đã nằm trong danh sách') : undefined}
                        className={`group block w-full rounded-lg border p-1.5 text-left transition-colors ${
                          isSel ? 'border-fg bg-surface-2 ring-2 ring-fg' : 'border-line bg-surface hover:bg-surface-2'
                        } ${off ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <span className="relative block aspect-square overflow-hidden rounded-md border border-line bg-surface-3">
                          <img src={r.url} alt={r.label} loading="lazy" className="size-full object-cover" />
                          {isSel && (
                            <span className="absolute left-1 top-1 grid size-6 place-items-center rounded-full bg-ink text-xs font-bold text-ink-fg">{idx + 1}</span>
                          )}
                          {off && (
                            <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/70 py-0.5 text-[11px] font-semibold text-white">
                              <Icon name="check" size={11} /> {r.in_project ? 'Đã có' : 'Đã thêm'}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block truncate text-[13px] font-semibold" title={r.label}>
                          {r.label}
                        </span>
                        <span className="block truncate text-[11px] text-muted" title={names}>
                          Đã dùng ở: {names || '—'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}

