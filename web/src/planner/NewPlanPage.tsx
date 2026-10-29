import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { RefUploader, toBatches, type RefItem } from '../components/RefUploader';
import { InlineError } from '../components/States';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { lanLibrarySource, planner } from './api';
import { hrefOf, navigate } from './useHashRoute';

/** App một người dùng: API vẫn đòi tên người tạo nên gửi giá trị cố định, không có ô nhập. */
const CREATOR = 'Máy này';

/** Tạo kế hoạch: nội dung, ảnh tham chiếu (sắp thứ tự, nhãn, thư viện). "Lưu nháp" chỉ tạo kế hoạch + ảnh; "Phân tích bằng AI" gửi phân tích luôn. */
export function NewPlanPage() {
  useDocumentTitle('Tạo kế hoạch');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 30_000 });
  const maxRefs = status.data?.limits?.max_refs ?? 12;

  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [styleLock, setStyleLock] = useState('');
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bước giữa chừng lỗi thì lần thử lại tiếp tục từ bước đó, không tạo kế hoạch trùng.
  const [planId, setPlanId] = useState<number | null>(null);
  const [batchesDone, setBatchesDone] = useState(0);

  const nameReason = !name.trim() ? 'Nhập tên kế hoạch' : refs.some((r) => !r.label.trim()) ? 'Mỗi ảnh cần có nhãn' : null;
  const analyzeReason = nameReason ?? (!brief.trim() ? 'Nhập yêu cầu kịch bản' : null);

  const submit = async (analyze: boolean) => {
    if (analyze ? analyzeReason : nameReason) return;
    setError(null);
    try {
      let id = planId;
      if (id === null) {
        setBusy('Đang tạo kế hoạch...');
        id = (await planner.createPlan({ name: name.trim(), created_by_name: CREATOR, brief: brief.trim(), style_lock: styleLock.trim() })).plan.id;
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
      if (analyze) {
        setBusy('Đang gửi phân tích...');
        await planner.analyze(id, { brief: brief.trim(), style_lock: styleLock.trim() });
      }
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['status'] });
      navigate({ name: 'plan', id });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const locked = !!busy;
  return (
    <>
      <header className="av-header">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
          <nav aria-label="Đường dẫn" className="av-crumb">
            <a href={hrefOf({ name: 'list' })}>Kế hoạch video</a>
            <span> / Tạo kế hoạch</span>
          </nav>
          <h1>Tạo kế hoạch mới</h1>
        </div>
        {busy && (
          <span role="status" className="av-muted text-[13px]">
            {busy}
          </span>
        )}
        <button type="button" className="av-btn" disabled={locked || !!nameReason} title={nameReason ?? undefined} onClick={() => void submit(false)}>
          Lưu nháp
        </button>
        <button type="button" className="av-btn av-btn-primary" disabled={locked || !!analyzeReason} title={analyzeReason ?? undefined} onClick={() => void submit(true)}>
          <Icon name="send" size={15} /> Phân tích bằng AI
        </button>
      </header>

      <form
        className="av-page"
        style={{ padding: '24px 32px 32px', maxWidth: 1104 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
        onKeyDown={(e) => {
          // Enter trong ô nhập một dòng (nhãn ảnh, ô lọc thư viện...) không được gửi cả biểu mẫu.
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault();
        }}
      >
        <section className="av-card av-card-pad" aria-labelledby="np-content">
          <h2 id="np-content">Nội dung</h2>
          <label className="av-label">
            Tên kế hoạch
            <input className="av-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Vd: Cacao Actiso Plus" disabled={locked || planId !== null} autoFocus />
          </label>
          <label className="av-label">
            Yêu cầu kịch bản
            <textarea className="av-input" rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Vd: Quảng cáo ngắn 4 cảnh cho sinh tố cacao actiso, dọc 9:16, mỗi cảnh 10 giây..." disabled={locked} />
          </label>
          <label className="av-label">
            Phong cách giữ nhất quán giữa các cảnh
            <input className="av-input" value={styleLock} onChange={(e) => setStyleLock(e.target.value)} placeholder="Vd: Ánh sáng ấm buổi sáng, bếp gỗ sáng màu" disabled={locked} />
          </label>
        </section>

        <section className="av-card av-card-pad" aria-labelledby="np-refs">
          <h2 id="np-refs">Ảnh tham chiếu sản phẩm</h2>
          <RefUploader items={refs} onChange={setRefs} disabled={locked || batchesDone > 0} librarySource={lanLibrarySource} maxItems={maxRefs} />
        </section>

        {error && <InlineError>{error}</InlineError>}
      </form>
    </>
  );
}
