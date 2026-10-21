import { dismiss, useToasts } from '../lib/toast';
import { Icon } from './Icon';

export function Toaster() {
  const items = useToasts();
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex max-w-lg items-start gap-2 rounded-lg px-3 py-2.5 text-sm shadow-lg ${
            t.kind === 'error' ? 'bg-danger-fg text-surface' : t.kind === 'success' ? 'bg-ok-fg text-surface' : 'bg-ink text-ink-fg'
          }`}
        >
          <Icon name={t.kind === 'error' ? 'alert' : 'check'} size={16} className="mt-0.5" />
          <span className="min-w-0 flex-1">{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Đóng thông báo" className="opacity-80 hover:opacity-100">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
