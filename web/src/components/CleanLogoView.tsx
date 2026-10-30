import type { FinalCut, LatestFinalCut } from '../api/types';
import { cleanAction } from '../lib/finalCut';
import { Button } from './Button';
import { Icon } from './Icon';

export type CleanCut = Pick<FinalCut | LatestFinalCut, 'id' | 'version' | 'status' | 'failed_stage' | 'watermark_removed'>;

/**
 * Nút "Xoá logo Veo" / "Thử xoá logo lại" thuần giao diện: nơi dùng truyền hàm gọi API (app chính hoặc trang planner LAN) và lý do khóa
 * (tool xoá logo tắt). Chỉ chạy lại bước xoá logo, không render lại, không tốn credit. Không hiện gì nếu bản dựng không cần.
 */
export function CleanLogoView({ fc, size = 'md', loading, disabledReason, onClick }: { fc: CleanCut; size?: 'sm' | 'md'; loading?: boolean; disabledReason?: string | null; onClick: () => void }) {
  const action = cleanAction(fc);
  if (!action) return null;
  return (
    <Button size={size} variant={action === 'retry' ? 'primary' : 'secondary'} icon={<Icon name="refresh" size={14} />} loading={loading} disabledReason={disabledReason} onClick={onClick}>
      {action === 'retry' ? 'Thử xoá logo lại' : 'Xoá logo Veo'}
    </Button>
  );
}
