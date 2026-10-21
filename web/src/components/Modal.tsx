import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** Hộp thoại dùng thẻ <dialog> gốc: tự bẫy phím Tab, đóng bằng Esc, có lớp nền mờ. */
export function Modal({ open, onClose, title, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={`m-auto w-[calc(100vw-24px)] ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[calc(100dvh-24px)] rounded-xl border border-line-strong bg-surface p-0 shadow-2xl`}
      aria-label={title}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-24px)] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Đóng" className="rounded p-1 text-muted hover:bg-surface-3 hover:text-fg">
              <Icon name="x" />
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Hiện huy hiệu credit trên nút xác nhận. */
  credit?: number;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  confirmDisabledReason?: string | null;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  wide?: boolean;
}

/** Bước xác nhận bắt buộc cho mọi thao tác tốn credit hoặc không hoàn tác. Nút "Hủy" nhận tiêu điểm đầu tiên. */
export function ConfirmDialog({ open, title, children, confirmLabel, credit, danger, pending, error, confirmDisabledReason, cancelLabel = 'Hủy', onConfirm, onClose, wide }: ConfirmProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      wide={wide}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={pending} credit={credit} disabledReason={confirmDisabledReason}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {children}
        {error && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-danger-fg">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
