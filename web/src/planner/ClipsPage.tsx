import { useState } from 'react';
import { ErrorState, Skeleton } from '../components/States';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useNow } from '../lib/useNow';
import { ClipEnvProvider, type ClipEnv, type ClipQuota } from '../clips/env';
import { DesktopClipWorkspace } from '../clips/DesktopWorkspace';
import { useClipProjectList } from '../clips/hooks';
import { clock, SOURCE_STATUS_LABEL } from '../clips/lib';
import { NewClipProjectDialog } from '../clips/NewProjectDialog';
import type { ClipProjectSummary } from '../clips/types';
import '../clips/clips-desktop.css';
import { lanClipApi, lanDeleteClipProject } from './api';
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

/** App desktop một người dùng: không có hạn mức theo người, nên không truy vấn/hiển thị số lượt còn lại. */
const desktopEnv: ClipEnv = {
  api: lanClipApi,
  scope: 'lan',
  quota: null,
  deleteProject: (id) => lanDeleteClipProject(id),
};

const BADGE: Record<string, string> = { transcribed: 'ok', transcribing: 'warn', uploaded: 'warn', failed: 'danger', cancelled: 'neutral' };

/** Màn "Cắt clip": danh sách dự án cắt clip + tạo dự án mới. */
export function ClipsPage() {
  useDocumentTitle('Cắt clip');
  return (
    <ClipEnvProvider value={desktopEnv}>
      <ClipsList />
    </ClipEnvProvider>
  );
}

function ClipsList() {
  const [creating, setCreating] = useState(false);
  const q = useClipProjectList();
  const now = useNow();
  const rows: ClipProjectSummary[] = q.data ?? [];
  return (
    <div className="cd-list-page">
      <div className="av-page-head">
        <h1 style={{ flex: '1 1 auto' }}>Cắt clip</h1>
        <button type="button" className="av-btn av-btn-primary" onClick={() => setCreating(true)}>
          Dự án cắt clip mới
        </button>
      </div>
      <div className="cd-table-wrap">
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <div className="av-card cd-empty">Chưa có dự án cắt clip nào.</div>
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
                    <td style={{ textAlign: 'right' }}>
                      <a className="av-btn av-btn-sm" href={hrefOf({ name: 'clip', id: p.id })}>
                        Mở
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <NewClipProjectDialog key={creating ? 'o' : 'c'} open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate({ name: 'clip', id })} />
    </div>
  );
}

/** Trang một dự án cắt clip. */
export function ClipProjectPage({ id }: { id: number }) {
  return (
    <ClipEnvProvider value={desktopEnv}>
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
