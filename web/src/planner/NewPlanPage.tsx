import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { RefUploader, toBatches, type RefItem } from '../components/RefUploader';
import { InlineError } from '../components/States';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { lanLibrarySource, planner } from './api';
import { hrefOf, navigate } from './useHashRoute';

const NAME_KEY = 'autovideo-lan-name';
const readName = (): string => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveName = (v: string) => {
  try {
    window.localStorage.setItem(NAME_KEY, v);
  } catch {
    /* trình duyệt chặn lưu trữ: bỏ qua */
  }
};

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

/** Tạo kế hoạch: tên, người tạo, yêu cầu kịch bản, khóa nhất quán, ảnh tham chiếu (kéo thả, sắp thứ tự, nhãn, thư viện LAN). */
export function NewPlanPage() {
  useDocumentTitle('Kế hoạch mới');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 30_000 });
  const limits = status.data?.limits;
  const maxRefs = limits?.max_refs ?? 12;

  const [name, setName] = useState('');
  const [by, setBy] = useState(readName);
  const [brief, setBrief] = useState('');
  const [styleLock, setStyleLock] = useState('');
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bước giữa chừng lỗi thì lần thử lại tiếp tục từ bước đó, không tạo kế hoạch trùng.
  const [planId, setPlanId] = useState<number | null>(null);
  const [batchesDone, setBatchesDone] = useState(0);

  const reason = !name.trim()
    ? 'Nhập tên kế hoạch'
    : !by.trim()
      ? 'Nhập tên của bạn'
      : !brief.trim()
        ? 'Nhập yêu cầu kịch bản'
        : refs.some((r) => !r.label.trim())
          ? 'Mỗi ảnh cần có nhãn'
          : null;

  const submit = async () => {
    if (reason) return;
    setError(null);
    try {
      let id = planId;
      if (id === null) {
        setBusy('Đang tạo kế hoạch...');
        saveName(by.trim());
        id = (await planner.createPlan({ name: name.trim(), created_by_name: by.trim(), brief: brief.trim(), style_lock: styleLock.trim() })).plan.id;
        setPlanId(id);
      }
      // Ảnh thêm lần lượt đúng thứ tự danh sách: mỗi đoạn liên tiếp cùng loại là một lần gọi API.
      const batches = toBatches(refs);
      for (let i = batchesDone; i < batches.length; i++) {
        const batch = batches[i]!;
        setBusy(`Đang thêm ảnh tham chiếu (${i + 1}/${batches.length})...`);
        if (batch.kind === 'upload') {
          await planner.uploadRefs(id, batch.items.map((r) => ({ file: r.file, label: r.label.trim() })));
        } else {
          const labels: Record<number, string> = {};
          for (const r of batch.items) labels[r.refId] = r.label.trim();
          await planner.addRefsFromLibrary(id, batch.items.map((r) => r.refId), labels);
        }
        setBatchesDone(i + 1);
      }
      setBusy('Đang gửi phân tích...');
      await planner.analyze(id, { brief: brief.trim(), style_lock: styleLock.trim() });
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['status'] });
      navigate({ name: 'plan', id });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const remaining = status.data?.analyze_remaining;
  const rateMax = status.data?.rate.analyze.max;

  return (
    <div className="mx-auto max-w-3xl">
      <a href={hrefOf({ name: 'list' })} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <Icon name="arrowLeft" size={14} /> Danh sách kế hoạch
      </a>
      <h1 className="mb-4 text-xl font-bold tracking-tight">Kế hoạch mới</h1>

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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tên kế hoạch" htmlFor="n-name">
            <input id="n-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Vd: Cacao Actiso Plus" disabled={!!busy || planId !== null} autoFocus />
          </Field>
          <Field label="Tên của bạn" htmlFor="n-by" hint="Để mọi người biết kế hoạch của ai.">
            <input id="n-by" value={by} onChange={(e) => setBy(e.target.value)} maxLength={60} placeholder="Vd: Lan" autoComplete="name" disabled={!!busy || planId !== null} />
          </Field>
        </div>

        <Field
          label="Yêu cầu kịch bản"
          htmlFor="n-brief"
          hint="Mô tả sản phẩm, thông điệp, số cảnh mong muốn, giọng điệu. AI chia cảnh và viết prompt từng cảnh theo quy tắc của hệ thống (khung 9:16, mỗi clip 10 giây)."
        >
          <textarea id="n-brief" rows={8} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Vd: Quảng cáo ngắn 4 cảnh cho sinh tố cacao actiso, dọc 9:16, mỗi cảnh 10 giây..." disabled={!!busy} />
        </Field>

        <div>
          <div className="mb-1 text-[13px] font-semibold">Ảnh tham chiếu sản phẩm</div>
          <RefUploader items={refs} onChange={setRefs} disabled={!!busy || batchesDone > 0} librarySource={lanLibrarySource} maxItems={maxRefs} />
          <p className="mt-1 text-xs text-muted">
            Tối đa {maxRefs} ảnh, mỗi ảnh ≤ 10 MB. Bạn sẽ nhận danh sách ảnh cần đính kèm cho từng cảnh theo đúng thứ tự.
            {batchesDone > 0 && ` Ảnh đã được thêm (xong ${batchesDone} lượt); bấm gửi để tiếp tục.`}
          </p>
        </div>

        <Field label="Khóa nhất quán" htmlFor="n-style" hint="Những thứ phải giống nhau ở mọi cảnh: ánh sáng, mặt bếp, màu chủ đạo, nhân vật... Có thể để trống.">
          <textarea id="n-style" rows={3} value={styleLock} onChange={(e) => setStyleLock(e.target.value)} placeholder="Vd: Ánh sáng ấm buổi sáng, mặt bếp đá trắng, tông màu nâu cacao" disabled={!!busy} />
        </Field>

        {error && (
          <div className="space-y-1">
            <InlineError>{error}</InlineError>
            {planId !== null && <p className="text-xs text-muted">Kế hoạch đã được tạo. Bấm lại nút gửi để tiếp tục từ bước bị lỗi.</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button type="submit" variant="primary" loading={!!busy} disabledReason={reason} icon={<Icon name="send" />}>
            Gửi phân tích
          </Button>
          {busy ? (
            <span className="text-[13px] text-muted">{busy}</span>
          ) : reason ? (
            <span className="text-[13px] text-muted">{reason}</span>
          ) : remaining !== undefined && rateMax !== undefined ? (
            <span className="text-[13px] text-muted">
              Bạn còn {remaining}/{rateMax} lượt phân tích trong giờ này.
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
