import { useState } from 'react';
import { errorMessage } from '../api/client';
import type { TrashItem } from '../api/types';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { usePurgeProject, useRestoreProject } from '../hooks/mutations';
import { useTrash } from '../hooks/queries';
import { fmtDateTimeYear } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const fmtSize = (n: number | null): string => {
  if (n === null) return 'không còn file';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
};

function PurgeDialog({ item, onClose }: { item: TrashItem; onClose: () => void }) {
  const purge = usePurgeProject();
  const [typed, setTyped] = useState('');
  const match = typed.trim().normalize('NFC') === item.name.trim().normalize('NFC');
  return (
    <Modal
      open
      onClose={onClose}
      title="Xoá vĩnh viễn?"
      footer={
        <>
          <Button onClick={onClose} disabled={purge.isPending}>
            Giữ lại
          </Button>
          <Button
            variant="danger"
            icon={<Icon name="trash" />}
            loading={purge.isPending}
            disabledReason={match ? null : 'Gõ đúng tên dự án để bật nút'}
            onClick={() =>
              purge.mutate(
                { projectId: item.id, confirmName: typed },
                {
                  onSuccess: () => {
                    toast.success(`Đã xoá vĩnh viễn "${item.name}"`);
                    onClose();
                  },
                },
              )
            }
          >
            Xoá vĩnh viễn
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          Xoá hẳn <strong>{item.name}</strong>: toàn bộ video, ảnh, bản hoàn chỉnh, nhật ký và sổ credit ({item.credits_used} credit đã dùng) của dự án mất vĩnh viễn, <strong>không khôi phục được</strong>.
        </p>
        <div>
          <label htmlFor="purge-name" className="mb-1 block text-[13px] font-semibold">
            Gõ đúng tên dự án để xác nhận
          </label>
          <input id="purge-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={item.name} />
        </div>
        {purge.isError && <InlineError>{errorMessage(purge.error)}</InlineError>}
      </div>
    </Modal>
  );
}

function TrashRow({ item, onPurge }: { item: TrashItem; onPurge: () => void }) {
  const restore = useRestoreProject();
  return (
    <li className="rounded-lg border border-line bg-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="break-words text-[15px] font-semibold leading-snug">{item.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={item.deleted_by === 'lan' ? 'info' : 'neutral'}>{item.deleted_by === 'lan' ? 'Xoá từ trang LAN' : 'Xoá ở app chính'}</Badge>
            {item.source === 'lan' && <Badge tone="neutral">Kế hoạch LAN{item.created_by_name ? ` · ${item.created_by_name}` : ''}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<Icon name="refresh" />}
            loading={restore.isPending}
            disabledReason={item.restore_block}
            onClick={() =>
              restore.mutate(item.id, {
                onSuccess: () => toast.success(`Đã khôi phục "${item.name}"`),
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            Khôi phục
          </Button>
          <Button variant="danger" size="sm" icon={<Icon name="trash" />} onClick={onPurge}>
            Xoá vĩnh viễn
          </Button>
        </div>
      </div>
      {item.restore_block && <p className="mt-2 text-xs text-warn-fg">{item.restore_block}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">Ngày xoá</dt>
          <dd className="text-sm font-semibold">{fmtDateTimeYear(item.deleted_at)}</dd>
        </div>
        <div>
          <dt className="text-muted">Còn lại</dt>
          <dd className={`text-sm font-semibold ${item.days_left <= 3 ? 'text-danger-fg' : ''}`}>
            {item.days_left} ngày
            <span className="block text-[11px] font-normal text-muted">tự xoá vĩnh viễn {fmtDateTimeYear(item.purge_at).slice(0, 10)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Dung lượng</dt>
          <dd className="text-sm font-semibold">{fmtSize(item.size_bytes)}</dd>
        </div>
        <div>
          <dt className="text-muted">Nội dung</dt>
          <dd className="text-sm font-semibold">
            {item.done_count}/{item.scene_count} cảnh xong · {item.credits_used} credit
          </dd>
        </div>
      </dl>
    </li>
  );
}

export default function TrashPage() {
  useDocumentTitle('Thùng rác');
  const { data, isLoading, error, refetch } = useTrash();
  const [purging, setPurging] = useState<TrashItem | null>(null);
  const retention = data?.[0]?.retention_days ?? 30;

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">Thùng rác</h1>
        <p className="text-[13px] text-muted">Dự án đã xoá nằm ở đây {retention} ngày rồi tự xoá vĩnh viễn. Khôi phục sẽ đưa file về đúng chỗ cũ, không ghi đè thư mục nào.</p>
      </div>
      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data && data.length === 0 ? (
        <EmptyState icon="trash" title="Thùng rác trống">
          Dự án bạn xoá (ở app chính hoặc người tạo xoá từ trang LAN) sẽ nằm ở đây để khôi phục.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {data?.map((t) => (
            <TrashRow key={t.id} item={t} onPurge={() => setPurging(t)} />
          ))}
        </ul>
      )}
      {purging && <PurgeDialog key={purging.id} item={purging} onClose={() => setPurging(null)} />}
    </div>
  );
}
