import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Scene } from '../api/types';
import { useCreateFinalCut } from '../hooks/mutations';
import { useFinalCuts } from '../hooks/queries';
import { cleanAction, finalBlockReason, finalStatusLabel, fmtSeconds } from '../lib/finalCut';
import { FINAL_STATUS, TONE_CLASS } from '../lib/status';
import { toast } from '../lib/toast';
import { Button, LinkButton } from './Button';
import { CleanLogoButton } from './CleanLogoButton';
import { Icon } from './Icon';

/** Khối "Bản hoàn chỉnh" trên bảng cảnh: trạng thái dựng cuối, xem bản dựng, dựng bản mới. */
export function FinalCutBlock({ projectId, scenes, serverBlock }: { projectId: number; scenes: Scene[] | undefined; serverBlock?: { message: string } | null }) {
  const q = useFinalCuts(projectId);
  const create = useCreateFinalCut();
  const latest = q.data?.[0];
  const reason = useMemo(() => finalBlockReason(scenes, latest, serverBlock), [scenes, latest, serverBlock]);
  const info = latest ? FINAL_STATUS[latest.status] : null;

  let status: React.ReactNode;
  if (q.isLoading) status = <span className="text-muted">Đang tải...</span>;
  else if (q.error) status = <span className="text-danger-fg">Không tải được bản dựng</span>;
  else if (!latest) status = <span className="text-muted">Chưa có bản hoàn chỉnh.{reason ? '' : ' Hệ thống tự gửi AI chọn điểm cắt khi mọi cảnh đã chọn video.'}</span>;
  else if (latest.status === 'planning') status = <>AI đang chọn điểm cắt cho v{latest.version}</>;
  else if (latest.status === 'rendering')
    status = (
      <>
        {latest.stage === 'clean' ? 'Đang xoá logo Veo' : 'Đang render'} v{latest.version}
        {latest.progress !== null ? ` ${Math.round(latest.progress)}%` : ''}
      </>
    );
  else if (latest.status === 'ready') status = <>v{latest.version} sẵn sàng · {fmtSeconds(latest.duration_s)}{latest.watermark_removed ? ' · đã xoá logo Veo' : ''}</>;
  else if (latest.status === 'failed')
    status = latest.failed_stage === 'clean' ? <>v{latest.version}: {latest.error ?? 'xoá logo Veo không thành công'}. Bản render vẫn còn, bấm «Thử xoá logo lại».</> : <>v{latest.version} lỗi: {latest.error ?? 'không rõ lý do'}</>;
  else status = <>v{latest.version} đã hủy{latest.failed_stage === 'clean' ? ' giữa bước xoá logo Veo' : ''}</>;

  return (
    <div className="min-w-0 flex-1 basis-80 rounded-lg border border-line bg-surface-2 px-3 py-2.5" aria-label="Bản hoàn chỉnh">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="film" size={15} className="text-muted" />
        <h2 className="text-[13px] font-semibold">Bản hoàn chỉnh</h2>
        {latest && info && (
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[info.tone]}`}>
            {info.live && <span aria-hidden="true" className="pulse-dot size-1.5 rounded-full bg-current" />}
            {finalStatusLabel(latest)}
          </span>
        )}
        {latest && cleanAction(latest) === 'clean' && (
          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${TONE_CLASS.warn}`} title="Bản này render trước khi có bước xoá logo, hoặc tool xoá logo đang tắt">
            Còn logo Veo
          </span>
        )}
        {latest?.outdated && (
          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${TONE_CLASS.warn}`} title="Bạn đã đổi video được chọn của một cảnh sau khi dựng bản này">
            Đã cũ vì đổi video
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px]">{status}</p>
      {latest?.status === 'rendering' && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(latest.progress ?? 0)} aria-valuemin={0} aria-valuemax={100} aria-label={latest.stage === 'clean' ? 'Tiến độ xoá logo Veo' : 'Tiến độ render'}>
          <div className="h-full bg-info-fg transition-[width] duration-500" style={{ width: `${Math.max(3, latest.progress ?? 0)}%` }} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {latest && (
          <LinkButton to={`/projects/${projectId}/final`} size="sm" variant={latest.status === 'ready' && !latest.outdated && latest.watermark_removed ? 'primary' : 'secondary'}>
            Xem bản hoàn chỉnh
          </LinkButton>
        )}
        {latest && <CleanLogoButton fc={latest} size="sm" />}
        <Button
          size="sm"
          variant={latest?.outdated ? 'primary' : 'secondary'}
          loading={create.isPending}
          disabledReason={reason}
          onClick={() => create.mutate(projectId, { onSuccess: (fc) => toast.success(`Đã tạo bản dựng v${fc.version}, AI sẽ chọn điểm cắt`) })}
        >
          Dựng bản mới
        </Button>
      </div>
      {reason && (
        <p className="mt-1 flex items-start gap-1 text-xs text-warn-fg">
          <Icon name="alert" size={13} className="mt-px" />
          <span>{reason}</span>
        </p>
      )}
      {!latest && !reason && !q.isLoading && (
        <p className="mt-1 text-xs text-muted">
          Hoặc bấm «Dựng bản mới» để làm ngay. Xem thêm ở <Link to={`/projects/${projectId}/final`} className="underline">trang bản hoàn chỉnh</Link>.
        </p>
      )}
    </div>
  );
}
