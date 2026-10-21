import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { intParam, parse } from '../lib/validate.js';
import { accountBody, createAccount, listAccounts, policyBody, projectPolicy, account } from '../services/ai/accounts.js';
import { probeAccount } from '../services/ai/router.js';
import { getProject } from '../services/repo.js';

/** Admin credentials are process-local, short-lived and never provider credentials. */
export function registerAiRoutes(app: FastifyInstance, ctx: AppContext) {
  const sessions = new Map<string, { csrf: string; until: number }>();
  app.register(async (a) => {
    a.addHook('onRequest', async (req) => {
      if (!(req.url.startsWith('/api/ai/') || req.url.includes('/ai-policy'))) return;
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('FORBIDDEN', 'Yêu cầu quản trị phải từ trang local', 403);
      if (req.method === 'GET') return;
      const sid = /(?:^|;\s*)autovideo_ai=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const session = sid ? sessions.get(sid) : undefined;
      if (!session || session.until < Date.now() || req.headers['x-ai-csrf'] !== session.csrf) throw new AppError('AI_ADMIN_REQUIRED', 'Mở lại trang Tài khoản AI để tạo phiên quản trị local', 403);
    });
    a.get('/api/ai/session', async (_req, reply) => {
      for (const [id, s] of sessions) if (s.until < Date.now()) sessions.delete(id);
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
      const sid = crypto.randomUUID(), csrf = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, { csrf, until: Date.now() + 3600_000 });
      reply.header('Cache-Control', 'no-store').header('Set-Cookie', `autovideo_ai=${sid}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600`);
      return { csrf };
    });
    a.get('/api/ai/accounts', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return listAccounts(ctx);
    });
    a.get('/api/ai/status', async () => ({ worker_mode: ctx.config.workerMode, accounts: listAccounts(ctx),
      sessions: ctx.db.prepare('SELECT worker_id,mode,last_seen_at FROM worker_sessions').all() }));
    a.post('/api/ai/accounts', async (req, reply) => reply.code(201).send(createAccount(ctx, parse(accountBody, req.body))));
    a.patch('/api/ai/accounts/:id', async (req) => {
      const id = intParam((req.params as { id: string }).id); account(ctx, id);
      const b = parse(z.object({ alias: z.string().trim().min(1).max(80).optional(), model: z.string().trim().min(1).max(150).optional(), enabled: z.boolean().optional(), priority: z.number().int().min(0).max(10000).optional() }), req.body);
      ctx.db.prepare('UPDATE ai_accounts SET alias=COALESCE(?,alias),model=COALESCE(?,model),enabled=COALESCE(?,enabled),priority=COALESCE(?,priority) WHERE id=?')
        .run(b.alias ?? null, b.model ?? null, b.enabled === undefined ? null : Number(b.enabled), b.priority ?? null, id);
      if (b.enabled) ctx.db.prepare("UPDATE ai_accounts SET state='unknown' WHERE id=? AND state='disabled'").run(id);
      return listAccounts(ctx).find((a) => a.id === id);
    });
    a.delete('/api/ai/accounts/:id', async (req) => {
      const id = intParam((req.params as { id: string }).id); const row = account(ctx, id);
      if (row.reserved_until && Date.parse(row.reserved_until) > ctx.clock.now()) throw new AppError('ACCOUNT_BUSY', 'Tắt tài khoản, chờ request hiện tại kết thúc rồi ngắt liên kết', 409);
      // Disable without deleting credential stores that may still be used by a native client.
      ctx.db.prepare("UPDATE ai_accounts SET enabled=0,state='disabled' WHERE id=?").run(id);
      return { ok: true, credentials_revoked: false };
    });
    a.post('/api/ai/accounts/:id/probe', async (req) => probeAccount(ctx, intParam((req.params as { id: string }).id)));
    a.get('/api/projects/:id/ai-policy', async (req) => { const id = intParam((req.params as { id: string }).id); getProject(ctx, id); return projectPolicy(ctx, id); });
    a.patch('/api/projects/:id/ai-policy', async (req) => {
      const id = intParam((req.params as { id: string }).id); getProject(ctx, id);
      const policy = parse(policyBody, req.body);
      ctx.db.prepare('INSERT INTO ai_project_policy VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET policy=excluded.policy').run(id, JSON.stringify(policy));
      return policy;
    });
    a.post('/api/ai/jobs/:id/resume', async (req) => {
      const id = intParam((req.params as { id: string }).id);
      const job = ctx.db.prepare('SELECT wait_reason FROM jobs WHERE id=?').get(id) as { wait_reason: string | null } | undefined;
      if (!job) throw new AppError('NOT_FOUND', 'Không tìm thấy job', 404);
      if (job.wait_reason === 'needs_reconciliation') throw new AppError('RECONCILIATION_REQUIRED', 'Cần đối soát lượt tạo bằng worker; không tự bỏ qua intent', 409);
      ctx.db.prepare('UPDATE jobs SET wait_reason=NULL,next_attempt_at=NULL WHERE id=? AND status=\'queued\'').run(id);
      return { ok: true };
    });
  });
}
