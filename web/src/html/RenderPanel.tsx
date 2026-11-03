import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { ApiError } from '../api/errors';
import { InlineError } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { Btn } from '../planner/ws-ui';
import { htmlApi } from './api';
import { idemDone, idemKey } from './idem';
import { bytesLabel, EnvNotices, hk, RENDER_ACTIVE, RENDER_LABEL, RENDER_TONE, SettingsLink, useHtmlEnv } from './lib';
import type { HtmlProject, HtmlQuality, HtmlRender, HtmlVersion } from './types';

const downloadUrl = (u: string) => `${u}${u.includes('?') ? '&' : '?'}download=1`;

/** Dựng MP4: chọn chất lượng, hàng đợi/tiến độ, hủy/thử lại/tải/mở thư mục. Key idempotency theo (dự án, phiên bản, chất lượng) giữ qua reload đến khi thành công. */
export function RenderPanel({ project, version, versions, renders, loadError }: { project: HtmlProject; version: HtmlVersion | undefined; versions: HtmlVersion[]; renders: HtmlRender[]; loadError: string | null }) {
  const qc = useQueryClient();
  const env = useHtmlEnv();
  const now = useNow();
  const readyVersions = useMemo(() => versions.filter((v) => v.status === 'ready'), [versions]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const chosenVersion = readyVersions.find((v) => v.version === selectedVersion) ?? (version?.status === 'ready' ? version : readyVersions[0]);
  const [quality, setQuality] = useState<HtmlQuality>(project.quality);
  const [error, setError] = useState<{ msg: string; code?: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: hk.renders(project.id) });

  const create = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const scope = `render:${project.id}:${chosenVersion!.version}:${quality}`;
      const r = await htmlApi.createRender(project.id, chosenVersion!.version, { quality, idempotency_key: idemKey(scope) });
      idemDone(scope);
      return r;
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => {
      // Lỗi nghiệp vụ (409/400) là kết quả cuối: bỏ key để lần bấm sau là hành động mới. Lỗi mạng/5xx giữ key để gửi lại an toàn.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && chosenVersion) idemDone(`render:${project.id}:${chosenVersion.version}:${quality}`);
      setError({ msg: errorMessage(e), code: e instanceof ApiError ? e.code : undefined });
      refresh();
    },
  });

  const activeSame = chosenVersion ? renders.find((r) => r.version === chosenVersion.version && r.quality === quality && RENDER_ACTIVE(r)) : undefined;
  const reason = !chosenVersion ? 'Chọn phiên bản đã sẵn sàng' : env.rendererMissing ? 'Chưa có bộ dựng video (xem Cài đặt)' : activeSame ? 'Phiên bản này đang có lượt dựng cùng chất lượng trong hàng đợi' : null;

  return (
    <section className="av-card av-card-pad hv-render" aria-labelledby="hv-render-h">
      <div className="hv-render-heading"><div><h2 id="hv-render-h">Dựng MP4</h2><span className="av-muted hv-hint">Kết xuất tệp video để tải về</span></div></div>
      <EnvNotices forRender />
      {loadError && <InlineError>{loadError}</InlineError>}
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="av-label hv-render-version">Phiên bản
          <select className="av-input" value={chosenVersion?.version ?? ''} onChange={(e) => setSelectedVersion(Number(e.target.value))}>
            {readyVersions.length === 0 && <option value="">Chưa có bản sẵn sàng</option>}
            {readyVersions.map((v) => <option key={v.id} value={v.version}>v{v.version} · {v.created_by === 'ai' ? 'AI' : 'Bạn'}</option>)}
          </select>
        </label>
        <div className="av-seg" role="group" aria-label="Chất lượng dựng">
          {(['720p', '1080p'] as const).map((q) => (
            <button key={q} type="button" aria-pressed={quality === q} onClick={() => setQuality(q)}>
              {q}
            </button>
          ))}
        </div>
        <Btn variant="primary" actionKind="local" loading={create.isPending} disabledReason={reason} onClick={() => create.mutate()}>
          Dựng v{chosenVersion?.version ?? '…'} MP4
        </Btn>
      </div>
      {error && (
        <InlineError>
          {error.msg}
          {error.code === 'HTML_RENDERER_MISSING' && (
            <>
              {' '}
              <SettingsLink>Mở Cài đặt</SettingsLink>
            </>
          )}
        </InlineError>
      )}
      {renders.length === 0 ? (
        <p className="av-muted">Chưa có lượt dựng nào.</p>
      ) : (
        <ul className="hv-renders">
          {renders.map((r) => (
            <RenderRow key={r.id} projectId={project.id} r={r} now={now} onChange={refresh} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RenderRow({ projectId, r, now, onChange }: { projectId: number; r: HtmlRender; now: number; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const act = useMutation({
    meta: { silent: true },
    mutationFn: async (kind: 'cancel' | 'retry' | 'reveal') => {
      if (kind === 'cancel') return htmlApi.cancelRender(projectId, r.id);
      if (kind === 'reveal') return htmlApi.revealRender(projectId, r.id);
      const scope = `retry:${projectId}:${r.id}`;
      const res = await htmlApi.retryRender(projectId, r.id, { idempotency_key: idemKey(scope) });
      idemDone(scope);
      return res;
    },
    onSuccess: (_d, kind) => {
      if (kind === 'reveal') toast.info('Đã mở thư mục chứa video.');
      onChange();
    },
    onError: (e, kind) => {
      if (kind === 'retry' && e instanceof ApiError && e.status >= 400 && e.status < 500) idemDone(`retry:${projectId}:${r.id}`);
      toast.error(errorMessage(e));
      onChange();
    },
  });
  const pct = r.progress === null ? null : Math.round(Math.min(1, r.progress > 1 ? r.progress / 100 : r.progress) * 100);
  return (
    <li className="hv-render-row">
      <div className="hv-poster" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
        {r.poster_url ? <img src={r.poster_url} alt={`Ảnh bìa v${r.version} ${r.quality}`} loading="lazy" /> : <span className="av-muted">{r.quality}</span>}
      </div>
      <div className="hv-render-main">
        <div className="flex flex-wrap items-center gap-2">
          <strong>
            v{r.version} · {r.quality}
          </strong>
          <span className={`av-badge av-badge-${RENDER_TONE[r.status]}`}>{RENDER_LABEL[r.status]}</span>
          <span className="av-muted">{fmtRelative(r.finished_at ?? r.started_at ?? r.created_at, now)}</span>
          {r.status === 'ready' && r.bytes ? <span className="av-muted">{bytesLabel(r.bytes)}{r.duration_s ? ` · ${r.duration_s.toFixed(1)} giây` : ''}</span> : null}
        </div>
        {r.status === 'queued' && (
          <p className="av-muted">{r.queue?.state === 'waiting' ? `Đang chờ đến lượt dựng${r.queue.position ? ` (vị trí ${r.queue.position})` : ''}` : 'Đang chờ bắt đầu…'}</p>
        )}
        {r.status === 'rendering' && (
          <div className="av-bar" role="progressbar" aria-label="Tiến độ dựng" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <i style={{ width: `${pct ?? 5}%` }} />
          </div>
        )}
        {r.status === 'rendering' && <span className="av-muted">{pct === null ? 'Đang dựng…' : `${pct}%`}</span>}
        {(r.status === 'failed' || r.status === 'cancelled') && r.error && <InlineError>{r.error}{r.error_code === 'HTML_RENDERER_MISSING' && <> <SettingsLink>Mở Cài đặt</SettingsLink></>}</InlineError>}
        <div className="flex flex-wrap items-center gap-2">
          {RENDER_ACTIVE(r) && (
            <Btn size="sm" loading={act.isPending && act.variables === 'cancel'} onClick={() => act.mutate('cancel')}>
              Hủy
            </Btn>
          )}
          {(r.status === 'failed' || r.status === 'cancelled') && (
            <Btn size="sm" icon="refresh" loading={act.isPending && act.variables === 'retry'} onClick={() => act.mutate('retry')}>
              Thử lại
            </Btn>
          )}
          {r.status === 'ready' && r.video_url && (
            <>
              <button type="button" className="av-btn av-btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? 'Ẩn video' : 'Xem'}
              </button>
              <a className="av-btn av-btn-sm av-btn-primary" href={downloadUrl(r.video_url)} download>
                Tải về
              </a>
              <Btn size="sm" loading={act.isPending && act.variables === 'reveal'} onClick={() => act.mutate('reveal')}>
                Mở thư mục
              </Btn>
            </>
          )}
        </div>
        {open && r.video_url && <video className="hv-video" src={r.video_url} poster={r.poster_url ?? undefined} controls preload="metadata" style={{ aspectRatio: `${r.width} / ${r.height}` }} />}
      </div>
    </li>
  );
}
