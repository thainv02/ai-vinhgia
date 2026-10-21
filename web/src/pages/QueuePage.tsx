import { useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client';
import type { Job } from '../api/types';
import { Button } from '../components/Button';
import { ElapsedTime } from '../components/ElapsedTime';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge, JobStatusBadge } from '../components/StatusBadge';
import { useCancelJob, useQueueControl } from '../hooks/mutations';
import { useJobs, useMeta, useProjects, useWorkerStatus } from '../hooks/queries';
import { fmtDateTime, fmtDuration, parseTime } from '../lib/format';
import { ACTIVE_JOB_STATUSES, FAIL_CODE_LABEL, JOB_TYPE_LABEL } from '../lib/status';
import { useDocumentTitle } from '../lib/useDocumentTitle';

type Tab = 'active' | 'done' | 'problem' | 'all';
const TABS: { key: Tab; label: string; status?: string }[] = [
  { key: 'active', label: 'Đang hoạt động', status: ACTIVE_JOB_STATUSES },
  { key: 'done', label: 'Đã xong', status: 'done' },
  { key: 'problem', label: 'Lỗi / Đã hủy', status: 'failed,cancelled' },
  { key: 'all', label: 'Tất cả' },
];

const isActive = (j: Job) => j.status === 'queued' || j.status === 'claimed' || j.status === 'running';
const isRunning = (j: Job) => j.status === 'claimed' || j.status === 'running';

function RunTime({ job }: { job: Job }) {
  if (isRunning(job)) return <ElapsedTime since={job.claimed_at} className="font-semibold" />;
  const a = parseTime(job.claimed_at);
  const b = parseTime(job.finished_at);
  if (a !== null && b !== null) return <span>{fmtDuration((b - a) / 1000)}</span>;
  return <span className="text-muted">—</span>;
}

function CreditCell({ job }: { job: Job }) {
  if (job.type !== 'video') return <span className="text-muted">—</span>;
  if (isActive(job)) {
    const expected = typeof job.payload?.credits_expected === 'number' ? job.payload.credits_expected : null;
    return <span className="text-spend">{expected !== null ? `${expected} (đặt trước)` : 'đặt trước'}</span>;
  }
  return job.credits_cost > 0 ? <strong className="text-spend">{job.credits_cost}</strong> : <span className="text-muted">0</span>;
}

function Requeued({ job }: { job: Job }) {
  if (job.requeue_count <= 0) return null;
  return (
    <Badge tone="warn" title="Job từng bị trả về hàng đợi do mất heartbeat. Worker cần kiểm tra Flow/ChatGPT xem đã tạo chưa trước khi tạo lại.">
      <Icon name="alert" size={11} /> Bị trả về {job.requeue_count} lần
    </Badge>
  );
}

function SceneLink({ job }: { job: Job }) {
  if (!job.scene_id || !job.scene_code) return <span className="text-muted">—</span>;
  return (
    <Link to={`/projects/${job.project_id}/scenes/${job.scene_id}`} className="font-semibold underline-offset-2 hover:underline">
      {job.scene_code}
    </Link>
  );
}

export default function QueuePage() {
  useDocumentTitle('Hàng đợi');
  const [tab, setTab] = useState<Tab>('active');
  const [projectId, setProjectId] = useState<number | undefined>(undefined);
  const status = TABS.find((t) => t.key === tab)?.status;
  const jobs = useJobs({ projectId, status, limit: 200 });
  const projects = useProjects();
  const meta = useMeta();
  const worker = useWorkerStatus();
  const { resume, pause } = useQueueControl();
  const cancel = useCancelJob({ silent: true });
  const [target, setTarget] = useState<Job | null>(null);

  const list = jobs.data ?? [];
  const running = list.filter(isRunning).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Hàng đợi</h1>
          <p className="text-[13px] text-muted">
            {worker.data?.online ? 'Worker đang online.' : 'Worker đang offline: job đứng yên cho tới khi mở phiên worker AI.'}
            {meta.data && ` Tối đa ${meta.data.config.max_concurrent_video_jobs} video chạy cùng lúc.`}
          </p>
        </div>
        {worker.data?.queue_paused ? (
          <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}>
            Tiếp tục hàng đợi
          </Button>
        ) : (
          <Button loading={pause.isPending} icon={<Icon name="pause2" />} onClick={() => pause.mutate(undefined)} title="Worker sẽ không nhận thêm job cho tới khi tiếp tục. Job đang chạy vẫn chạy nốt.">
            Tạm dừng hàng đợi
          </Button>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Lọc job" className="flex flex-wrap gap-1 rounded-lg bg-surface-3 p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === t.key ? 'bg-surface shadow-sm' : 'text-muted hover:text-fg'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="q-project">
          Lọc theo dự án
        </label>
        <select id="q-project" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : undefined)} className="w-auto! max-w-full">
          <option value="">Tất cả dự án</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {tab === 'active' && list.length > 0 && (
          <span className="text-[13px] text-muted">
            {list.length} job · {running} đang chạy
          </span>
        )}
      </div>

      {jobs.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : jobs.error ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon="list" title={tab === 'active' ? 'Hàng đợi đang trống' : 'Không có job nào'}>
          {tab === 'active' ? 'Khi bạn duyệt storyboard hoặc video, job xuất hiện ở đây và tự cập nhật.' : 'Không có job nào khớp bộ lọc này.'}
        </EmptyState>
      ) : (
        <>
          {/* Bảng cho màn rộng */}
          <div className="hidden overflow-hidden rounded-lg border border-line bg-surface md:block">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Loại</th>
                  <th className="px-3 py-2 font-semibold">Dự án</th>
                  <th className="px-3 py-2 font-semibold">Cảnh</th>
                  <th className="px-3 py-2 font-semibold">Trạng thái</th>
                  <th className="px-3 py-2 font-semibold">Tạo lúc</th>
                  <th className="px-3 py-2 font-semibold">Nhận lúc</th>
                  <th className="px-3 py-2 font-semibold">Đã chạy</th>
                  <th className="px-3 py-2 text-right font-semibold">Credit</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((j) => (
                  <tr key={j.id} className={j.requeue_count > 0 && isActive(j) ? 'bg-warn-bg/40' : ''}>
                    <td className="px-3 py-2 text-muted">{j.id}</td>
                    <td className="px-3 py-2 font-medium">{JOB_TYPE_LABEL[j.type]}</td>
                    <td className="max-w-44 truncate px-3 py-2">
                      <Link to={`/projects/${j.project_id}`} className="hover:underline" title={j.project_name}>
                        {j.project_name ?? `#${j.project_id}`}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <SceneLink job={j} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <JobStatusBadge status={j.status} />
                        {j.ai && <span className="text-xs text-muted" title={`${j.ai.provider} / ${j.ai.model}`}>{j.ai.alias}</span>}
                        {j.wait_reason && <span className="text-xs text-muted">{j.wait_reason === 'ai_quota' ? 'Chờ tài khoản AI' : 'Cần đối soát lượt tạo'}</span>}
                        <Requeued job={j} />
                      </div>
                      {j.status === 'failed' && (
                        <p className="mt-1 max-w-72 text-xs text-danger-fg">
                          {j.error_code ? `${FAIL_CODE_LABEL[j.error_code] ?? j.error_code}: ` : ''}
                          {j.error}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDateTime(j.created_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDateTime(j.claimed_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <RunTime job={j} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <CreditCell job={j} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isActive(j) && (
                        <Button size="sm" variant="danger" onClick={() => { cancel.reset(); setTarget(j); }}>
                          Hủy
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Danh sách thẻ cho điện thoại */}
          <ul className="space-y-2 md:hidden">
            {list.map((j) => (
              <li key={j.id} className={`rounded-lg border border-line p-3 ${j.requeue_count > 0 && isActive(j) ? 'bg-warn-bg/40' : 'bg-surface'}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-xs text-muted">#{j.id}</span>
                  <strong>{JOB_TYPE_LABEL[j.type]}</strong>
                  {j.scene_id && <SceneLink job={j} />}
                  <span className="ml-auto">
                    <JobStatusBadge status={j.status} />
                        {j.ai && <span className="text-xs text-muted" title={`${j.ai.provider} / ${j.ai.model}`}>{j.ai.alias}</span>}
                        {j.wait_reason && <span className="text-xs text-muted">{j.wait_reason === 'ai_quota' ? 'Chờ tài khoản AI' : 'Cần đối soát lượt tạo'}</span>}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">{j.project_name}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>Tạo {fmtDateTime(j.created_at)}</span>
                  {j.claimed_at && (
                    <span>
                      Chạy <RunTime job={j} />
                    </span>
                  )}
                  {j.type === 'video' && (
                    <span>
                      Credit <CreditCell job={j} />
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Requeued job={j} />
                </div>
                {j.status === 'failed' && <p className="mt-1 text-xs text-danger-fg">{j.error}</p>}
                {isActive(j) && (
                  <Button size="sm" variant="danger" className="mt-2" onClick={() => { cancel.reset(); setTarget(j); }}>
                    Hủy job
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={target ? `Hủy job #${target.id}: ${JOB_TYPE_LABEL[target.type].toLowerCase()}${target.scene_code ? ` ${target.scene_code}` : ''}?` : 'Hủy job?'}
        confirmLabel="Hủy job"
        cancelLabel="Giữ lại"
        danger
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() => target && cancel.mutate(target.id, { onSuccess: () => setTarget(null) })}
      >
        {target?.status === 'queued' ? (
          <p>Job chưa được worker nhận.{target.type === 'video' ? ' Phần credit đã đặt trước sẽ được trả lại.' : ' Không mất credit.'}</p>
        ) : (
          <p>
            Worker đang xử lý job này và sẽ dừng ở lần báo tiếp theo.
            {target?.type === 'video' ? ' Nếu Flow đã bắt đầu tạo video thì credit có thể đã bị tính.' : ''}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
