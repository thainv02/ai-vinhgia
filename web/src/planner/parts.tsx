import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../components/StatusBadge';
import { Button } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import type { PlanStatus } from './types';

export const PLAN_STATUS: Record<PlanStatus, { label: string; tone: 'neutral' | 'info' | 'ok' | 'danger'; live?: boolean }> = {
  draft: { label: 'Nháp', tone: 'neutral' },
  analyzing: { label: 'Đang phân tích', tone: 'info', live: true },
  ready: { label: 'Đã phân tích', tone: 'ok' },
  failed: { label: 'Lỗi', tone: 'danger' },
};

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const s = PLAN_STATUS[status];
  return (
    <Badge tone={s.tone} live={s.live}>
      {s.label}
    </Badge>
  );
}

/** Shared workspace navigation; arrow keys, Home and End move between panels. */
export function WorkspaceTabs({ id, label, items, value, onChange }: {
  id: string; label: string;
  items: { value: string; label: string; icon?: IconName; meta?: string; done?: boolean }[];
  value: string; onChange: (value: string) => void;
}) {
  return <div className="workspace-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button
      key={item.value} type="button" role="tab" id={`${id}-tab-${item.value}`} aria-controls={`${id}-panel-${item.value}`}
      aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1}
      onClick={() => onChange(item.value)}
      onKeyDown={(e) => {
        const next = e.key === 'ArrowRight' ? (index + 1) % items.length : e.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
        if (next === null) return;
        e.preventDefault(); onChange(items[next].value);
        document.getElementById(`${id}-tab-${items[next].value}`)?.focus();
      }}
    >
      {item.icon && <Icon name={item.icon} size={16} />}
      <span>{item.label}</span>
      {item.meta && <span className="tab-meta">{item.meta}</span>}
      {item.done && <Icon name="check" size={14} className="text-ok-fg" />}
    </button>)}
  </div>;
}

/** Nút sao chép có phản hồi "Đã chép" (đọc được bằng trình đọc màn hình qua vùng aria-live). */
export function CopyButton({
  text,
  label = 'Sao chép',
  variant = 'secondary',
  size = 'sm',
  onFail,
}: {
  text: string;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  onFail?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'ok'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={<Icon name={state === 'ok' ? 'check' : 'copy'} size={14} />}
        onClick={() => {
          void copyText(text).then((ok) => {
            window.clearTimeout(timer.current);
            if (ok) {
              setState('ok');
              timer.current = window.setTimeout(() => setState('idle'), 2200);
            } else {
              onFail?.();
              toast.error('Trình duyệt không cho phép sao chép tự động. Hãy bôi đen đoạn văn rồi nhấn Ctrl+C (hoặc giữ tay trên điện thoại).');
            }
          });
        }}
      >
        {state === 'ok' ? 'Đã chép' : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'ok' ? 'Đã chép vào bộ nhớ tạm' : ''}
      </span>
    </>
  );
}

/** Khối văn bản nguyên văn (tin nhắn ChatGPT / prompt Flow) kèm nút sao chép. */
export function TextBlock({ title, text, hint, copyLabel }: { title: string; text: string; hint?: ReactNode; copyLabel?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const selectAll = () => {
    const el = ref.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold">{title}</h4>
        <CopyButton text={text} label={copyLabel} onFail={selectAll} />
      </div>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label={title}
        className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 font-mono text-[12.5px] leading-relaxed [overflow-wrap:anywhere]"
      >
        {text}
      </pre>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'spend' }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${tone === 'spend' ? 'border-spend-line bg-spend-bg text-spend' : 'border-line bg-surface-2 text-fg'}`}
    >
      {children}
    </span>
  );
}

export const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${Math.round(n / 1024)} KB`);

export const fmtMB = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / 1024 / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace('.', ',')} MB`;
};

/** Số thứ tự bước + tiêu đề + mô tả ngắn (đầu mỗi khối Bước 1/2/3 của thẻ cảnh). */
export function StepHeader({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span aria-hidden="true" className="grid size-7 place-items-center rounded-full bg-ink text-sm font-bold text-ink-fg">
        {n}
      </span>
      <div className="leading-tight">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="text-xs text-muted">{sub}</p>
      </div>
    </div>
  );
}

/** Thanh tiến trình có nhãn cho trình đọc màn hình. */
export function ProgressBar({ value, label, tone = 'info' }: { value: number | null; label: string; tone?: 'info' | 'ok' | 'danger' }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(pct)}
    >
      <div className={`h-full transition-[width] duration-500 ${tone === 'ok' ? 'bg-ok-fg' : tone === 'danger' ? 'bg-danger-fg' : 'bg-info-fg'} ${pct === null ? 'shimmer w-1/3' : ''}`} style={pct === null ? undefined : { width: `${Math.max(3, pct)}%` }} />
    </div>
  );
}
