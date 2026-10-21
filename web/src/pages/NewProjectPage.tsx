import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { RefUploader, type LibraryItem, type RefItem, type UploadItem } from '../components/RefUploader';
import { InlineError } from '../components/States';
import { useDocumentTitle } from '../lib/useDocumentTitle';

function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-[13px] font-semibold">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

type Batch = { kind: 'upload'; items: UploadItem[] } | { kind: 'library'; items: LibraryItem[] };

/** Gom các ảnh liên tiếp cùng loại thành từng lượt, giữ nguyên thứ tự danh sách. */
function toBatches(items: RefItem[]): Batch[] {
  const out: Batch[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.kind === it.kind) (last.items as RefItem[]).push(it);
    else out.push(it.kind === 'upload' ? { kind: 'upload', items: [it] } : { kind: 'library', items: [it] });
  }
  return out;
}

export default function NewProjectPage() {
  useDocumentTitle('Dự án mới');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [styleLock, setStyleLock] = useState('');
  const [perVideo, setPerVideo] = useState('15');
  const [attempts, setAttempts] = useState('2');
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Nếu một bước giữa chừng lỗi, lần thử lại tiếp tục từ bước đó thay vì tạo trùng dự án.
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [refBatchesDone, setRefBatchesDone] = useState(0);

  const perVideoN = Number(perVideo);
  const attemptsN = Number(attempts);
  const numbersOk = Number.isInteger(perVideoN) && perVideoN >= 0 && Number.isInteger(attemptsN) && attemptsN >= 1 && attemptsN <= 20;

  const reason = !name.trim() ? 'Nhập tên dự án' : !brief.trim() ? 'Nhập yêu cầu kịch bản' : !numbersOk ? 'Kiểm tra lại credit mỗi video và số lượt' : refs.some((r) => !r.label.trim()) ? 'Mỗi ảnh cần có nhãn' : null;

  const submit = async () => {
    if (reason) return;
    setError(null);
    try {
      let id = createdId;
      if (id === null) {
        setBusy('Đang tạo dự án...');
        const p = await api.createProject({
          name: name.trim(),
          brief: brief.trim(),
          style_lock: styleLock.trim(),
          credit_per_video: perVideoN,
          max_attempts_per_scene: attemptsN,
        });
        id = p.id;
        setCreatedId(id);
      }
      // Ảnh được thêm lần lượt đúng thứ tự trong danh sách: mỗi đoạn liên tiếp cùng loại là một lần gọi
      // (tải lên → POST /refs, thư viện → POST /refs/from-library), nên thứ tự cuối cùng khớp danh sách.
      const batches = toBatches(refs);
      for (let i = refBatchesDone; i < batches.length; i++) {
        const batch = batches[i]!;
        setBusy(`Đang thêm ảnh tham chiếu (${i + 1}/${batches.length})...`);
        if (batch.kind === 'upload') {
          await api.uploadRefs(id, batch.items.map((r) => ({ file: r.file, label: r.label.trim() })));
        } else {
          const labels: Record<number, string> = {};
          for (const r of batch.items) labels[r.refId] = r.label.trim();
          await api.addRefsFromLibrary(id, batch.items.map((r) => r.refId), labels);
        }
        setRefBatchesDone(i + 1);
      }
      setBusy('Đang gửi cho AI...');
      await api.submitBrief(id, brief.trim());
      void qc.invalidateQueries();
      navigate(`/projects/${id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <Icon name="arrowLeft" size={14} /> Dự án
      </Link>
      <h1 className="mb-4 text-xl font-bold tracking-tight">Dự án mới</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          // Enter trong ô nhập một dòng (nhãn ảnh, ô lọc thư viện...) không được gửi cả biểu mẫu.
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault();
        }}
        className="space-y-5 rounded-lg border border-line bg-surface p-4 sm:p-5"
      >
        <Field label="Tên dự án" htmlFor="p-name">
          <input id="p-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Vd: Cacao Actiso Plus" disabled={!!busy} autoFocus />
        </Field>

        <Field label="Yêu cầu kịch bản" htmlFor="p-brief" hint="Mô tả sản phẩm, thông điệp, số cảnh mong muốn, giọng điệu. AI sẽ chia cảnh và viết prompt từng cảnh theo quy tắc trong video-production-rules.md.">
          <textarea id="p-brief" rows={8} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Vd: Quảng cáo ngắn 4 cảnh cho sinh tố cacao actiso, dọc 9:16, mỗi cảnh 10 giây..." disabled={!!busy} />
        </Field>

        <div>
          <div className="mb-1 text-[13px] font-semibold">Ảnh tham chiếu sản phẩm</div>
          <RefUploader items={refs} onChange={setRefs} disabled={!!busy || refBatchesDone > 0} />
          {refBatchesDone > 0 && <p className="mt-1 text-xs text-muted">Ảnh đã được thêm vào dự án (đã xong {refBatchesDone} lượt thêm). Bấm gửi để tiếp tục.</p>}
        </div>

        <Field label="Khóa nhất quán (style lock)" htmlFor="p-style" hint="Những thứ phải giữ giống nhau ở mọi cảnh: ánh sáng, mặt bếp, màu chủ đạo, nhân vật... Có thể để trống.">
          <textarea id="p-style" rows={3} value={styleLock} onChange={(e) => setStyleLock(e.target.value)} placeholder="Vd: Ánh sáng ấm buổi sáng, mặt bếp đá trắng, tông màu nâu cacao" disabled={!!busy} />
        </Field>

        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!!busy}>
          <legend className="mb-1 text-[13px] font-semibold">Credit và số lượt</legend>
          <Field label="Credit mỗi video" htmlFor="p-per">
            <input id="p-per" type="number" inputMode="numeric" min={0} step={1} value={perVideo} onChange={(e) => setPerVideo(e.target.value)} />
          </Field>
          <Field label="Số lượt video tối đa mỗi cảnh" htmlFor="p-att">
            <input id="p-att" type="number" inputMode="numeric" min={1} max={20} step={1} value={attempts} onChange={(e) => setAttempts(e.target.value)} />
          </Field>
          <p className="text-xs text-muted sm:col-span-2">
            Mỗi video tốn {numbersOk ? perVideoN : '...'} credit thật trên Google Flow. Không video nào được tạo nếu bạn chưa duyệt và xác nhận từng lượt.
          </p>
        </fieldset>

        {error && (
          <div className="space-y-1">
            <InlineError>{error}</InlineError>
            {createdId !== null && <p className="text-xs text-muted">Dự án đã được tạo (mã {createdId}). Bấm lại nút gửi để tiếp tục từ bước bị lỗi.</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button type="submit" variant="primary" loading={!!busy} disabledReason={reason} icon={<Icon name="send" />}>
            Gửi cho AI phân tích
          </Button>
          {busy ? <span className="text-[13px] text-muted">{busy}</span> : reason ? <span className="text-[13px] text-muted">{reason}</span> : null}
        </div>
      </form>
    </div>
  );
}
