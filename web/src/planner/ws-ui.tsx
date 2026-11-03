import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ActionTag, DisabledReason, type ActionKind } from '../components/ActionTag';
import { Icon, type IconName } from '../components/Icon';
import { Spinner } from '../components/Button';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import './workspace.css';

/** Nút desktop với lý do khoá hiển thị tại chỗ và nhãn loại hành động. */
export function Btn({ variant, size, loading, disabledReason, icon, actionKind, className = '', children, disabled, title, ...rest }: {
  variant?: 'primary' | 'danger' | 'ghost';
  size?: 'sm';
  loading?: boolean;
  disabledReason?: string | null;
  icon?: IconName;
  actionKind?: ActionKind;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['av-btn', variant ? `av-btn-${variant}` : '', size ? 'av-btn-sm' : '', className].filter(Boolean).join(' ');
  const reasonId = useId();
  const button = (
    <button type="button" {...rest} disabled={disabled || loading || !!disabledReason} title={disabledReason ?? title} aria-describedby={disabledReason ? [rest['aria-describedby'], reasonId].filter(Boolean).join(' ') : rest['aria-describedby']} aria-busy={loading || undefined} className={cls}>
      {loading ? <Spinner /> : icon && <Icon name={icon} size={14} />}
      {children}
      {actionKind && <ActionTag kind={actionKind} />}
    </button>
  );
  return disabledReason ? <span className="av-action-control">{button}<DisabledReason id={reasonId}>{disabledReason}</DisabledReason></span> : button;
}

/** Link tải/mở dạng nút. */
export function LinkBtn({ href, icon, children, primary, small = true, ...rest }: { href: string; icon?: IconName; children: ReactNode; primary?: boolean; small?: boolean } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...rest} className={`av-btn ${primary ? 'av-btn-primary' : ''} ${small ? 'av-btn-sm' : ''}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </a>
  );
}

/** Nút sao chép, chép xong đổi thành "Đã chép". */
export function CopyBtn({ text, label = 'Sao chép', primary }: { text: string; label?: string; primary?: boolean }) {
  const [ok, setOk] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`av-btn av-btn-sm ${primary ? 'av-btn-primary' : ''}`}
      onClick={() => {
        void copyText(text).then((done) => {
          window.clearTimeout(timer.current);
          if (done) {
            setOk(true);
            timer.current = window.setTimeout(() => setOk(false), 2200);
          } else {
            toast.error('Không sao chép tự động được. Hãy bôi đen rồi nhấn Ctrl+C.');
          }
        });
      }}
    >
      <Icon name={ok ? 'check' : 'copy'} size={14} />
      {ok ? 'Đã chép' : label}
    </button>
  );
}

/** Khối văn bản nguyên văn (.av-code), bôi đen được để chép tay. */
export function CodeBlock({ text, label }: { text: string; label: string }) {
  return <pre tabIndex={0} aria-label={label} className="av-code ws-code">{text}</pre>;
}
