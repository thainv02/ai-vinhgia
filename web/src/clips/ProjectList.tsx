import type { ComponentType, ReactNode } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { fmtRelative } from '../lib/format';
import { useNow } from '../lib/useNow';
import { clock, SOURCE_STATUS_LABEL } from './lib';
import type { ClipProjectSummary } from './types';

export type LinkComp = ComponentType<{ id: number; className?: string; children: ReactNode }>;

/** Danh sách dự án cắt clip (thẻ). `Link` do nơi dùng cấp: react-router ở app chính, thẻ <a href="#/..."> ở trang LAN. */
export function ClipProjectList({ projects, loading, error, onRetry, onCreate, Link }: { projects: ClipProjectSummary[] | undefined; loading: boolean; error: unknown; onRetry: () => void; onCreate: () => void; Link: LinkComp }) {
  const now = useNow();
  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!projects || projects.length === 0) {
    return (
      <EmptyState
        icon="film"
        title="Chưa có dự án cắt clip nào"
        action={
          <Button variant="primary" icon={<Icon name="plus" />} onClick={onCreate}>
            Tạo dự án đầu tiên
          </Button>
        }
      >
        Tải lên một video dài (livestream, podcast, phỏng vấn...), AI chọn ra các đoạn hay, bạn duyệt rồi dựng thành clip 9:16 có phụ đề.
      </EmptyState>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((p) => (
        <li key={p.id}>
          <Link id={p.id} className="group flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-[15px] font-semibold leading-snug group-hover:underline">{p.name}</h2>
              <Badge tone="violet">Cắt clip</Badge>
            </div>
            <p className="text-[13px] text-muted">
              {p.created_by_name ? `${p.created_by_name} · ` : ''}
              {fmtRelative(p.created_at, now)}
            </p>
            <p className="mt-auto border-t border-line pt-2 text-xs text-muted">
              {p.source_video ? (
                <>
                  Video {p.source_video.duration_s ? clock(p.source_video.duration_s) : ''} · {SOURCE_STATUS_LABEL[p.source_video.status] ?? p.source_video.status}
                </>
              ) : (
                'Chưa tải video'
              )}
              {p.clip_count !== undefined ? ` · ${p.clip_count} clip` : ''}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
