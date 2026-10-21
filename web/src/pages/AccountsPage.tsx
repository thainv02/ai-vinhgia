import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { Button } from '../components/Button';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { AccountQuota, type AccountQuotaData } from '../components/AccountQuota';

interface Account extends AccountQuotaData {
  id: number; alias: string; provider: string; model: string; base_url: string; enabled: boolean; priority: number;
  state: string; retry_after: string | null; last_error: string | null; login_command: string | null;
}
interface Policy { providers: string[]; allow_provider_fallback: boolean; allow_model_fallback: boolean; max_attempts: number }
let adminSession: Promise<{ csrf: string }> | null = null;
let sessionUntil = 0;
export async function aiRequest<T>(url: string, method = 'GET', body?: unknown, retrySession = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    if (!adminSession || Date.now() >= sessionUntil) {
      sessionUntil = Date.now() + 45 * 60000;
      adminSession = fetch('/api/ai/session').then(async (session) => {
        if (!session.ok) throw new Error('Không mở được phiên quản trị');
        return session.json() as Promise<{ csrf: string }>;
      }).catch((error) => { adminSession = null; throw error; });
    }
    headers['X-AI-CSRF'] = (await adminSession).csrf;
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await r.json();
  if (!r.ok && result.error?.code === 'AI_ADMIN_REQUIRED' && retrySession) {
    adminSession = null; return aiRequest<T>(url, method, body, false);
  }
  if (!r.ok) throw new Error(result.error?.message ?? 'Yêu cầu thất bại');
  return result;
}
const labels: Record<string, string> = { unknown: 'Chưa kiểm tra', ready: 'Gateway sẵn sàng', cooldown: 'Đang chờ thử lại', login_required: 'Cần đăng nhập lại', access_denied: 'Không có quyền truy cập', model_unavailable: 'Model chưa khả dụng', offline: 'Gateway chưa kết nối', disabled: 'Đã ngắt liên kết' };
const defaults: Policy = { providers: ['codex', 'antigravity', 'claude', 'openai'], allow_provider_fallback: false, allow_model_fallback: false, max_attempts: 3 };

export default function AccountsPage() {
  useDocumentTitle('Tài khoản AI');
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['ai-accounts'], queryFn: () => aiRequest<Account[]>('/api/ai/accounts'), refetchInterval: 5000 });
  const quotas = useQuery({ queryKey: ['ai-quotas'], queryFn: async () => {
    const rows = await aiRequest<Account[]>('/api/ai/quotas/refresh', 'POST', {});
    qc.setQueryData(['ai-accounts'], rows); return rows;
  }, refetchInterval: 5 * 60000, staleTime: 60000, retry: false, refetchOnWindowFocus: false });
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => aiRequest<{ worker_mode: string }>('/api/ai/status'), refetchInterval: 10000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const [alias, setAlias] = useState('');
  const [provider, setProvider] = useState('codex');
  const [model, setModel] = useState('');
  const [priority, setPriority] = useState(100);
  const [baseUrl, setBaseUrl] = useState('');
  const [keyEnv, setKeyEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Account | null>(null);
  const [models, setModels] = useState<Record<number, string[]>>({});
  const [project, setProject] = useState('');
  const [policy, setPolicy] = useState(defaults);
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await qc.invalidateQueries({ queryKey: ['ai-accounts'] }); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-6xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-bold">Tài khoản AI</h1><p className="mt-1 text-sm text-muted">Giữ tài khoản đang dùng; chuyển sang tài khoản tiếp theo khi quota không còn khả dụng.</p></div><Button loading={quotas.isFetching} disabled={busy} onClick={() => void quotas.refetch()}>Cập nhật hạn mức</Button></div>
    <div className="rounded-lg border border-line bg-surface p-4 text-sm">
      Chế độ worker: <strong>{status.data?.worker_mode === 'managed' ? 'Tự động qua account pool' : 'Worker bên ngoài (legacy)'}</strong>.
      <p className="mt-1 text-muted">Thanh hiển thị phần trăm hạn mức còn lại do provider trả về, tự cập nhật mỗi 5 phút. Đây không phải số token còn lại. Quota AI tách biệt với credit Google Flow.</p>
    </div>
    {(error || accounts.error) && <div role="alert" className="rounded-lg bg-danger-bg p-3 text-sm text-danger-fg">{error || errorMessage(accounts.error)}</div>}
    {quotas.error && <div role="status" className="text-xs text-muted">Chưa cập nhật được hạn mức. Dữ liệu lần trước vẫn được giữ; bấm Cập nhật hạn mức để thử lại.</div>}
    {notice && <div role="status" className="rounded-lg bg-surface-2 p-3 text-sm">{notice}</div>}
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">Thêm tài khoản</h2>
      <form className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void act(async () => {
        const a = await aiRequest<Account>('/api/ai/accounts', 'POST', { alias, provider, model: model || 'pending', priority, ...(baseUrl ? { base_url: baseUrl } : {}), ...(keyEnv ? { key_env: keyEnv } : {}) });
        setSelected(a); setAlias(''); setNotice('Đã thêm tài khoản. Hoàn tất bước kết nối bên dưới rồi kiểm tra gateway.');
      }); }}>
        <label className="text-sm">Tên dễ nhớ<input required maxLength={80} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Codex A" className="mt-1" /></label>
        <label className="text-sm">Nhà cung cấp<select value={provider} onChange={(e) => setProvider(e.target.value)} className="mt-1"><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude API / gateway ngoài</option><option value="openai">OpenAI API / gateway ngoài</option></select></label>
        <label className="text-sm">Model ID (chọn sau đăng nhập)<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Có thể để trống" className="mt-1" /></label>
        <label className="text-sm">Ưu tiên (số nhỏ trước)<input type="number" min={0} max={10000} value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="mt-1" /></label>
        <details className="sm:col-span-2 lg:col-span-4 text-sm"><summary className="cursor-pointer text-muted">Gateway ngoài hoặc API credentials</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><label>Gateway local URL<input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Để trống: tạo proxy local riêng" /></label><label>Tên biến môi trường chứa API key<input value={keyEnv} onChange={(e) => setKeyEnv(e.target.value)} placeholder="Ví dụ AUTOVIDEO_CLAUDE_KEY" /></label></div><p className="mt-2 text-muted">Nhập tên biến, không nhập token. Claude subscription dùng CLI nguyên bản; ứng dụng inference dùng API/gateway được phép.</p></details>
        <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" variant="primary" loading={busy}>Thêm tài khoản</Button></div>
      </form>
    </section>
    {selected && <section className="rounded-lg border border-line bg-surface-2 p-4">
      <h2 className="font-semibold">Kết nối {selected.alias}</h2>
      {selected.login_command ? <><p className="mt-2 text-sm">Chạy lệnh này trong terminal của repo, chọn đúng tài khoản trong luồng đăng nhập của provider:</p><pre className="my-2 overflow-x-auto rounded bg-surface p-3 text-sm">{selected.login_command}</pre><p className="text-sm">Sau khi đăng nhập, giữ proxy chạy trong một terminal riêng:</p><pre className="mt-2 overflow-x-auto rounded bg-surface p-3 text-sm">npm run ai:proxy -- {selected.id}</pre></> : <p className="mt-2 text-sm">Khởi động gateway tại {selected.base_url} và cấu hình biến môi trường key trên server. Sau đó bấm Kiểm tra.</p>}
      <p className="mt-2 text-xs text-muted">Mỗi account dùng credential store riêng. Không đăng nhập tài khoản thứ hai vào cùng store; thêm một dòng tài khoản mới.</p>
    </section>}
    <section className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-surface-2 text-muted"><tr><th className="p-3">Tài khoản / model</th><th className="p-3">Hạn mức còn lại</th><th className="p-3">Trạng thái</th><th className="p-3">Ưu tiên</th><th className="p-3">Thao tác</th></tr></thead><tbody className="divide-y divide-line">
        {accounts.isLoading && <tr><td colSpan={5} className="p-5 text-muted">Đang tải tài khoản...</td></tr>}
        {accounts.data?.length === 0 && <tr><td colSpan={5} className="p-6 text-muted">Chưa có tài khoản. Thêm từng tài khoản để thiết lập pool.</td></tr>}
        {accounts.data?.map((a) => <tr key={a.id} className={!a.enabled ? 'opacity-60' : ''}>
          <td className="p-3"><strong>{a.alias}</strong><div className="text-xs text-muted">{a.provider} · {a.model}</div>{models[a.id] && <select aria-label={`Model ${a.alias}`} className="mt-2 max-w-64" value={a.model} disabled={busy} onChange={(e) => void act(async () => { await aiRequest(`/api/ai/accounts/${a.id}`, 'PATCH', { model: e.target.value }); })}><option value={a.model}>{a.model}</option>{models[a.id].filter((m) => m !== a.model).map((m) => <option key={m}>{m}</option>)}</select>}</td>
          <td className="p-3"><AccountQuota account={a} /></td>
          <td className="p-3"><span>{a.enabled ? labels[a.state] ?? a.state : 'Đã tắt'}</span>{a.retry_after && <div className="text-xs text-muted">Thử lại: {new Date(a.retry_after).toLocaleString('vi-VN')}</div>}{a.last_error && <div className="text-xs text-muted">{a.last_error}</div>}</td>
          <td className="p-3"><input aria-label={`Ưu tiên ${a.alias}`} className="max-w-20" type="number" min={0} max={10000} defaultValue={a.priority} key={`${a.id}-${a.priority}`} disabled={busy} onBlur={(e) => { const n = Number(e.target.value); if (n !== a.priority) void act(async () => { await aiRequest(`/api/ai/accounts/${a.id}`, 'PATCH', { priority: n }); }); }} /></td>
          <td className="p-3"><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => setSelected(a)}>Kết nối</Button><Button size="sm" disabled={busy} onClick={() => void act(async () => { const r = await aiRequest<{ ok: boolean; models: string[] }>(`/api/ai/accounts/${a.id}/probe`, 'POST', {}); setModels((old) => ({ ...old, [a.id]: r.models })); setNotice(r.ok ? 'Gateway có model đã chọn. Quyền inference sẽ được xác nhận khi thực hiện job.' : 'Gateway/model chưa sẵn sàng. Kiểm tra đăng nhập, proxy và model ID.'); })}>Kiểm tra</Button><Button size="sm" disabled={busy} onClick={() => void act(async () => { await aiRequest(`/api/ai/accounts/${a.id}`, 'PATCH', { enabled: !a.enabled }); })}>{a.enabled ? 'Tắt' : 'Bật'}</Button></div></td>
        </tr>)}
      </tbody></table>
    </section>
    <section className="rounded-lg border border-line bg-surface p-4"><h2 className="font-semibold">Chuyển provider theo dự án</h2><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm">Dự án<select value={project} onChange={(e) => { setProject(e.target.value); if (e.target.value) void act(async () => setPolicy(await aiRequest<Policy>(`/api/projects/${e.target.value}/ai-policy`))); }}><option value="">Chọn dự án</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-sm">Thứ tự provider (cách nhau dấu phẩy)<input value={policy.providers.join(',')} onChange={(e) => setPolicy({ ...policy, providers: e.target.value.split(',').map((v) => v.trim()) })} /></label></div><div className="my-3 flex flex-wrap gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={policy.allow_provider_fallback} onChange={(e) => setPolicy({ ...policy, allow_provider_fallback: e.target.checked })} />Cho phép chuyển provider</label><label className="flex items-center gap-2"><input type="checkbox" checked={policy.allow_model_fallback} onChange={(e) => setPolicy({ ...policy, allow_model_fallback: e.target.checked })} />Cho phép chuyển model</label></div><Button disabled={!project || busy} onClick={() => void act(async () => { await aiRequest(`/api/projects/${project}/ai-policy`, 'PATCH', policy); setNotice('Đã lưu chính sách AI cho dự án.'); })}>Lưu chính sách</Button></section>
  </div>;
}
