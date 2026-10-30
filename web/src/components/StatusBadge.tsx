import { JOB_STATUS, PROJECT_STATUS, TONE_CLASS, TONE_SOLID, sceneStatusInfo, type StatusInfo, type Tone, VERDICT } from '../lib/status';
import type { JobStatus, ProjectStatus, Verdict } from '../api/types';

export function Badge({ tone, live, children, title, className = '' }: { tone: Tone; live?: boolean; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]} ${className}`}>
      {live && <span aria-hidden="true" className={`pulse-dot size-1.5 rounded-full ${TONE_SOLID[tone]}`} />}
      {children}
    </span>
  );
}

function fromInfo(info: StatusInfo, className?: string) {
  return (
    <Badge tone={info.tone} live={info.live} className={className}>
      {info.label}
    </Badge>
  );
}

export const SceneStatusBadge = ({ status, className }: { status: string; className?: string }) => fromInfo(sceneStatusInfo(status), className);
export const JobStatusBadge = ({ status }: { status: JobStatus }) => fromInfo(JOB_STATUS[status] ?? { label: status, tone: 'neutral' });
export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }) => fromInfo(PROJECT_STATUS[status] ?? { label: status, tone: 'neutral' });

export function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <Badge tone="neutral">Chưa đánh giá</Badge>;
  const v = VERDICT[verdict];
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

/** Nhãn "LAN · <người tạo>" cho kế hoạch do người dùng trong mạng LAN tạo qua trang planner. */
export function LanBadge({ name }: { name?: string | null }) {
  return (
    <Badge tone="violet" title="Kế hoạch tạo từ trang planner trong mạng LAN (chỉ lập kế hoạch prompt)">
      LAN · {name || 'không rõ'}
    </Badge>
  );
}
