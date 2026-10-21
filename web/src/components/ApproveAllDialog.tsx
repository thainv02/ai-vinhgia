import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Stage } from '../api/types';
import { useApproveAll } from '../hooks/mutations';
import { useApprovePreview } from '../hooks/queries';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Modal } from './Modal';
import { InlineError, LoadingBlock } from './States';

interface Props {
  projectId: number;
  open: boolean;
  onClose: () => void;
}

const STAGE_LABEL: Record<Stage, string> = {
  storyboard: 'Duyệt prompt & tạo storyboard',
  video: 'Tạo video',
};

/** Duyệt hàng loạt: ghi rõ tổng credit, gửi kèm expectedCredits để server từ chối nếu số liệu đã đổi. */
export function ApproveAllDialog({ projectId, open, onClose }: Props) {
  const sb = useApprovePreview(projectId, 'storyboard', open);
  const vd = useApprovePreview(projectId, 'video', open);
  const approve = useApproveAll();
  const [stage, setStage] = useState<Stage | null>(null);

  // Mỗi lần mở: chọn bước đầu tiên đang có cảnh chờ duyệt.
  useEffect(() => {
    if (!open) {
      setStage(null);
      approve.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const effectiveStage: Stage = stage ?? ((sb.data?.count ?? 0) > 0 ? 'storyboard' : (vd.data?.count ?? 0) > 0 ? 'video' : 'storyboard');
  const preview = effectiveStage === 'storyboard' ? sb : vd;
  const data = preview.data;

  const reason = !data ? 'Đang tải danh sách cảnh' : data.count === 0 ? 'Không có cảnh nào đủ điều kiện ở bước này' : null;

  const chooseStage = (s: Stage) => {
    setStage(s);
    approve.reset();
  };

  const confirm = () => {
    if (!data || reason) return;
    approve.mutate(
      { projectId, stage: effectiveStage, expectedCredits: data.total_credits },
      {
        onSuccess: (r) => {
          toast.success(`Đã duyệt ${r.count} cảnh${r.total_credits > 0 ? `, đặt trước ${r.total_credits} credit` : ''}`);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Duyệt tất cả cảnh đang chờ"
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={approve.isPending}>
            Hủy
          </Button>
          <Button
            variant="primary"
            loading={approve.isPending}
            disabledReason={reason}
            credit={data && data.total_credits > 0 ? data.total_credits : undefined}
            onClick={confirm}
          >
            {data ? `Duyệt ${data.count} cảnh` : 'Duyệt'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div role="tablist" aria-label="Bước cần duyệt" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-3 p-1">
          {(['storyboard', 'video'] as const).map((s) => {
            const q = s === 'storyboard' ? sb : vd;
            const active = effectiveStage === s;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => chooseStage(s)}
                className={`rounded-md px-2 py-2 text-[13px] font-medium ${active ? 'bg-surface shadow-sm' : 'text-muted hover:text-fg'}`}
              >
                {STAGE_LABEL[s]}
                <span className="block text-xs font-normal text-muted">
                  {q.data ? `${q.data.count} cảnh${s === 'video' && q.data.count > 0 ? `, ${q.data.total_credits} credit` : s === 'storyboard' ? ', miễn phí' : ''}` : '...'}
                </span>
              </button>
            );
          })}
        </div>

        {preview.isLoading ? (
          <LoadingBlock />
        ) : preview.error ? (
          <InlineError>{errorMessage(preview.error)}</InlineError>
        ) : data ? (
          <>
            {data.count === 0 ? (
              <p className="rounded-md bg-surface-2 px-3 py-4 text-center text-muted">
                {effectiveStage === 'storyboard' ? 'Không có cảnh nào đang chờ duyệt prompt.' : 'Không có cảnh nào đang ở bước xem storyboard để tạo video.'}
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {data.scenes.map((s) => (
                  <li key={s.scene_id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <strong>{s.code}</strong> <span className="text-muted">{s.title}</span>
                    </span>
                    <span className="shrink-0 text-[13px] font-semibold">{s.credits > 0 ? <span className="text-spend">{s.credits} credit</span> : <span className="text-muted">miễn phí</span>}</span>
                  </li>
                ))}
              </ul>
            )}

            {data.skipped.length > 0 && (
              <div className="rounded-md bg-warn-bg px-3 py-2 text-[13px] text-warn-fg">
                <p className="font-semibold">Bỏ qua {data.skipped.length} cảnh:</p>
                <ul className="mt-1 list-inside list-disc">
                  {data.skipped.map((s) => (
                    <li key={s.scene_id}>{s.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {data.count > 0 && (
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md bg-surface-2 px-3 py-2.5">
                <dt className="font-semibold">Tổng credit sắp tốn</dt>
                <dd className="text-right text-base font-bold text-spend">{data.total_credits} credit</dd>
                <dt className="text-muted">Số video sẽ tạo</dt>
                <dd className="text-right">{effectiveStage === 'video' ? data.count : 0}</dd>
              </dl>
            )}
            {effectiveStage === 'video' && data.count > 0 && (
              <p className="text-[13px] text-muted">
                Tất cả hoặc không cảnh nào: nếu số credit thay đổi trong lúc bạn xem hộp này, việc duyệt bị từ chối để bạn kiểm tra lại.
              </p>
            )}
          </>
        ) : null}

        {approve.isError && <InlineError>{errorMessage(approve.error)}</InlineError>}
      </div>
    </Modal>
  );
}
