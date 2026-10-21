import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import { account, localUrl, secretDir, type Account } from './accounts.js';
import { managementKey } from './management-key.js';

export interface QuotaWindow {
  id: string; label: string; model: string | null; remaining_percent: number; resets_at: string | null; window_minutes: number | null;
}
export interface QuotaSnapshot { source: string; observed_at: string; windows: QuotaWindow[] }

function number(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}
function iso(value: unknown): string | null {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}
function percent(value: unknown): number | null {
  const n = number(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}

export function parseAntigravityQuota(body: any): QuotaWindow[] {
  if (!body?.models || Array.isArray(body.models) || typeof body.models !== 'object') return [];
  return Object.entries(body.models).flatMap(([model, info]: [string, any]) => {
    const n = number(info?.quotaInfo?.remainingFraction);
    if (n === null || n < 0 || n > 1) return [];
    return [{ id: model, model, label: String(info.displayName ?? model).slice(0, 150), remaining_percent: Math.round(n * 1000) / 10, resets_at: iso(info.quotaInfo.resetTime), window_minutes: null }];
  });
}

export function parseCodexQuota(body: any): QuotaWindow[] {
  const limits = body?.rateLimitsByLimitId ?? body?.rate_limits_by_limit_id;
  const groups: [string, any][] = limits && typeof limits === 'object' ? Object.entries(limits) : [['codex', body?.rateLimits ?? body?.rate_limit ?? body]];
  return groups.flatMap(([group, limit]) => ['primary', 'secondary'].flatMap((key) => {
    const window = limit?.[key] ?? limit?.[`${key}_window`];
    const used = percent(window?.usedPercent ?? window?.used_percent);
    if (used === null) return [];
    const duration = number(window?.windowDurationMins) ?? (number(window?.limit_window_seconds) !== null ? window.limit_window_seconds / 60 : null);
    const minutes = duration !== null && duration > 0 ? duration : null;
    const label = minutes === 300 ? '5 giờ' : minutes === 10080 ? '7 ngày' : minutes !== null ? `${minutes} phút` : key === 'primary' ? 'Hạn mức chính' : 'Hạn mức bổ sung';
    return [{ id: `${group}:${key}`, model: null, label: group === 'codex' ? label : `${group} · ${label}`, remaining_percent: Math.round((100 - used) * 10) / 10,
      resets_at: iso(window.resetsAt ?? window.reset_at), window_minutes: minutes }];
  }));
}

export function parseCodexSignals(signals: Record<string, unknown>): QuotaWindow[] {
  const lower = Object.fromEntries(Object.entries(signals).map(([k, v]) => [k.toLowerCase(), v]));
  const value = (key: string) => {
    const v = lower[key];
    return typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : v;
  };
  const limit = Object.fromEntries(['primary', 'secondary'].map((key) => [key, {
    usedPercent: value(`x-codex-${key}-used-percent`), windowDurationMins: value(`x-codex-${key}-window-minutes`), resetsAt: value(`x-codex-${key}-reset-at`),
  }]));
  return parseCodexQuota({ rateLimits: limit });
}

async function management(a: Account, key: string, endpoint: string, body?: unknown) {
  const origin = new URL(localUrl(a.base_url)).origin;
  const response = await fetch(origin + '/v0/management' + endpoint, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'management_unavailable' : 'gateway_unavailable');
  return response.json() as Promise<any>;
}

async function collect(a: Account, key: string) {
  const auths = await management(a, key, '/auth-files');
  const files = (Array.isArray(auths.files) ? auths.files : []).filter((f: any) => (f.provider ?? f.type) === a.provider && !f.disabled);
  if (files.length !== 1 || typeof files[0].auth_index !== 'string') throw new Error('credential_not_unique');
  const credential = files[0];
  if (a.provider === 'codex') {
    const quota = credential.model_quotas?.[a.model] ?? credential.quota;
    const passive = parseCodexSignals(quota?.signals ?? {});
    if (passive.length && typeof quota?.observed_at === 'string' && Date.now() - Date.parse(quota.observed_at) < 300000) return { windows: passive, observed_at: iso(quota.observed_at) };
  }
  const endpoint = a.provider === 'antigravity' ? 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels' : 'https://chatgpt.com/backend-api/wham/usage';
  // Fixed read-only quota endpoints. Caller cannot inject a URL/header/body or see OAuth tokens.
  const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' };
  const chatgptAccountId = credential.id_token?.chatgpt_account_id;
  if (a.provider === 'codex' && typeof chatgptAccountId === 'string') header['Chatgpt-Account-Id'] = chatgptAccountId;
  if (a.provider === 'antigravity') header['User-Agent'] = 'antigravity/2.24.0';
  const result = await management(a, key, '/api-call', { auth_index: credential.auth_index, method: a.provider === 'antigravity' ? 'POST' : 'GET', url: endpoint, header,
    ...(a.provider === 'antigravity' ? { data: JSON.stringify(typeof credential.project_id === 'string' ? { project: credential.project_id } : {}) } : {}) });
  if (result.status_code !== 200 || typeof result.body !== 'string') throw new Error(result.status_code === 401 ? 'login_required' : 'quota_unavailable');
  const data = JSON.parse(result.body);
  return { windows: a.provider === 'antigravity' ? parseAntigravityQuota(data) : parseCodexQuota(data), observed_at: null };
}

const inFlight = new WeakMap<AppContext, Map<number, Promise<QuotaSnapshot | null>>>();
export async function refreshQuota(ctx: AppContext, id: number): Promise<QuotaSnapshot | null> {
  const row = ctx.db.prepare('SELECT quota_checked_at,quota_snapshot FROM ai_accounts WHERE id=?').get(id) as { quota_checked_at: string | null; quota_snapshot: string | null } | undefined;
  const a = account(ctx, id);
  if (row?.quota_checked_at && ctx.clock.now() - Date.parse(row.quota_checked_at) < 60000) return row.quota_snapshot ? JSON.parse(row.quota_snapshot) : null;
  let map = inFlight.get(ctx); if (!map) { map = new Map(); inFlight.set(ctx, map); }
  const running = map.get(id); if (running) return running;
  const promise = (async () => {
    let error: string | null = null;
    let snapshot: QuotaSnapshot | null = null;
    try {
      if (a.key_env || !['antigravity', 'codex'].includes(a.provider)) throw new Error('unsupported');
      const dir = secretDir(ctx, id);
      const upgrading = !fs.existsSync(path.join(dir, 'management-key'));
      const key = managementKey(dir);
      if (upgrading) await new Promise((r) => setTimeout(r, 800));
      const result = await collect(a, key);
      if (!result.windows.length) throw new Error('no_quota_data');
      snapshot = { source: a.provider, observed_at: result.observed_at ?? ctx.now(), windows: result.windows };
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      error = ['unsupported', 'management_unavailable', 'credential_not_unique', 'login_required', 'no_quota_data', 'quota_unavailable'].includes(code) ? code : 'gateway_unavailable';
    }
    ctx.db.prepare('UPDATE ai_accounts SET quota_snapshot=COALESCE(?,quota_snapshot),quota_checked_at=?,quota_error=? WHERE id=?').run(snapshot ? JSON.stringify(snapshot) : null, ctx.now(), error, id);
    return snapshot ?? (row?.quota_snapshot ? JSON.parse(row.quota_snapshot) : null);
  })();
  map.set(id, promise);
  try { return await promise; } finally { map.delete(id); }
}
