import { useState, type ReactNode } from 'react';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useAppStatus } from './useAppStatus';
import { useTheme, type ThemeMode } from './theme';

const SECTIONS = [
  { id: 'ai', label: 'AI' },
  { id: 'logo', label: 'Xoá logo Veo' },
  { id: 'render', label: 'Hàng đợi dựng' },
  { id: 'ui', label: 'Giao diện' },
] as const;

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'dark', label: 'Tối' },
  { value: 'light', label: 'Sáng' },
  { value: 'system', label: 'Theo Windows' },
];

function Section({ id, title, badge, children }: { id: string; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="av-card av-card-pad" style={{ gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <h2 id={`${id}-h`} className="flex-1">
          {title}
        </h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="av-kv">
    <span>{k}</span>
    <span>{v}</span>
  </div>
);

/** Cài đặt: chỉ những gì thật sự đổi/đọc được. Trạng thái dịch vụ là chỉ đọc (lấy từ máy chủ nội bộ). */
export function SettingsPage() {
  useDocumentTitle('Cài đặt');
  const { status, tool } = useAppStatus();
  const [theme, setTheme] = useTheme();
  const [active, setActive] = useState<string>('ai');
  const w = status.data?.worker;
  const logo = tool.data?.remove_logo;
  const render = status.data?.render ?? tool.data?.render;

  const aiBadge = !w ? <span className="av-badge av-badge-neutral">Đang kiểm tra</span> : w.queue_paused ? <span className="av-badge av-badge-warn">Tạm dừng</span> : w.online ? <span className="av-badge av-badge-ok">Đã kết nối</span> : <span className="av-badge av-badge-danger">Chưa sẵn sàng</span>;

  return (
    <>
      <header className="av-header">
        <h1>Cài đặt</h1>
      </header>
      <div className="av-settings">
        <nav className="av-settings-nav" aria-label="Mục cài đặt">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#/settings`}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setActive(s.id);
                document.getElementById(s.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="av-settings-body">
          <Section id="ai" title="AI chia cảnh và chọn điểm cắt" badge={aiBadge}>
            <Row k="Máy chủ" v="Máy chủ AI nội bộ" />
            <Row k="Hàng đợi" v={w ? (w.queue_paused ? 'Tạm dừng' : 'Đang chạy') : '—'} />
          </Section>

          <Section id="logo" title="Xoá logo Veo" badge={logo ? <span className={`av-badge ${logo.available ? 'av-badge-ok' : 'av-badge-danger'}`}>{logo.available ? 'Đang bật' : 'Đang tắt'}</span> : undefined}>
            {logo && (
              <>
                <Row k="Độ dài video" v={`${logo.min_s}–${logo.max_s} giây`} />
                <Row k="File giữ trong" v={`${tool.data?.retention_days ?? '—'} ngày`} />
                {!logo.available && logo.reason && <Row k="Lý do" v={logo.reason} />}
              </>
            )}
          </Section>

          <Section id="render" title="Hàng đợi dựng">
            {render ? (
              <>
                <Row k="Đang chạy" v={`${render.running_count}/${render.concurrency} việc`} />
                <Row k="Đang chờ" v={`${render.waiting_count} việc`} />
              </>
            ) : (
              <Row k="Trạng thái" v="—" />
            )}
          </Section>

          <Section id="ui" title="Giao diện">
            <div className="av-seg" role="group" aria-label="Chế độ màu" style={{ alignSelf: 'flex-start' }}>
              {THEMES.map((t) => (
                <button key={t.value} type="button" aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>
                  {t.label}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
