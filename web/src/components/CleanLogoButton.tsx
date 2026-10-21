import type { FinalCut, LatestFinalCut } from '../api/types';
import { useCleanFinalCut } from '../hooks/mutations';
import { useMeta } from '../hooks/queries';
import { cleanAction } from '../lib/finalCut';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';

/**
 * "Xoá logo Veo" (bản sẵn sàng còn logo) / "Thử xoá logo lại" (lỗi ở bước xoá logo). Chỉ chạy lại bước xoá logo,
 * không render lại, không tốn credit. Không hiện gì nếu bản dựng không cần.
 */
export function CleanLogoButton({ fc, size = 'md' }: { fc: Pick<FinalCut | LatestFinalCut, 'id' | 'version' | 'status' | 'failed_stage' | 'watermark_removed'>; size?: 'sm' | 'md' }) {
  const clean = useCleanFinalCut();
  const meta = useMeta();
  const action = cleanAction(fc);
  if (!action) return null;
  const remover = meta.data?.watermark_remover;
  const reason = remover && !remover.active ? `Tool xoá logo Veo đang tắt: ${remover.reason}` : null;
  return (
    <Button
      size={size}
      variant={action === 'retry' ? 'primary' : 'secondary'}
      icon={<Icon name="refresh" size={14} />}
      loading={clean.isPending}
      disabledReason={reason}
      onClick={() => clean.mutate(fc.id, { onSuccess: () => toast.success(`Đang xoá logo Veo cho v${fc.version}`) })}
    >
      {action === 'retry' ? 'Thử xoá logo lại' : 'Xoá logo Veo'}
    </Button>
  );
}
