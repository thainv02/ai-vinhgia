import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Job, ReconcileOutcome } from '../api/types';
import { useReconcileJob } from '../hooks/mutations';
import { JOB_TYPE_LABEL } from '../lib/status';
import { Button } from './Button';
import { Modal } from './Modal';

/** Trạng thái action ngoài → mô tả cho người dùng. */
const ACTION_TEXT: Record<string, string> = {
  intent: 'worker đã ghi ý định bấm tạo nhưng chưa biết nút có được bấm hay không',
  uncertain: 'worker đã bấm tạo nhưng mất phản hồi, chưa biết lượt có được nhận hay không',
  submitted: 'worker đã bấm tạo thành công, nhưng chưa tải được kết quả',
  downloaded: 'worker đã tải kết quả nhưng chưa hoàn tất job',
};

export const needsReconcile = (job: Job | null | undefined): boolean => !!job?.reconcile_required;

/** Job queued không có worker giữ nhưng còn action sống (vd sau retry_download, chờ worker): vẫn đối soát được, không hủy được. */
export const canReconcile = (job: Job | null | undefined): boolean =>
  !!job && job.worker_mode === 'managed' && job.status === 'queued' && ['intent', 'uncertain', 'submitted', 'downloaded'].includes(job.action_state ?? '');

/** Hàng đợi/cảnh đã gửi lệnh tạo sang Flow/ChatGPT mà worker không còn giữ: hủy sẽ làm mất ghi sổ credit/lượt. */
export const cancelBlockedReason = (job: Job | null | undefined): string | null =>
  job && job.worker_mode === 'managed' && ['intent', 'uncertain', 'submitted', 'downloaded'].includes(job.action_state ?? '') && !job.reconcile_required
    ? 'Worker đã gửi lệnh tạo sang Flow/ChatGPT. Không hủy được (sẽ mất ghi sổ credit/lượt); đợi worker xong hoặc dừng để đối soát.'
    : null;

/**
 * Hộp thoại đối soát job `needs_reconciliation`. Không có lựa chọn mặc định: người dùng phải tự chọn sau khi kiểm tra
 * Flow/ChatGPT. Mỗi lựa chọn giải thích hệ quả; lựa chọn "chạy lại từ đầu" ghi rõ có thể tốn thêm credit.
 */
export function ReconcileDialog({ job, open, onClose }: { job: Job | null; open: boolean; onClose: () => void }) {
  const [outcome, setOutcome] = useState<ReconcileOutcome | null>(null);
  const [note, setNote] = useState('');
  const reconcile = useReconcileJob();
  useEffect(() => { if (open) { setOutcome(null); setNote(''); reconcile.reset(); } }, [open, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!job) return null;
  const isVideo = job.type === 'video';
  const credits = typeof job.payload?.credits_expected === 'number' ? job.payload.credits_expected : null;
  const site = isVideo ? 'Google Flow' : 'ChatGPT';
  const options: { value: ReconcileOutcome; title: string; body: string }[] = [
    {
      value: 'retry_download',
      title: `${isVideo ? 'Video' : 'Ảnh'} đã được tạo: tìm và tải lại`,
      body: `Chọn khi bạn thấy kết quả trên ${site}. Worker sẽ chạy tiếp, tìm kết quả đó và tải về. Worker KHÔNG bấm tạo lại.`,
    },
    {
      value: 'nothing_created',
      title: 'Không có gì được tạo: chạy lại từ đầu',
      body: `Chỉ chọn khi bạn đã kiểm tra ${site} và chắc chắn không có lượt tạo nào. Job chạy lại từ đầu với lệnh tạo mới${isVideo && credits !== null ? ` và có thể tốn thêm ${credits} credit` : ''}. Nếu thực ra đã có lượt tạo, bạn sẽ tốn credit hai lần.`,
    },
    ...(isVideo
      ? [{
          value: 'charge_and_fail' as const,
          title: 'Đã tốn credit nhưng không lấy được kết quả',
          body: `Ghi nhận ${credits ?? 'số'} credit đã dùng và một lượt tạo video cho cảnh; job báo lỗi và cảnh về trạng thái Lỗi. Chọn khi ${site} đã trừ credit mà không có video dùng được.`,
        }]
      : []),
  ];
  const submit = () => outcome && reconcile.mutate({ jobId: job.id, outcome, note: note.trim() || undefined }, { onSuccess: onClose });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Đối soát job #${job.id}: ${JOB_TYPE_LABEL[job.type].toLowerCase()}${job.scene_code ? ` ${job.scene_code}` : ''}`}
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={reconcile.isPending}>Đóng</Button>
          <Button variant="primary" loading={reconcile.isPending} disabledReason={outcome ? null : 'Chọn một kết quả bên dưới'} onClick={submit}>
            Xác nhận đối soát
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          Job này đã gửi lệnh tạo sang {site}: {ACTION_TEXT[job.action_state ?? ''] ?? 'chưa rõ kết quả'}. Hệ thống không tự bấm tạo lại để tránh tốn credit hai lần.
        </p>
        <p className="text-[13px] text-muted">
          Mở {site} bằng cửa sổ trình duyệt media (<code>npm run ai:browser</code>), kiểm tra {isVideo ? 'dự án/lịch sử tạo video' : 'hội thoại'} của cảnh này, rồi chọn kết quả đúng với những gì bạn thấy.
        </p>
        <fieldset className="space-y-2" disabled={reconcile.isPending}>
          <legend className="sr-only">Kết quả đối soát</legend>
          {options.map((o) => (
            <label key={o.value} className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${outcome === o.value ? 'border-ink bg-surface-2' : 'border-line'}`}>
              <input type="radio" name="reconcile" className="mt-1 size-4 shrink-0" checked={outcome === o.value} onChange={() => setOutcome(o.value)} />
              <span>
                <strong className="block">{o.title}</strong>
                <span className="mt-0.5 block text-[13px] text-muted">{o.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block text-[13px]">
          <span className="mb-1 block text-muted">Ghi chú (tùy chọn, lưu vào nhật ký)</span>
          <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} className="w-full" />
        </label>
        {reconcile.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-danger-fg">{errorMessage(reconcile.error)}</p>
        )}
      </div>
    </Modal>
  );
}
