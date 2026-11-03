import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { InlineError } from '../components/States';
import { Btn } from '../planner/ws-ui';
import { htmlApi } from './api';
import { hk } from './lib';
import type { HtmlAsset } from './types';

export function ImageReviewCard({ id, assets, scanning, resuming }: { id: number; assets: HtmlAsset[]; scanning: boolean; resuming: boolean }) {
  const qc = useQueryClient();
  const pending = assets.filter((a) => a.kind === 'image' && a.scan_error_code && !a.label_confirmed);
  const signature = pending.map((a) => `${a.id}:${a.scan_error_code}`).join(',');
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setConfirmed(false); }, [signature]);
  if (!pending.length) return null;
  const reason = scanning ? 'Đang quét các ảnh còn lại. Đợi quét xong để xác nhận đủ ảnh.' : pending.some((a) => !(labels[a.id] ?? a.manual_label ?? '').trim()) ? 'Nhập nhãn mô tả nội dung cho từng ảnh chưa đọc được' : !confirmed ? 'Đánh dấu xác nhận sau khi kiểm tra nhãn của tất cả ảnh bên dưới' : null;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await htmlApi.confirmImageLabels(id, pending.map((a) => ({ id: a.id, label: (labels[a.id] ?? a.manual_label ?? '').trim() })));
      setConfirmed(false);
      await Promise.all([qc.invalidateQueries({ queryKey: hk.assets(id) }), qc.invalidateQueries({ queryKey: hk.versions(id) }), qc.invalidateQueries({ queryKey: hk.project(id) })]);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <section className="av-card av-card-pad hv-image-review" aria-labelledby="hv-review-heading">
    <h2 id="hv-review-heading">Cần kiểm tra {pending.length} ảnh</h2>
    <p className="av-muted">AI chưa đọc được nội dung các ảnh này. Job được giữ lại, chưa tạo video. Nhập nhãn mô tả ảnh (sản phẩm, dung tích, nội dung…), kiểm tra và xác nhận để tiếp tục.</p>
    <div className="hv-review-grid">{pending.map((a) => <label className="av-label" key={a.id}>
      <img src={a.url} alt={a.name} loading="lazy" />
      <span>Ảnh #{a.id} · {a.name}</span>
      <span className="av-muted hv-hint">{a.scan_error_code === 'SCAN_UNAVAILABLE' ? 'Model đọc ảnh chưa khả dụng hoặc hết hạn mức' : a.scan_error_code === 'SCAN_LIMIT' ? 'Ảnh chưa được quét vì đã đạt giới hạn lượt quét' : 'Không nhận được mô tả ảnh hợp lệ'}</span>
      <input className="av-input" aria-label={`Nhãn ảnh #${a.id}`} maxLength={600} value={labels[a.id] ?? a.manual_label ?? ''} disabled={busy} placeholder="Vd: Hộp sữa Vinh Gia 110ml, mặt trước" onChange={(e) => { setLabels((cur) => ({ ...cur, [a.id]: e.target.value })); setConfirmed(false); }} />
    </label>)}</div>
    <label><input type="checkbox" checked={confirmed} disabled={busy || scanning} onChange={(e) => setConfirmed(e.target.checked)} /> Tôi đã kiểm tra và xác nhận nhãn của tất cả ảnh trên là đúng</label>
    {error && <InlineError>{error}</InlineError>}
    <Btn actionKind={resuming ? 'ai' : 'local'} loading={busy} disabledReason={reason} onClick={() => void save()}>{resuming ? 'Xác nhận nhãn & tiếp tục tạo video' : 'Xác nhận nhãn ảnh'}</Btn>
  </section>;
}
