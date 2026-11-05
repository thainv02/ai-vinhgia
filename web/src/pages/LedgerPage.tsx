import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { buttonClass } from '../components/Button';
import { EventTimeline } from '../components/EventTimeline';
import { Icon } from '../components/Icon';
import { ErrorState } from '../components/States';
import { useProject } from '../hooks/queries';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/** Nhật ký sự kiện của dự án (route `/projects/:projectId/ledger` giữ nguyên để link cũ vẫn mở được). */
export default function LedgerPage() {
  const projectId = Number(useParams().projectId);
  const valid = Number.isInteger(projectId) && projectId > 0;
  const project = useProject(valid ? projectId : 0);
  useDocumentTitle(project.data ? `Nhật ký · ${project.data.name}` : 'Nhật ký');

  if (!valid) return <ErrorState title="Mã dự án không hợp lệ" error={new Error('Đường dẫn dự án sai.')} />;
  if (project.error && !project.data) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;

  return (
    <div>
      <Link to={`/projects/${projectId}`} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <Icon name="arrowLeft" size={14} /> {project.data?.name ?? 'Dự án'}
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Nhật ký</h1>
        <div className="flex flex-wrap gap-2">
          <a href={api.logMdUrl(projectId)} download className={buttonClass('secondary', 'md')}>
            <Icon name="download" /> Xuất log.md
          </a>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-3 sm:p-4">
        <EventTimeline projectId={projectId} showScene />
      </div>
    </div>
  );
}
