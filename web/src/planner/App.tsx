import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icon, type IconName } from '../components/Icon';
import { Toaster } from '../components/Toaster';
import { planner, lanClipApi } from './api';
import { NewPlanPage } from './NewPlanPage';
import { PlanListPage } from './PlanListPage';
import { PlanPage } from './PlanPage';
import { SettingsPage } from './SettingsPage';
import { ToolPage } from './ToolPage';
import { ClipProjectPage, ClipsPage } from './ClipsPage';
import { useAppStatus } from './useAppStatus';
import { hrefOf, useHashRoute, type Route } from './useHashRoute';
import './theme';

type Tone = 'ok' | 'warn' | 'bad';
const DOT: Record<Tone, string> = { ok: 'var(--dot-ok)', warn: 'var(--dot-warn)', bad: 'var(--dot-bad)' };

function StatusBar() {
  const { status, tool } = useAppStatus();
  const w = status.data?.worker;
  const ai: { tone: Tone; text: string } = !w
    ? { tone: status.isError ? 'bad' : 'warn', text: status.isError ? 'mất kết nối' : 'đang kiểm tra' }
    : w.queue_paused
      ? { tone: 'warn', text: 'tạm dừng' }
      : w.online
        ? { tone: 'ok', text: 'sẵn sàng' }
        : { tone: 'bad', text: 'chưa sẵn sàng' };
  const logo = tool.data?.remove_logo;
  const render = status.data?.render ?? tool.data?.render;
  return (
    <footer className="av-statusbar">
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="av-dot" style={{ background: DOT[ai.tone] }} />
        AI: máy chủ nội bộ · {ai.text}
      </span>
      {logo && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="av-dot" style={{ background: logo.available ? DOT.ok : DOT.bad }} />
          Xoá logo · {logo.available ? 'bật' : 'tắt'}
        </span>
      )}
      {render && (
        <span>
          Render: {render.running_count} đang chạy · {render.waiting_count} chờ
        </span>
      )}
    </footer>
  );
}

function Sidebar({ route }: { route: Route }) {
  const plans = useQuery({ queryKey: ['plans', 'all'], queryFn: planner.listPlans, refetchInterval: 15_000 });
  const clips = useQuery({ queryKey: ['clip-projects', 'side'], queryFn: () => lanClipApi.listProjects(), refetchInterval: 30_000 });
  const planRows = (plans.data ?? []).filter((p) => p.kind !== 'clips');
  const clipRows = clips.data ?? [];
  const recent = [
    ...planRows.map((p) => ({
      key: `p${p.id}`,
      name: p.name,
      at: p.updated_at,
      href: hrefOf({ name: 'plan', id: p.id }),
      color: p.status === 'ready' ? '#74d5a8' : p.status === 'failed' ? '#f59d84' : p.status === 'analyzing' ? '#93bbf5' : '#f0c26c',
    })),
    ...clipRows.map((c) => ({ key: `c${c.id}`, name: c.name, at: c.updated_at ?? c.created_at, href: hrefOf({ name: 'clip', id: c.id }), color: '#93bbf5' })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 3);

  const nav = (href: string, label: string, icon: IconName, on: boolean, count?: number) => (
    <a href={href} className="av-nav" aria-current={on ? 'page' : undefined}>
      <Icon name={icon} size={17} />
      {label}
      {count !== undefined && <span className="av-cnt">{count}</span>}
    </a>
  );
  const inPlans = route.name === 'list' || route.name === 'new' || route.name === 'plan';
  const inClips = route.name === 'clips' || route.name === 'clip';

  return (
    <aside className="av-side">
      <a href={hrefOf({ name: 'list' })} className="flex items-center gap-2.5 px-1.5 pb-2 pt-1 no-underline" aria-label="AutoVideo, về danh sách kế hoạch">
        <span aria-hidden="true" className="grid size-[34px] place-items-center rounded-[9px] text-white" style={{ background: '#207d79' }}>
          <Icon name="film" size={18} />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-[15px] font-bold" style={{ color: 'var(--side-fg)' }}>
            AutoVideo
          </span>
          <span className="text-[11.5px]" style={{ color: 'var(--side-muted)' }}>
            Sản xuất video AI
          </span>
        </span>
      </a>
      <nav aria-label="Điều hướng chính" className="flex flex-col gap-0.5">
        {nav(hrefOf({ name: 'list' }), 'Kế hoạch video', 'film', inPlans, plans.data ? planRows.length : undefined)}
        {nav(hrefOf({ name: 'clips' }), 'Cắt clip', 'play', inClips, clips.data ? clipRows.length : undefined)}
        {nav(hrefOf({ name: 'tool' }), 'Xoá logo Veo', 'edit', route.name === 'tool')}
      </nav>
      {recent.length > 0 && (
        <nav aria-label="Gần đây" className="flex flex-col gap-0.5">
          <span className="av-side-label">Gần đây</span>
          {recent.map((r) => (
            <a key={r.key} href={r.href} className="av-nav" title={r.name}>
              <span aria-hidden="true" className="av-dot" style={{ background: r.color }} />
              {r.name}
            </a>
          ))}
        </nav>
      )}
      <div className="mt-auto flex flex-col gap-0.5">{nav(hrefOf({ name: 'settings' }), 'Cài đặt', 'gear', route.name === 'settings')}</div>
    </aside>
  );
}

/** Khung app desktop một người dùng: thanh bên + nội dung + thanh trạng thái. Không đăng nhập. */
export default function App() {
  const route = useHashRoute();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [route]);
  const mine = route.name === 'list' || route.name === 'new' || route.name === 'tool' || route.name === 'settings' || route.name === 'plan' || route.name === 'clip';

  return (
    <div className="av-app">
      <div className="av-body">
        <Sidebar route={route} />
        <main ref={main} className="av-main">
          {/* Trang kế hoạch/cắt clip tự lo bố cục; av-legacy chỉ thêm lề cho trang chưa có đầu trang kiểu mới. */}
          <div className={mine ? 'contents' : 'av-legacy'}>
            {route.name === 'new' ? (
              <NewPlanPage />
            ) : route.name === 'plan' ? (
              <PlanPage key={route.id} id={route.id} />
            ) : route.name === 'tool' ? (
              <ToolPage />
            ) : route.name === 'settings' ? (
              <SettingsPage />
            ) : route.name === 'clips' ? (
              <ClipsPage />
            ) : route.name === 'clip' ? (
              <ClipProjectPage key={route.id} id={route.id} />
            ) : (
              <PlanListPage />
            )}
          </div>
        </main>
      </div>
      <StatusBar />
      <Toaster />
    </div>
  );
}
