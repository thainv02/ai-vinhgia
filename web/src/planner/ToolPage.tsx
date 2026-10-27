import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../api/errors';
import { Button, buttonClass } from '../components/Button';
import { Icon } from '../components/Icon';
import { Alert, EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { fmtSeconds, renderQueueTitle } from '../lib/finalCut';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { fmtMB, ProgressBar } from './parts';
import type { ToolJob, ToolJobStatus, ToolStatus } from './types';

const NAME_KEY = 'lan-tool-name';
const readName = (): string => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveName = (v: string) => {
  try {
    window.localStorage.setItem(NAME_KEY, v);
  } catch {
    /* trình duyệt chặn lưu: bỏ qua */
  }
};

const STATUS: Record<ToolJobStatus, { label: string; tone: 'neutral' | 'info' | 'ok' | 'danger' | 'warn'; live?: boolean }> = {
  queued: { label: 'Đang xếp hàng', tone: 'info', live: true },
  processing: { label: 'Đang xoá logo', tone: 'info', live: true },
  ready: { label: 'Sẵn sàng', tone: 'ok' },
  failed: { label: 'Lỗi', tone: 'danger' },
  cancelled: { label: 'Đã hủy', tone: 'neutral' },
  expired: { label: 'Đã hết hạn', tone: 'neutral' },
};

const daysLeft = (iso: string, now: number): number => Math.max(0, Math.ceil((Date.parse(iso) - now) / 86_400_000));

function JobCard({ job, onChanged }: { job: ToolJob; onChanged: () => void }) {
  const now = useNow();
  const cancel = useMutation({ mutationFn: () => planner.cancelToolJob(job.id), meta: { silent: true }, onSuccess: onChanged });
  const retry = useMutation({
    mutationFn: () => planner.retryToolJob(job.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success('Đã xếp lại hàng đợi');
      onChanged();
    },
  });
  const st = STATUS[job.status];
  const waiting = job.status === 'queued' || job.status === 'processing';
  const download = `${job.original_name.replace(/\.[^.]+$/, '') || 'video'}_sach.mp4`;
  return (
    <li className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-label={`Việc xoá logo: ${job.original_name}`}>
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
        {job.output ? (
          <div className="mx-auto w-full max-w-[170px] overflow-hidden rounded-md bg-ink sm:mx-0">
            <video src={`${job.output.url}#t=0.5`} controls preload="metadata" playsInline aria-label={`Bản đã xoá logo: ${job.original_name}`} className="aspect-[9/16] w-full object-contain" />
          </div>
        ) : (
          <div className="hidden aspect-[9/16] w-[170px] place-items-center rounded-md border border-dashed border-line-strong bg-surface-2 text-muted sm:grid" aria-hidden="true">
            <Icon name="film" size={26} />
          </div>
        )}
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-[15px] font-semibold" title={job.original_name}>
              {job.original_name}
            </h3>
            <Badge tone={st.tone} live={st.live}>
              {job.status === 'processing' && job.progress !== null ? `${st.label} ${Math.round(job.progress)}%` : job.status === 'queued' && job.queue_position ? `Chờ xoá logo (vị trí ${job.queue_position})` : st.label}
            </Badge>
          </div>
          <p className="text-xs text-muted">
            {job.input ? `${fmtSeconds(job.input.duration_s)} · ${job.input.width && job.input.height ? `${job.input.width}×${job.input.height} · ` : ''}${fmtMB(job.input.bytes)}` : ''} · tải lên {fmtRelative(job.created_at, now)} ({fmtDateTime(job.created_at)})
            {job.created_by_name ? ` · ${job.created_by_name}` : ''}
          </p>

          {job.status === 'processing' && (
            <div className="space-y-1">
              <ProgressBar value={job.progress} label={`Tiến độ xoá logo ${job.original_name}`} />
              <p className="text-xs text-muted">
                Khoảng 2 giây xử lý cho mỗi giây video. Có thể rời trang, việc vẫn chạy.
                {job.running_count && job.concurrency ? ` Máy chủ đang chạy ${job.running_count}/${job.concurrency} việc.` : ''}
              </p>
            </div>
          )}
          {job.status === 'queued' && (
            <p className="text-[13px] text-muted">
              <Icon name="clock" size={13} className="mr-1 inline" />
              {renderQueueTitle('xoá logo', { position: job.queue_position, running_count: job.running_count, concurrency: job.concurrency })}.
              <span className="block text-xs">Có chỗ trống là tự bắt đầu, không cần làm gì thêm. Có thể rời trang, việc vẫn xếp hàng.</span>
            </p>
          )}
          {job.status === 'ready' && job.output && (
            <p className="text-xs text-muted">
              Bản sạch {job.output.duration_s ? fmtSeconds(job.output.duration_s) : ''}
              {job.output.bytes ? ` · ${fmtMB(job.output.bytes)}` : ''}. Giữ trên máy chủ {daysLeft(job.expires_at, now)} ngày nữa rồi tự xoá.
            </p>
          )}
          {job.status === 'failed' && <InlineError>{job.error ?? 'Xoá logo không thành công.'}</InlineError>}
          {job.status === 'cancelled' && <p className="text-[13px] text-muted">Đã hủy. Video gốc vẫn được giữ, bấm «Thử lại» để xử lý tiếp.</p>}
          {job.status === 'expired' && <p className="text-[13px] text-muted">Đã quá 7 ngày nên file đã bị xoá. Hãy tải video lên lại.</p>}
          {(cancel.isError || retry.isError) && <InlineError>{errorMessage(cancel.error ?? retry.error)}</InlineError>}

          <div className="flex flex-wrap items-center gap-2">
            {job.output && (
              <a href={job.output.url} download={download} className={buttonClass('primary', 'md')}>
                <Icon name="download" /> Tải bản sạch
              </a>
            )}
            {waiting && (
              <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Hủy
              </Button>
            )}
            {job.can_retry && (
              <Button icon={<Icon name="refresh" size={14} />} loading={retry.isPending} onClick={() => retry.mutate()}>
                Thử lại
              </Button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function UploadCard({ status, onCreated }: { status: ToolStatus; onCreated: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const [name, setName] = useState(readName);
  const [up, setUp] = useState<{ name: string; loaded: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const r = status.remove_logo;
  useEffect(() => () => abortRef.current?.(), []);

  const reason = up
    ? 'Đang tải lên'
    : !r.available
      ? `Tool xoá logo Veo đang tắt hoặc lỗi: ${r.reason ?? 'chưa sẵn sàng'}`
      : r.remaining <= 0
        ? `Bạn đã xoá logo ${r.rate.max} lần trong giờ này, hãy thử lại sau`
        : status.queue.total >= status.queue.cap
          ? 'Hàng đợi đang đầy, thử lại sau'
          : null;

  const start = (file: File) => {
    const ext = /\.(mp4|mov)$/i.test(file.name) || /^video\/(mp4|quicktime)$/.test(file.type);
    const bad = !ext ? `"${file.name}" không phải video mp4 hoặc mov.` : file.size === 0 ? `"${file.name}" là file rỗng.` : file.size > r.max_bytes ? `"${file.name}" nặng ${fmtMB(file.size)}, vượt giới hạn ${fmtMB(r.max_bytes)}.` : null;
    setProblem(bad);
    if (bad) return;
    saveName(name.trim());
    const { promise, abort } = planner.createToolJob(file, name, (loaded, total) => setUp({ name: file.name, loaded, total }));
    abortRef.current = abort;
    setUp({ name: file.name, loaded: 0, total: file.size });
    promise
      .then(() => {
        toast.success('Đã tải lên, việc xoá logo đang xếp hàng');
        onCreated();
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.code === 'ABORTED')) setProblem(errorMessage(e));
        onCreated(); // làm mới hạn mức/hàng đợi dù lỗi
      })
      .finally(() => {
        abortRef.current = null;
        setUp(null);
      });
  };
  const pct = up && up.total > 0 ? (up.loaded / up.total) * 100 : 0;
  const verifying = !!up && up.total > 0 && up.loaded >= up.total;

  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby="tool-upload-h">
      <h2 id="tool-upload-h" className="text-[15px] font-semibold">
        Tải video lên
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        mp4 hoặc mov, tối đa {fmtMB(r.max_bytes)}, dài {r.min_s}–{r.max_s} giây. Còn {Math.max(0, r.remaining)}/{r.rate.max} lượt xoá logo trong giờ này.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div>
          <label htmlFor="tool-name" className="mb-1 block text-xs font-semibold text-muted">
            Tên của bạn (tuỳ chọn)
          </label>
          <input id="tool-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Vd: Lan" disabled={!!up} />
        </div>
        <div
          onDragOver={(e) => {
            if (!reason) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !reason) start(f);
          }}
          className={`rounded-md border border-dashed p-3 text-center ${dragging ? 'border-info-fg bg-info-bg' : 'border-line-strong bg-surface-2'}`}
        >
          <Icon name="upload" size={20} className="mx-auto text-muted" />
          <p className="mt-1 text-[13px] font-medium">Kéo video vào đây hoặc</p>
          <div className="mt-1.5">
            <Button variant="primary" icon={<Icon name="upload" size={14} />} disabledReason={reason} onClick={() => input.current?.click()}>
              Chọn video để xoá logo
            </Button>
          </div>
          {reason && !up && <p className="mt-1.5 text-xs text-warn-fg">{reason}</p>}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov"
        hidden
        aria-label="Chọn video cần xoá logo Veo"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) start(f);
        }}
      />
      {up && (
        <div className="mt-3 space-y-1.5 rounded-md border border-line bg-surface-2 p-2.5" role="status">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-medium" title={up.name}>
              {up.name}
            </span>
            <span className="shrink-0 text-muted">{verifying ? 'Đang kiểm tra video…' : `${Math.round(pct)}% · ${fmtMB(up.loaded)}/${fmtMB(up.total)}`}</span>
          </div>
          <ProgressBar value={verifying ? null : pct} label="Tiến độ tải video lên" />
          <Button size="sm" onClick={() => abortRef.current?.()}>
            Hủy tải lên
          </Button>
        </div>
      )}
      {problem && (
        <div className="mt-3">
          <InlineError>{problem}</InlineError>
        </div>
      )}
    </section>
  );
}

/** Công cụ độc lập "Xoá logo Veo": tải một video lên, xếp hàng chung với bản dựng (chạy song song tối đa `RENDER_CONCURRENCY` việc), tải bản sạch về. Chỉ thấy việc của trình duyệt này. */
export function ToolPage() {
  useDocumentTitle('Xoá logo Veo');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['tool-status'], queryFn: planner.toolStatus, refetchInterval: 10_000 });
  const jobs = useQuery({
    queryKey: ['tool-jobs'],
    queryFn: planner.toolJobs,
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'queued' || j.status === 'processing') ? 3000 : 15_000),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tool-jobs'] });
    void qc.invalidateQueries({ queryKey: ['tool-status'] });
  };

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">Xoá logo Veo</h1>
        <p className="text-[13px] text-muted">Xoá logo Veo khỏi bất kỳ video nào, không cần kế hoạch. Việc xếp hàng chung với bản dựng hoàn chỉnh; máy chủ chạy song song một vài việc cùng lúc, còn lại chờ tới lượt. File giữ 7 ngày rồi tự xoá.</p>
      </div>

      {status.isLoading ? (
        <Skeleton className="h-40" />
      ) : status.error || !status.data ? (
        <ErrorState title="Không đọc được trạng thái công cụ" error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className="space-y-4">
          {!status.data.remove_logo.available && (
            <Alert tone="warn" icon="alert">
              <strong>Công cụ xoá logo Veo đang tắt hoặc lỗi.</strong> {status.data.remove_logo.reason ?? ''} Nút tải lên bị khóa tới khi chủ máy bật lại.
            </Alert>
          )}
          <UploadCard status={status.data} onCreated={refresh} />
          <p className="text-xs text-muted" aria-live="polite">
            {status.data.render ? `Máy chủ đang chạy ${status.data.render.running_count}/${status.data.render.concurrency} việc, ${status.data.render.waiting_count} việc đang chờ. ` : ''}
            Hàng đợi LAN: {status.data.queue.total}/{status.data.queue.cap} việc ({status.data.queue.cuts} bản dựng, {status.data.queue.tools} xoá logo). Chỉ trình duyệt này thấy các việc bên dưới; xoá cookie hoặc đổi trình duyệt sẽ không xem lại được.
          </p>

          <section aria-labelledby="tool-jobs-h">
            <h2 id="tool-jobs-h" className="mb-2 text-[15px] font-semibold">
              Việc của bạn
            </h2>
            {jobs.isLoading ? (
              <div aria-busy="true" className="space-y-3">
                <Skeleton className="h-32" />
              </div>
            ) : jobs.error ? (
              <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
            ) : jobs.data && jobs.data.length === 0 ? (
              <EmptyState icon="film" title="Chưa có việc nào">
                Tải một video lên ở trên. Khi xong, bản sạch hiện ở đây để xem và tải về.
              </EmptyState>
            ) : (
              <ul className="space-y-3">
                {jobs.data?.map((j) => (
                  <JobCard key={j.id} job={j} onChanged={refresh} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
