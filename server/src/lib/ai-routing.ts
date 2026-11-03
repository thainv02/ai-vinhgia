/** Automatic model selection shared by worker inference and transcript correction.
 * Only explicit HTTP rejections may trigger failover. A lost/partial response must
 * never cause an immediate duplicate inference on another model.
 */
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { AppError } from './errors.js';
import { listModels } from './ai-models.js';

export type AiTask = 'planning' | 'fast' | 'compose' | 'vision';
export interface ModelProfile {
  text: boolean;
  vision: boolean;
  code: boolean;
  maxOutput: number;
  jsonMode: boolean;
}

// Explicit supported IDs; /models confirms availability, not capabilities.
// Provider docs: platform.claude.com/docs/en/models/overview,
// ai.google.dev/gemini-api/docs/models/gemini-2.5-flash,
// developers.openai.com/api/docs/models/gpt-4.1-mini.
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-sonnet-4-6': { text: true, vision: true, code: true, maxOutput: 16_000, jsonMode: false },
  'claude-haiku-4-5': { text: true, vision: true, code: true, maxOutput: 16_000, jsonMode: false },
  'claude-haiku-4-5-20251001': { text: true, vision: true, code: true, maxOutput: 16_000, jsonMode: false },
  'gemini-2.5-flash': { text: true, vision: true, code: true, maxOutput: 65_536, jsonMode: true },
  'gpt-4.1-mini': { text: true, vision: true, code: true, maxOutput: 32_768, jsonMode: true },
  'gpt-4.1-mini-2025-04-14': { text: true, vision: true, code: true, maxOutput: 32_768, jsonMode: true },
};
export const profileOf = (id: string): ModelProfile | null => MODEL_PROFILES[id] ?? null;

interface RoutingState { credential: string; cooldowns: Map<string, number> }
const states = new WeakMap<AppContext, RoutingState>();
function stateOf(ctx: AppContext): RoutingState {
  const credential = crypto.createHash('sha256').update(ctx.config.aiApiUrl + '\n' + ctx.config.aiApiKey).digest('hex');
  let state = states.get(ctx);
  if (!state || state.credential !== credential) {
    state = { credential, cooldowns: new Map() };
    states.set(ctx, state);
  }
  for (const [id, until] of state.cooldowns) if (until <= ctx.clock.now()) state.cooldowns.delete(id);
  return state;
}
export function clearModelRouting(ctx: AppContext): void { states.delete(ctx); }

export interface ModelSelection {
  task: AiTask;
  preferred?: string;
  capabilities?: string[];
  signal?: AbortSignal;
}

export async function modelCandidates(ctx: AppContext, o: ModelSelection): Promise<string[]> {
  let ids: string[] | null;
  try { ids = await listModels(ctx); } catch { ids = null; }
  o.signal?.throwIfAborted();
  const preferred = o.preferred || (o.task === 'fast' ? ctx.config.aiFastModel : ctx.config.aiModel);
  const fast = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gemini-2.5-flash'];
  const rank = o.task === 'fast' ? fast : ['claude-sonnet-4-6', 'gemini-2.5-flash', 'gpt-4.1-mini', ...fast];
  const choices = [...new Set((ids === null ? [preferred || ctx.config.aiModel] : [preferred, ...rank, ctx.config.aiModel]).filter((x): x is string => !!x))];
  return choices.filter((id) => {
    if (ids && !ids.includes(id)) return false;
    const p = profileOf(id);
    // Preserve configured private aliases as the initial preference only. Unknown
    // /models entries are never guessed to support images or code for failover.
    if (!p) return id === preferred || (o.task === 'fast' && !preferred && id === ctx.config.aiModel);
    if (o.task === 'compose' && (!p.code || p.maxOutput < 16_000)) return false;
    if ((o.task === 'vision' || o.capabilities?.includes('vision')) && !p.vision) return false;
    return p.text;
  });
}

/** Safe to retry elsewhere: upstream explicitly rejected this request. */
export class ModelRejected extends AppError {
  constructor(readonly retryAt: number, readonly outcome: string) {
    super('AI_UNAVAILABLE', 'Dịch vụ AI đang giới hạn model; ứng dụng sẽ tự chọn model phù hợp khác.', 503, { retry_at: new Date(retryAt).toISOString() });
  }
}

export function modelRejection(ctx: AppContext, status: number, raw: string, retryAfter: string | null): ModelRejected | null {
  const quota = /quota[_ .-]?(?:exhausted|exceeded)|resource[_ .-]?exhausted|rate[_ .-]?limit|usage[_ .-]?limit|model[_ .-]?cooldown/i.test(raw);
  const unavailable = (status === 404 || status === 400) && /model[_ .-]?not[_ .-]?found|unknown model|model[^\n]{0,80}(?:not found|not available|does not exist)/i.test(raw);
  if (!(status === 429 || (status === 503 && quota) || unavailable)) return null;
  const now = ctx.clock.now();
  let wait = 60_000;
  if (retryAfter?.trim()) {
    const n = Number(retryAfter);
    const parsed = Number.isFinite(n) ? n * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(parsed)) wait = Math.max(1000, Math.min(parsed, 7 * 86400_000));
  }
  return new ModelRejected(now + wait, unavailable ? 'model_unavailable' : 'rate_limited');
}

/** Bounded failover within the SAME operation/job. Never creates a replacement job. */
export async function withModelFallback<T>(ctx: AppContext, o: ModelSelection, run: (id: string) => Promise<T>): Promise<T> {
  const candidates = await modelCandidates(ctx, o);
  const state = stateOf(ctx);
  let attempts = 0;
  for (const id of candidates) {
    o.signal?.throwIfAborted();
    if ((state.cooldowns.get(id) ?? 0) > ctx.clock.now()) continue;
    if (attempts++ >= 3) break;
    try { return await run(id); }
    catch (e) {
      if (!(e instanceof ModelRejected)) throw e;
      state.cooldowns.set(id, e.retryAt);
    }
  }
  const availableLater = candidates.map((id) => state.cooldowns.get(id) ?? ctx.clock.now() + 30_000);
  const retryAt = availableLater.length ? Math.min(...availableLater) : ctx.clock.now() + 60_000;
  throw new AppError('AI_UNAVAILABLE', candidates.length
    ? 'Các model AI phù hợp đang tạm giới hạn. Yêu cầu được giữ và sẽ tự chạy lại khi có model sẵn sàng.'
    : 'Chưa có model AI phù hợp đang khả dụng. Yêu cầu được giữ để tự thử lại; nếu kéo dài, hãy liên hệ bộ phận hỗ trợ.',
  503, { retry_at: new Date(retryAt).toISOString(), reason: candidates.length ? 'models_cooling_down' : 'model_unavailable' });
}
