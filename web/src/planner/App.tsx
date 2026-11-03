import { useEffect, useRef, useState } from 'react';
import brandLogo from '../assets/vinh-gia-logo.jpg';
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
import { HtmlListPage } from '../html/HtmlListPage';
import { HtmlProjectPage } from '../html/HtmlProjectPage';
import { htmlApi } from '../html/api';
import { hrefOf, useHashRoute, type Route } from './useHashRoute';
import './theme';

function Sidebar({ route }: { route: Route }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('av-sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const toggle = () => setCollapsed((value) => {
    try { localStorage.setItem('av-sidebar-collapsed', String(!value)); } catch { /* lưu trữ không khả dụng */ }
    return !value;
  });
  const plans = useQuery({ queryKey: ['plans', 'all'], queryFn: planner.listPlans, refetchInterval: 15_000 });
  const clips = useQuery({ queryKey: ['clip-projects', 'side'], queryFn: () => lanClipApi.listProjects(), refetchInterval: 30_000 });
  const htmlQ = useQuery({ queryKey: ['html', 'list'], queryFn: htmlApi.list, refetchInterval: 30_000 });
  const planRows = (plans.data ?? []).filter((p) => p.kind !== 'clips');
  const clipRows = clips.data ?? [];
  const recent = [
    ...planRows.map((p) => ({
      key: `p${p.id}`,
      name: p.name,
      at: p.updated_at,
      href: hrefOf({ name: 'plan', id: p.id }),
      color: p.status === 'ready' ? 'var(--side-fg)' : p.status === 'failed' ? 'var(--dot-bad)' : 'var(--side-muted)',
    })),
    ...clipRows.map((c) => ({ key: `c${c.id}`, name: c.name, at: c.updated_at ?? c.created_at, href: hrefOf({ name: 'clip', id: c.id }), color: 'var(--side-muted)' })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 3);

  const nav = (href: string, label: string, icon: IconName, on: boolean, count?: number) => (
    <a href={href} className="av-nav" title={label} aria-label={label} aria-current={on ? 'page' : undefined}>
      <Icon name={icon} size={17} />
      <span className="av-nav-label">{label}</span>
      {count !== undefined && <span className="av-cnt">{count}</span>}
    </a>
  );
  const inPlans = route.name === 'list' || route.name === 'new' || route.name === 'plan';
  const inClips = route.name === 'clips' || route.name === 'clip';
  const inHtml = route.name === 'html' || route.name === 'html-project';

  return (
    <aside className={`av-side ${collapsed ? 'av-side-mini' : ''}`}>
      <a href={hrefOf({ name: 'list' })} className="av-brand flex items-center gap-2.5 px-1.5 pb-2 pt-1 no-underline" aria-label="AI Vinh Gia, về danh sách kế hoạch">
        <img src={brandLogo} alt="" className="size-[40px] shrink-0 rounded-[9px] bg-white object-contain" width={40} height={40} />
        <span className="av-brand-copy flex flex-col leading-tight">
          <span className="text-[15px] font-bold" style={{ color: 'var(--side-fg)' }}>
            AI Vinh Gia
          </span>
          <span className="text-[11.5px]" style={{ color: 'var(--side-muted)' }}>
            Sản xuất video
          </span>
        </span>
      </a>
      <nav aria-label="Điều hướng chính" className="flex flex-col gap-0.5">
        {nav(hrefOf({ name: 'list' }), 'Kế hoạch video', 'film', inPlans, plans.data ? planRows.length : undefined)}
        {nav(hrefOf({ name: 'clips' }), 'Cắt clip', 'play', inClips, clips.data ? clipRows.length : undefined)}
        {nav(hrefOf({ name: 'html' }), 'Video HTML', 'image', inHtml, htmlQ.data?.length)}
        {nav(hrefOf({ name: 'tool' }), 'Xoá logo Veo', 'edit', route.name === 'tool')}
        {nav(hrefOf({ name: 'settings' }), 'Cài đặt', 'gear', route.name === 'settings')}
      </nav>
      {recent.length > 0 && (
        <nav aria-label="Gần đây" className="av-recents flex flex-col gap-0.5">
          <span className="av-side-label">Gần đây</span>
          {recent.map((r) => (
            <a key={r.key} href={r.href} className="av-nav" title={r.name}>
              <span aria-hidden="true" className="av-dot" style={{ background: r.color }} />
              <span className="av-nav-label">{r.name}</span>
            </a>
          ))}
        </nav>
      )}
      <button type="button" className="av-side-toggle" aria-label={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} title={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'} aria-expanded={!collapsed} onClick={toggle}>
        <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={18} /><span className="av-nav-label">Thu gọn</span>
      </button>
    </aside>
  );
}

/** Khung app desktop một người dùng: thanh bên và nội dung. Không đăng nhập. */
export default function App() {
  const route = useHashRoute();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [route]);
  const mine = route.name === 'list' || route.name === 'new' || route.name === 'tool' || route.name === 'settings' || route.name === 'plan' || route.name === 'clip' || route.name === 'html' || route.name === 'html-project';

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
            ) : route.name === 'html' ? (
              <HtmlListPage />
            ) : route.name === 'html-project' ? (
              <HtmlProjectPage key={route.id} id={route.id} />
            ) : route.name === 'clip' ? (
              <ClipProjectPage key={route.id} id={route.id} />
            ) : (
              <PlanListPage />
            )}
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
