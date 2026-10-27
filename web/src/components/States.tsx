import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/errors';
import { Button, Spinner } from './Button';
import { Icon, type IconName } from './Icon';

export function LoadingBlock({ label = 'Đang tải...' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-muted">
      <Spinner size={16} />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`shimmer rounded-lg bg-surface-3 ${className}`} />;
}

export function EmptyState({ icon = 'film', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-4 py-14 text-center">
      <div className="mb-1 grid size-11 place-items-center rounded-full bg-surface-3 text-muted">
        <Icon name={icon} size={20} />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {children && <div className="text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Không tải được dữ liệu' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-2 px-4 py-14 text-center">
      <div className="mb-1 grid size-11 place-items-center rounded-full bg-danger-bg text-danger-fg">
        <Icon name="alert" size={20} />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-muted">{errorMessage(error)}</p>
      {onRetry && !(error instanceof ApiError && error.status === 404) && (
        <Button className="mt-2" onClick={onRetry} icon={<Icon name="refresh" />}>
          Thử lại
        </Button>
      )}
    </div>
  );
}

/** Dòng lỗi nhỏ ngay trong form / thẻ. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger-fg">
      <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Alert({ tone = 'warn', icon = 'alert', children, actions }: { tone?: 'warn' | 'danger' | 'info'; icon?: IconName; children: ReactNode; actions?: ReactNode }) {
  const cls = { warn: 'bg-warn-bg text-warn-fg', danger: 'bg-danger-bg text-danger-fg', info: 'bg-info-bg text-info-fg' }[tone];
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2.5 text-[13px] ${cls}`}>
      <Icon name={icon} size={16} />
      <div className="min-w-0 flex-1 basis-64">{children}</div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
