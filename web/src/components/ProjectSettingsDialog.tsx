import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { usePatchProject } from '../hooks/mutations';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Modal } from './Modal';
import { InlineError } from './States';

export function ProjectSettingsDialog({ project, open, onClose }: { project: ProjectDetail; open: boolean; onClose: () => void }) {
  const patch = usePatchProject({ silent: true });
  const [name, setName] = useState(project.name);
  const [style, setStyle] = useState(project.style_lock);
  const [perVideo, setPerVideo] = useState(String(project.credit_per_video));
  const [attempts, setAttempts] = useState(String(project.max_attempts_per_scene));

  useEffect(() => {
    if (open) {
      setName(project.name);
      setStyle(project.style_lock);
      setPerVideo(String(project.credit_per_video));
      setAttempts(String(project.max_attempts_per_scene));
      patch.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const p = Number(perVideo);
  const a = Number(attempts);
  const ok = Number.isInteger(p) && p >= 0 && Number.isInteger(a) && a >= 1 && a <= 20;
  const reason = !name.trim() ? 'Tên dự án không được để trống' : !ok ? 'Kiểm tra lại các con số' : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cài đặt dự án"
      footer={
        <>
          <Button onClick={onClose}>Đóng</Button>
          <Button
            variant="primary"
            loading={patch.isPending}
            disabledReason={reason}
            onClick={() =>
              patch.mutate(
                { projectId: project.id, input: { name: name.trim(), style_lock: style, credit_per_video: p, max_attempts_per_scene: a } },
                {
                  onSuccess: () => {
                    toast.success('Đã lưu cài đặt dự án');
                    onClose();
                  },
                },
              )
            }
          >
            Lưu cài đặt
          </Button>
        </>
      }
    >
      <form className="space-y-3 text-sm" onSubmit={(e) => e.preventDefault()}>
        <div>
          <label htmlFor="s-name" className="mb-1 block text-[13px] font-semibold">
            Tên dự án
          </label>
          <input id="s-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="s-per" className="mb-1 block text-[13px] font-semibold">
              Credit mỗi video
            </label>
            <input id="s-per" type="number" min={0} step={1} value={perVideo} onChange={(e) => setPerVideo(e.target.value)} />
          </div>
          <div>
            <label htmlFor="s-att" className="mb-1 block text-[13px] font-semibold">
              Lượt video mỗi cảnh
            </label>
            <input id="s-att" type="number" min={1} max={20} step={1} value={attempts} onChange={(e) => setAttempts(e.target.value)} />
          </div>
        </div>
        <p className="-mt-1 text-xs text-muted">Nâng số lượt để mở khóa các cảnh đã dùng hết lượt. Credit mỗi video chỉ ảnh hưởng các video tạo từ giờ.</p>
        <div>
          <label htmlFor="s-style" className="mb-1 block text-[13px] font-semibold">
            Khóa nhất quán (style lock)
          </label>
          <textarea id="s-style" rows={4} value={style} onChange={(e) => setStyle(e.target.value)} />
        </div>
        <p className="text-xs text-muted">Ảnh tham chiếu quản lý ở mục «Ảnh tham chiếu» trên bảng cảnh.</p>
        {patch.isError && <InlineError>{errorMessage(patch.error)}</InlineError>}
      </form>
    </Modal>
  );
}
