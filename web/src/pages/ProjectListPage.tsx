import { useProjects } from '../hooks/queries';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { LinkButton } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { ProjectCard } from '../components/ProjectCard';

export default function ProjectListPage() {
  useDocumentTitle('Dự án');
  const { data, isLoading, error, refetch } = useProjects();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Dự án</h1>
        <LinkButton to="/projects/new" variant="primary" icon={<Icon name="plus" />}>
          Dự án mới
        </LinkButton>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data && data.length === 0 ? (
        <EmptyState
          icon="film"
          title="Chưa có dự án nào"
          action={
            <LinkButton to="/projects/new" variant="primary" icon={<Icon name="plus" />}>
              Tạo dự án đầu tiên
            </LinkButton>
          }
        >
          Nhập kịch bản, tải ảnh sản phẩm lên, Claude sẽ chia thành các cảnh và viết prompt cho từng cảnh.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {data?.map((p) => <ProjectCard key={p.id} project={p} />)}
        </div>
      )}
    </div>
  );
}
