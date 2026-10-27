import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium select-none transition-colors disabled:opacity-50 disabled:pointer-events-auto';
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-ink-fg hover:bg-ink-hover disabled:hover:bg-ink',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-surface-2 disabled:hover:bg-surface',
  ghost: 'text-fg hover:bg-surface-3 disabled:hover:bg-transparent',
  danger: 'border border-danger-fg/50 bg-surface text-danger-fg hover:bg-danger-bg disabled:hover:bg-surface',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-2.5 text-[13px]',
  md: 'min-h-9 px-3.5 text-sm',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = ''): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${extra}`.trim();
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Số credit sẽ bị tiêu: hiển thị huy hiệu "15 credit" ngay trên nút. */
  credit?: number;
  /** Lý do vô hiệu hóa: tự đặt disabled và tooltip. */
  disabledReason?: string | null;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, credit, disabledReason, icon, className = '', children, disabled, title, ...rest }: Props) {
  const isDisabled = disabled || loading || !!disabledReason;
  return (
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      title={disabledReason ?? title}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {credit !== undefined && <span className="spend-chip">{credit} credit</span>}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
