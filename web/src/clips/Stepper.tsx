import { Icon } from '../components/Icon';
import { pct100, readyClipCount } from './lib';
import type { ClipProjectDetail } from './types';

type StepState = 'done' | 'active' | 'todo' | 'error';
interface Step {
  label: string;
  state: StepState;
  note?: string;
}

export function computeSteps(d: ClipProjectDetail): Step[] {
  const s = d.source;
  const planActive = !!d.plan_job && ['queued', 'claimed', 'running'].includes(d.plan_job.status);
  const ready = readyClipCount(d.clips);
  const rendering = d.clips.some((c) => c.latest_cut?.status === 'rendering');
  const transcribed = s?.status === 'transcribed';
  const steps: Step[] = [];
  steps.push({ label: 'Tải video', state: s ? 'done' : 'active' });
  steps.push({
    label: 'Nhận dạng lời nói',
    state: !s ? 'todo' : transcribed ? 'done' : s.status === 'failed' ? 'error' : s.status === 'cancelled' ? 'error' : 'active',
    note: s && (s.status === 'transcribing' || s.status === 'uploaded') ? (s.queue?.state === 'waiting' ? 'đang chờ' : pct100(s.progress) !== null ? `~${Math.round(pct100(s.progress)!)}%` : undefined) : undefined,
  });
  steps.push({
    label: 'AI đề xuất',
    state: planActive ? 'active' : d.clips.length > 0 ? 'done' : d.plan_job?.status === 'failed' ? 'error' : transcribed ? 'active' : 'todo',
    note: planActive ? (d.plan_job?.queue?.position ? `chờ #${d.plan_job.queue.position}` : 'đang chạy') : undefined,
  });
  steps.push({
    label: 'Duyệt & dựng',
    state: d.clips.length === 0 ? 'todo' : ready > 0 && !rendering && d.clips.every((c) => c.status === 'rejected' || c.latest_cut?.status === 'ready') ? 'done' : 'active',
    note: rendering ? 'đang dựng' : d.clips.length ? `${ready}/${d.clips.filter((c) => c.status !== 'rejected').length}` : undefined,
  });
  steps.push({ label: 'Tải về', state: ready > 0 ? 'active' : 'todo', note: ready > 0 ? `${ready} clip` : undefined });
  return steps;
}

const DOT: Record<StepState, string> = {
  done: 'bg-ok-fg text-surface',
  active: 'bg-ink text-ink-fg',
  todo: 'bg-surface-3 text-muted',
  error: 'bg-danger-fg text-surface',
};

/** Thanh các bước: Tải video → Nhận dạng → AI đề xuất → Duyệt & dựng → Tải về. */
export function Stepper({ detail }: { detail: ClipProjectDetail }) {
  const steps = computeSteps(detail);
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Các bước">
      {steps.map((s, k) => (
        <li key={s.label} aria-current={s.state === 'active' ? 'step' : undefined} className="relative flex min-w-0 flex-col items-center gap-1 text-center">
          {k > 0 && <span aria-hidden="true" className={`absolute right-1/2 top-[13px] -z-0 h-0.5 w-full ${s.state === 'todo' ? 'bg-line' : 'bg-ink/40'}`} />}
          <span className={`relative z-10 grid size-7 place-items-center rounded-full text-xs font-bold ${DOT[s.state]}`}>
            {s.state === 'done' ? <Icon name="check" size={14} /> : s.state === 'error' ? <Icon name="alert" size={13} /> : k + 1}
          </span>
          <span className={`text-[11px] leading-tight sm:text-xs ${s.state === 'todo' ? 'text-muted' : 'font-semibold'}`}>{s.label}</span>
          {s.note && <span className="-mt-0.5 text-[10px] leading-tight text-muted sm:text-[11px]">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}
