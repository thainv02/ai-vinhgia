import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { htmlApi } from './api';
import type { HtmlRender, HtmlVersion, HtmlVersionStatus } from './types';
import { useAppStatus } from '../planner/useAppStatus';

export const hk = {
  list: ['html', 'list'] as const,
  project: (id: number) => ['html', 'project', id] as const,
  versions: (id: number) => ['html', 'versions', id] as const,
  assets: (id: number) => ['html', 'assets', id] as const,
  voice: (id: number) => ['html', 'voice', id] as const,
  renders: (id: number) => ['html', 'renders', id] as const,
  preview: (id: number, v: number) => ['html', 'preview', id, v] as const,
  templates: ['html', 'templates'] as const,
  renderer: ['html-renderer'] as const,
};

export const VERSION_ACTIVE = (s: HtmlVersionStatus) => s === 'composing' || s === 'validating';
export const RENDER_ACTIVE = (r: Pick<HtmlRender, 'status'>) => r.status === 'queued' || r.status === 'rendering';

export const VERSION_LABEL: Record<HtmlVersionStatus, string> = {
  composing: 'Đang tạo',
  validating: 'Đang kiểm tra',
  ready: 'Sẵn sàng',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};
const VERSION_TONE: Record<HtmlVersionStatus, string> = { composing: 'info', validating: 'info', ready: 'ok', failed: 'danger', cancelled: 'neutral' };

export function VersionChip({ status }: { status: HtmlVersionStatus }) {
  return <span className={`av-badge av-badge-${VERSION_TONE[status]}`}>{VERSION_LABEL[status]}</span>;
}

export const RENDER_LABEL: Record<HtmlRender['status'], string> = { queued: 'Đang chờ dựng', rendering: 'Đang dựng', ready: 'Đã xong', failed: 'Lỗi', cancelled: 'Đã hủy' };
export const RENDER_TONE: Record<HtmlRender['status'], string> = { queued: 'warn', rendering: 'info', ready: 'ok', failed: 'danger', cancelled: 'neutral' };

export const bytesLabel = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export const ASPECT_LABEL = { '9:16': '9:16 dọc', '1:1': '1:1 vuông', '16:9': '16:9 ngang' } as const;

/** Giới hạn tải asset (khớp server): ảnh 20 MB, video/nhạc 200 MB, 1 GB/dự án. */
export const ASSET_LIMITS = { image: 20e6, media: 200e6, project: 1e9 };
export const ASSET_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,.mp3,.wav,.m4a,.aac,.ogg,.mp4,.mov,.webm';
export function assetFileProblem(f: File): string | null {
  const image = f.type.startsWith('image/');
  const limit = image ? ASSET_LIMITS.image : ASSET_LIMITS.media;
  if (f.size > limit) return `Quá lớn (tối đa ${bytesLabel(limit)} cho ${image ? 'ảnh' : 'video/nhạc'})`;
  if (/\.mkv$/i.test(f.name)) return 'Không hỗ trợ định dạng MKV';
  return null;
}

/** Trạng thái môi trường cho các nút tạo/sửa: AI chưa có key / worker offline / bộ dựng chưa cài. */
export function useHtmlEnv() {
  const { status } = useAppStatus();
  const renderer = useQuery({ queryKey: hk.renderer, queryFn: htmlApi.renderer, refetchInterval: (q) => (q.state.data?.download?.state === 'downloading' ? 1000 : 30_000), retry: false });
  const w = status.data?.worker;
  const ai = status.data?.ai;
  return {
    aiMissingKey: !!ai && !ai.key_set,
    workerOffline: !!w && !w.online,
    paused: !!w?.queue_paused,
    rendererMissing: renderer.data ? !renderer.data.installed : false,
    rendererDownloading: renderer.data?.download?.state === 'downloading',
    rendererKnown: !!renderer.data,
  };
}

/** Nhảy tới mục "Bộ dựng Video HTML" của Cài đặt. */
export function gotoRendererSettings(): void {
  try {
    window.sessionStorage.setItem('av-settings-focus', 'html');
  } catch {
    /* bỏ qua */
  }
  window.location.hash = '#/settings';
}

export function SettingsLink({ children }: { children: ReactNode }) {
  return (
    <a
      href="#/settings"
      onClick={(e) => {
        e.preventDefault();
        gotoRendererSettings();
      }}
    >
      {children}
    </a>
  );
}

/** Thông báo trạng thái dùng chung (AI/worker). `forCompose` = áp dụng cho việc tạo/sửa bằng AI. */
export function EnvNotices({ forCompose, forRender }: { forCompose?: boolean; forRender?: boolean }) {
  const env = useHtmlEnv();
  const items: ReactNode[] = [];
  if (forCompose && env.aiMissingKey)
    items.push(
      <p key="ai" className="hv-note hv-note-warn">
        AI chưa sẵn sàng: chưa có API key. Vào <a href="#/settings">Cài đặt</a> để nhập key trước khi tạo hoặc sửa video.
      </p>,
    );
  else if (forCompose && env.paused)
    items.push(
      <p key="pause" className="hv-note hv-note-warn">
        Hàng đợi AI đang tạm dừng, yêu cầu sẽ chờ đến khi chạy lại.
      </p>,
    );
  else if (forCompose && env.workerOffline)
    items.push(
      <p key="w" className="hv-note hv-note-warn">
        Worker AI đang offline, yêu cầu sẽ chờ cho đến khi worker kết nối lại.
      </p>,
    );
  if (forRender && env.rendererMissing)
    items.push(
      <p key="r" className="hv-note hv-note-warn">
        {env.rendererDownloading ? 'Bộ dựng video đang được tải, vui lòng chờ xong. ' : 'Chưa có bộ dựng video (trình duyệt dựng nội bộ). '}
        Mở <SettingsLink>Cài đặt → Bộ dựng Video HTML</SettingsLink>
        {env.rendererDownloading ? ' để xem tiến độ.' : ' để tải một lần.'}
      </p>,
    );
  return items.length ? <>{items}</> : null;
}

export function versionProblem(v: HtmlVersion): string | null {
  if (v.status !== 'failed' && v.status !== 'cancelled') return null;
  return v.error ?? v.job?.error ?? (v.status === 'cancelled' ? 'Đã hủy.' : 'Không rõ nguyên nhân.');
}
