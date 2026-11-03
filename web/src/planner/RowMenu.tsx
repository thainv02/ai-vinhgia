import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';

export interface RowMenuItem {
  label: string;
  danger?: boolean;
  /** Có lý do → mục bị khoá, lý do hiện ngay dưới nhãn. */
  disabledReason?: string | null;
  onSelect: () => void;
}

const MENU_HEIGHT_GUESS = 120;

/**
 * Nút ⋮ ở cuối một dòng danh sách, mở menu thao tác. Menu đặt `position: fixed` theo vị trí nút (bảng nằm trong khung cuộn nên menu tuyệt đối
 * sẽ bị cắt), sát đáy màn hình thì mở lên trên. Đóng khi bấm ra ngoài, Esc, cuộn trang hoặc chọn một mục.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (open || !btn.current) return setPos(null);
    const r = btn.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    setPos(r.bottom + MENU_HEIGHT_GUESS > window.innerHeight ? { right, bottom: window.innerHeight - r.top + 4 } : { right, top: r.bottom + 4 });
  };

  return (
    <>
      <button ref={btn} type="button" className="av-btn av-btn-sm av-btn-ghost" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <Icon name="more" size={16} strokeWidth={3} />
      </button>
      {pos && (
        <div ref={menu} className="av-rowmenu" role="menu" aria-label={label} style={pos}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              disabled={!!it.disabledReason}
              onClick={() => {
                setPos(null);
                it.onSelect();
              }}
            >
              {it.label}
              {it.disabledReason && <small>{it.disabledReason}</small>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Xác nhận xoá một dự án từ danh sách: xoá vĩnh viễn (app không có thùng rác), phải gõ XOA. Lỗi (vd file đang mở trong chương trình khác) hiện ngay
 * trong hộp thoại để người dùng đóng file rồi bấm xoá lại.
 */
export function DeleteProjectDialog({
  target,
  what,
  onDelete,
  onClose,
  onDeleted,
}: {
  target: { id: number; name: string } | null;
  /** "kế hoạch" / "dự án cắt clip" */
  what: string;
  onDelete: (id: number) => Promise<unknown>;
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    setConfirmation('');
    setError(null);
  }, [target?.id]);
  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };
  return (
    <ConfirmDialog
      open={!!target}
      title={`Xoá ${what}`}
      confirmLabel="Xoá vĩnh viễn"
      danger
      cancelLabel="Giữ lại"
      confirmDisabledReason={confirmation !== 'XOA' ? 'Gõ XOA để xác nhận xoá vĩnh viễn' : null}
      pending={pending}
      error={error}
      onClose={close}
      onConfirm={() => {
        if (!target || pending || confirmation !== 'XOA') return;
        setPending(true);
        setError(null);
        onDelete(target.id).then(
          () => {
            setPending(false);
            onDeleted(target.name);
          },
          (e: unknown) => {
            setPending(false);
            setError(errorMessage(e));
          },
        );
      }}
    >
      <p>
        Xoá {what} <strong>{target?.name}</strong>?
      </p>
      <label className="av-label">Gõ XOA để xác nhận<input className="av-input av-mono" value={confirmation} autoComplete="off" spellCheck={false} disabled={pending} onChange={(e) => setConfirmation(e.target.value)} /></label>
      <p className="text-muted">
        Toàn bộ ảnh, video và bản dựng của nó sẽ bị xoá khỏi máy. Không khôi phục được.
      </p>
    </ConfirmDialog>
  );
}
