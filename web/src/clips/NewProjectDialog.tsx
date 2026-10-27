import { useState } from 'react';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { InlineError } from '../components/States';
import { useClipEnv } from './env';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clipKeys } from './hooks';

const NAME_KEY = 'autovideo-lan-name';
const readName = (): string => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Hộp thoại tạo dự án cắt clip: tên + tên riêng/thuật ngữ hay xuất hiện (giúp nhận dạng đúng). */
export function NewClipProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const { api, scope, quota } = useClipEnv();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [terms, setTerms] = useState('');
  const [by, setBy] = useState(readName);
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), ...(terms.trim() ? { stt_terms: terms.trim() } : {}), ...(scope === 'lan' && by.trim() ? { created_by_name: by.trim() } : {}) }),
    meta: { silent: true },
    onSuccess: (d) => {
      try {
        if (scope === 'lan') window.localStorage.setItem(NAME_KEY, by.trim());
      } catch {
        /* trình duyệt chặn lưu */
      }
      void qc.invalidateQueries({ queryKey: clipKeys.list(scope) });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onCreated(d.project.id);
    },
  });
  const quotaBlock = scope === 'lan' && quota?.project !== undefined && quota.project !== null && quota.project <= 0 ? 'Bạn đã tạo đủ số dự án trong giờ này, hãy thử lại sau' : null;
  const reason = !name.trim() ? 'Nhập tên dự án' : quotaBlock;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Dự án cắt clip mới"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Hủy
          </Button>
          <Button variant="primary" loading={create.isPending} disabledReason={reason} onClick={() => create.mutate()}>
            Tạo dự án
          </Button>
        </>
      }
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason) create.mutate();
        }}
      >
        <div>
          <label htmlFor="ncp-name" className="mb-1 block text-[13px] font-semibold">
            Tên dự án
          </label>
          <input id="ncp-name" value={name} maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Vd: Livestream bán hàng 25/10" />
        </div>
        <div>
          <label htmlFor="ncp-terms" className="mb-1 block text-[13px] font-semibold">
            Tên riêng / thuật ngữ hay xuất hiện (tuỳ chọn)
          </label>
          <textarea id="ncp-terms" rows={2} value={terms} maxLength={500} onChange={(e) => setTerms(e.target.value)} placeholder="Vd: Cacao, Actiso, Autovideo" />
          <p className="mt-1 text-xs text-muted">Cách nhau bằng dấu phẩy. Giúp nhận dạng lời nói đúng tên sản phẩm, tên người.</p>
        </div>
        {scope === 'lan' && (
          <div>
            <label htmlFor="ncp-by" className="mb-1 block text-[13px] font-semibold">
              Tên của bạn (tuỳ chọn)
            </label>
            <input id="ncp-by" value={by} maxLength={60} onChange={(e) => setBy(e.target.value)} placeholder="Vd: Lan" />
          </div>
        )}
        {scope === 'lan' && quota?.project !== undefined && quota.project !== null && <p className="text-xs text-muted">Còn {Math.max(0, quota.project)} lượt tạo dự án trong giờ này.</p>}
        {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
      </form>
    </Modal>
  );
}
