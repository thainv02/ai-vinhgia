import { NavLink, Outlet, Link } from 'react-router-dom';
import { useJobs } from '../hooks/queries';
import { useSseState } from '../hooks/useSSE';
import { Banners, ACTIVE_JOBS_FILTER } from './Banners';
import { Toaster } from './Toaster';
import { WorkerBadge } from './WorkerBadge';

const navCls = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${isActive ? 'bg-white/15 text-white' : 'text-header-fg/70 hover:bg-white/10 hover:text-white'}`;

export function Layout() {
  const sse = useSseState();
  const { data: active } = useJobs(ACTIVE_JOBS_FILTER);
  const activeCount = active?.length ?? 0;

  return (
    <div className="min-h-dvh">
      <header className="z-30 bg-header text-header-fg sm:sticky sm:top-0">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <Link to="/" className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-white">
            <span aria-hidden="true" className="grid h-5 w-3 place-items-center rounded-[3px] border-2 border-white">
              <span className="size-1 rounded-full bg-white" />
            </span>
            Autovideo
          </Link>
          <nav className="flex items-center gap-1" aria-label="Điều hướng chính">
            <NavLink to="/" end className={navCls}>
              Dự án
            </NavLink>
            <NavLink to="/queue" className={navCls}>
              Hàng đợi
              {activeCount > 0 && <span className="ml-1.5 rounded bg-white/20 px-1.5 py-px text-[11px] font-bold">{activeCount}</span>}
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {sse === 'reconnecting' && (
              <span className="rounded-full bg-[#f59e0b]/20 px-2.5 py-1 text-xs font-medium text-[#fbbf24]" role="status">
                Mất kết nối, đang nối lại...
              </span>
            )}
            <WorkerBadge />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 pb-16 pt-4 sm:px-6">
        <Banners />
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
