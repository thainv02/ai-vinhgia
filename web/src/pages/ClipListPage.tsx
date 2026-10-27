import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { ClipEnvProvider } from '../clips/env';
import { appClipEnv } from '../clips/appIo';
import { NewClipProjectDialog } from '../clips/NewProjectDialog';
import { ClipProjectList, type LinkComp } from '../clips/ProjectList';
import type { ClipProjectSummary } from '../clips/types';
import { useProjects } from '../hooks/queries';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const RouterLink: LinkComp = ({ id, className, children }) => (
  <Link to={`/clips/${id}`} className={className}>
    {children}
  </Link>
);

/** `/clips`: danh sách dự án cắt clip từ video dài + tạo dự án mới. */
export default function ClipListPage() {
  useDocumentTitle('Cắt clip');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const { data, isLoading, error, refetch } = useProjects();
  const projects = data?.filter((p) => p.kind === 'clips') as ClipProjectSummary[] | undefined;

  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  return (
    <ClipEnvProvider value={appClipEnv}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Cắt clip từ video dài</h1>
          <p className="text-[13px] text-muted">Tải lên video dài, AI chọn các đoạn hay, bạn duyệt rồi dựng thành clip 9:16 có phụ đề tiếng Việt.</p>
        </div>
        <Button variant="primary" icon={<Icon name="plus" />} onClick={() => setCreating(true)}>
          Dự án cắt clip mới
        </Button>
      </div>
      <ClipProjectList projects={projects} loading={isLoading} error={error} onRetry={() => void refetch()} onCreate={() => setCreating(true)} Link={RouterLink} />
      <NewClipProjectDialog key={creating ? 'o' : 'c'} open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/clips/${id}`)} />
    </ClipEnvProvider>
  );
}
