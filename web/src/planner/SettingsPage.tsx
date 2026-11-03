import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { InlineError } from '../components/States';
import { ActionTag, DisabledReason } from '../components/ActionTag';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { htmlApi } from '../html/api';
import type { HtmlRendererStatus } from '../html/types';
import { planner } from './api';
import type { AiSettings, SttSettings } from './types';
import { useAppStatus } from './useAppStatus';
import { useTheme, type ThemeMode } from './theme';

const SECTIONS = [
  { id: 'ai', label: 'AI' },
  { id: 'stt', label: 'Nhận dạng lời nói' },
  { id: 'html', label: 'Bộ dựng Video HTML' },
  { id: 'logo', label: 'Xoá logo & hàng đợi' },
  { id: 'ui', label: 'Giao diện' },
  { id: 'data', label: 'Dữ liệu & log' },
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
function RenderConcurrencySetting(){
 const q=useQuery({queryKey:['render-settings'],queryFn:htmlApi.renderSettings,refetchInterval:10000}),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const change=async(value:string)=>{setBusy(true);setError(null);try{await htmlApi.setRenderSettings(value==='auto'?'auto':Number(value));await q.refetch();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 return <label className="av-label">Số việc dựng chạy cùng lúc<select className="av-input" value={q.data?.concurrency??'auto'} disabled={busy||!q.data} onChange={e=>void change(e.target.value)}><option value="auto">Tự động (máy này: {q.data?.auto_concurrency??'…'} luồng)</option>{[1,2,3,4].map(n=><option key={n} value={n}>{n} luồng</option>)}</select>{(error||q.error)&&<InlineError>{error??errorMessage(q.error)}</InlineError>}</label>;
}

/**
 * Bản desktop: nhập API key của máy chủ AI nội bộ, kiểm tra (lấy danh sách model) rồi lưu. Key không bao giờ hiện lại,
 * chỉ 4 ký tự cuối; để trống ô key = giữ key đang lưu. Server tự chọn model theo công việc.
 */
function AiKeyForm({ ai }: { ai: AiSettings }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const typed = key.trim();

  const check = async () => {
    setBusy('check');
    setError(null);
    setSaved(false);
    try {
      const r = await planner.checkAi(typed || undefined);
      if (!r.models.length) throw new Error('Dịch vụ AI chưa cung cấp model. Vui lòng liên hệ hỗ trợ.');
      setChecked(true);
    } catch (e) {
      setChecked(false);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await planner.saveAi({ ...(typed ? { api_key: typed } : {}) });
      setKey('');
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['status'] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Lưu được khi đã kiểm tra thành công (key mới hoặc key cũ); đổi key thì phải kiểm tra lại
  const canSave = checked && (!!typed || ai.key_set) && busy === null;
  return (
    <form
      className="flex flex-col"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <label className="av-label">
        {ai.key_set ? 'API key mới (để trống để giữ key đang dùng)' : 'API key'}
        <input
          className="av-input av-mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy !== null}
          onChange={(e) => {
            setKey(e.target.value);
            setChecked(false);
            setSaved(false);
          }}
          placeholder="sk-..."
        />
        <span className="av-muted text-xs font-normal">Để trống để giữ key cũ. Key đã lưu chỉ hiện 4 ký tự cuối.</span>
      </label>
      <p className="av-muted text-sm">Ứng dụng tự chọn AI phù hợp cho từng chức năng và ưu tiên model nhẹ khi sửa lời thoại. Khi một model bị giới hạn, ứng dụng tự chuyển sang model phù hợp khác. Nếu tất cả đang bận, công việc trong hàng đợi sẽ chờ để thử lại.</p>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex items-center gap-2.5">
        <button type="button" className="av-btn" disabled={busy !== null || (!typed && !ai.key_set)} onClick={() => void check()}>
          {busy === 'check' ? 'Đang kiểm tra…' : 'Kiểm tra'}
        </button>
        <button type="submit" className="av-btn av-btn-primary" disabled={!canSave} title={!checked ? 'Bấm Kiểm tra trước khi lưu' : undefined}>
          {busy === 'save' ? 'Đang lưu…' : 'Lưu'}
        </button>
        {saved && (
          <span className="av-badge av-badge-ok" role="status">
            Đã lưu
          </span>
        )}
      </div>
      {!canSave && !busy && <DisabledReason>{!typed && !ai.key_set ? 'Nhập API key và kiểm tra trước khi lưu.' : 'Cần kiểm tra thành công trước khi lưu.'}</DisabledReason>}
    </form>
  );
}

const MB = (n: number) => `${Math.round(n / 1e6)} MB`;

/**
 * Nhận dạng lời nói chạy ngay trên máy (CPU). Model do installer tải; thiếu (cài khi không có mạng, tải lỗi) thì tải bù ở đây.
 * Đang tải thì hỏi lại tiến độ mỗi giây; tải xong làm mới trạng thái cắt clip để mở khoá tải video.
 */
function SttSection() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['stt-settings'],
    queryFn: planner.sttSettings,
    refetchInterval: (query) => (query.state.data?.download?.state === 'downloading' ? 1000 : false),
  });
  const [error, setError] = useState<string | null>(null);
  const s = q.data;
  const d = s?.download ?? null;
  const downloading = d?.state === 'downloading';
  const act = async (fn: () => Promise<SttSettings>) => {
    setError(null);
    try {
      qc.setQueryData(['stt-settings'], await fn());
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const installed = !!s?.installed;
  useEffect(() => {
    if (installed) void qc.invalidateQueries({ queryKey: ['clip-status'] });
  }, [installed, qc]);

  const badge = !s ? undefined : s.installed ? (
    <span className="av-badge av-badge-ok">Sẵn sàng</span>
  ) : downloading ? (
    <span className="av-badge av-badge-info">Đang tải</span>
  ) : (
    <span className="av-badge av-badge-warn">Chưa có model</span>
  );
  return (
    <Section id="stt" title="Nhận dạng lời nói" badge={<><ActionTag kind="local" />{badge}</>}>
      {q.error ? (
        <InlineError>{errorMessage(q.error)}</InlineError>
      ) : !s ? (
        <Row k="Trạng thái" v="—" />
      ) : s.provider !== 'local' ? (
        <Row k="Dịch vụ" v="Máy chủ nhận dạng riêng (cấu hình STT_URL)" />
      ) : (
        <>
          <Row k="Provider" v="Trên máy (CPU)" />
          <Row k="Số luồng CPU" v={<>{s.threads} <small className="av-muted">(chỉ hiển thị)</small></>} />
          <Row k="Model" v={`${s.model.label} · ${MB(s.model.total_bytes)}`} />
          <Row k="Trạng thái" v={s.installed ? 'Đã cài' : downloading ? `Đang tải ${MB(d!.received)}/${MB(d!.total)}` : 'Chưa có (cần tải một lần)'} />
          {downloading && (
            <div className="av-bar" role="progressbar" aria-label="Tiến độ tải model" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((d!.received / d!.total) * 100)}>
              <i style={{ width: `${(d!.received / d!.total) * 100}%` }} />
            </div>
          )}
          {d?.state === 'failed' && d.error && <InlineError>{d.error}</InlineError>}
          {error && <InlineError>{error}</InlineError>}
          {!s.installed && (
            <div className="flex items-center gap-2.5">
              {downloading ? (
                <button type="button" className="av-btn" onClick={() => void act(planner.cancelSttDownload)}>
                  Hủy tải
                </button>
              ) : (
                <button type="button" className="av-btn" onClick={() => void act(planner.downloadSttModel)}>
                  {d?.state === 'failed' ? 'Tải lại' : `Tải model (${MB(s.model.total_bytes)})`}
                </button>
              )}
              <span className="av-muted" style={{ fontSize: 12.5 }}>
                Chỉ tải một lần. Sau đó nhận dạng chạy hoàn toàn trên máy, không cần mạng.
              </span>
            </div>
          )}
        </>
      )}
      {s?.ai_fix && (
        <Row
          k="Chuẩn hoá chính tả"
          v={
            !s.ai_fix.enabled ? (
              'Tắt (STT_AI_FIX=0)'
            ) : !s.ai_fix.key_set ? (
              <>Bật · chờ API key <small className="av-muted">(chưa có key thì hiện bản nhận dạng gốc)</small></>
            ) : (
              <>
                AI · <span className="av-mono">{s.ai_fix.model}</span> <small className="av-muted">(model nhẹ, sửa chính tả, tên riêng, dấu câu trước khi hiện lời thoại)</small>
              </>
            )
          }
        />
      )}
    </Section>
  );
}


/**
 * Bộ dựng Video HTML (trình duyệt headless nội bộ để xuất MP4). Không tự tải: người dùng bấm tải một lần.
 * Đang tải thì hỏi lại tiến độ mỗi giây.
 */
function HtmlRendererSection() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['html-renderer'],
    queryFn: htmlApi.renderer,
    refetchInterval: (query) => (query.state.data?.download?.state === 'downloading' ? 1000 : false),
  });
  const [error, setError] = useState<string | null>(null);
  const s = q.data;
  const d = s?.download ?? null;
  const downloading = d?.state === 'downloading';
  const act = async (fn: () => Promise<HtmlRendererStatus>) => {
    setError(null);
    try {
      qc.setQueryData(['html-renderer'], await fn());
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['html-renderer'] });
    }
  };
  const badge = !s ? undefined : s.installed ? (
    <span className="av-badge av-badge-ok">Sẵn sàng</span>
  ) : downloading ? (
    <span className="av-badge av-badge-info">Đang tải</span>
  ) : (
    <span className="av-badge av-badge-warn">Chưa cài</span>
  );
  const pct = d && d.total > 0 ? (d.received / d.total) * 100 : 0;
  return (
    <Section id="html" title="Bộ dựng Video HTML (MP4)" badge={badge}>
      {q.error ? (
        <InlineError>{errorMessage(q.error)}</InlineError>
      ) : !s ? (
        <Row k="Trạng thái" v="—" />
      ) : (
        <>
          <Row k="Thành phần" v={`Trình duyệt dựng nội bộ (Chrome headless ${s.version})`} />
          <Row k="Dung lượng" v={`Tải khoảng ${MB(s.download_bytes)} · chiếm khoảng ${MB(s.disk_bytes)} trên ổ đĩa`} />
          <Row k="Trạng thái" v={s.installed ? 'Đã cài' : downloading ? `Đang tải ${MB(d!.received)}/${MB(d!.total)}` : 'Chưa có (cần tải một lần để dựng MP4)'} />
          {s.installed && s.path && <Row k="Vị trí" v={<span className="av-mono" style={{ wordBreak: 'break-all' }}>{s.path}</span>} />}
          {downloading && (
            <div className="av-bar" role="progressbar" aria-label="Tiến độ tải bộ dựng" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
          {d?.state === 'failed' && d.error && <InlineError>{d.error}</InlineError>}
          {error && <InlineError>{error}</InlineError>}
          {!s.installed && (
            <div className="flex items-center gap-2.5">
              {downloading ? (
                <button type="button" className="av-btn" onClick={() => void act(htmlApi.cancelRendererDownload)}>
                  Hủy tải
                </button>
              ) : (
                <button type="button" className="av-btn" onClick={() => void act(htmlApi.downloadRenderer)}>
                  {d?.state === 'failed' ? 'Tải lại' : `Tải bộ dựng (${MB(s.download_bytes)})`}
                </button>
              )}
              <span className="av-muted" style={{ fontSize: 12.5 }}>
                Chỉ tải một lần. Xem trước vẫn dùng được khi chưa có bộ dựng; chỉ xuất MP4 mới cần.
              </span>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** Cài đặt: chỉ những gì thật sự đổi/đọc được. Trạng thái dịch vụ là chỉ đọc (lấy từ máy chủ nội bộ). */
export function SettingsPage() {
  useDocumentTitle('Cài đặt');
  const { status, tool } = useAppStatus();
  const [theme, setTheme] = useTheme();
  const [active, setActive] = useState<string>('ai');
  // Từ trang Video HTML bấm "Mở Cài đặt" → cuộn tới mục bộ dựng.
  useEffect(() => {
    let focus: string | null = null;
    try {
      focus = window.sessionStorage.getItem('av-settings-focus');
      window.sessionStorage.removeItem('av-settings-focus');
    } catch {
      /* bỏ qua */
    }
    if (!focus) return;
    setActive(focus);
    const t = window.setTimeout(() => document.getElementById(focus!)?.scrollIntoView({ block: 'start' }), 150);
    return () => window.clearTimeout(t);
  }, []);
  const w = status.data?.worker;
  const logo = tool.data?.remove_logo;
  const render = status.data?.render ?? tool.data?.render;

  const ai = status.data?.ai;
  const aiBadge = !w ? <span className="av-badge av-badge-neutral">Đang kiểm tra</span> : ai && !ai.key_set ? <span className="av-badge av-badge-warn">Chưa có API key</span> : w.queue_paused ? <span className="av-badge av-badge-warn">Tạm dừng</span> : w.online ? <span className="av-badge av-badge-ok">Đã kết nối</span> : <span className="av-badge av-badge-danger">Chưa sẵn sàng</span>;

  return (
    <>
      <header className="av-header">
        <div><h1>Cài đặt</h1><p className="av-page-intro">Kết nối AI, chuẩn bị các thành phần xử lý trên máy và chọn giao diện.</p></div>
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
          {status.isError && <InlineError>Mất kết nối dịch vụ trên máy. Đây không phải AI đang chờ. <button className="av-btn av-btn-sm" type="button" onClick={() => void status.refetch()}>Thử lại</button></InlineError>}
          <Section id="ai" title="AI chia cảnh và chọn điểm cắt" badge={aiBadge}>
            <Row k="Máy chủ" v={ai?.url ?? 'Máy chủ AI nội bộ'} />
            {ai && <Row k="AI" v="Tự động theo chức năng" />}
            {ai && <Row k="API key" v={ai.key_set ? `Đã lưu (${ai.key_hint})` : 'Chưa có'} />}
            <Row k="Hàng đợi" v={w ? (w.queue_paused ? 'Tạm dừng' : 'Đang chạy') : '—'} />
            {ai && <AiKeyForm ai={ai} />}
          </Section>

          <SttSection />

          <HtmlRendererSection />

          <Section id="logo" title="Xoá logo & hàng đợi">
            <RenderConcurrencySetting/>
            {logo && (
              <>
                <Row k="Xoá logo Veo" v={<span className={`av-badge ${logo.available ? 'av-badge-ok' : 'av-badge-danger'}`}>{logo.available ? 'Đang bật' : 'Chưa khả dụng'}</span>} />
                <Row k="Độ dài video" v={`${logo.min_s}–${logo.max_s} giây`} />
                <Row k="File giữ trong" v={`${tool.data?.retention_days ?? '—'} ngày`} />
                {!logo.available && logo.reason && <Row k="Lý do" v={logo.reason} />}
              </>
            )}
            {render ? (
              <>
                <Row k="Hàng đợi dựng" v={`${render.running_count}/${render.concurrency} đang chạy`} />
                <Row k="Đang chờ" v={`${render.waiting_count} việc`} />
              </>
            ) : (
              <Row k="Trạng thái" v="—" />
            )}
            <p className="av-muted text-xs">Mỗi việc có trạng thái riêng. Mức song song theo cấu hình của máy.</p>
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

          {/* autovideo://…: cửa sổ app (Tauri) tự mở thư mục bằng Explorer; trong trình duyệt dev các link này không làm gì */}
          <Section id="data" title="Dữ liệu & log">
            <Row k="Thư mục dữ liệu" v={<span className="av-mono">{status.data?.data_dir ?? '—'}</span>} />
            <div className="flex flex-wrap gap-2">
              <a className="av-btn" href="autovideo://open-data">Mở thư mục dữ liệu</a>
              <a className="av-btn" href="autovideo://open-logs">Mở thư mục log</a>
            </div>
            <p className="av-muted text-xs">Gặp lỗi thì mở thư mục log và gửi các file trong đó cho bộ phận hỗ trợ. Tải lại trang: phím F5.</p>
          </Section>
        </div>
      </div>
    </>
  );
}
