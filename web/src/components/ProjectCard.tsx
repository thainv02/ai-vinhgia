import { Link } from 'react-router-dom';
import type { ProjectSummary, SceneStatus } from '../api/types';
import { pct } from '../lib/format';
import { finalStatusLabel } from '../lib/finalCut';
import { SCENE_STATUS, TONE_SOLID } from '../lib/status';
import { ProjectStatusBadge } from './StatusBadge';

// Thứ tự các đoạn trong thanh tiến trình: từ xong (trái) tới chưa xong (phải).
const SEGMENTS: SceneStatus[] = [
  'done',
  'video_review',
  'storyboard_review',
  'video_running',
  'storyboard_running',
  'video_queued',
  'storyboard_queued',
  'needs_revision',
  'awaiting_approval',
  'failed',
  'blocked_budget',
];

export function ProgressBar({ counts, total }: { counts: Partial<Record<SceneStatus, number>>; total: number }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label="Tiến trình các cảnh">
      {SEGMENTS.map((s) => {
        const n = counts[s] ?? 0;
        if (!n) return null;
        return <span key={s} title={`${SCENE_STATUS[s].label}: ${n}`} className={`${TONE_SOLID[SCENE_STATUS[s].tone]} first:rounded-l-full last:rounded-r-full`} style={{ width: `${pct(n, total)}%` }} />;
      })}
    </div>
  );
}

export function ProjectCard({ project: p }: { project: ProjectSummary }) {
  const total = p.scene_count;
  return (
    <Link
      to={`/projects/${p.id}`}
      className="group flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-[15px] font-semibold leading-snug group-hover:underline">{p.name}</h2>
        <ProjectStatusBadge status={p.status} />
      </div>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-xs text-muted">
          <span>
            {total > 0 ? (
              <>
                <strong className="text-fg">{p.done_count}</strong>/{total} cảnh hoàn tất
              </>
            ) : (
              'Chưa có cảnh'
            )}
          </span>
          <span>{total > 0 ? `${Math.round(pct(p.done_count, total))}%` : ''}</span>
        </div>
        <ProgressBar counts={p.status_counts} total={total} />
        {total > 0 && (
          <p className="mt-1.5 text-xs text-muted">
            {SEGMENTS.filter((st) => (p.status_counts[st] ?? 0) > 0 && st !== 'done')
              .map((st) => `${SCENE_STATUS[st].label} ${p.status_counts[st]}`)
              .join(' · ') || 'Tất cả cảnh đã hoàn tất'}
          </p>
        )}
      </div>
      {p.latest_final_cut && (
        <p className="-mt-1 text-xs text-muted">
          Bản hoàn chỉnh v{p.latest_final_cut.version}: <strong className="text-fg">{finalStatusLabel(p.latest_final_cut)}</strong>
          {p.latest_final_cut.outdated ? ' · đã cũ vì đổi video' : ''}
          {p.latest_final_cut.status === 'ready' && !p.latest_final_cut.watermark_removed ? ' · còn logo Veo' : ''}
        </p>
      )}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-3 text-xs">
        <div>
          <dt className="text-muted">Số cảnh</dt>
          <dd className="text-sm font-semibold">{total}</dd>
        </div>
        <div>
          <dt className="text-muted">Đã dùng</dt>
          <dd className="text-sm font-semibold">{p.credits_used} credit</dd>
        </div>
        {p.credits_reserved > 0 && (
          <div>
            <dt className="text-muted">Đặt trước</dt>
            <dd className="text-sm font-semibold text-spend">{p.credits_reserved} credit</dd>
          </div>
        )}
        <div className="ml-auto text-right">
          <dt className="text-muted">Mỗi video</dt>
          <dd className="text-sm font-semibold">{p.credit_per_video} credit</dd>
        </div>
      </dl>
    </Link>
  );
}
