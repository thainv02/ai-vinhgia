interface QuotaWindow { id: string; label: string; model: string | null; remaining_percent: number; resets_at: string | null; window_minutes: number | null }
export interface AccountQuotaData {
  quota?: { observed_at: string; source: string; windows: QuotaWindow[] } | null;
  quota_checked_at?: string | null; quota_error?: string | null; model: string;
}
function Bar({ window, stale }: { window: QuotaWindow; stale: boolean }) {
  const n = window.remaining_percent;
  const color = stale ? 'bg-slate-400' : n <= 10 ? 'bg-red-500' : n <= 30 ? 'bg-amber-500' : 'bg-emerald-500';
  return <div className="min-w-44 space-y-1">
    <div className="flex items-baseline justify-between gap-3 text-xs"><span className="max-w-48 truncate" title={window.label}>{window.label}</span><strong className="whitespace-nowrap">{n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% còn lại</strong></div>
    <div role="progressbar" aria-label={`Hạn mức còn lại ${window.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={n} className="h-2 overflow-hidden rounded-full bg-surface-3"><div className={`h-full rounded-full ${color}`} style={{ width: `${n}%` }} /></div>
    <div className="text-[11px] text-muted">{window.resets_at ? Date.parse(window.resets_at) <= Date.now() ? 'Mốc reset đã qua · chờ cập nhật' : `Reset ${new Date(window.resets_at).toLocaleString('vi-VN')}` : 'Chưa có thời điểm reset'}</div>
  </div>;
}
export function AccountQuota({ account }: { account: AccountQuotaData }) {
  const windows = account.quota?.windows ?? [];
  if (!windows.length) return <div className="max-w-64 text-xs text-muted"><span>Chưa có dữ liệu hạn mức</span><p className="mt-1">{account.quota_error === 'unsupported' ? 'Kết nối này chưa cung cấp quota subscription.' : account.quota_error === 'login_required' ? 'Cần đăng nhập lại để đọc quota.' : account.quota_error === 'management_unavailable' ? 'Cần khởi động lại proxy để bật đọc quota.' : 'Chỉ hiển thị khi provider trả dữ liệu; không suy từ số token đã dùng.'}</p></div>;
  const age = Date.now() - Date.parse(account.quota!.observed_at);
  const selected = windows.filter((w) => !w.model || w.model === account.model);
  const shown = selected;
  const other = windows.filter((w) => !shown.includes(w));
  const stale = !!account.quota_error || age > 10 * 60000;
  return <div className="space-y-3 py-1">
    {!shown.length && <p className="text-xs text-muted">Chưa có quota cho model đang chọn</p>}
    {shown.map((w) => <Bar key={w.id} window={w} stale={stale || (!!w.resets_at && Date.parse(w.resets_at) <= Date.now())} />)}
    {other.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-muted">{other.length} model khác</summary><div className="mt-3 space-y-3">{other.map((w) => <Bar key={w.id} window={w} stale={stale || (!!w.resets_at && Date.parse(w.resets_at) <= Date.now())} />)}</div></details>}
    <div className="text-[11px] text-muted">{stale ? 'Dữ liệu cũ · ' : ''}Cập nhật {new Date(account.quota!.observed_at).toLocaleTimeString('vi-VN')}</div>
  </div>;
}
