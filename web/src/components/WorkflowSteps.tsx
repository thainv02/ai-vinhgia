import { Icon } from './Icon';

export interface WorkflowStep { label: string; state: 'done' | 'active' | 'todo' | 'error'; note?: string }
const DOT = { done: 'bg-ok-fg text-surface', active: 'bg-ink text-ink-fg', todo: 'bg-surface-3 text-muted', error: 'bg-danger-fg text-surface' };

export function WorkflowSteps({ steps, label = 'Các bước', onSelect }: { steps: WorkflowStep[]; label?: string; onSelect?: (index: number) => void }) {
  return <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length},minmax(0,1fr))` }} aria-label={label}>
    {steps.map((s, k) => <li key={s.label} aria-current={s.state === 'active' ? 'step' : undefined} className="relative min-w-0 text-center">
      {k > 0 && <span aria-hidden="true" className={`absolute right-1/2 top-[13px] h-0.5 w-full ${s.state === 'todo' ? 'bg-line' : 'bg-ink/40'}`} />}
      {(() => {
        const body = <><span className={`relative z-10 grid size-7 place-items-center rounded-full text-xs font-bold ${DOT[s.state]}`}>{s.state === 'done' ? <Icon name="check" size={14} /> : s.state === 'error' ? <Icon name="alert" size={13} /> : k + 1}</span><span className={`text-xs leading-tight ${s.state === 'todo' ? 'text-muted' : 'font-semibold'}`}>{s.label}</span>{s.note && <span className="text-[11px] leading-tight text-muted">{s.note}</span>}</>;
        return onSelect ? <button type="button" className="relative flex w-full flex-col items-center gap-1 rounded-md focus-visible:outline-offset-2" onClick={() => onSelect(k)}>{body}</button> : <div className="relative flex flex-col items-center gap-1">{body}</div>;
      })()}
    </li>)}
  </ol>;
}
