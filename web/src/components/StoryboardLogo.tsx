import { errorMessage } from '../api/client';
import type { Asset, LogoInfo } from '../api/types';
import { useRemoveLogo } from '../hooks/mutations';
import { toast } from '../lib/toast';
import { Icon } from './Icon';

/** `meta.logo` của ảnh storyboard (chỉ ảnh Google Flow có); null với ảnh Muse/cũ. */
export function logoOf(asset: Pick<Asset, 'meta'> | null | undefined): LogoInfo | null {
  const l = asset?.meta?.logo as LogoInfo | undefined;
  return l && typeof l === 'object' && typeof l.status === 'string' ? l : null;
}

/** true: ảnh storyboard Google Flow chưa được xoá logo (tool lỗi hoặc chưa cấu hình). */
export const logoPending = (asset: Pick<Asset, 'meta'> | null | undefined): boolean => {
  const s = logoOf(asset)?.status;
  return s === 'failed' || s === 'skipped';
};

const LABEL: Record<LogoInfo['status'], string> = {
  removed: 'Đã xoá logo',
  none: 'Không có logo',
  failed: 'Còn logo',
  skipped: 'Còn logo',
};

/** Trạng thái xoá logo dưới ảnh storyboard Google Flow, kèm nút «Xoá logo lại» khi chưa xoá được. */
export function StoryboardLogoBadge({ asset }: { asset: Asset }) {
  const logo = logoOf(asset);
  const retry = useRemoveLogo();
  if (!logo) return null;
  const pending = logo.status === 'failed' || logo.status === 'skipped';
  return (
    <span className="mt-0.5 block text-center text-[11px]">
      <span className={`inline-flex items-center gap-0.5 ${pending ? 'text-warn-fg' : 'text-muted'}`} title={logo.detail}>
        <Icon name={pending ? 'alert' : 'check'} size={11} />
        {LABEL[logo.status]}
      </span>
      {pending && (
        <button
          type="button"
          disabled={retry.isPending}
          onClick={() =>
            retry.mutate(asset.id, {
              onSuccess: ({ asset: a }) => {
                const l = logoOf(a);
                if (l?.status === 'removed' || l?.status === 'none') toast.success(l.detail);
                else toast.error(l?.detail ?? 'Chưa xoá được logo');
              },
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
          className="mt-0.5 block w-full rounded border border-line-strong px-1 py-0.5 text-[11px] font-semibold hover:bg-surface-2 disabled:opacity-60"
        >
          {retry.isPending ? 'Đang xoá…' : 'Xoá logo lại'}
        </button>
      )}
    </span>
  );
}
