import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorState, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { errorMessage } from '../api/errors';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { ClipEnvProvider, type ClipEnv, type ClipQuota } from '../clips/env';
import { DesktopClipWorkspace } from '../clips/DesktopWorkspace';
import { clipKeys, useClipProjectList } from '../clips/hooks';
import { clock, SOURCE_STATUS_LABEL } from '../clips/lib';
import { NewClipProjectDialog } from '../clips/NewProjectDialog';
import type { ClipProjectSummary } from '../clips/types';
import '../clips/clips-desktop.css';
import { lanClipApi, lanDeleteClipProject } from './api';
import { RowMenu } from './RowMenu';
import { Modal } from '../components/Modal';
import { Button } from '../components/Button';
import type { PlannerStatus } from './types';
import { hrefOf, navigate } from './useHashRoute';

const pick = (r: PlannerStatus['remaining'] | undefined, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === 'number') return v;
  }
  return null;
};

/** Hạn mức còn lại của chính người dùng trong giờ này, lấy từ `/lan/api/status` → `remaining` (giữ lại cho trang LAN; app desktop không hiển thị). */
export function toClipQuota(status: PlannerStatus | undefined): ClipQuota | null {
  const r = status?.remaining;
  if (!r) return null;
  const q: ClipQuota = {
    project: pick(r, 'clip_project', 'clip_projects', 'create_clip_project'),
    source: pick(r, 'clip_source', 'clip_upload', 'upload_clip_source'),
    plan: pick(r, 'clip_plan'),
    render: pick(r, 'clip_render'),
    edit: pick(r, 'clip_edit'),
    known: false,
  };
  q.known = [q.project, q.source, q.plan, q.render, q.edit].some((v) => v !== null);
  return q;
}

/** App desktop một người dùng: không có hạn mức theo người, nên không truy vấn/hiển thị số lượt còn lại. Bản desktop xoá là xoá vĩnh viễn. */
function useDesktopEnv(): ClipEnv {
  return useMemo(() => ({ api: lanClipApi, scope: 'lan', quota: null, deleteProject: (id) => lanDeleteClipProject(id) }), []);
}

const BADGE: Record<string, string> = { transcribed: 'ok', transcribing: 'warn', uploaded: 'warn', failed: 'danger', cancelled: 'neutral' };

/** Màn "Cắt clip": danh sách dự án cắt clip + tạo dự án mới. */
export function ClipsPage() {
  useDocumentTitle('Cắt clip');
  return (
    <ClipEnvProvider value={useDesktopEnv()}>
      <ClipsList />
    </ClipEnvProvider>
  );
}

function ClipsList() {
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ClipProjectSummary | null>(null);
  const qc = useQueryClient();
  const q = useClipProjectList();
  const now = useNow();
  const rows: ClipProjectSummary[] = q.data ?? [];
  return (
    <div className="cd-list-page">
      <div className="av-page-head">
        <h1 style={{ flex: '1 1 auto' }}>Cắt clip</h1>
        <button type="button" className="av-btn av-btn-primary cd-main-action" onClick={() => setCreating(true)}>
          Dự án cắt clip mới
        </button>
      </div>
      <div className="cd-table-wrap">
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <div className="av-card cd-empty cd-list-empty"><h2>Chưa có dự án cắt clip</h2><p>Tạo dự án rồi tải video nguồn để nhận dạng lời thoại và chọn đoạn clip.</p><button type="button" className="av-btn av-btn-primary" onClick={() => setCreating(true)}>Tạo dự án</button></div>
        ) : (
          <div className="av-card av-table-wrap">
            <table className="av-table">
              <thead>
                <tr>
                  <th>Tên dự án</th>
                  <th>Video nguồn</th>
                  <th>Clip</th>
                  <th>Cập nhật</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a className="cd-row-link" href={hrefOf({ name: 'clip', id: p.id })}>
                        {p.name}
                      </a>
                    </td>
                    <td>
                      {p.source_video ? (
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <span className={`av-badge av-badge-${BADGE[p.source_video.status] ?? 'neutral'}`}>{SOURCE_STATUS_LABEL[p.source_video.status] ?? p.source_video.status}</span>
                          {p.source_video.duration_s ? <span className="av-muted av-mono">{clock(p.source_video.duration_s)}</span> : null}
                        </span>
                      ) : (
                        <span className="av-muted">Chưa tải video</span>
                      )}
                    </td>
                    <td>{p.clip_count ?? 0}</td>
                    <td className="av-muted">{fmtRelative(p.updated_at ?? p.created_at, now)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <a className="av-btn av-btn-sm" href={hrefOf({ name: 'clip', id: p.id })}>
                        Mở
                      </a>{' '}
                      {p.can_delete && (
                        <RowMenu
                          label={`Thao tác với dự án ${p.name}`}
                          items={[{ label: 'Xoá vĩnh viễn…', danger: true, disabledReason: p.delete_block, onSelect: () => setDeleting(p) }]}
                        />
                      )}
                      {p.delete_block && <div className="cd-inline-why">{p.delete_block}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <NewClipProjectDialog key={creating ? 'o' : 'c'} open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate({ name: 'clip', id })} />
      <ClipDeleteDialog key={deleting?.id ?? 'closed'} target={deleting} onClose={() => setDeleting(null)} onDeleted={(name) => {
        setDeleting(null);
        toast.success(`Đã xoá dự án "${name}"`);
        void qc.invalidateQueries({ queryKey: clipKeys.list('lan') });
      }} />
    </div>
  );
}

function ClipDeleteDialog({ target, onClose, onDeleted }: { target: ClipProjectSummary | null; onClose: () => void; onDeleted: (name: string) => void }) {
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal open={!!target} onClose={() => { if (!pending) { setConfirmation(''); setError(null); onClose(); } }} title="Xoá dự án cắt clip" footer={<>
    <Button onClick={() => { setConfirmation(''); setError(null); onClose(); }} disabled={pending}>Huỷ</Button>
    <Button variant="danger" loading={pending} disabledReason={confirmation !== 'XOA' ? 'Gõ XOA để xác nhận xoá vĩnh viễn' : null} onClick={() => {
      if (!target || confirmation !== 'XOA') return;
      setPending(true); setError(null);
      lanDeleteClipProject(target.id).then(() => onDeleted(target.name), (e: unknown) => setError(errorMessage(e))).finally(() => setPending(false));
    }}>Xoá vĩnh viễn</Button>
  </>}>
    <div className="space-y-3 text-sm">
      <p>Xoá vĩnh viễn dự án <strong>{target?.name}</strong>, video nguồn, lời thoại và các clip khỏi máy. Không thể khôi phục.</p>
      <label className="block text-xs font-semibold" htmlFor="clip-delete-confirm">Gõ <span className="font-mono">XOA</span> để xác nhận</label>
      <input id="clip-delete-confirm" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" />
      {error && <p className="text-danger-fg" role="alert">{error}</p>}
    </div>
  </Modal>;
}

/** Trang một dự án cắt clip. */
export function ClipProjectPage({ id }: { id: number }) {
  return (
    <ClipEnvProvider value={useDesktopEnv()}>
      <DesktopClipWorkspace
        projectId={id}
        crumb={<a href={hrefOf({ name: 'clips' })}>Cắt clip</a>}
        onDeleted={() => {
          toast.success('Đã xoá dự án.');
          navigate({ name: 'clips' });
        }}
      />
    </ClipEnvProvider>
  );
}
