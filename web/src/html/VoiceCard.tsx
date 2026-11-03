import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { InlineError } from '../components/States';
import { Btn } from '../planner/ws-ui';
import { htmlApi } from './api';
import { assetFileProblem, hk } from './lib';
import type { HtmlAsset } from './types';
import { VideoEstimate } from './VideoEstimate';

export function useHtmlVoice(id: number) {
  return useQuery({ queryKey: hk.voice(id), queryFn: () => htmlApi.voice(id), refetchInterval: (q) => q.state.data && ['queued', 'processing'].includes(q.state.data.status) ? 1500 : false });
}
export function VoiceCard({ id, assets, locked }: { id: number; assets: HtmlAsset[]; locked: boolean }) {
  const qc = useQueryClient();
  const q = useHtmlVoice(id);
  const v = q.data;
  const [asset, setAsset] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [captions, setCaptions] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const processing = !!v && ['queued', 'processing'].includes(v.status);
  const source = assets.find((a) => a.id === v?.asset_id);
  useEffect(() => { setCaptions(v?.captions ?? true); setEdits({}); }, [v?.transcript, v?.captions]);
  useEffect(() => {
    if (v?.status === 'ready') void qc.invalidateQueries({ queryKey: hk.project(id) });
  }, [v?.status, id, qc]);
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: hk.voice(id) }), qc.invalidateQueries({ queryKey: hk.assets(id) }), qc.invalidateQueries({ queryKey: hk.project(id) })]);
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); setProgress(null); }
  };
  const upload = (files: FileList | null, voice: boolean) => {
    if (!files?.length) return;
    void action(async () => {
      for (const f of [...files]) {
        const problem = assetFileProblem(f); if (problem) throw new Error(problem);
        const a = await htmlApi.uploadAsset(id, f, (n, total) => setProgress(Math.round(n * 100 / total))).promise;
        if (voice) await htmlApi.startVoice(id, a.id, captions);
      }
    });
  };
  const reason = locked ? 'Đợi AI tạo xong hoặc hủy phiên bản đang tạo để thay lời đọc' : processing ? 'Đang nhận dạng lời đọc' : null;
  return <section className="av-card av-card-pad hv-voice-card" aria-labelledby="hv-voice-heading">
    <h2 id="hv-voice-heading">Lời đọc &amp; ảnh minh họa</h2>
    <p className="av-muted">Tải voice hoặc video có tiếng (tối đa 7 phút), kèm bộ ảnh. App lấy thời gian lời đọc làm chuẩn; AI tự đọc ảnh và chọn ảnh cho từng cảnh. Bạn kiểm tra bản xem trước và đổi ảnh trước khi xuất.</p>
    <div className="hv-voice-actions">
      <label className="av-btn av-btn-sm hv-upload">Tải voice / video…<input aria-label="Tải lời đọc" type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.ogg" disabled={busy || !!reason} onChange={(e) => { upload(e.target.files, true); e.target.value = ''; }} /></label>
      <label className="av-btn av-btn-sm hv-upload">Thêm bộ ảnh…<input aria-label="Thêm ảnh minh họa" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || locked || processing} onChange={(e) => { upload(e.target.files, false); e.target.value = ''; }} /></label>
      {!processing && <label className="av-label">Hoặc chọn tệp đã tải<select aria-label="Tệp lời đọc" className="av-input" value={asset} disabled={busy || locked} onChange={(e) => setAsset(e.target.value)}><option value="">Chọn âm thanh / video</option>{assets.filter((a) => a.has_audio && a.kind !== 'image').map((a) => <option key={a.id} value={a.id}>{a.name} · {a.duration_s}s</option>)}</select></label>}
      {!!asset && !processing && <Btn actionKind="local" loading={busy} disabledReason={reason} onClick={() => void action(() => htmlApi.startVoice(id, Number(asset), captions))}>Nhận dạng lời đọc</Btn>}
    </div>
    {reason && <p className="why">{reason}</p>}
    {progress !== null && <p role="status">{progress < 100 ? `Đang tải ${progress}%` : 'Đang kiểm tra tệp… chưa hoàn tất'}</p>}
    {processing && <div role="status"><p>{v?.status === 'queued' ? 'Đang chờ xử lý trên máy…' : 'Đang nhận dạng lời đọc…'}</p><Btn disabled={busy} onClick={() => void action(() => htmlApi.cancelVoice(id))}>Hủy nhận dạng</Btn></div>}
    {source && <div className="hv-voice-player"><span>{source.name}</span><audio controls preload="metadata" src={source.url} /></div>}
    {v?.status === 'ready' && v.transcript && <>
      <p className="av-muted">Đã nhận dạng {v.transcript.words.length} từ · {v.transcript.duration_s}s. Thời lượng video theo file lời đọc.</p>
      <VideoEstimate id={id}/>
      <label><input type="checkbox" checked={captions} disabled={busy || locked} onChange={(e) => setCaptions(e.target.checked)} /> Phụ đề đồng bộ theo từ</label>
      <details><summary>Kiểm tra, sửa chữ lời đọc và timestamp</summary>
        <div className="hv-voice-words">{v.transcript.words.map((w) => <label key={w.i}><span className="av-muted">{w.start.toFixed(2)}–{w.end.toFixed(2)}s</span><input className="av-input" aria-label={`Từ ${w.i + 1}, ${w.start}s`} maxLength={100} value={edits[w.i] ?? w.w} disabled={busy || locked} onChange={(e) => setEdits((cur) => ({ ...cur, [w.i]: e.target.value }))} /></label>)}</div>
      </details>
      {(Object.keys(edits).length > 0 || captions !== v.captions) && <Btn actionKind="local" loading={busy} disabledReason={locked ? reason : Object.values(edits).some((s) => !s.trim()) ? 'Mỗi từ cần có chữ' : null} onClick={() => void action(() => htmlApi.editVoice(id, Object.entries(edits).map(([i, w]) => ({ i: Number(i), w })), captions))}>Lưu lời đọc &amp; phụ đề</Btn>}
    </>}
    {(v?.status === 'failed' || v?.status === 'cancelled') && <p className="av-muted">{v.error ?? 'Đã hủy nhận dạng. Chọn tệp và nhận dạng lại.'}</p>}
    {v && !processing && <Btn disabledReason={locked ? reason : null} disabled={busy} onClick={() => void action(() => htmlApi.clearVoice(id))}>Bỏ lời đọc cho lần tạo tiếp theo</Btn>}
    {(error || q.error) && <InlineError>{error ?? errorMessage(q.error)}</InlineError>}
  </section>;
}
