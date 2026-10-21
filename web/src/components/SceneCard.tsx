import { Link } from 'react-router-dom';
import type { Scene } from '../api/types';
import { fmtDuration } from '../lib/format';
import { sceneStatusInfo, TONE_BORDER } from '../lib/status';
import { ElapsedTime } from './ElapsedTime';
import { Icon } from './Icon';
import { SceneActions } from './SceneActions';
import { SceneStatusBadge } from './StatusBadge';

/** Khung 9:16 có nhãn góc. */
function Frame({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`relative aspect-[9/16] overflow-hidden rounded-md border border-line bg-surface-3 ${className}`}>{children}</div>;
}

function Placeholder({ text, live, sub }: { text: string; live?: boolean; sub?: React.ReactNode }) {
  return (
    <div className={`absolute inset-0 grid place-content-center gap-1 px-2 text-center text-[11px] text-muted ${live ? 'shimmer' : ''}`}>
      <span>{text}</span>
      {sub && <span className="font-semibold text-fg">{sub}</span>}
    </div>
  );
}

const Tag = ({ children, side = 'left' }: { children: React.ReactNode; side?: 'left' | 'right' }) => (
  <span className={`absolute bottom-1 ${side === 'left' ? 'left-1' : 'right-1'} rounded bg-black/70 px-1.5 py-px text-[10px] font-semibold text-white`}>{children}</span>
);

export function SceneMedia({ scene, detailHref }: { scene: Scene; detailHref: string }) {
  const sbRunning = scene.status === 'storyboard_queued' || scene.status === 'storyboard_running';
  const vidRunning = scene.status === 'video_queued' || scene.status === 'video_running';
  const job = scene.active_job;
  const jobRunning = job && (job.status === 'claimed' || job.status === 'running');
  const dur = scene.video?.meta?.duration_s;

  return (
    <div className="flex shrink-0 gap-2 max-md:w-[196px] md:w-full">
      <Link to={detailHref} className="block min-w-0 flex-1" aria-label={`Xem storyboard ${scene.code}`}>
        <Frame>
          {scene.storyboard ? (
            <>
              <img src={scene.storyboard.url} alt={`Storyboard ${scene.code}`} loading="lazy" className="size-full object-cover" />
              <Tag>Storyboard{scene.storyboard_count > 1 ? ` ${scene.storyboard_count}` : ''}</Tag>
            </>
          ) : sbRunning ? (
            <Placeholder live text={jobRunning ? 'Đang tạo storyboard' : 'Storyboard đang chờ'} sub={jobRunning ? <ElapsedTime since={job?.claimed_at} /> : null} />
          ) : (
            <Placeholder text="Chưa có storyboard" />
          )}
        </Frame>
      </Link>
      <Link to={detailHref} className="block min-w-0 flex-1" aria-label={`Xem video ${scene.code}`}>
        <Frame className="bg-black">
          {scene.video ? (
            <>
              <video
                src={`${scene.video.url}#t=0.1`}
                muted
                playsInline
                preload="metadata"
                className="size-full object-cover"
                aria-label={`Video ${scene.code} bản ${scene.video.attempt}`}
              />
              <span className="absolute inset-0 grid place-items-center text-white/90">
                <span className="grid size-8 place-items-center rounded-full bg-black/55">
                  <Icon name="play" size={14} />
                </span>
              </span>
              <Tag>v{scene.video.attempt}</Tag>
              {typeof dur === 'number' && <Tag side="right">{fmtDuration(dur)}</Tag>}
              {vidRunning && (
                <span className="absolute inset-x-0 top-0 flex items-center justify-center gap-1 bg-info-bg/95 px-1 py-1 text-[10px] font-semibold text-info-fg">
                  <span aria-hidden="true" className="pulse-dot size-1.5 rounded-full bg-info-fg" />
                  Đang tạo bản mới
                </span>
              )}
              {scene.status === 'done' && (
                <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-ok-fg text-surface" title="Đã chọn video này">
                  <Icon name="check" size={12} />
                </span>
              )}
            </>
          ) : vidRunning ? (
            <div className="absolute inset-0 text-white/80">
              <Placeholder live text={jobRunning ? 'Đang tạo video' : 'Video đang chờ'} sub={jobRunning ? <ElapsedTime since={job?.claimed_at} className="text-white" /> : null} />
            </div>
          ) : (
            <Placeholder text="Chưa có video" />
          )}
        </Frame>
      </Link>
    </div>
  );
}

function AttemptPips({ used, max }: { used: number; max: number }) {
  const full = used >= max;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Lượt tạo video: đã dùng ${used}/${max}`}>
      <span className="flex gap-0.5" aria-hidden="true">
        {Array.from({ length: Math.min(max, 8) }, (_, i) => (
          <span key={i} className={`h-2 w-3.5 rounded-[2px] ${i < used ? (full ? 'bg-danger-fg' : 'bg-fg') : 'bg-surface-3'}`} />
        ))}
      </span>
      <span className={full ? 'font-semibold text-danger-fg' : ''}>
        Lượt {used}/{max}
      </span>
    </span>
  );
}

export function SceneCard({ scene, projectId, creditPerVideo }: { scene: Scene; projectId: number; creditPerVideo: number }) {
  const info = sceneStatusInfo(scene.status);
  const href = `/projects/${projectId}/scenes/${scene.id}`;
  const job = scene.active_job;
  const jobRunning = job && (job.status === 'claimed' || job.status === 'running');

  return (
    <article className={`flex flex-col rounded-lg border border-line border-t-[3px] bg-surface p-3 ${TONE_BORDER[info.tone]}`} aria-label={`Cảnh ${scene.code}`}>
      <header className="mb-2.5 flex items-start justify-between gap-2">
        <Link to={href} className="group min-w-0">
          <span className="text-lg font-extrabold leading-none tracking-tight">{scene.code}</span>
          <span className="mt-1 block text-[13px] leading-snug text-muted group-hover:text-fg group-hover:underline">{scene.title}</span>
        </Link>
        <SceneStatusBadge status={scene.status} />
      </header>

      <div className="flex gap-3 md:flex-col">
        <SceneMedia scene={scene} detailHref={href} />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex flex-col gap-1 text-xs text-muted">
            <AttemptPips used={scene.attempts_used} max={scene.max_attempts} />
            <span className="flex flex-wrap items-center gap-x-2">
              <span>Prompt v{scene.prompt_version}</span>
              {scene.open_comments > 0 && (
                <Link to={href} className="inline-flex items-center gap-1 font-medium text-info-fg hover:underline">
                  <Icon name="comment" size={12} />
                  {scene.open_comments} nhận xét mở
                </Link>
              )}
            </span>
            {job && (
              <span className="flex items-center gap-1 text-fg">
                <Icon name="clock" size={12} />
                {jobRunning ? (
                  <>
                    Worker đang chạy <ElapsedTime since={job.claimed_at} className="font-semibold" />
                  </>
                ) : (
                  <>{scene.waiting_reason ?? 'Đang chờ worker nhận'}</>
                )}
                {job.requeue_count > 0 && <span className="rounded bg-warn-bg px-1 text-warn-fg">bị trả về {job.requeue_count} lần</span>}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <SceneActions scene={scene} creditPerVideo={creditPerVideo} variant="card" />
      </div>
    </article>
  );
}
