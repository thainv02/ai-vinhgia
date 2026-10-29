import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { fmtSeconds } from '../lib/finalCut';
import { fmtDateTime } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { planner } from './api';
import { fmtMB } from './parts';
import type { ToolJob, ToolJobStatus, ToolStatus } from './types';

const STATUS: Record<ToolJobStatus, { label: string; cls: string }> = {
  queued: { label: 'Đang chờ', cls: 'av-badge-neutral' },
  processing: { label: 'Đang xoá', cls: 'av-badge-info' },
  ready: { label: 'Xong', cls: 'av-badge-ok' },
  failed: { label: 'Lỗi', cls: 'av-badge-danger' },
  cancelled: { label: 'Đã huỷ', cls: 'av-badge-neutral' },
  expired: { label: 'Đã hết hạn', cls: 'av-badge-neutral' },
};

function JobRow({ job, onChanged, onPreview }: { job: ToolJob; onChanged: () => void; onPreview: (j: ToolJob) => void }) {
  const cancel = useMutation({ mutationFn: () => planner.cancelToolJob(job.id), meta: { silent: true }, onSuccess: onChanged, onError: (e) => toast.error(errorMessage(e)) });
  const retry = useMutation({
    mutationFn: () => planner.retryToolJob(job.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success('Đã xếp lại hàng đợi');
      onChanged();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const waiting = job.status === 'queued' || job.status === 'processing';
  const download = `${job.original_name.replace(/\.[^.]+$/, '') || 'video'}_sach.mp4`;
  const dims = job.input ? [job.input.width && job.input.height ? `${job.input.width}×${job.input.height}` : null, fmtMB(job.input.bytes)].filter(Boolean).join(' · ') : '';
  return (
    <tr>
      <td>
        <strong title={job.original_name}>{job.original_name}</strong>
        {dims && <div className="av-muted" style={{ fontSize: 12, marginTop: 3 }}>{dims}</div>}
      </td>
      <td>{job.input ? fmtSeconds(job.input.duration_s) : '—'}</td>
      <td>
        {job.status === 'processing' ? (
          <div className="flex items-center gap-2.5" style={{ minWidth: 170 }}>
            <div className="av-bar" style={{ width: 110 }} role="progressbar" aria-label={`Tiến độ xoá logo ${job.original_name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress === null ? undefined : Math.round(job.progress)}>
              <i style={{ width: `${Math.max(3, job.progress ?? 3)}%` }} />
            </div>
            <span style={{ fontSize: 12.5 }}>{job.progress !== null ? `${Math.round(job.progress)}%` : 'Đang xoá'}</span>
          </div>
        ) : job.status === 'failed' ? (
          <span className="av-badge av-badge-danger" title={job.error ?? undefined}>
            Lỗi{job.error ? `: ${job.error}` : ''}
          </span>
        ) : (
          <span className={`av-badge ${STATUS[job.status].cls}`}>{job.status === 'queued' && job.queue_position ? `Đang chờ · vị trí ${job.queue_position}` : STATUS[job.status].label}</span>
        )}
      </td>
      <td className="av-muted" style={{ fontSize: 12.5 }}>
        {fmtDateTime(job.finished_at ?? job.created_at)}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {job.output && (
          <>
            <button type="button" className="av-btn av-btn-sm" onClick={() => onPreview(job)}>
              Xem
            </button>{' '}
            <a href={job.output.url} download={download} className="av-btn av-btn-sm av-btn-primary">
              Tải về
            </a>
          </>
        )}
        {waiting && (
          <button type="button" className="av-btn av-btn-sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Huỷ
          </button>
        )}
        {job.can_retry && (
          <button type="button" className="av-btn av-btn-sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
            Thử lại
          </button>
        )}
      </td>
    </tr>
  );
}

function checkFile(file: File, r: ToolStatus['remove_logo']): string | null {
  const ext = /\.(mp4|mov)$/i.test(file.name) || /^video\/(mp4|quicktime)$/.test(file.type);
  if (!ext) return `"${file.name}" không phải video mp4 hoặc mov.`;
  if (file.size === 0) return `"${file.name}" là file rỗng.`;
  if (file.size > r.max_bytes) return `"${file.name}" nặng ${fmtMB(file.size)}, vượt giới hạn ${fmtMB(r.max_bytes)}.`;
  return null;
}

/** Vùng kéo thả: nhiều video được tải lên lần lượt (API nhận một file mỗi lượt), job nào xong lượt tải là vào hàng đợi xử lý ngay. */
function DropCard({ status, onCreated }: { status: ToolStatus; onCreated: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const cancelled = useRef(false);
  const [up, setUp] = useState<{ name: string; loaded: number; total: number; left: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const r = status.remove_logo;
  useEffect(
    () => () => {
      cancelled.current = true;
      abortRef.current?.();
    },
    [],
  );

  const blocked = up ? 'Đang tải lên' : !r.available ? `Công cụ xoá logo đang tắt hoặc lỗi: ${r.reason ?? 'chưa sẵn sàng'}` : null;

  const run = async (files: File[]) => {
    cancelled.current = false;
    const errs: string[] = [];
    const ok = files.filter((f) => {
      const bad = checkFile(f, r);
      if (bad) errs.push(bad);
      return !bad;
    });
    setProblems(errs);
    for (let i = 0; i < ok.length && !cancelled.current; i++) {
      const file = ok[i]!;
      const { promise, abort } = planner.createToolJob(file, '', (loaded, total) => setUp({ name: file.name, loaded, total, left: ok.length - i - 1 }));
      abortRef.current = abort;
      setUp({ name: file.name, loaded: 0, total: file.size, left: ok.length - i - 1 });
      try {
        await promise;
        onCreated();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'ABORTED') {
          cancelled.current = true;
        } else {
          errs.push(`${file.name}: ${errorMessage(e)}`);
          setProblems([...errs]);
        }
        onCreated();
      }
    }
    abortRef.current = null;
    setUp(null);
  };

  const pick = (list: FileList | null | undefined) => {
    const files = list ? Array.from(list) : [];
    if (files.length && !blocked) void run(files);
  };
  const pct = up && up.total > 0 ? (up.loaded / up.total) * 100 : 0;

  return (
    <div className="av-card" style={{ padding: 8 }}>
      <div
        className={`av-drop ${over ? 'over' : ''}`}
        style={{ padding: '34px 24px', gap: 10 }}
        onDragOver={(e) => {
          if (!blocked) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer.files);
        }}
      >
        <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl" style={{ background: 'var(--surface-3)', color: 'var(--muted)' }}>
          <Icon name="upload" size={22} />
        </span>
        <span className="text-[15px] font-bold">Kéo một hoặc nhiều video vào đây</span>
        <span className="av-muted text-[12.5px]">
          mp4 hoặc mov, mỗi video {r.min_s}–{r.max_s} giây, tối đa {fmtMB(r.max_bytes)}
        </span>
        <button type="button" className="av-btn av-btn-primary" style={{ marginTop: 4 }} disabled={!!blocked} title={blocked ?? undefined} onClick={() => input.current?.click()}>
          Chọn video…
        </button>
        {blocked && !up && <span className="text-xs" style={{ color: 'var(--warn-fg)' }}>{blocked}</span>}
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept="video/mp4,video/quicktime,.mp4,.mov"
        hidden
        aria-label="Chọn video cần xoá logo Veo"
        onChange={(e) => {
          const files = e.target.files;
          pick(files);
          e.target.value = '';
        }}
      />
      {up && (
        <div className="flex flex-col gap-1.5 px-3 pb-3 pt-3" role="status">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-medium">{up.name}</span>
            <span className="av-muted shrink-0">
              {up.total > 0 && up.loaded >= up.total ? 'Đang kiểm tra video…' : `${Math.round(pct)}% · ${fmtMB(up.loaded)}/${fmtMB(up.total)}`}
              {up.left > 0 ? ` · còn ${up.left} video` : ''}
            </span>
          </div>
          <div className="av-bar">
            <i style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <div>
            <button type="button" className="av-btn av-btn-sm" onClick={() => { cancelled.current = true; abortRef.current?.(); }}>
              Huỷ tải lên
            </button>
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-1 px-3 pb-3 pt-2">
          {problems.map((p, i) => (
            <InlineError key={i}>{p}</InlineError>
          ))}
        </div>
      )}
    </div>
  );
}

/** Công cụ "Xoá logo Veo": thả một hay nhiều video, theo dõi từng việc, xem và tải bản sạch. */
export function ToolPage() {
  useDocumentTitle('Xoá logo Veo');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['tool-status'], queryFn: planner.toolStatus, refetchInterval: 10_000 });
  const jobs = useQuery({
    queryKey: ['tool-jobs'],
    queryFn: planner.toolJobs,
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'processing') ? 3000 : 15_000),
  });
  const [preview, setPreview] = useState<ToolJob | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tool-jobs'] });
    void qc.invalidateQueries({ queryKey: ['tool-status'] });
  };
  const render = status.data?.render;

  return (
    <>
      <header className="av-header">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
          <h1>Xoá logo Veo</h1>
          <p className="av-muted text-[13px]">Xoá logo khỏi bất kỳ video Veo nào, không cần kế hoạch.</p>
        </div>
      </header>

      <section className="av-page" style={{ gap: 20 }}>
        {status.isLoading ? (
          <Skeleton className="h-40" />
        ) : status.error || !status.data ? (
          <ErrorState title="Không đọc được trạng thái công cụ" error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <DropCard status={status.data} onCreated={refresh} />
        )}

        <div className="flex items-center gap-3">
          <h2 className="flex-1 text-[15px] font-bold">Việc xoá logo</h2>
          {render && (
            <span className="av-muted text-[12.5px]" aria-live="polite">
              {render.running_count} đang chạy · {render.waiting_count} chờ · tối đa {render.concurrency} việc cùng lúc
            </span>
          )}
        </div>

        {jobs.isLoading ? (
          <Skeleton className="h-32" />
        ) : jobs.error ? (
          <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : jobs.data && jobs.data.length === 0 ? (
          <EmptyState icon="film" title="Chưa có việc nào" />
        ) : (
          <div className="av-card av-table-wrap">
            <table className="av-table">
              <thead>
                <tr>
                  <th>Video</th>
                  <th>Thời lượng</th>
                  <th>Trạng thái</th>
                  <th>Thời gian</th>
                  <th>
                    <span className="av-sr">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.data?.map((j) => (
                  <JobRow key={j.id} job={j} onChanged={refresh} onPreview={setPreview} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {preview?.output && (
          <div className="av-card flex flex-col gap-2 p-3" style={{ alignSelf: 'flex-start' }}>
            <div className="flex items-center gap-2">
              <strong className="min-w-0 flex-1 truncate text-[13px]">{preview.original_name}</strong>
              <button type="button" className="av-btn av-btn-sm av-btn-ghost" aria-label="Đóng xem trước" onClick={() => setPreview(null)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <video src={`${preview.output.url}#t=0.5`} controls autoPlay playsInline aria-label={`Bản đã xoá logo: ${preview.original_name}`} style={{ maxHeight: 420, maxWidth: '100%', background: 'var(--stage)', borderRadius: 8 }} />
          </div>
        )}
      </section>
    </>
  );
}
