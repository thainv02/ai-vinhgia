import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { ClipEnvProvider, type ClipEnv, type ClipQuota } from '../clips/env';
import { ClipWorkspace } from '../clips/ClipWorkspace';
import { useClipProjectList } from '../clips/hooks';
import { NewClipProjectDialog } from '../clips/NewProjectDialog';
import { ClipProjectList, type LinkComp } from '../clips/ProjectList';
import { toast } from '../lib/toast';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { lanClipApi, lanDeleteClipProject, planner } from './api';
import type { PlannerStatus } from './types';
import { hrefOf, navigate } from './useHashRoute';

const pick = (r: PlannerStatus['remaining'] | undefined, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === 'number') return v;
  }
  return null;
};

/** Hạn mức còn lại của chính người dùng trong giờ này, lấy từ `/lan/api/status` → `remaining`. */
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

function useLanClipEnv(): ClipEnv {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 10_000 });
  return {
    api: lanClipApi,
    scope: 'lan',
    quota: toClipQuota(status.data),
    refreshQuota: () => void qc.invalidateQueries({ queryKey: ['status'] }),
    deleteProject: (id) => lanDeleteClipProject(id),
  };
}

const AnchorLink: LinkComp = ({ id, className, children }) => (
  <a href={hrefOf({ name: 'clip', id })} className={className}>
    {children}
  </a>
);

/** Tab "Cắt clip" của trang LAN: danh sách dự án của mọi người trong mạng + tạo dự án mới. */
export function ClipsPage() {
  useDocumentTitle('Cắt clip');
  const env = useLanClipEnv();
  return (
    <ClipEnvProvider value={env}>
      <ClipsList />
    </ClipEnvProvider>
  );
}

function ClipsList() {
  const [creating, setCreating] = useState(false);
  const q = useClipProjectList();
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Cắt clip từ video dài</h1>
          <p className="text-[13px] text-muted">Tải lên video dài có tiếng nói, AI chọn các đoạn hay, bạn duyệt rồi dựng clip 9:16 có phụ đề tiếng Việt và tải về.</p>
        </div>
        <Button variant="primary" icon={<Icon name="plus" />} onClick={() => setCreating(true)}>
          Dự án cắt clip mới
        </Button>
      </div>
      <ClipProjectList projects={q.data} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} onCreate={() => setCreating(true)} Link={AnchorLink} />
      <NewClipProjectDialog key={creating ? 'o' : 'c'} open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate({ name: 'clip', id })} />
    </div>
  );
}

/** Trang một dự án cắt clip trên LAN: cùng luồng với app chính (gọn hơn), kèm số lượt còn lại. */
export function ClipProjectPage({ id }: { id: number }) {
  const env = useLanClipEnv();
  return (
    <ClipEnvProvider value={env}>
      <ClipWorkspace
        projectId={id}
        back={
          <a href={hrefOf({ name: 'clips' })} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
            <Icon name="arrowLeft" size={14} /> Cắt clip
          </a>
        }
        onDeleted={() => {
          toast.success('Đã xoá dự án (chủ máy khôi phục được trong 30 ngày).');
          navigate({ name: 'clips' });
        }}
      />
    </ClipEnvProvider>
  );
}
