import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { ErrorState, InlineError, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { planner } from '../planner/api';
import { Btn } from '../planner/ws-ui';
import { DeleteProjectDialog, RowMenu } from '../planner/RowMenu';
import { hrefOf, navigate } from '../planner/useHashRoute';
import { htmlApi } from './api';
import { hashOf, idemDone, idemKey } from './idem';
import { ASPECT_LABEL, ASSET_ACCEPT, ASSET_LIMITS, assetFileProblem, bytesLabel, EnvNotices, hk, VersionChip, VERSION_ACTIVE, useHtmlEnv } from './lib';
import type { HtmlAspect, HtmlProject, HtmlQuality } from './types';
import './html.css';

type UploadState = 'pending' | 'uploading' | 'done' | 'error';
interface UpFile {
  file: File;
  state: UploadState;
  loaded: number;
  error?: string;
}

/** Màn "Video HTML": danh sách dự án + form tạo mới. */
export function HtmlListPage() {
  useDocumentTitle('Video HTML');
  const qc = useQueryClient();
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<HtmlProject | null>(null);
  const q = useQuery({ queryKey: hk.list, queryFn: htmlApi.list, refetchInterval: (query) => (query.state.data?.some((p) => p.active_versions > 0) ? 3000 : false) });
  const rows = q.data ?? [];
  return (
    <div className="cd-list-page hv-page">
      <div className="av-page-head">
        <div className="hv-list-heading">
          <h1>Video HTML</h1>
          <p className="av-muted">Mô tả video, xem trước ngay trong app rồi dựng MP4. Luồng riêng, không liên quan Google Flow.</p>
        </div>
          <button type="button" className="av-btn av-btn-primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          {creating ? 'Đóng form' : 'Video HTML mới'}
        </button>
      </div>
      <div className={`hv-body${creating ? ' hv-list-layout' : ''}`}>
        {creating && <CreateForm onDone={(id) => navigate({ name: 'html-project', id })} />}
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <div className="av-card cd-empty hv-empty"><strong>Chưa có dự án Video HTML</strong><span className="av-muted">Tạo dự án bằng mô tả và để AI dựng phiên bản đầu tiên.</span><button type="button" className="av-btn av-btn-primary" onClick={() => setCreating(true)}>Video HTML mới <span className="hv-action-tag hv-ai">AI</span></button></div>
        ) : (
          <div className="av-card av-table-wrap hv-project-table">
            <table className="av-table">
              <thead>
                <tr>
                  <th>Dự án</th>
                  <th>Tỉ lệ</th>
                  <th>Phiên bản mới nhất</th>
                  <th>Cập nhật</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a className="cd-row-link" href={hrefOf({ name: 'html-project', id: p.id })}>
                        {p.name}
                      </a>
                    </td>
                    <td className="av-muted">
                      {ASPECT_LABEL[p.aspect]} · {p.duration_s} giây
                    </td>
                    <td>
                      {p.latest_version ? (
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <VersionChip status={p.latest_version.status} />
                          <span className="av-muted">v{p.latest_version.version}</span>
                          {VERSION_ACTIVE(p.latest_version.status) && <span className="av-muted">đang xử lý…</span>}
                        </span>
                      ) : (
                        <span className="av-muted">Chưa tạo</span>
                      )}
                    </td>
                    <td className="av-muted">{fmtRelative(p.updated_at, now)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <a className="av-btn av-btn-sm" href={hrefOf({ name: 'html-project', id: p.id })}>
                        Mở
                      </a>{' '}
                      <RowMenu label={`Thao tác với dự án ${p.name}`} items={[{ label: 'Xoá vĩnh viễn', danger: true, disabledReason: p.delete_block?.message ?? null, onSelect: () => setDeleting(p) }]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <DeleteProjectDialog
        target={deleting}
        what="dự án Video HTML"
        onDelete={htmlApi.remove}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          setDeleting(null);
          toast.success(`Đã xoá dự án "${name}"`);
          void qc.invalidateQueries({ queryKey: hk.list });
        }}
      />
    </div>
  );
}

const ASPECTS: HtmlAspect[] = ['9:16', '1:1', '16:9'];

/** Tạo dự án → tải asset lần lượt (có tiến độ, tiếp tục được khi lỗi) → gửi compose (idempotency key giữ qua reload). */
function CreateForm({ onDone }: { onDone: (id: number) => void }) {
  const qc = useQueryClient();
  const env = useHtmlEnv();
  const templates = useQuery({ queryKey: hk.templates, queryFn: htmlApi.templates, retry: false, staleTime: 5 * 60_000 });
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [template, setTemplate] = useState('');
  const [aspect, setAspect] = useState<HtmlAspect>('9:16');
  const [duration, setDuration] = useState(15);
  const [quality, setQuality] = useState<HtmlQuality>('720p');
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceAssetId, setVoiceAssetId] = useState<number | null>(null);
  const [files, setFiles] = useState<UpFile[]>([]);
  const [adv, setAdv] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [compose, setCompose] = useState('auto');
  const [vision, setVision] = useState('auto');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bước giữa chừng lỗi thì lần thử lại tiếp tục từ đó, không tạo dự án trùng.
  const [projectId, setProjectId] = useState<number | null>(null);
  const abort = useRef<(() => void) | null>(null);
  const cancelled = useRef(false);

  const picked = (list: FileList | null) => {
    if (!list) return;
    const add: UpFile[] = [...list].map((file) => {
      const p = assetFileProblem(file);
      return { file, state: p ? 'error' : 'pending', loaded: 0, error: p ?? undefined };
    });
    setFiles((cur) => [...cur, ...add]);
  };
  const total = files.reduce((n, f) => n + f.file.size, 0);
  const blocked = files.some((f) => f.state === 'error' && !!assetFileProblem(f.file));
  const tpl = (templates.data ?? []).filter((t) => !t.aspects || t.aspects.includes(aspect));
  const aspectOk = !template || tpl.some((t) => t.id === template);
  const reason = !name.trim() ? 'Nhập tên dự án' : voiceMode && !voiceFile ? 'Chọn file lời đọc hoặc video có tiếng' : !voiceMode && !brief.trim() ? 'Mô tả video cần dựng' : !aspectOk ? 'Mẫu này không hỗ trợ tỉ lệ đã chọn' : total + (voiceFile?.size ?? 0) > ASSET_LIMITS.project ? 'Tổng asset vượt 1 GB' : !voiceMode && env.aiMissingKey ? 'Chưa có API key của AI (vào Cài đặt)' : null;

  const setFile = (i: number, patch: Partial<UpFile>) => setFiles((cur) => cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const loadModels = async () => {
    setModelErr(null);
    try {
      setModels((await planner.checkAi()).models);
    } catch (e) {
      setModelErr(errorMessage(e));
    }
  };

  const submit = async () => {
    if (reason) return;
    setError(null);
    cancelled.current = false;
    try {
      let id = projectId;
      if (id === null) {
        setBusy('Đang tạo dự án…');
        const model = compose !== 'auto' || vision !== 'auto' ? { ...(compose !== 'auto' ? { compose } : {}), ...(vision !== 'auto' ? { vision } : {}) } : undefined;
        id = (await htmlApi.create({ name: name.trim(), brief: brief.trim() || 'Tạo video minh họa khớp lời đọc, chọn ảnh theo nội dung.', aspect, duration_s: duration, quality, template: template || null, ...(model ? { model } : {}) })).id;
        setProjectId(id);
        void qc.invalidateQueries({ queryKey: hk.list });
      }
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        if (f.state === 'done' || assetFileProblem(f.file)) continue;
        setBusy(`Đang tải tệp ${i + 1}/${files.length}…`);
        setFile(i, { state: 'uploading', loaded: 0, error: undefined });
        const up = htmlApi.uploadAsset(id, f.file, (loaded) => setFile(i, { loaded }));
        abort.current = up.abort;
        try {
          await up.promise;
          setFile(i, { state: 'done', loaded: f.file.size });
        } catch (e) {
          setFile(i, { state: 'error', error: errorMessage(e) });
          throw e;
        } finally {
          abort.current = null;
        }
      }
      if (voiceMode && voiceFile) {
        let voiceId = voiceAssetId;
        if (voiceId === null) {
          const problem = assetFileProblem(voiceFile); if (problem) throw new Error(problem);
          setBusy('Đang tải và kiểm tra lời đọc…');
          const up = htmlApi.uploadAsset(id, voiceFile, () => undefined);
          abort.current = up.abort;
          try { voiceId = (await up.promise).id; setVoiceAssetId(voiceId); } finally { abort.current = null; }
        }
        setBusy('Đang xếp nhận dạng lời đọc…');
        try { await htmlApi.startVoice(id, voiceId); }
        catch (e) { toast.error(errorMessage(e)); }
        onDone(id);
        return;
      }
      setBusy('Đang gửi yêu cầu cho AI…');
      const prompt = brief.trim();
      const scope = `compose:${id}:${hashOf(prompt)}`;
      await htmlApi.compose(id, { prompt, idempotency_key: idemKey(scope) });
      idemDone(scope);
      void qc.invalidateQueries({ queryKey: hk.list });
      onDone(id);
    } catch (e) {
      if (!cancelled.current) setError(errorMessage(e));
      setBusy(null);
    }
  };

  const locked = !!busy;
  return (
    <form
      className="av-card av-card-pad hv-create"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Video HTML mới</h2>
      <p className="av-muted hv-intro">Mô tả nội dung và phong cách. AI tạo bản xem trước để bạn rà soát trước khi dựng MP4.</p>
      <EnvNotices forCompose />
      <label><input type="checkbox" checked={voiceMode} disabled={locked || projectId !== null} onChange={(e) => setVoiceMode(e.target.checked)} /> Dựng theo lời đọc có sẵn</label>
      {voiceMode && <label className="av-label">File lời đọc hoặc video có tiếng (tối đa 7 phút)<input type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.ogg" disabled={locked || voiceAssetId !== null} onChange={(e) => setVoiceFile(e.target.files?.[0] ?? null)} /><span className="av-muted">Nhận dạng trước để bạn kiểm tra lời đọc. AI sẽ đọc bộ ảnh và chọn ảnh khi bạn bấm tạo video.</span></label>}
      <label className="av-label">
        Tên dự án
        <input className="av-input" value={name} maxLength={200} disabled={locked || projectId !== null} onChange={(e) => setName(e.target.value)} placeholder="Vd: Quảng cáo sữa hạt 15 giây" />
      </label>
      <label className="av-label">
        Mô tả video
        <textarea className="av-input" rows={5} value={brief} maxLength={10000} disabled={locked} onChange={(e) => setBrief(e.target.value)} placeholder="Nội dung, thông điệp, phong cách, chữ cần hiện, màu thương hiệu…" />
      </label>
      <div className="hv-grid">
        <label className="av-label">
          Mẫu
          <select className="av-input" value={template} disabled={locked || projectId !== null} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Tự chọn</option>
            {tpl.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {template && <span className="av-muted hv-hint">{tpl.find((t) => t.id === template)?.description}</span>}
        </label>
        <div className="av-label">
          Tỉ lệ khung hình
          <div className="av-seg" role="group" aria-label="Tỉ lệ khung hình">
            {ASPECTS.map((a) => (
              <button key={a} type="button" aria-pressed={aspect === a} disabled={locked || projectId !== null} onClick={() => setAspect(a)}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <label className="av-label">
          Thời lượng (giây, tối đa 420 — 7 phút)
          <input className="av-input" type="number" min={1} max={420} step={1} value={duration} disabled={locked || projectId !== null || voiceMode} onChange={(e) => setDuration(Math.min(420, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
          {!voiceMode&&<span className="av-muted">Ước tính {duration<=60?1:Math.ceil(duration/50)} đoạn / lượt compose ban đầu; chi phí tăng theo số đoạn.</span>}
          {voiceMode && <span className="av-muted">Thời lượng tự lấy từ lời đọc sau khi nhận dạng.</span>}
        </label>
        <div className="av-label">
          Chất lượng xuất mặc định
          <div className="av-seg" role="group" aria-label="Chất lượng xuất">
            {(['720p', '1080p'] as const).map((qv) => (
              <button key={qv} type="button" aria-pressed={quality === qv} disabled={locked || projectId !== null} onClick={() => setQuality(qv)}>
                {qv}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="av-label">
        Ảnh, video, nhạc của bạn (tuỳ chọn)
        <span className="av-muted hv-hint">
          Ảnh PNG/JPG/WebP/GIF tối đa {bytesLabel(ASSET_LIMITS.image)}; video MP4/MOV/WebM và nhạc MP3/WAV/M4A/AAC/OGG tối đa {bytesLabel(ASSET_LIMITS.media)}; tổng {bytesLabel(ASSET_LIMITS.project)} mỗi dự án.
        </span>
        <input type="file" multiple accept={ASSET_ACCEPT} disabled={locked} onChange={(e) => { picked(e.target.files); e.target.value = ''; }} />
      </div>
      {files.length > 0 && (
        <ul className="hv-files">
          {files.map((f, i) => (
            <li key={`${f.file.name}-${i}`}>
              <span className="hv-fname" title={f.file.name}>
                {f.file.name}
              </span>
              <span className="av-muted">{bytesLabel(f.file.size)}</span>
              {f.state === 'uploading' && (
                <div className="av-bar" role="progressbar" aria-label={`Tải ${f.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((f.loaded / f.file.size) * 100)}>
                  <i style={{ width: `${Math.min(100, (f.loaded / f.file.size) * 100)}%` }} />
                </div>
              )}
              {f.state === 'done' && <span className="av-badge av-badge-ok">Đã tải</span>}
              {f.state === 'error' && <span className="av-badge av-badge-danger" title={f.error}>{f.error}</span>}
              {!locked && f.state !== 'done' && (
                <button type="button" className="av-btn av-btn-sm av-btn-ghost" aria-label={`Bỏ ${f.file.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                  Bỏ
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div>
        <button type="button" className="av-btn av-btn-sm av-btn-ghost" aria-expanded={adv} onClick={() => setAdv((v) => !v)}>
          {adv ? 'Ẩn tuỳ chọn nâng cao' : 'Tuỳ chọn nâng cao (model)'}
        </button>
      </div>
      {adv && (
        <div className="hv-grid">
          <label className="av-label">
            Model tạo video (compose)
            <select className="av-input" value={compose} disabled={locked || projectId !== null} onChange={(e) => setCompose(e.target.value)}>
              <option value="auto">Tự chọn phù hợp</option>
              {(models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="av-label">
            Model kiểm tra bằng hình (vision)
            <select className="av-input" value={vision} disabled={locked || projectId !== null} onChange={(e) => setVision(e.target.value)}>
              <option value="auto">Tự chọn phù hợp</option>
              {(models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2.5">
            <button type="button" className="av-btn av-btn-sm" disabled={models !== null} onClick={() => void loadModels()}>
              {models ? 'Đã tải danh sách model' : 'Tải danh sách model'}
            </button>
            {modelErr && <InlineError>{modelErr}</InlineError>}
          </div>
        </div>
      )}

      {error && <InlineError>{error}</InlineError>}
      {projectId !== null && !busy && <p className="hv-note hv-note-warn">Dự án đã được tạo (#{projectId}). Bấm "Thử lại" để tiếp tục các bước còn lại, không tạo trùng.</p>}
      <div className="flex items-center gap-2.5">
        <Btn type="submit" variant="primary" actionKind={voiceMode ? 'local' : 'ai'} loading={locked} disabledReason={reason ?? (blocked ? 'Bỏ các tệp không hợp lệ trước' : null)}>
          {busy ?? (projectId !== null ? 'Thử lại' : voiceMode ? 'Tải tệp & nhận dạng lời đọc' : 'Tạo bằng AI')}
        </Btn>
        {busy && abort.current && (
          <button
            type="button"
            className="av-btn"
            onClick={() => {
              cancelled.current = true;
              abort.current?.();
              setError('Đã hủy tải lên. Bấm "Thử lại" để tiếp tục.');
            }}
          >
            Hủy tải
          </button>
        )}
      </div>
    </form>
  );
}
