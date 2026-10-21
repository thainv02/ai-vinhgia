import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parseJson } from '../repo.js';

export const accountBody = z.object({
  alias: z.string().trim().min(1).max(80), provider: z.enum(['codex', 'antigravity', 'claude', 'openai']),
  model: z.string().trim().min(1).max(150), priority: z.number().int().min(0).max(10000).default(100),
  base_url: z.string().url().optional(), key_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).nullable().optional(),
  capabilities: z.array(z.enum(['text', 'vision', 'tools'])).min(1).default(['text', 'vision', 'tools']),
  quota_scope_key: z.string().max(150).nullable().optional(),
});
export interface Account {
  id: number; alias: string; provider: string; adapter: string; model: string; base_url: string; key_env: string | null;
  enabled: number; priority: number; capabilities: string; quota_scope_key: string | null; state: string;
  retry_after: string | null; reserved_until: string | null; reservation_id: string | null; last_error: string | null; last_used_at: string | null;
}
export function localUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) {
    throw new AppError('INVALID_GATEWAY', 'Gateway phải là HTTP loopback, không chứa credential/query');
  }
  return value.replace(/\/$/, '');
}
export function account(ctx: AppContext, id: number): Account {
  const r = ctx.db.prepare('SELECT * FROM ai_accounts WHERE id=?').get(id) as Account | undefined;
  if (!r) throw notFound('tài khoản AI');
  return r;
}
export function listAccounts(ctx: AppContext) {
  return (ctx.db.prepare('SELECT * FROM ai_accounts ORDER BY priority,id').all() as Account[]).map((a) => ({
    id: a.id, alias: a.alias, provider: a.provider, model: a.model, base_url: a.base_url, enabled: !!a.enabled,
    priority: a.priority, capabilities: parseJson<string[]>(a.capabilities, []), quota_scope_key: a.quota_scope_key,
    state: a.state, retry_after: a.retry_after, last_error: a.last_error, last_used_at: a.last_used_at,
    login_method: ['codex', 'antigravity'].includes(a.provider) && !a.key_env ? 'cli-oauth' : 'external-gateway',
    login_command: ['codex', 'antigravity'].includes(a.provider) && !a.key_env ? `npm run ai:login -- ${a.id}` : null,
  }));
}
export function secretDir(ctx: AppContext, id: number) { return path.join(ctx.config.aiHome, String(id)); }
export function keyOf(ctx: AppContext, a: Account) {
  if (a.key_env) {
    const key = process.env[a.key_env];
    if (!key) throw new AppError('KEY_MISSING', 'Biến môi trường gateway key chưa được cấu hình', 503);
    return key;
  }
  return fs.readFileSync(path.join(secretDir(ctx, a.id), 'access-key'), 'utf8').trim();
}
export function createAccount(ctx: AppContext, input: z.infer<typeof accountBody>) {
  if (['claude', 'openai'].includes(input.provider) && (!input.base_url || !input.key_env)) throw new AppError('GATEWAY_REQUIRED', 'Claude/OpenAI API cần gateway local và tên biến môi trường key');
  return ctx.tx(() => {
    const next = (ctx.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='ai_accounts'),0)+1 AS n").get() as { n: number }).n;
    const base = localUrl(input.base_url ?? `http://127.0.0.1:${18317 + next}/v1`);
    const r = ctx.db.prepare(`INSERT INTO ai_accounts(alias,provider,model,base_url,key_env,priority,capabilities,quota_scope_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.alias, input.provider, input.model, base, input.key_env ?? null, input.priority, JSON.stringify(input.capabilities), input.quota_scope_key ?? null, ctx.now());
    const id = Number(r.lastInsertRowid);
    const dir = secretDir(ctx, id);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new AppError('CREDENTIAL_STORE_EXISTS', 'Store này đã tồn tại (có thể sau restore DB). Khôi phục DB account pool hoặc đổi AI_HOME; không ghi đè credential cũ', 409);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'access-key'), key, { mode: 0o600 });
    const port = Number(new URL(base).port || 80);
    // One isolated proxy/store per account. Autovideo is the only account router.
    fs.writeFileSync(path.join(dir, 'config.yaml'), `server:\n  host: "127.0.0.1"\n  port: ${port}\naccess:\n  api-keys:\n    - "${key}"\nmanagement:\n  allow-remote: false\n  secret-key: "${crypto.randomBytes(32).toString('hex')}"\noauth:\n  auth-dir: ${JSON.stringify(path.join(dir, 'auth'))}\n  providers:\n    antigravity:\n      antigravity-credits: false\nrouting:\n  strategy: "fill-first"\n  retry:\n    request-retry: 0\n    max-retry-credentials: 1\n`, { mode: 0o600 });
    return listAccounts(ctx).find((a) => a.id === id)!;
  });
}

export const policyBody = z.object({
  providers: z.array(z.enum(['codex', 'antigravity', 'claude', 'openai'])).min(1).max(4).default(['codex', 'antigravity', 'claude', 'openai']),
  allow_provider_fallback: z.boolean().default(false), allow_model_fallback: z.boolean().default(false), max_attempts: z.number().int().min(1).max(3).default(3),
});
export function projectPolicy(ctx: AppContext, projectId: number) {
  const row = ctx.db.prepare('SELECT policy FROM ai_project_policy WHERE project_id=?').get(projectId) as { policy: string } | undefined;
  return policyBody.parse(row ? JSON.parse(row.policy) : {});
}
