import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { useDeleteProject, usePatchProject } from '../hooks/mutations';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { InlineError } from './States';

/** Vùng nguy hiểm: chuyển dự án vào thùng rác 30 ngày (khôi phục được). Phải gõ đúng tên; hiện lý do nếu đang bị chặn. */
function DeleteZone({ project, onDone }: { project: ProjectDetail; onDone: () => void }) {
  const navigate = useNavigate();
  const del = useDeleteProject();
  const [typed, setTyped] = useState('');
  const block = project.delete_block;
  const match = typed.trim().normalize('NFC') === project.name.trim().normalize('NFC');
  return (
    <section aria-labelledby="del-title" className="mt-4 rounded-lg border border-danger-fg/40 bg-danger-bg/40 p-3 text-sm">
      <h3 id="del-title" className="mb-1 flex items-center gap-1.5 text-[13px] font-bold text-danger-fg">
        <Icon name="trash" size={15} /> Xoá dự án
      </h3>
      <p className="text-[13px]">
        Dự án (cảnh, video, bản hoàn chỉnh, ảnh tham chiếu) được chuyển vào <strong>Thùng rác 30 ngày</strong>: biến khỏi mọi danh sách, worker không nhận việc của nó. Trong 30 ngày bạn khôi phục được ở mục «Thùng rác»; sau đó xoá vĩnh viễn và không lấy lại được.
      </p>
      {block ? (
        <div role="alert" className="mt-2 rounded-md bg-warn-bg px-3 py-2 text-[13px] text-warn-fg">
          <strong>Chưa xoá được lúc này:</strong>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {block.reasons.map((r) => (
              <li key={r.code + r.message}>{r.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mt-2">
          <label htmlFor="del-name" className="mb-1 block text-xs font-semibold">
            Gõ đúng tên dự án «{project.name}» để bật nút
          </label>
          <input id="del-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={project.name} />
        </div>
      )}
      {del.isError && (
        <div className="mt-2">
          <InlineError>{errorMessage(del.error)}</InlineError>
        </div>
      )}
      <div className="mt-2">
        <Button
          variant="danger"
          icon={<Icon name="trash" />}
          loading={del.isPending}
          disabledReason={block ? 'Đang bị chặn, xem lý do ở trên' : !match ? 'Gõ đúng tên dự án để bật nút' : null}
          onClick={() =>
            del.mutate(
              { projectId: project.id, confirmName: typed },
              {
                onSuccess: () => {
                  toast.success(`Đã chuyển "${project.name}" vào thùng rác. Khôi phục trong 30 ngày ở mục Thùng rác.`);
                  onDone();
                  navigate('/');
                },
              },
            )
          }
        >
          Chuyển vào thùng rác
        </Button>
      </div>
    </section>
  );
}

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
      {open && <DeleteZone key={project.id} project={project} onDone={onClose} />}
    </Modal>
  );
}
