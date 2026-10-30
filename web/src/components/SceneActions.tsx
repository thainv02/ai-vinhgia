import { useState } from 'react';
import { errorMessage, type ApiError } from '../api/client';
import type { JobType, Scene } from '../api/types';
import { useApproveScene, useCancelJob, useResetScene, useSelectVideo } from '../hooks/mutations';
import { JOB_TYPE_LABEL } from '../lib/status';
import { Button, type ButtonVariant } from './Button';
import { ConfirmDialog } from './Modal';
import { Icon } from './Icon';
import { ReconcileDialog, canReconcile, cancelBlockedReason } from './ReconcileDialog';

interface ActionSpec {
  key: string;
  label: string;
  variant: ButtonVariant;
  credit?: number;
  reason?: string | null;
  loading?: boolean;
  onClick: () => void;
  /** Chỉ hiện ở trang chi tiết. */
  detailOnly?: boolean;
}

interface Props {
  scene: Scene;
  creditPerVideo: number;
  variant: 'card' | 'detail';
  /** Loại job gần nhất của cảnh (chỉ trang chi tiết có) để "Thử lại" đúng bước. */
  lastJobType?: JobType;
  /** Video đang xem ở trang chi tiết: dùng cho "Chọn video này". */
  viewingVideoId?: number;
}

/** Nút theo trạng thái của một cảnh. Mọi nút tốn credit ghi rõ số credit và qua hộp xác nhận. */
export function SceneActions({ scene, creditPerVideo, variant, lastJobType, viewingVideoId }: Props) {
  const [confirm, setConfirm] = useState<'video' | 'cancel' | 'reconcile' | null>(null);
  const approveStoryboard = useApproveScene();
  const approveVideo = useApproveScene({ silent: true });
  const cancel = useCancelJob({ silent: true });
  const reset = useResetScene();
  const select = useSelectVideo();

  const sb = scene.storyboard_block;
  const vb = scene.video_block;
  const hasStoryboard = !!scene.storyboard;
  const sceneId = scene.id;

  const storyboardAction = (label: string, variantName: ButtonVariant, detailOnly?: boolean): ActionSpec => ({
    key: 'storyboard',
    label,
    variant: variantName,
    reason: sb?.message ?? null,
    loading: approveStoryboard.isPending,
    detailOnly,
    onClick: () => approveStoryboard.mutate({ sceneId, stage: 'storyboard' }),
  });
  const videoAction = (label: string, variantName: ButtonVariant): ActionSpec => ({
    key: 'video',
    label,
    variant: variantName,
    credit: creditPerVideo,
    reason: vb?.message ?? null,
    onClick: () => {
      approveVideo.reset();
      setConfirm('video');
    },
  });

  const actions: ActionSpec[] = [];
  switch (scene.status) {
    case 'awaiting_approval':
      if (hasStoryboard) {
        actions.push(videoAction('Tạo video', 'primary'), storyboardAction('Tạo lại storyboard', 'secondary'));
      } else {
        actions.push(storyboardAction('Duyệt prompt & tạo storyboard', 'primary'));
      }
      break;
    case 'storyboard_review':
      actions.push(videoAction('Tạo video', 'primary'), storyboardAction('Tạo lại storyboard', 'secondary'));
      break;
    case 'video_review': {
      const videoId = viewingVideoId ?? scene.video?.id;
      actions.push({
        key: 'select',
        label: 'Chọn video này',
        variant: 'primary',
        reason: scene.video ? null : 'Cảnh chưa có video để chọn',
        loading: select.isPending,
        onClick: () => select.mutate({ sceneId, assetId: videoId }),
      });
      actions.push(videoAction('Tạo lại', 'secondary'), storyboardAction('Tạo lại storyboard', 'ghost', true));
      break;
    }
    case 'done':
      actions.push(videoAction('Tạo lại', 'secondary'), storyboardAction('Tạo storyboard', 'ghost', true));
      break;
    case 'failed':
    case 'blocked_budget': {
      actions.push({
        key: 'reset',
        label: 'Về chờ duyệt',
        variant: 'secondary',
        loading: reset.isPending,
        onClick: () => reset.mutate(sceneId),
      });
      if (variant === 'detail') {
        if (lastJobType === 'video' && hasStoryboard) actions.unshift(videoAction('Thử lại tạo video', 'primary'));
        else if (lastJobType === 'storyboard') actions.unshift(storyboardAction('Thử lại storyboard', 'primary'));
      }
      break;
    }
    case 'storyboard_queued':
    case 'storyboard_running':
    case 'video_queued':
    case 'video_running':
    case 'needs_revision':
      if (scene.active_job?.reconcile_required) {
        // Job đã gửi lệnh tạo sang Flow/ChatGPT nhưng chưa rõ kết quả: hủy bị chặn, phải đối soát để credit/lượt ghi đúng.
        actions.push({ key: 'reconcile', label: 'Đối soát', variant: 'primary', onClick: () => setConfirm('reconcile') });
      } else if (scene.active_job) {
        actions.push({ key: 'cancel', label: 'Hủy job', variant: 'danger', reason: cancelBlockedReason(scene.active_job), onClick: () => setConfirm('cancel') });
        if (canReconcile(scene.active_job)) actions.push({ key: 'reconcile', label: 'Đối soát', variant: 'secondary', onClick: () => setConfirm('reconcile') });
      }
      break;
    default:
      break;
  }

  const shown = variant === 'card' ? actions.filter((a) => !a.detailOnly).slice(0, 2) : actions;
  const job = scene.active_job;

  return (
    <>
      <div className={variant === 'card' ? 'flex flex-col gap-2' : 'flex flex-wrap items-start gap-x-3 gap-y-2'}>
        {shown.map((a) => (
          <div key={a.key} className={variant === 'card' ? 'w-full' : ''}>
            <Button
              variant={a.variant}
              credit={a.credit}
              loading={a.loading}
              disabledReason={a.reason}
              onClick={a.onClick}
              className={variant === 'card' ? 'w-full' : ''}
            >
              {a.label}
            </Button>
            {a.reason && (
              <p className="mt-1 flex items-start gap-1 text-xs text-warn-fg">
                <Icon name="alert" size={13} className="mt-px" />
                <span>{a.reason}</span>
              </p>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirm === 'video'}
        onClose={() => setConfirm(null)}
        title={`Tạo video cho ${scene.code}?`}
        confirmLabel="Xác nhận tạo video"
        credit={creditPerVideo}
        pending={approveVideo.isPending}
        error={approveVideo.isError ? errorMessage(approveVideo.error) : null}
        confirmDisabledReason={vb?.message ?? null}
        onConfirm={() =>
          approveVideo.mutate(
            { sceneId, stage: 'video' },
            { onSuccess: () => setConfirm(null) },
          )
        }
      >
        <VideoCostSummary scene={scene} creditPerVideo={creditPerVideo} />
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        title={job ? `Hủy job ${JOB_TYPE_LABEL[job.type].toLowerCase()} của ${scene.code}?` : 'Hủy job?'}
        confirmLabel="Hủy job"
        cancelLabel="Giữ lại"
        danger
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() =>
          job &&
          cancel.mutate(job.id, {
            onSuccess: () => setConfirm(null),
            onError: (e) => { if ((e as ApiError).code === 'RECONCILIATION_REQUIRED') setConfirm('reconcile'); },
          })
        }
      >
        {job?.status === 'queued' ? (
          <p>
            Job chưa được worker nhận.{' '}
            {job.type === 'video' ? `Phần credit đã đặt trước (${creditPerVideo}) sẽ được trả lại.` : 'Không mất credit.'} Cảnh quay về trạng thái ổn định trước đó.
          </p>
        ) : (
          <p>
            Worker đang xử lý job này và sẽ dừng ở lần báo tiếp theo.
            {job?.type === 'video' ? ' Nếu Flow đã bắt đầu tạo video thì credit có thể đã bị tính.' : ''}
          </p>
        )}
      </ConfirmDialog>

      <ReconcileDialog job={job ?? null} open={confirm === 'reconcile'} onClose={() => setConfirm(null)} />
    </>
  );
}

/** Nội dung xác nhận chi phí cho mọi thao tác tạo video: số credit sắp tiêu và lượt dùng. */
export function VideoCostSummary({ scene, creditPerVideo }: { scene: Scene; creditPerVideo: number }) {
  return (
    <>
      <p>
        Tạo 1 video 9:16 cho <strong>{scene.code}: {scene.title}</strong>. Việc này tiêu <strong className="text-spend">{creditPerVideo} credit</strong> thật trên Google Flow.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
        <dt className="text-muted">Lượt video của cảnh</dt>
        <dd>
          {scene.attempts_used}/{scene.max_attempts} → <strong>{scene.attempts_used + 1}/{scene.max_attempts}</strong>
        </dd>
      </dl>
      <p className="text-[13px] text-muted">
        Credit được đặt trước ngay khi bạn xác nhận. Nếu hủy job trước khi worker chạy, phần đặt trước được trả lại. Các video cũ vẫn được giữ.
      </p>
    </>
  );
}
