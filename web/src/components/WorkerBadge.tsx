import { useWorkerStatus } from '../hooks/queries';
import { fmtDateTimeLong, fmtRelative } from '../lib/format';
import { useNow } from '../lib/useNow';

/** Chỉ báo worker (phiên worker AI) online/offline, kiểu đèn tally. */
export function WorkerBadge() {
  const { data, isError, isLoading } = useWorkerStatus();
  const now = useNow();
  const online = !!data?.online;
  const short = isLoading ? '...' : isError && !data ? 'Không rõ' : online ? 'Online' : 'Offline';
  const label = isLoading ? 'Worker...' : isError && !data ? 'Worker: không rõ' : online ? 'Worker online' : 'Worker offline';
  const detail = data
    ? online
      ? `Phiên worker AI đang kết nối${data.worker_id ? ` (${data.worker_id})` : ''}. Thấy lần cuối ${fmtRelative(data.last_seen_at, now)}.`
      : data.last_seen_at
        ? `Phiên worker AI không phản hồi từ ${fmtDateTimeLong(data.last_seen_at)}. Hàng đợi đứng yên cho tới khi mở lại phiên worker.`
        : 'Chưa có phiên worker AI nào kết nối. Hàng đợi đứng yên cho tới khi mở phiên worker.'
    : 'Chưa đọc được trạng thái worker';
  return (
    <span
      title={detail}
      className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-header-fg"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${online ? 'pulse-dot bg-[#4ade80] shadow-[0_0_6px_#4ade80]' : 'bg-[#f87171]'}`}
      />
      <span className="max-[420px]:hidden">{label}</span>
      <span className="min-[421px]:hidden">{short}</span>
    </span>
  );
}
