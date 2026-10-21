import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import type { Budget, ProjectDetail, Scene, SceneStatus } from '../api/types';
import { ApproveAllDialog } from '../components/ApproveAllDialog';
import { Button, LinkButton } from '../components/Button';
import { Icon } from '../components/Icon';
import { ProjectSettingsDialog } from '../components/ProjectSettingsDialog';
import { RefManager } from '../components/RefManager';
import { FinalCutBlock } from '../components/FinalCutBlock';
import { SceneCard } from '../components/SceneCard';
import { ConfirmDialog } from '../components/Modal';
import { EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { ProjectStatusBadge } from '../components/StatusBadge';
import { useCancelJob, useSubmitBrief } from '../hooks/mutations';
import { useApprovePreview, useBudget, useJobs, useProject, useScenes } from '../hooks/queries';
import { ACTIVE_JOB_STATUSES, SCENE_STATUS, TONE_CLASS } from '../lib/status';
import { useDocumentTitle } from '../lib/useDocumentTitle';

function CreditUsage({ budget }: { budget: Budget }) {
  return (
    <div className="min-w-[200px] flex-1 sm:max-w-xs">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-extrabold leading-none tracking-tight">{budget.used}</span>
        <span className="text-[13px] font-medium">credit đã dùng</span>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {budget.reserved > 0 && (
          <>
            Đặt trước <strong className="text-spend">{budget.reserved} credit</strong> cho video đang chờ ·{' '}
          </>
        )}
        {budget.credit_per_video} credit/video · tối đa {budget.max_attempts} lượt/cảnh
      </p>
    </div>
  );
}

function StatusChips({ scenes, filter, onFilter }: { scenes: Scene[]; filter: SceneStatus | null; onFilter: (s: SceneStatus | null) => void }) {
  const counts = useMemo(() => {
    const m = new Map<SceneStatus, number>();
    for (const s of scenes) m.set(s.status, (m.get(s.status) ?? 0) + 1);
    return [...m.entries()];
  }, [scenes]);
  if (counts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Lọc cảnh theo trạng thái">
      {counts.map(([status, n]) => {
        const info = SCENE_STATUS[status];
        const active = filter === status;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            onClick={() => onFilter(active ? null : status)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ring-offset-1 ring-offset-bg ${TONE_CLASS[info.tone]} ${active ? 'ring-2 ring-fg' : 'opacity-90 hover:opacity-100'}`}
          >
            {info.live && <span aria-hidden="true" className="pulse-dot size-1.5 rounded-full bg-current" />}
            {info.label}
            <span className="rounded bg-black/10 px-1 text-[11px] dark:bg-white/10">{n}</span>
          </button>
        );
      })}
      {filter && (
        <button type="button" onClick={() => onFilter(null)} className="px-1 text-xs text-muted underline hover:text-fg">
          Bỏ lọc
        </button>
      )}
    </div>
  );
}

function BriefPanel({ project }: { project: ProjectDetail }) {
  const [brief, setBrief] = useState(project.brief);
  const submit = useSubmitBrief();
  const analyzingJobs = useJobs({ projectId: project.id, status: ACTIVE_JOB_STATUSES });
  const cancel = useCancelJob({ silent: true });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const analyzeJob = analyzingJobs.data?.find((j) => j.type === 'analyze_brief');

  if (project.status === 'analyzing') {
    return (
      <EmptyState
        icon="clock"
        title="Claude đang phân tích kịch bản"
        action={
          analyzeJob && (
            <>
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Hủy phân tích
              </Button>
              <ConfirmDialog
                open={confirmCancel}
                onClose={() => setConfirmCancel(false)}
                title="Hủy phân tích kịch bản?"
                confirmLabel="Hủy phân tích"
                cancelLabel="Giữ lại"
                danger
                pending={cancel.isPending}
                error={cancel.isError ? errorMessage(cancel.error) : null}
                onConfirm={() => cancel.mutate(analyzeJob.id, { onSuccess: () => setConfirmCancel(false) })}
              >
                <p>Việc phân tích chưa xong sẽ bị bỏ. Bạn có thể gửi lại kịch bản sau.</p>
              </ConfirmDialog>
            </>
          )
        }
      >
        Danh sách cảnh sẽ tự hiện ra khi Claude xong, không cần tải lại trang. Claude chỉ làm việc khi phiên Claude Code (worker) đang mở.
        {analyzeJob && <span className="mt-1 block text-xs">Job #{analyzeJob.id}: {analyzeJob.status === 'queued' ? 'đang chờ worker nhận' : 'worker đang chạy'}.</span>}
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-1 text-base font-semibold">{project.status === 'draft' ? 'Chưa gửi kịch bản cho Claude' : 'Dự án chưa có cảnh nào'}</h2>
      <p className="mb-3 text-muted">Kiểm tra lại yêu cầu kịch bản rồi gửi cho Claude để chia cảnh và viết prompt.</p>
      <label htmlFor="brief" className="sr-only">
        Yêu cầu kịch bản
      </label>
      <textarea id="brief" rows={7} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Mô tả sản phẩm, thông điệp, số cảnh mong muốn..." />
      {submit.isError && (
        <div className="mt-2">
          <InlineError>{errorMessage(submit.error)}</InlineError>
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="primary"
          icon={<Icon name="send" />}
          loading={submit.isPending}
          disabledReason={brief.trim() ? null : 'Nhập yêu cầu kịch bản'}
          onClick={() => submit.mutate({ projectId: project.id, brief: brief.trim() })}
        >
          Gửi cho Claude phân tích
        </Button>
      </div>
    </div>
  );
}

export default function BoardPage() {
  const projectId = Number(useParams().projectId);
  const valid = Number.isInteger(projectId) && projectId > 0;
  const project = useProject(valid ? projectId : 0);
  const scenes = useScenes(valid ? projectId : 0);
  const budget = useBudget(valid ? projectId : 0);
  const sbPreview = useApprovePreview(projectId, 'storyboard', valid);
  const vdPreview = useApprovePreview(projectId, 'video', valid);
  const [filter, setFilter] = useState<SceneStatus | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useDocumentTitle(project.data?.name);

  if (!valid) return <ErrorState title="Mã dự án không hợp lệ" error={new Error('Đường dẫn dự án sai.')} />;
  if (project.error && !project.data) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;

  const p = project.data;
  const list = scenes.data ?? [];
  const shown = filter ? list.filter((s) => s.status === filter) : list;
  const waitingCount = (sbPreview.data?.count ?? 0) + (vdPreview.data?.count ?? 0);
  const approveReason = waitingCount > 0 ? null : sbPreview.isLoading || vdPreview.isLoading ? 'Đang tải' : 'Không có cảnh nào đang chờ duyệt';
  const creditPerVideo = p?.credit_per_video ?? budget.data?.credit_per_video ?? 15;

  return (
    <div>
      <Link to="/" className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <Icon name="arrowLeft" size={14} /> Dự án
      </Link>

      <section className="mb-4 rounded-lg border border-line bg-surface p-3 sm:p-4" aria-label="Tổng quan dự án">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {p ? (
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight">{p.name}</h1>
                <ProjectStatusBadge status={p.status} />
              </div>
            ) : (
              <Skeleton className="h-7 w-56" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LinkButton to="/queue" size="sm" variant="ghost" icon={<Icon name="list" />}>
              Hàng đợi
            </LinkButton>
            <LinkButton to={`/projects/${projectId}/ledger`} size="sm" variant="ghost" icon={<Icon name="ledger" />}>
              Nhật ký & credit
            </LinkButton>
            <Button size="sm" variant="ghost" icon={<Icon name="gear" />} onClick={() => setSettingsOpen(true)} disabled={!p}>
              Cài đặt
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-3">
          {budget.data ? <CreditUsage budget={budget.data} /> : <Skeleton className="h-12 w-60" />}
          <div className="min-w-0 flex-1 basis-72 space-y-2">
            <StatusChips scenes={list} filter={filter} onFilter={setFilter} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<Icon name="check" />}
                disabledReason={approveReason}
                onClick={() => setApproveOpen(true)}
              >
                Duyệt tất cả cảnh đang chờ{waitingCount > 0 ? ` (${waitingCount})` : ''}
              </Button>
              {approveReason && <span className="text-xs text-muted">{approveReason}</span>}
              {!approveReason && vdPreview.data && vdPreview.data.count > 0 && (
                <span className="text-xs text-muted">
                  Có {vdPreview.data.count} cảnh chờ tạo video: <strong className="text-spend">{vdPreview.data.total_credits} credit</strong>
                </span>
              )}
            </div>
          </div>
        </div>

        {valid && (
          <div className="mt-3 flex flex-wrap gap-3">
            <FinalCutBlock projectId={projectId} scenes={scenes.data} serverBlock={p?.final_cut_block} />
          </div>
        )}

        {p && (
          <div className="mt-3 space-y-1 border-t border-line pt-2 text-[13px]">
            <details>
              <summary className="w-fit py-1 text-muted hover:text-fg">Yêu cầu kịch bản và khóa nhất quán</summary>
              <div className="mt-2 grid gap-3 pb-2 md:grid-cols-2">
                <div>
                  <div className="mb-0.5 text-xs font-semibold text-muted">Yêu cầu kịch bản</div>
                  <p className="whitespace-pre-wrap">{p.brief || '—'}</p>
                </div>
                <div>
                  <div className="mb-0.5 text-xs font-semibold text-muted">Khóa nhất quán</div>
                  <p className="whitespace-pre-wrap">{p.style_lock || '—'}</p>
                </div>
              </div>
            </details>
            <details>
              <summary className="w-fit py-1 text-muted hover:text-fg">Ảnh tham chiếu ({p.refs.length})</summary>
              <div className="mt-2 pb-2">
                <RefManager project={p} />
              </div>
            </details>
          </div>
        )}
      </section>

      {scenes.isLoading || project.isLoading ? (
        <div className="grid gap-3 md:grid-cols-[repeat(auto-fill,minmax(250px,1fr))]" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      ) : scenes.error ? (
        <ErrorState error={scenes.error} onRetry={() => void scenes.refetch()} />
      ) : list.length === 0 ? (
        p ? <BriefPanel project={p} /> : null
      ) : shown.length === 0 ? (
        <EmptyState icon="list" title="Không có cảnh nào ở trạng thái này" action={<Button onClick={() => setFilter(null)}>Bỏ lọc</Button>} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">
          {shown.map((s) => (
            <SceneCard key={s.id} scene={s} projectId={projectId} creditPerVideo={creditPerVideo} />
          ))}
        </div>
      )}

      <ApproveAllDialog projectId={projectId} open={approveOpen} onClose={() => setApproveOpen(false)} />
      {p && <ProjectSettingsDialog project={p} open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
