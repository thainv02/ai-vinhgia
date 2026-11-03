import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { modelRejection, withModelFallback, type AiTask } from '../../lib/ai-routing.js';
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

/** Tài khoản giả đại diện cho API AI gọi trực tiếp (`AI_API_URL`): không có dòng trong `ai_accounts`. */
export const DIRECT_PROVIDER = 'internal';

/** Tổng thời gian tối đa của một lượt gọi API AI trực tiếp, và thời gian tối đa không nhận được byte nào (stream bị treo). */
export const DIRECT_TOTAL_MS = 10 * 60_000;
export const DIRECT_IDLE_MS = 90_000;

interface StreamMessage {
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

/**
 * Ghép các chunk SSE của `/chat/completions` (`stream: true`) thành một `message` như bản không stream: nối `delta.content`,
 * gộp `delta.tool_calls` theo `index` (tên + arguments được gửi từng mẩu). Bỏ qua `reasoning_content` và dòng không phải `data:`.
 */
export function assembleStream(sse: string): { message: StreamMessage; usage: unknown } | null {
  let content = '';
  let sawContent = false;
  let usage: unknown = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for (const raw of sse.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: unknown };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') {
      content += delta.content;
      sawContent = true;
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(i, cur);
    }
  }
  if (!sawContent && calls.size === 0) return null;
  const message: StreamMessage = { content: sawContent ? content : null };
  if (calls.size) {
    message.tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } }));
  }
  return { message, usage };
}

/** Đọc hết body (stream) với giới hạn tổng thời gian, thời gian im lặng và kích thước. */
async function readBody(res: Response, total: AbortController, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  let idle: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => total.abort(), DIRECT_IDLE_MS);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      out += decoder.decode(value, { stream: true });
      if (out.length > maxBytes) throw new Error('response_too_large');
    }
    return out + decoder.decode();
  } finally {
    clearTimeout(idle);
  }
}

/**
 * Gọi thẳng API AI cấu hình bằng `AI_API_URL`/`AI_API_KEY`/`AI_MODEL` (chuẩn OpenAI `/chat/completions`, HTTPS được), không qua account pool.
 * Luôn dùng `stream: true`: proxy phía trước API nội bộ cắt phản hồi không stream sau ~50 giây (504), còn stream thì giữ được tới khi xong.
 * Hết quota / lỗi tạm / mạng, và cả thiếu key / sai key → `AI_UNAVAILABLE` kèm `retry_at`: worker xếp job chờ rồi thử lại, nên nhập key đúng
 * trong Cài đặt là job tự chạy tiếp (không phải bấm làm lại). Model bị giới hạn/không tồn tại → router thử model phù hợp khác;
 * lỗi dữ liệu request → `AI_INVALID_REQUEST` (job lỗi).
 */
async function inferDirect(ctx: AppContext, jobId: number, messages: unknown[], tools: unknown[], modelOverride?: string) {
  const { aiApiUrl, aiApiKey } = ctx.config;
  const aiModel = modelOverride ?? ctx.config.aiModel; // override do SERVER chọn theo policy của job (xem models.ts modelForJob), không bao giờ lấy từ worker
  const waitUntil = (ms: number) => new Date(ctx.clock.now() + ms).toISOString();
  if (!aiApiKey) throw new AppError('AI_UNAVAILABLE', 'Chưa có API key của máy chủ AI (nhập trong Cài đặt)', 503, { retry_at: waitUntil(60_000), reason: 'key_missing' });
  const start = Date.now();
  let outcome = 'network_error';
  const abort = new AbortController();
  const totalTimer = setTimeout(() => abort.abort(), DIRECT_TOTAL_MS);
  try {
    let res: Response;
    let raw: string;
    try {
      res = await fetch(`${aiApiUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aiApiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: aiModel, messages, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools, parallel_tool_calls: false } : {}) }),
        signal: abort.signal,
        redirect: 'error',
      });
      raw = await readBody(res, abort, 4_000_000);
    } catch (err) {
      if (err instanceof Error && err.message === 'response_too_large') throw new AppError('AI_UNAVAILABLE', 'API AI trả về quá lớn', 503, { retry_at: waitUntil(30_000) });
      if (abort.signal.aborted) outcome = 'timeout';
      throw new AppError('AI_UNAVAILABLE', abort.signal.aborted ? 'API AI không trả lời kịp' : 'Không kết nối được API AI', 503, { retry_at: waitUntil(30_000) });
    }
    if (!res.ok) {
      const failure = normalizeFailure(res.status, raw, res.headers.get('retry-after'), ctx.clock.now());
      outcome = failure.code;
      const rejected = modelRejection(ctx, res.status, raw, res.headers.get('retry-after'));
      if (rejected) { outcome = rejected.outcome; throw rejected; }
      if (res.status === 401 || res.status === 403) throw new AppError('AI_UNAVAILABLE', 'Máy chủ AI từ chối API key (kiểm tra lại trong Cài đặt)', 503, { retry_at: waitUntil(60_000), reason: 'key_invalid' });
      if (failure.code === 'invalid_request') throw new AppError('AI_INVALID_REQUEST', `Dịch vụ AI chưa xử lý được yêu cầu này (HTTP ${res.status}). Hãy liên hệ bộ phận hỗ trợ nếu lỗi lặp lại.`, 400);
      throw new AppError('AI_UNAVAILABLE', `API AI tạm lỗi (HTTP ${res.status})`, 503, { retry_at: failure.retryAt ?? waitUntil(30_000), status:res.status, reason:failure.code });
    }
    // Phần lớn gateway trả SSE; nếu trả JSON thường (bỏ qua stream) thì đọc như bản không stream
    let parsed: { message: StreamMessage; usage: unknown } | null = null;
    if (/^\s*\{/.test(raw)) {
      try {
        const body = JSON.parse(raw) as { choices?: { message?: StreamMessage }[]; usage?: unknown };
        const m = body.choices?.[0]?.message;
        if (m && (typeof m.content === 'string' || Array.isArray(m.tool_calls))) parsed = { message: m, usage: body.usage ?? null };
      } catch {
        parsed = null;
      }
    } else {
      parsed = assembleStream(raw);
    }
    if (!parsed) {
      outcome = 'invalid_response';
      throw new AppError('AI_UNAVAILABLE', 'API AI trả về không hợp lệ', 503, { retry_at: waitUntil(30_000) });
    }
    outcome = 'ok';
    ctx.publish('ai.updated', null, { job_id: jobId, state: 'ready' });
    return { message: parsed.message, account: { id: null, alias: 'API AI', provider: DIRECT_PROVIDER, model: aiModel }, usage: parsed.usage };
  } finally {
    clearTimeout(totalTimer);
    ctx.db.prepare('INSERT INTO ai_attempts(account_id,job_id,model,outcome,latency_ms,created_at) VALUES(NULL,?,?,?,?,?)').run(jobId, aiModel, outcome, Date.now() - start, ctx.now());
  }
}

/** `opts.model`: chỉ có tác dụng với API AI trực tiếp (account pool dùng model của từng tài khoản). Do server quyết định, không nhận từ request của worker. */
export async function infer(ctx: AppContext, jobId: number, projectId: number, messages: unknown[], tools: unknown[], capabilities: string[], opts: { model?: string; task?: AiTask } = {}) {
  if (ctx.config.aiApiUrl) {
    if (!ctx.config.aiApiKey) return inferDirect(ctx, jobId, messages, tools, opts.model);
    return withModelFallback(ctx, { task: opts.task ?? 'planning', preferred: opts.model, capabilities }, (model) => inferDirect(ctx, jobId, messages, tools, model));
  }
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
      const res = await gateway(ctx, candidate, '/chat/completions', { model: candidate.model, messages, stream: false, ...(tools.length ? { tools, parallel_tool_calls: false } : {}) });
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
