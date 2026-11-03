import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import '@hyperframes/player';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../api/errors';
import { ErrorState, InlineError, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { Btn } from '../planner/ws-ui';
import { DeleteProjectDialog, RowMenu } from '../planner/RowMenu';
import { hrefOf, navigate } from '../planner/useHashRoute';
import { htmlApi } from './api';
import { hashOf, idemDone, idemKey } from './idem';
import { ASPECT_LABEL, ASSET_ACCEPT, assetFileProblem, bytesLabel, EnvNotices, hk, RENDER_ACTIVE, VERSION_ACTIVE, VersionChip, versionProblem, useHtmlEnv } from './lib';
import { RenderPanel } from './RenderPanel';
import type { HtmlAsset, HtmlProject, HtmlVariable, HtmlVersion } from './types';
import './html.css';
import { VoiceCard, useHtmlVoice } from './VoiceCard';
import { ImageReviewCard } from './ImageReviewCard';
import { VideoEstimate } from './VideoEstimate';
const versionHasWork=(v:HtmlVersion)=>VERSION_ACTIVE(v.status)||!!v.segments?.some(s=>['queued','composing'].includes(s.status)&&v.status!=='cancelled');

/** Chạy một hành động có idempotency key bền: lỗi mạng/5xx giữ key (gửi lại sau reload vẫn là cùng hành động); thành công hoặc lỗi nghiệp vụ 4xx thì bỏ key. */
async function withKey<T>(scope: string, fn: (key: string) => Promise<T>): Promise<T> {
  try {
    const r = await fn(idemKey(scope));
    idemDone(scope);
    return r;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemDone(scope);
    throw e;
  }
}

export function HtmlProjectPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const now = useNow();
  const [sel, setSel] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [section, setSection] = useState<'preview' | 'files'>('preview');

  const project = useQuery({ queryKey: hk.project(id), queryFn: () => htmlApi.get(id), refetchInterval: (q) => (q.state.data && q.state.data.active_versions > 0 ? 3000 : false) });
  const versions = useQuery({
    queryKey: hk.versions(id),
    queryFn: () => htmlApi.versions(id),
    refetchInterval: (q) => (q.state.data?.some(versionHasWork) ? 2500 : false),
  });
  const assets = useQuery({ queryKey: hk.assets(id), queryFn: () => htmlApi.assets(id), refetchInterval: versions.data?.some(versionHasWork) ? 1500 : false });
  const voice = useHtmlVoice(id);
  const renders = useQuery({
    queryKey: hk.renders(id),
    queryFn: () => htmlApi.renders(id),
    retry: false,
    refetchInterval: (q) => (q.state.data?.some(RENDER_ACTIVE) ? 1500 : false),
  });
  const p = project.data;
  useDocumentTitle(p?.name ?? 'Video HTML');

  const vs = useMemo(() => versions.data ?? [], [versions.data]);
  const selected = vs.find((v) => v.version === sel) ?? vs[0];
  const latestReady = vs.find((v) => v.status === 'ready');
  const hasActive = vs.some(versionHasWork);
  // Khi phiên bản đang tạo chuyển sang sẵn sàng/lỗi, làm mới dự án + danh sách.
  const activeKey = vs.map((v) => `${v.version}:${v.status}`).join(',');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void qc.invalidateQueries({ queryKey: hk.project(id) });
    void qc.invalidateQueries({ queryKey: hk.list });
    void qc.invalidateQueries({ queryKey: hk.assets(id) });
  }, [activeKey, id, qc]);

  const afterNewVersion = (v: HtmlVersion) => {
    setSel(v.version);
    void qc.invalidateQueries({ queryKey: hk.versions(id) });
    void qc.invalidateQueries({ queryKey: hk.project(id) });
  };

  if (project.isLoading) return <div className="hv-page hv-body"><Skeleton className="h-40" /></div>;
  if (project.error || !p) return <div className="hv-page hv-body"><ErrorState error={project.error ?? new Error('Không tải được dự án')} onRetry={() => void project.refetch()} /></div>;

  return (
    <div className="hv-page">
      <header className="av-header">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
          <nav aria-label="Đường dẫn" className="av-crumb">
            <a href={hrefOf({ name: 'html' })}>Video HTML</a>
            <span> / {p.name}</span>
          </nav>
          <h1>{p.name}</h1>
          <span className="av-muted" style={{ fontSize: 12.5 }}>
            {ASPECT_LABEL[p.aspect]} · {p.width}×{p.height} · {p.duration_s} giây · 30 fps · {p.template_id ? `mẫu ${p.template_id}` : 'tự chọn mẫu'}
          </span>
        </div>
        <RowMenu label="Thao tác với dự án" items={[{ label: 'Xoá vĩnh viễn', danger: true, disabledReason: p.delete_block?.message ?? null, onSelect: () => setDeleting(true) }]} />
      </header>

      <div className="hv-body">
        <EnvNotices forCompose={hasActive || vs.length === 0} />
        <ImageReviewCard id={id} assets={assets.data ?? []} scanning={vs.some((v) => VERSION_ACTIVE(v.status) && v.job?.queue?.wait_reason !== 'image_labels')} resuming={vs.some((v) => v.job?.queue?.wait_reason === 'image_labels')} />
        <VoiceCard id={id} assets={assets.data ?? []} locked={hasActive} />
        <nav className="hv-tabs" role="tablist" aria-label="Phần của dự án">
          <button id="hv-tab-preview" type="button" role="tab" aria-controls="hv-panel-preview" tabIndex={section === 'preview' ? 0 : -1} aria-selected={section === 'preview'} className={section === 'preview' ? 'is-active' : ''} onClick={() => setSection('preview')} onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'End') { e.preventDefault(); setSection('files'); document.getElementById('hv-tab-files')?.focus(); } }}>Xem trước &amp; phiên bản <span>{vs.length}</span></button>
          <button id="hv-tab-files" type="button" role="tab" aria-controls="hv-panel-files" tabIndex={section === 'files' ? 0 : -1} aria-selected={section === 'files'} className={section === 'files' ? 'is-active' : ''} onClick={() => setSection('files')} onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home') { e.preventDefault(); setSection('preview'); document.getElementById('hv-tab-preview')?.focus(); } }}>Tệp &amp; xuất MP4 <span>{assets.data?.length ?? p.asset_count}</span></button>
        </nav>
        <div id="hv-panel-preview" className="hv-tab-panel" role="tabpanel" aria-labelledby="hv-tab-preview" hidden={section !== 'preview'} tabIndex={0}>
          <div className="hv-detail-grid">
            <div className="hv-col hv-preview-col">
              {selected && <VersionPane key={selected.version} project={p} version={selected} assets={assets.data??[]} onCreated={afterNewVersion} onCancelled={() => void qc.invalidateQueries({ queryKey: hk.versions(id) })} />}
              {!selected && <div className="av-card av-card-pad hv-no-preview"><strong>Chưa có bản xem trước</strong><span className="av-muted">Tạo bản đầu tiên từ mô tả đã lưu của dự án.</span></div>}
            </div>
            <div className="hv-col hv-edit-col">
              {(vs.length === 0 || (!latestReady && !hasActive) || (!!voice.data && !hasActive)) && <ComposeCard project={p} onCreated={afterNewVersion} needsImageLabels={assets.data?.some((a) => !!a.scan_error_code && !a.label_confirmed)} failed={vs[0]?.status === 'failed' ? vs[0] : undefined} />}
              {selected?.status === 'ready' && <Variables key={`${selected.id}`} project={p} version={selected} assets={assets.data ?? []} onCreated={afterNewVersion} />}
              {selected?.status === 'ready' && <Feedback project={p} version={selected} onCreated={afterNewVersion} />}
              {selected?.status === 'ready' && !selected.segments && selected.variables.length === 0 && <p className="av-muted hv-no-vars">Bản này không khai báo trường chỉnh nhanh. Bạn có thể góp ý để AI tạo phiên bản mới.</p>}
            </div>
            <section className="av-card av-card-pad" aria-labelledby="hv-ver-h">
              <h2 id="hv-ver-h">Lịch sử phiên bản <span className="av-muted hv-hint">{vs.length} bản</span></h2>
              {vs.length === 0 ? (
                <p className="av-muted">Chưa có phiên bản nào.</p>
              ) : (
                <ul className="hv-versions">
                  {vs.map((v) => (
                    <li key={v.id}>
                      <button type="button" className="hv-ver" aria-current={selected?.version === v.version ? 'true' : undefined} onClick={() => setSel(v.version)}>
                        <span className="hv-ver-top">
                          <strong>v{v.version}</strong>
                          <VersionChip status={v.status} />
                          <span className="av-muted">{v.created_by === 'ai' ? 'AI' : 'Bạn'}</span>
                          {v.version !== vs[0]?.version && <span className="hv-old-tag">Phiên bản cũ</span>}
                          {v.parent_version !== null && <span className="av-muted hv-parent">từ v{v.parent_version}</span>}
                          <span className="av-muted hv-ver-time">{fmtRelative(v.created_at, now)}</span>
                        </span>
                        <span className="hv-ver-sum">{v.summary ?? v.feedback ?? v.prompt}</span>
                        {v.policy.compose && v.policy.compose !== 'auto' && <span className="av-muted hv-hint">Model: {v.policy.compose}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {versions.error && <InlineError>{errorMessage(versions.error)}</InlineError>}
            </section>
          </div>
        </div>
        <div id="hv-panel-files" className="hv-tab-panel" role="tabpanel" aria-labelledby="hv-tab-files" hidden={section !== 'files'} tabIndex={0}>
          <div className="hv-files-grid">
            <AssetsCard project={p} assets={assets.data ?? []} loadError={assets.error ? errorMessage(assets.error) : null} />
            <RenderPanel project={p} version={selected?.status === 'ready' ? selected : latestReady} versions={vs} renders={renders.data ?? []} loadError={renders.error ? errorMessage(renders.error) : null} />
          </div>
        </div>
      </div>
      <DeleteProjectDialog
        target={deleting ? p : null}
        what="dự án Video HTML"
        onDelete={htmlApi.remove}
        onClose={() => setDeleting(false)}
        onDeleted={(name) => {
          toast.success(`Đã xoá dự án "${name}"`);
          void qc.invalidateQueries({ queryKey: hk.list });
          navigate({ name: 'html' });
        }}
      />
    </div>
  );
}

/** Tạo phiên bản đầu (hoặc tạo lại khi các lần trước đều lỗi/hủy). */
function ComposeCard({ project, onCreated, failed, needsImageLabels }: { project: HtmlProject; onCreated: (v: HtmlVersion) => void; failed?: HtmlVersion; needsImageLabels?: boolean }) {
  const env = useHtmlEnv();
  const voice = useHtmlVoice(project.id);
  const [prompt, setPrompt] = useState(project.brief);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = needsImageLabels ? 'Gán nhãn và xác nhận các ảnh chưa đọc được trước khi tạo video' : voice.data && voice.data.status !== 'ready' ? 'Nhận dạng và kiểm tra lời đọc trước khi tạo video' : !prompt.trim() ? 'Nhập mô tả video' : env.aiMissingKey ? 'Chưa có API key của AI (vào Cài đặt)' : null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = prompt.trim();
      const r = await withKey(`compose:${project.id}:${hashOf(text)}`, (k) => htmlApi.compose(project.id, { prompt: text, idempotency_key: k }));
      onCreated(r.version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="av-card av-card-pad" aria-labelledby="hv-compose-h">
      <h2 id="hv-compose-h">{failed ? 'Tạo lại video' : 'Tạo video bằng AI'}</h2>
      <VideoEstimate id={project.id} enabled={!voice.data||voice.data.status==='ready'} />
      {voice.data?.status === 'ready' && <p className="av-muted">Dựng theo lời đọc đã kiểm tra. AI quét ảnh mới một lần và chọn ảnh theo nội dung; phụ đề lấy từ ASR.</p>}
      <label className="av-label">
        Mô tả video
        <textarea className="av-input" rows={5} value={prompt} maxLength={10000} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div>
      <Btn variant="primary" actionKind="ai" loading={busy} disabledReason={reason} onClick={() => void go()}>
          {failed ? 'Tạo lại' : 'Để AI tạo video'}
        </Btn>
      </div>
    </section>
  );
}

/** Khung xem phiên bản đang chọn: tiến trình khi đang tạo, lỗi, hoặc player xem trước. */
function VersionPane({ project, version, onCancelled, onCreated, assets }: { project: HtmlProject; version: HtmlVersion; onCancelled: () => void;onCreated:(v:HtmlVersion)=>void;assets:HtmlAsset[] }) {
  const env = useHtmlEnv();
  const [busy, setBusy] = useState(false);
  const active = VERSION_ACTIVE(version.status);
  const cancel = async () => {
    setBusy(true);
    try {
      await htmlApi.cancelVersion(project.id, version.version);
      onCancelled();
    } catch (e) {
      toast.error(errorMessage(e));
      onCancelled();
    } finally {
      setBusy(false);
    }
  };
  const q = version.job?.queue;
  const waitingImages = q?.wait_reason === 'image_labels';
  const problem = versionProblem(version);
  let body: ReactNode;
  if (active) {
    body = (
      <>
        <div className="hv-working" role="status">
          <span className="hv-spin" aria-hidden="true" />
          <div>
            <strong>{waitingImages ? 'Đang chờ xác nhận nhãn ảnh' : version.status === 'validating' ? 'Đang kiểm tra bản dựng…' : q?.state === 'waiting' ? 'Đang chờ đến lượt…' : 'AI đang tạo video…'}</strong>
            <p className="av-muted">
              {waitingImages ? 'Nhập nhãn và xác nhận các ảnh chưa đọc được ở phía trên để tiếp tục chính job này.' : q?.state === 'waiting'
                ? `Phía trước còn ${q.ahead ?? (q.position ? q.position - 1 : 0)} việc${q.position ? ` (vị trí ${q.position})` : ''}.${env.workerOffline ? ' Worker AI đang offline nên chưa bắt đầu.' : ''}`
                : 'Có thể mất một vài phút. Bạn có thể rời trang, tiến trình vẫn chạy.'}
            </p>
          </div>
        </div>
        <div>
          <Btn loading={busy} onClick={() => void cancel()}>
            Hủy
          </Btn>
        </div>
      </>
    );
  } else if (version.status === 'ready') {
    body = version.segments?null:<PreviewPane project={project} version={version} />;
  } else {
    body = (
      <>
        <InlineError>{problem}</InlineError>
        {version.lint_report && version.lint_report.errors.length > 0 && (
          <ul className="hv-lint">
            {version.lint_report.errors.slice(0, 8).map((e, i) => (
              <li key={i}>
                <code>{e.code}</code> {e.message}
                {e.file ? <span className="av-muted"> ({e.file})</span> : null}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  const warns = version.status === 'ready' ? version.lint_report?.warnings ?? [] : [];
  return (
    <section className="av-card av-card-pad" aria-labelledby="hv-pane-h">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 id="hv-pane-h" className="flex-1">
          Xem trước v{version.version}
        </h2>
        <VersionChip status={version.status} />
        {version.version !== project.latest_version?.version && <span className="hv-old-tag">Xem trước đã cũ</span>}
      </div>
      {version.status === 'ready' && <p className="av-muted hv-preview-note">Bản xem trước tương tác chạy trong app. Tệp MP4 được dựng riêng ở mục Tệp &amp; xuất MP4.</p>}
      {body}
      {version.status==='failed'&&versionHasWork(version)&&<Btn loading={busy} onClick={()=>void cancel()}>Hủy các đoạn còn chờ</Btn>}
      {version.segments&&<SegmentPanel project={project} version={version} assets={assets} onCreated={onCreated} onRefresh={onCancelled}/>}
      {version.summary && <p>{version.summary}</p>}
      {warns.length > 0 && (
        <details>
          <summary className="av-muted">{warns.length} cảnh báo kiểm tra</summary>
          <ul className="hv-lint">
            {warns.slice(0, 10).map((w, i) => (
              <li key={i}>
                <code>{w.code}</code> {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Xem trước trong `<hyperframes-player>`: nguồn là origin xem trước riêng (cô lập), sandbox opaque. */
function PreviewPane({ project, version, segment }: { project: HtmlProject; version: HtmlVersion;segment?:number }) {
  const q = useQuery({
    queryKey: [...hk.preview(project.id, version.version),segment??0],
    queryFn: () => segment?htmlApi.segmentPreview(project.id,version.version,segment):htmlApi.preview(project.id, version.version),
    staleTime: 20 * 60_000,
    retry: false,
  });
  return (
    <div className="hv-stage">
      <div className="hv-player" style={{ aspectRatio: `${project.width} / ${project.height}`, width: project.width > project.height ? '100%' : 'min(100%, 360px)' }}>
        {q.isLoading ? (
          <Skeleton className="h-full" />
        ) : q.data ? (
          <hyperframes-player key={q.data.url} src={q.data.url} sandbox-origin="opaque" controls style={{ width: '100%', height: '100%', display: 'block' }} />
        ) : (
          <div className="hv-player-err">
            <InlineError>{q.error ? errorMessage(q.error) : 'Không mở được xem trước.'}</InlineError>
            <button type="button" className="av-btn av-btn-sm" onClick={() => void q.refetch()}>
              Thử lại
            </button>
          </div>
        )}
      </div>
      {q.data && (
        <button type="button" className="av-btn av-btn-sm av-btn-ghost" onClick={() => void q.refetch()}>
          Tải lại xem trước
        </button>
      )}
    </div>
  );
}

function SegmentPanel({project,version,assets,onCreated,onRefresh}:{project:HtmlProject;version:HtmlVersion;assets:HtmlAsset[];onCreated:(v:HtmlVersion)=>void;onRefresh:()=>void}){
 const [idx,setIdx]=useState(1),[feedback,setFeedback]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const env=useHtmlEnv(),row=version.segments?.find(s=>s.idx===idx);
 const run=async(retry:boolean)=>{setBusy(true);setError(null);try{
  if(retry){await htmlApi.retrySegment(project.id,version.version,idx);onRefresh();}
  else{const r=await withKey(`segment:${version.id}:${idx}:${hashOf(feedback)}`,k=>htmlApi.reviseSegment(project.id,version.version,idx,{feedback:feedback.trim()||'Tạo lại hình ảnh và bố cục đoạn này, giữ nội dung và phong cách chung',idempotency_key:k}));onCreated(r.version);}
 }catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 return <div className="hv-col">
  <p role="status">Đã xong {version.segments_ready??0}/{version.segments?.length} đoạn</p>
  <div className="flex flex-wrap gap-2" role="group" aria-label="Các đoạn video">{version.segments?.map(s=><button type="button" className="av-btn av-btn-sm" key={s.idx} aria-pressed={idx===s.idx} onClick={()=>setIdx(s.idx)}>Đoạn {s.idx} · {s.start_s.toFixed(1)}–{s.end_s.toFixed(1)}s · {{queued:'Chờ',composing:'Đang tạo',ready:'Sẵn sàng',failed:'Lỗi'}[s.status]??s.status}</button>)}</div>
  {row?.error&&<InlineError>Đoạn {idx}: {row.error}</InlineError>}
  {row?.status==='ready'&&<PreviewPane project={project} version={version} segment={idx}/>}
  {row?.status==='ready'&&version.status==='ready'&&<>
    <Variables key={`${version.id}:${idx}`} project={project} version={{...version,variables:row.variables}} assets={assets} onCreated={onCreated} segment={idx}/>
    <label className="av-label">Góp ý riêng đoạn {idx}<textarea className="av-input" rows={2} maxLength={5000} value={feedback} onChange={e=>setFeedback(e.target.value)}/></label>
    <Btn actionKind="ai" loading={busy} disabledReason={env.aiMissingKey?'Chưa có API key':null} onClick={()=>void run(false)}>Tạo lại đoạn {idx}</Btn>
  </>}
  {row?.status==='failed'&&version.status!=='cancelled'&&<Btn actionKind="ai" loading={busy} onClick={()=>void run(true)}>Thử lại đoạn {idx}</Btn>}
  {error&&<InlineError>{error}</InlineError>}
 </div>;
}

function Feedback({ project, version, onCreated }: { project: HtmlProject; version: HtmlVersion; onCreated: (v: HtmlVersion) => void }) {
  const env = useHtmlEnv();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = !text.trim() ? 'Nhập góp ý' : env.aiMissingKey ? 'Chưa có API key của AI (vào Cài đặt)' : null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const fb = text.trim();
      const r = await withKey(`revise:${project.id}:${version.version}:${hashOf(fb)}`, (k) => htmlApi.revise(project.id, version.version, { feedback: fb, idempotency_key: k }));
      setText('');
      onCreated(r.version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="av-card av-card-pad" aria-labelledby="hv-fb-h">
      <h2 id="hv-fb-h">Góp ý để AI sửa</h2>
      <p className="av-muted">AI sẽ tạo phiên bản mới từ v{version.version}; bản này được giữ nguyên.</p>
      <textarea className="av-input" rows={3} value={text} maxLength={5000} aria-label="Góp ý" onChange={(e) => setText(e.target.value)} placeholder="Vd: Chữ tiêu đề to hơn, đổi nền sang màu xanh, thêm 1 giây ở cảnh cuối" />
      {error && <InlineError>{error}</InlineError>}
      <div>
        <Btn variant="primary" icon="send" actionKind="ai" loading={busy} disabledReason={reason} onClick={() => void go()}>
          Gửi góp ý
        </Btn>
      </div>
    </section>
  );
}

function Variables({ project, version, assets, onCreated, segment }: { project: HtmlProject; version: HtmlVersion; assets: HtmlAsset[]; onCreated: (v: HtmlVersion) => void;segment?:number }) {
  const vars = version.variables;
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(vars.map((v) => [v.id, v.value])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (vars.length === 0) return null;
  const changed = Object.fromEntries(vars.filter((v) => vals[v.id] !== v.value).map((v) => [v.id, vals[v.id]!]));
  const n = Object.keys(changed).length;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await withKey(`vars:${project.id}:${version.version}:${hashOf(JSON.stringify(changed))}`, (k) => segment?htmlApi.segmentVariables(project.id,version.version,segment,{values:changed,idempotency_key:k}):htmlApi.setVariables(project.id, version.version, { values: changed, idempotency_key: k }));
      onCreated(r.version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (v: HtmlVariable) => {
    const val = vals[v.id] ?? '';
    const set = (x: string) => setVals((c) => ({ ...c, [v.id]: x }));
    if (v.type === 'color')
      return (
        <span className="flex items-center gap-2">
          <input type="color" aria-label={v.label} value={/^#[0-9a-f]{6}$/i.test(val) ? val : '#000000'} onChange={(e) => set(e.target.value)} className="hv-color" />
          <code>{val}</code>
        </span>
      );
    if (v.type === 'asset') {
      const originalKind = assets.find((a) => String(a.id) === v.value)?.kind;
      const choices = assets.filter((a) => !originalKind || a.kind === originalKind);
      const chosen = choices.find((a) => String(a.id) === val);
      return <span className="hv-asset-choice">
        {chosen?.kind === 'image' && <img src={chosen.url} alt={chosen.description?.summary ?? chosen.name} />}
        <select className="av-input" value={val} onChange={(e) => set(e.target.value)}>
          {!choices.some((a) => String(a.id) === val) && <option value={val}>{val ? `Tệp #${val} (đã xoá?)` : 'Chọn tệp'}</option>}
          {choices.map((a) => <option key={a.id} value={String(a.id)}>#{a.id} · {a.name}</option>)}
        </select>
        {chosen?.description && <span className="av-muted hv-hint">{chosen.description.summary}{chosen.description.uncertain ? ' · Cần kiểm tra chi tiết ảnh' : ''}</span>}
      </span>;
    }
    return v.maxLength && v.maxLength > 80 ? (
      <textarea className="av-input" rows={3} maxLength={v.maxLength} value={val} onChange={(e) => set(e.target.value)} />
    ) : (
      <input className="av-input" maxLength={v.maxLength} value={val} onChange={(e) => set(e.target.value)} />
    );
  };
  return (
    <section className="av-card av-card-pad" aria-labelledby="hv-var-h">
      <h2 id="hv-var-h">Chỉnh nội dung nhanh</h2>
      <p className="av-muted">Đổi chữ, màu, ảnh mà không cần gọi AI. Lưu sẽ tạo phiên bản mới.</p>
      <div className="hv-vars">
        {vars.map((v) => (
          <label key={v.id} className="av-label">
            {v.label}
            {field(v)}
          </label>
        ))}
      </div>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex items-center gap-2.5">
        <Btn variant="primary" actionKind="local" loading={busy} disabledReason={n === 0 ? 'Chưa có thay đổi' : null} onClick={() => void go()}>
          Lưu thành phiên bản mới
        </Btn>
        {n > 0 && !busy && (
          <button type="button" className="av-btn av-btn-ghost" onClick={() => setVals(Object.fromEntries(vars.map((v) => [v.id, v.value])))}>
            Hoàn tác
          </button>
        )}
      </div>
    </section>
  );
}

function AssetsCard({ project, assets, loadError }: { project: HtmlProject; assets: HtmlAsset[]; loadError: string | null }) {
  const qc = useQueryClient();
  const [up, setUp] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: hk.assets(project.id) });
    void qc.invalidateQueries({ queryKey: hk.project(project.id) });
  };
  const upload = async (list: FileList | null) => {
    if (!list) return;
    setError(null);
    for (const f of [...list]) {
      const bad = assetFileProblem(f);
      if (bad) {
        setError(`${f.name}: ${bad}`);
        continue;
      }
      setUp({ name: f.name, pct: 0 });
      try {
        await htmlApi.uploadAsset(project.id, f, (l, t) => setUp({ name: f.name, pct: Math.round((l / t) * 100) })).promise;
      } catch (e) {
        setError(`${f.name}: ${errorMessage(e)}`);
      }
    }
    setUp(null);
    refresh();
  };
  const remove = async (a: HtmlAsset) => {
    try {
      await htmlApi.deleteAsset(project.id, a.id);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <section className="av-card av-card-pad" aria-labelledby="hv-asset-h">
      <div className="hv-assets-head"><div><h2 id="hv-asset-h">Tệp dự án</h2><span className="av-muted hv-hint">{assets.length} tệp · {bytesLabel(project.asset_bytes)} / {bytesLabel(1_073_741_824)}</span></div><label className="av-btn av-btn-sm hv-upload">Thêm tệp…<input type="file" multiple accept={ASSET_ACCEPT} disabled={!!up} aria-label="Thêm tệp" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} /></label></div>
      {loadError && <InlineError>{loadError}</InlineError>}
      {assets.length > 0 && (
        <ul className="hv-assets">
          {assets.map((a) => (
            <li key={a.id}>
              {a.kind === 'image' ? <img src={a.url} alt="" loading="lazy" /> : <span className="hv-asset-ico av-muted">{a.kind === 'video' ? 'Video' : 'Nhạc'}</span>}
              <code className="hv-fname" title={a.name}>
                {a.name}
                {a.description && <span className="hv-image-description">{a.description.summary}{a.description.details ? ` · ${a.description.details}` : ''}{a.description.uncertain ? ' · Cần kiểm tra chi tiết ảnh' : ''}</span>}
              </code>
              <span className="av-muted">{bytesLabel(a.bytes)}</span>
              <button type="button" className="av-btn av-btn-sm av-btn-ghost" aria-label={`Xoá ${a.name}`} onClick={() => void remove(a)}>
                Xoá
              </button>
            </li>
          ))}
        </ul>
      )}
      {up && (
        <div className="av-bar" role="progressbar" aria-label={`Đang tải ${up.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={up.pct}>
          <i style={{ width: `${up.pct}%` }} />
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
      {up && <span className="av-muted hv-upload-status">Đang tải {up.name} · {up.pct}%</span>}
      <span className="av-muted hv-hint">Tệp thêm sau chỉ được dùng cho lần AI tạo hoặc sửa tiếp theo; phiên bản đã có giữ nguyên.</span>
    </section>
  );
}
