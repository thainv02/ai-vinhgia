import { WorkflowSteps, type WorkflowStep } from '../components/WorkflowSteps';
import { jobIsActive, pct100, readyClipCount } from './lib';
import type { ClipProjectDetail } from './types';

type Step = WorkflowStep;

export function computeSteps(d: ClipProjectDetail): Step[] {
  const s = d.source;
  const planActive = jobIsActive(d.plan_job);
  const pending = d.clips.some((c) => !c.cleanup && c.status !== 'rejected');
  const processed = d.clips.filter((c) => !!c.cleanup);
  const ready = readyClipCount(processed);
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
    label: 'AI đề xuất & làm gọn',
    state: planActive || pending ? 'active' : d.clips.length > 0 ? 'done' : d.plan_job?.status === 'failed' ? 'error' : transcribed ? 'active' : 'todo',
    note: pending ? 'đang làm gọn' : planActive ? (d.plan_job?.queue?.position ? `chờ #${d.plan_job.queue.position}` : 'đang chạy') : undefined,
  });
  steps.push({
    label: 'Duyệt & dựng',
    state: processed.length === 0 ? 'todo' : ready > 0 && !rendering && processed.every((c) => c.status === 'rejected' || c.latest_cut?.status === 'ready') ? 'done' : 'active',
    note: rendering ? 'đang dựng' : processed.length ? `${ready}/${processed.filter((c) => c.status !== 'rejected').length}` : undefined,
  });
  steps.push({ label: 'Tải về', state: ready > 0 ? 'active' : 'todo', note: ready > 0 ? `${ready} clip` : undefined });
  return steps;
}

/** Shared presentation with the LAN storyboard/video workflow. */
export function Stepper({ detail }: { detail: ClipProjectDetail }) {
  return <WorkflowSteps steps={computeSteps(detail)} />;
}
