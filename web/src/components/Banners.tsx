import { Link, useLocation } from 'react-router-dom';
import { useJobs, useWorkerStatus } from '../hooks/queries';
import { useQueueControl } from '../hooks/mutations';
import { ACTIVE_JOB_STATUSES, JOB_TYPE_LABEL } from '../lib/status';
import { errorMessage } from '../api/client';
import { Alert } from './States';
import { Button } from './Button';

export const ACTIVE_JOBS_FILTER = { status: ACTIVE_JOB_STATUSES } as const;

const PAUSE_HINT: Record<string, string> = {
  CAPTCHA: 'Hãy giải CAPTCHA trong Chrome của worker, sau đó tiếp tục hàng đợi.',
  LOGIN_REQUIRED: 'Hãy đăng nhập lại ChatGPT / Google Flow trong Chrome của worker, sau đó tiếp tục hàng đợi.',
  FLOW_OUT_OF_CREDIT: 'Tài khoản Google Flow đã hết credit. Nạp thêm credit rồi mới tiếp tục hàng đợi.',
  UI_CHANGED: 'Giao diện dịch vụ đã đổi nên worker không thao tác được. Cần kiểm tra lại quy trình worker.',
};

/** Banner toàn cục: hàng đợi tạm dừng, job bị trả về do mất heartbeat, worker offline khi còn việc chờ. */
export function Banners() {
  const { data: worker } = useWorkerStatus();
  const { data: active } = useJobs(ACTIVE_JOBS_FILTER);
  const { resume } = useQueueControl();
  const onQueuePage = useLocation().pathname === '/queue';

  const requeued = (active ?? []).filter((j) => j.requeue_count > 0);
  const waiting = (active ?? []).filter((j) => j.status === 'queued' || j.status === 'claimed' || j.status === 'running');

  const showOffline = !!worker && !worker.online && !worker.queue_paused && waiting.length > 0;
  if (!worker?.queue_paused && requeued.length === 0 && !showOffline) return null;

  return (
    <div className="mb-4 space-y-2">
      {worker?.queue_paused && (
        <Alert
          tone="danger"
          actions={
            <Button size="sm" variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}>
              Tiếp tục hàng đợi
            </Button>
          }
        >
          <strong>Hàng đợi đang tạm dừng.</strong> {worker.pause_reason ?? 'Không rõ lý do.'}
          {worker.pause_code && PAUSE_HINT[worker.pause_code] ? <span className="block opacity-90">{PAUSE_HINT[worker.pause_code]}</span> : null}
          {worker.pause_code === 'MANUAL' && <span className="block opacity-90">Bạn đã tạm dừng hàng đợi. Worker sẽ không nhận thêm job cho tới khi tiếp tục.</span>}
          {resume.isError && <span className="mt-1 block font-semibold">{errorMessage(resume.error)}</span>}
        </Alert>
      )}
      {requeued.length > 0 && (
        <Alert
          tone="warn"
          icon="refresh"
          actions={
            onQueuePage ? undefined : (
              <Link to="/queue" className="rounded-md border border-current/40 px-2.5 py-1 font-medium hover:bg-white/30">
                Xem hàng đợi
              </Link>
            )
          }
        >
          <strong>{requeued.length} job bị trả về hàng đợi do mất heartbeat:</strong>{' '}
          {requeued.map((j) => `${j.scene_code ?? j.project_name ?? 'Dự án'} (${JOB_TYPE_LABEL[j.type]}, ${j.requeue_count} lần)`).join(', ')}.
          <span className="block opacity-90">Worker cần kiểm tra Flow/ChatGPT xem đã tạo chưa trước khi bấm tạo lại, tránh tốn credit hai lần.</span>
        </Alert>
      )}
      {showOffline && (
        <Alert tone="info" icon="clock">
          <strong>Worker đang offline.</strong> {waiting.length} job đang chờ sẽ chạy khi phiên Claude Code mở lại và nhận việc.
        </Alert>
      )}
    </div>
  );
}

