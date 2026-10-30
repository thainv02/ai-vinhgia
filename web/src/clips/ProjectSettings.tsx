import { useState } from 'react';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { InlineError } from '../components/States';
import { toast } from '../lib/toast';
import { useClipEnv } from './env';
import { useClipActions } from './hooks';
import type { ClipProjectDetail } from './types';

/** Cài đặt dự án cắt clip: tên, thuật ngữ cho nhận dạng lời nói, chuyển vào thùng rác. */
export function ProjectSettings({ open, detail, onClose, onDeleted, onRetranscribe }: { open: boolean; detail: ClipProjectDetail; onClose: () => void; onDeleted: () => void; onRetranscribe: () => void }) {
  const { deleteProject, scope } = useClipEnv();
  const p = detail.project;
  const { patchProject } = useClipActions(p.id);
  const [name, setName] = useState(p.name);
  const [terms, setTerms] = useState(p.stt_terms ?? '');
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const termsChanged = terms.trim() !== (p.stt_terms ?? '').trim();
  const canRetranscribe = detail.source?.status === 'transcribed' || detail.source?.status === 'failed' || detail.source?.status === 'cancelled';
  const block = detail.delete_block ? (typeof detail.delete_block === 'string' ? detail.delete_block : detail.delete_block.message) : null;
  const canDelete = !!deleteProject && (scope === 'app' || detail.can_delete);

  const save = () =>
    patchProject.mutate(
      { name: name.trim(), stt_terms: terms.trim() },
      {
        onSuccess: () => {
          toast.success('Đã lưu cài đặt dự án');
          if (!(termsChanged && canRetranscribe && detail.source && !detail.source.source_deleted)) onClose();
        },
      },
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cài đặt dự án cắt clip"
      footer={
        <>
          <Button onClick={onClose}>Đóng</Button>
          <Button variant="primary" loading={patchProject.isPending} disabledReason={!name.trim() ? 'Nhập tên dự án' : null} onClick={save}>
            Lưu
          </Button>
        </>
      }
    >
      <form className="space-y-3 text-sm" onSubmit={(e) => e.preventDefault()}>
        <div>
          <label htmlFor="cp-name" className="mb-1 block text-[13px] font-semibold">
            Tên dự án
          </label>
          <input id="cp-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="cp-terms" className="mb-1 block text-[13px] font-semibold">
            Tên riêng / thuật ngữ hay xuất hiện
          </label>
          <textarea id="cp-terms" rows={2} value={terms} maxLength={500} onChange={(e) => setTerms(e.target.value)} placeholder="Vd: Cacao, Actiso, Autovideo" />
          <p className="mt-1 text-xs text-muted">Cách nhau bằng dấu phẩy. Giúp nhận dạng đúng tên sản phẩm, tên người. Chỉ có tác dụng ở lần nhận dạng tiếp theo.</p>
        </div>
        {patchProject.isSuccess && detail.source && canRetranscribe && !detail.source.source_deleted && detail.clips.length === 0 && (detail.project.stt_terms ?? '').trim() === terms.trim() && (
          <div className="rounded-md bg-info-bg px-3 py-2 text-[13px] text-info-fg">
            Thuật ngữ đã lưu. <button type="button" className="font-semibold underline" onClick={() => { onRetranscribe(); onClose(); }}>Nhận dạng lại ngay</button> để áp dụng.
          </div>
        )}
        {canDelete && (
          <div className="rounded-lg border border-danger-fg/40 p-3">
            <h3 className="text-[13px] font-semibold text-danger-fg">Xoá dự án</h3>
            {block ? (
              <p className="mt-1 text-xs text-muted">{block}</p>
            ) : !deleting ? (
              <>
                <p className="mt-1 text-xs text-muted">Chuyển cả video nguồn, lời thoại và các clip vào thùng rác của chủ máy (khôi phục được trong 30 ngày).</p>
                <Button className="mt-2" variant="danger" size="sm" icon={<Icon name="trash" size={14} />} onClick={() => setDeleting(true)}>
                  Xoá dự án...
                </Button>
              </>
            ) : (
              <div className="mt-1 space-y-2">
                <label htmlFor="cp-confirm" className="block text-xs text-muted">
                  {scope === 'app' ? <>Gõ lại tên dự án <strong className="text-fg">{p.name}</strong> để xác nhận</> : 'Bấm xác nhận để xoá dự án này'}
                </label>
                {scope === 'app' && <input id="cp-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
                {delError && <InlineError>{delError}</InlineError>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setDeleting(false)}>
                    Thôi
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabledReason={scope === 'app' && confirm !== p.name ? 'Tên chưa khớp' : null}
                    onClick={() => {
                      setDelError(null);
                      deleteProject!(p.id, confirm).then(onDeleted, (e: unknown) => setDelError(errorMessage(e)));
                    }}
                  >
                    Xoá dự án
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {patchProject.isError && <InlineError>{errorMessage(patchProject.error)}</InlineError>}
      </form>
    </Modal>
  );
}
