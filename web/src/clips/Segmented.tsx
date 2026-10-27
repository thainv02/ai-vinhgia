import type { ReactNode } from 'react';

interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Nhóm nút chọn một (radio dạng nút): dùng cho khung hình, kiểu phụ đề, độ dài. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, children }: { label: string; value: T; options: readonly Option<T>[]; onChange: (v: T) => void; disabled?: boolean; children?: ReactNode }) {
  const cur = options.find((o) => o.value === value);
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted" id={`seg-${label}`}>
        {label}
      </div>
      <div role="radiogroup" aria-labelledby={`seg-${label}`} className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={disabled}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={`min-h-8 rounded-md border px-2.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${o.value === value ? 'border-ink bg-ink text-ink-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-2'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {cur?.hint && <p className="mt-1 text-xs text-muted">{children ?? cur.hint}</p>}
    </div>
  );
}
