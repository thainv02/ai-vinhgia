import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingBlock } from '../components/States';
import { Toaster } from '../components/Toaster';
import { planner, onUnauthenticated } from './api';
import { LoginScreen } from './LoginScreen';
import { NewPlanPage } from './NewPlanPage';
import { PlanListPage } from './PlanListPage';
import { PlanPage } from './PlanPage';
import { ToolPage } from './ToolPage';
import { ClipProjectPage, ClipsPage } from './ClipsPage';
import { hrefOf, useHashRoute } from './useHashRoute';

/** `onLogout` chỉ có khi trang đòi mã truy cập (LAN_REQUIRE_CODE=true); không cần mã thì không có phiên nên không có nút "Thoát". */
function Shell({ onLogout }: { onLogout?: () => void }) {
  const route = useHashRoute();
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 10_000 });
  const online = status.data?.worker.online;
  const paused = status.data?.worker.queue_paused;
  const label = status.isLoading ? 'Máy chủ AI...' : online && !paused ? 'Máy chủ AI sẵn sàng' : paused ? 'Hàng đợi tạm dừng' : 'Máy chủ AI chưa sẵn sàng';
  const ready = !!online && !paused;

  return (
    <div className="planner-app min-h-dvh">
      <header className="planner-header">
        <div className="planner-shell flex min-h-18 items-center gap-4">
          <a href={hrefOf({ name: 'list' })} className="planner-brand">
            <span aria-hidden="true" className="planner-brand-mark"><Icon name="film" size={21} /></span>
            <span>autovideo<span className="planner-brand-sub">Không gian sáng tạo</span></span>
          </a>
          <div className="ml-auto flex items-center gap-2">
            <span
              title={ready ? 'Máy chủ AI đang chạy: phân tích sẽ được xử lý ngay.' : 'Phân tích vẫn được gửi và xếp hàng, nhưng sẽ chờ tới khi máy chủ AI sẵn sàng.'}
              className={`planner-server-status ${ready ? 'is-ready' : ''}`}
            >
              <span aria-hidden="true" className={`size-1.5 rounded-full ${ready ? 'bg-ok-fg' : 'bg-warn-fg'}`} />
              <span className="max-[480px]:hidden">{label}</span>
              <span className="min-[481px]:hidden">{ready ? 'AI sẵn sàng' : status.isLoading ? '...' : 'AI chưa sẵn sàng'}</span>
            </span>
            {onLogout && (
              <button type="button" onClick={onLogout} className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-fg">
                Thoát
              </button>
            )}
          </div>
        </div>
      </header>
      <nav aria-label="Chức năng" className="border-b border-line bg-surface">
        <div className="planner-shell flex gap-4 overflow-x-auto sm:gap-5">
          {[
            { href: hrefOf({ name: 'list' }), label: 'Kế hoạch prompt', icon: 'film' as const, on: route.name === 'list' || route.name === 'new' || route.name === 'plan' },
            { href: hrefOf({ name: 'clips' }), label: 'Cắt clip', icon: 'play' as const, on: route.name === 'clips' || route.name === 'clip' },
            { href: hrefOf({ name: 'tool' }), label: 'Xoá logo Veo', icon: 'edit' as const, on: route.name === 'tool' },
          ].map((t) => (
            <a
              key={t.href}
              href={t.href}
              aria-current={t.on ? 'page' : undefined}
              className={`-mb-px inline-flex min-h-12 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-1 text-[13px] font-semibold ${t.on ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-fg'}`}
            >
              <Icon name={t.icon} size={15} />
              {t.label}
            </a>
          ))}
        </div>
      </nav>
      <main className="planner-shell pb-16 pt-7">
        {status.data && !ready && route.name !== 'plan' && route.name !== 'tool' && route.name !== 'clip' && (
          <div role="status" className="mb-4 flex items-center gap-2 rounded-lg bg-warn-bg px-3 py-2.5 text-[13px] text-warn-fg">
            <Icon name="alert" size={16} />
            <span>
              <strong>Máy chủ AI chưa sẵn sàng.</strong> Yêu cầu phân tích sẽ xếp hàng và chạy khi máy chủ sẵn sàng.
            </span>
          </div>
        )}
        {route.name === 'new' ? <NewPlanPage /> : route.name === 'plan' ? <PlanPage key={route.id} id={route.id} /> : route.name === 'tool' ? <ToolPage /> : route.name === 'clips' ? <ClipsPage /> : route.name === 'clip' ? <ClipProjectPage key={route.id} id={route.id} /> : <PlanListPage />}
      </main>
      <Toaster />
    </div>
  );
}

/**
 * Cổng đăng nhập CHỈ khi server đòi mã (LAN_REQUIRE_CODE=true): chưa có phiên (hoặc phiên hết hạn) thì hiện màn nhập mã; có phiên thì hiện ứng dụng.
 * Mặc định không cần mã: `session` trả `authenticated:true, code_required:false` nên vào thẳng ứng dụng, không có màn đăng nhập và nút "Thoát".
 */
export default function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: planner.session, retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    if (session.isSuccess) setAuthed(session.data.authenticated);
    else if (session.isError) setAuthed(null);
  }, [session.isSuccess, session.isError, session.data]);

  useEffect(
    () =>
      onUnauthenticated(() => {
        setAuthed(false);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      }),
    [qc],
  );

  if (authed === false) {
    return (
      <LoginScreen
        onSuccess={() => {
          qc.clear();
          setAuthed(true);
          void qc.invalidateQueries();
        }}
      />
    );
  }
  if (authed === null) {
    if (session.isError) {
      return (
        <div className="grid min-h-dvh place-items-center">
          <ErrorState title="Không kết nối được máy chủ" error={session.error} onRetry={() => void session.refetch()} />
        </div>
      );
    }
    return <LoadingBlock />;
  }
  // server cũ không trả `code_required`: coi như cần mã (giữ nút Thoát)
  const codeRequired = session.data?.code_required !== false;
  return (
    <Shell
      onLogout={
        codeRequired
          ? () => {
              void planner.logout().finally(() => {
                qc.clear();
                setAuthed(false);
              });
            }
          : undefined
      }
    />
  );
}

