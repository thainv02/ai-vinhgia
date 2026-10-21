import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { keyOf, account, projectPolicy, localUrl, secretDir, type Account } from './accounts.js';
import { parseJson } from '../repo.js';

export function normalizeFailure(status: number, body: string, retryAfter: string | null, now: number) {
  let code = 'upstream_error'; let delay = 30_000; let state = 'cooldown';
  if (status === 401) { code = 'login_required'; state = 'login_required'; delay = 0; }
  else if (status === 403) { code = 'access_denied'; state = 'access_denied'; delay = 0; }
  else if (status === 429) {
    code = /quota|usage.limit|resource.exhausted|credit/i.test(body) ? 'quota_exhausted' : 'rate_limited';
    delay = 60_000;
  } else if (status >= 400 && status < 500) { code = 'invalid_request'; state = 'ready'; delay = 0; }
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(parsed)) delay = Math.max(1000, Math.min(parsed - now, 7 * 86400_000));
  }
  return { code, state, retryAt: delay ? new Date(now + delay).toISOString() : null };
}

async function gateway(ctx: AppContext, a: Account, endpoint: string, payload?: unknown) {
  const url = localUrl(a.base_url) + endpoint;
  return fetch(url, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${keyOf(ctx, a)}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(120_000), redirect: 'error' });
}

export async function probeAccount(ctx: AppContext, id: number) {
  const a = account(ctx, id);
  try {
    const identityFile = path.join(secretDir(ctx, id), 'identity');
    if (fs.existsSync(identityFile)) {
      const identity = fs.readFileSync(identityFile, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(identity)) {
        ctx.db.prepare('UPDATE ai_accounts SET identity_hash=?,quota_scope_key=COALESCE(quota_scope_key,?) WHERE id=?').run(identity, `${a.provider}:${identity}`, id);
        const duplicate = ctx.db.prepare('SELECT id FROM ai_accounts WHERE provider=? AND identity_hash=? AND id<>? AND enabled=1 LIMIT 1').get(a.provider, identity, id);
        if (duplicate) {
          ctx.db.prepare("UPDATE ai_accounts SET enabled=0,state='disabled',last_error='duplicate_identity' WHERE id=?").run(id);
          return { ok: false, models: [], entitlement_verified: false, reason: 'duplicate_identity' };
        }
      }
    }
    const res = await gateway(ctx, a, '/models');
    if (!res.ok) throw new Error('gateway_unavailable');
    const body = await res.json() as { data?: { id: string }[] };
    const models = (body.data ?? []).map((m) => m.id);
    const found = models.includes(a.model);
    const cooling = a.retry_after && Date.parse(a.retry_after) > ctx.clock.now();
    ctx.db.prepare('UPDATE ai_accounts SET state=?,last_error=?,last_checked_at=?,retry_after=? WHERE id=?')
      .run(found ? cooling ? a.state : 'ready' : 'model_unavailable', found ? cooling ? a.last_error : null : 'model_unavailable', ctx.now(), cooling ? a.retry_after : null, id);
    return { ok: found, models, entitlement_verified: false };
  } catch {
    ctx.db.prepare("UPDATE ai_accounts SET state='offline',last_error='gateway_unavailable',last_checked_at=? WHERE id=?").run(ctx.now(), id);
    return { ok: false, models: [], entitlement_verified: false };
  }
}

export async function infer(ctx: AppContext, jobId: number, projectId: number, messages: unknown[], tools: unknown[], capabilities: string[]) {
  const policy = projectPolicy(ctx, projectId);
  const all = (ctx.db.prepare('SELECT * FROM ai_accounts WHERE enabled=1 ORDER BY priority,id').all() as Account[])
    .filter((a) => capabilities.every((c) => parseJson<string[]>(a.capabilities, []).includes(c)))
    .sort((a, b) => policy.providers.indexOf(a.provider as typeof policy.providers[number]) - policy.providers.indexOf(b.provider as typeof policy.providers[number]) || a.priority - b.priority || a.id - b.id)
    .filter((a) => policy.providers.includes(a.provider as typeof policy.providers[number]));
  const provider = all[0]?.provider;
  const primaryModels = new Map<string, string>();
  for (const a of all) if (!primaryModels.has(a.provider)) primaryModels.set(a.provider, a.model);
  let count = 0;
  for (const candidate of all) {
    if (!policy.allow_provider_fallback && candidate.provider !== provider) continue;
    if (!policy.allow_model_fallback && primaryModels.get(candidate.provider) !== candidate.model) continue;
    if (count >= policy.max_attempts) break;
    const reservation = crypto.randomUUID();
    const reserved = ctx.tx(() => {
      const a = account(ctx, candidate.id);
      if (!a.enabled || ['login_required', 'access_denied', 'model_unavailable', 'disabled'].includes(a.state)) return false;
      if (a.retry_after && Date.parse(a.retry_after) > ctx.clock.now()) return false;
      if (a.reserved_until && Date.parse(a.reserved_until) > ctx.clock.now()) return false;
      if (a.quota_scope_key && ctx.db.prepare('SELECT 1 FROM ai_accounts WHERE quota_scope_key=? AND retry_after>? LIMIT 1').get(a.quota_scope_key, ctx.now())) return false;
      ctx.db.prepare('UPDATE ai_accounts SET reservation_id=?,reserved_until=?,last_used_at=? WHERE id=?')
        .run(reservation, new Date(ctx.clock.now() + 150_000).toISOString(), ctx.now(), a.id);
      return true;
    });
    if (!reserved) continue;
    count++;
    const start = Date.now(); let outcome = 'network_error';
    try {
      const res = await gateway(ctx, candidate, '/chat/completions', { model: candidate.model, messages, stream: false, ...(tools.length ? { tools } : {}) });
      const raw = await res.text();
      if (raw.length > 4_000_000) throw new Error('response_too_large');
      if (!res.ok) {
        const failure = normalizeFailure(res.status, raw, res.headers.get('retry-after'), ctx.clock.now());
        outcome = failure.code;
        ctx.db.prepare('UPDATE ai_accounts SET state=?,retry_after=?,last_error=? WHERE id=?').run(failure.state, failure.retryAt, failure.code, candidate.id);
        if (failure.code === 'invalid_request') throw new AppError('AI_INVALID_REQUEST', 'Gateway từ chối định dạng request; kiểm tra adapter/model', 400);
        continue;
      }
      const body = JSON.parse(raw) as { choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[]; usage?: unknown };
      const message = body.choices?.[0]?.message;
      if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) throw new Error('invalid_response');
      outcome = 'ok';
      ctx.db.prepare("UPDATE ai_accounts SET state='ready',retry_after=NULL,last_error=NULL,last_checked_at=? WHERE id=?").run(ctx.now(), candidate.id);
      ctx.publish('ai.updated', null, { account_id: candidate.id, job_id: jobId, state: 'ready' });
      return { message, account: { id: candidate.id, alias: candidate.alias, provider: candidate.provider, model: candidate.model }, usage: body.usage ?? null };
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.db.prepare("UPDATE ai_accounts SET state='cooldown',retry_after=?,last_error='gateway_unavailable' WHERE id=?")
        .run(new Date(ctx.clock.now() + 30_000).toISOString(), candidate.id);
    } finally {
      ctx.db.prepare('UPDATE ai_accounts SET reservation_id=NULL,reserved_until=NULL WHERE id=? AND reservation_id=?').run(candidate.id, reservation);
      ctx.db.prepare('INSERT INTO ai_attempts(account_id,job_id,model,outcome,latency_ms,created_at) VALUES(?,?,?,?,?,?)')
        .run(candidate.id, jobId, candidate.model, outcome, Date.now() - start, ctx.now());
    }
  }
  ctx.publish('ai.updated', null, { job_id: jobId, state: 'waiting' });
  throw new AppError('AI_UNAVAILABLE', 'Chưa có tài khoản AI phù hợp đang khả dụng', 503, { retry_at: new Date(ctx.clock.now() + 60_000).toISOString() });
}
