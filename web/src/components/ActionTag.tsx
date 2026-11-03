import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** Chú thích nơi xử lý của hành động, theo Foundations trong docs/design. */
export type ActionKind = 'ai' | 'local' | 'external';

export function ActionTag({ kind }: { kind: ActionKind }) {
  const label = { ai: 'AI', local: 'TRÊN MÁY', external: 'MỞ NGOÀI' }[kind];
  return <span className={`av-action-tag av-action-tag-${kind}`}>{label}</span>;
}

export function DisabledReason({ children, id }: { children: ReactNode; id?: string }) {
  return <span id={id} className="av-disabled-reason"><Icon name="lock" size={12} />{children}</span>;
}
