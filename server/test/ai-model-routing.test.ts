import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { clearModelCache } from '../src/lib/ai-models.js';
import { modelCandidates, modelRejection, withModelFallback } from '../src/lib/ai-routing.js';
import { fixTranscript } from '../src/services/clips/transcript-fix.js';
import type { Transcript } from '../src/services/clips/transcript.js';

afterEach(() => { vi.unstubAllGlobals(); clearModelCache(); });
function setup(ids = ['claude-sonnet-4-6', 'gemini-2.5-flash', 'claude-haiku-4-5']) {
  let now = Date.UTC(2026, 9, 31);
  const ctx = { config: { aiApiUrl: 'http://fake/v1', aiApiKey: 'test', aiModel: 'claude-sonnet-4-6', aiFastModel: '' }, clock: { now: () => now }, now: () => new Date(now).toISOString() } as AppContext;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: ids.map(id => ({ id })) })));
  return { ctx, advance: (ms: number) => { now += ms; } };
}
describe('automatic AI routing', () => {
  it('selects light models for transcript repair and excludes unknown advertised IDs', async () => {
    const { ctx } = setup(['unknown-image-model', 'claude-haiku-4-5', 'gemini-2.5-flash']);
    expect(await modelCandidates(ctx, { task: 'fast' })).toEqual(['claude-haiku-4-5', 'gemini-2.5-flash']);
    expect(await modelCandidates(ctx, { task: 'vision' })).not.toContain('unknown-image-model');
  });
  it('switches after 429, skips cooldown on subsequent calls, retries after expiry', async () => {
    const { ctx, advance } = setup();
    const run = vi.fn(async (id: string) => {
      if (id === 'claude-sonnet-4-6') throw modelRejection(ctx, 429, '', '120');
      return id;
    });
    expect(await withModelFallback(ctx, { task: 'planning' }, run)).toBe('gemini-2.5-flash');
    run.mockClear();
    await withModelFallback(ctx, { task: 'planning' }, run);
    expect(run.mock.calls.map(c => c[0])).toEqual(['gemini-2.5-flash']);
    advance(120_001);
    run.mockClear();
    await withModelFallback(ctx, { task: 'planning' }, run);
    expect(run.mock.calls[0]?.[0]).toBe('claude-sonnet-4-6');
  });
  it('keeps the request waiting at the earliest retry time when all models are limited', async () => {
    const { ctx } = setup();
    const run = vi.fn(async () => { throw modelRejection(ctx, 429, '', '120'); });
    await expect(withModelFallback(ctx, { task: 'compose' }, run)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', details: { retry_at: new Date(ctx.clock.now() + 120_000).toISOString() } });
    run.mockClear();
    await expect(withModelFallback(ctx, { task: 'compose' }, run)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
  });
  it('does not repeat ambiguous network errors or key failures', async () => {
    const { ctx } = setup();
    const error = new Error('connection reset');
    const run = vi.fn(async () => { throw error; });
    await expect(withModelFallback(ctx, { task: 'planning' }, run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(modelRejection(ctx, 401, 'invalid key', null)).toBeNull();
    expect(modelRejection(ctx, 503, 'service unavailable', null)).toBeNull();
    expect(modelRejection(ctx, 400, 'invalid messages', null)).toBeNull();
    expect(modelRejection(ctx, 404, 'model_not_found', null)).not.toBeNull();
  });
  it('uses only the configured model when the catalog cannot be fetched', async () => {
    const { ctx } = setup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await modelCandidates(ctx, { task: 'planning' })).toEqual(['claude-sonnet-4-6']);
  });
  it('resets cooldowns after a credential change and isolates app contexts', async () => {
    const { ctx } = setup(['claude-sonnet-4-6']);
    await expect(withModelFallback(ctx, { task: 'planning' }, async () => { throw modelRejection(ctx, 429, '', '120'); })).rejects.toThrow();
    ctx.config.aiApiKey = 'replacement';
    expect(await withModelFallback(ctx, { task: 'planning' }, async id => id)).toBe('claude-sonnet-4-6');
  });
  it('limits failover attempts and never uses models absent from the catalog', async () => {
    const { ctx } = setup(['claude-sonnet-4-6', 'gemini-2.5-flash', 'gpt-4.1-mini', 'claude-haiku-4-5']);
    const run = vi.fn(async () => { throw modelRejection(ctx, 429, '', null); });
    await expect(withModelFallback(ctx, { task: 'planning' }, run)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(run).toHaveBeenCalledTimes(3);
    const empty = setup([]).ctx;
    run.mockClear();
    clearModelCache();
    await expect(withModelFallback(empty, { task: 'vision' }, run)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'model_unavailable' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('transcript repair switches models while retaining word timestamps; all limited keeps ASR', async () => {
    const { ctx } = setup();
    const called: string[] = [];
    let allLimited = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/models')) return Response.json({ data: ['claude-haiku-4-5', 'gpt-4.1-mini'].map(id => ({ id })) });
      const model = JSON.parse(options!.body as string).model;
      called.push(model);
      if (allLimited || model === 'claude-haiku-4-5') return Response.json({ error: 'rate_limit_exceeded' }, { status: 429 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ s: [{ id: 1, t: 'Xin chào.' }] }) } }] });
    }));
    const transcript: Transcript = { version: 1, model: 'asr', duration_s: 1, terms: null, content_hash: null, speech_ratio: 1, segments: [],
      words: [{ i: 0, w: 'xin', start: 0, end: 0.4, p: 0.9 }, { i: 1, w: 'chào', start: 0.5, end: 0.9, p: 0.9 }],
      sentences: [{ id: 1, start_word: 0, end_word: 1, start: 0, end: 0.9, text: 'xin chào' }] };
    const result = await fixTranscript(ctx, transcript, new AbortController().signal);
    expect(called).toEqual(['claude-haiku-4-5', 'gpt-4.1-mini']);
    expect(result.info.model).toBe('gpt-4.1-mini');
    expect(result.words?.map(w => [w.start, w.end])).toEqual([[0, 0.4], [0.5, 0.9]]);
    allLimited = true;
    const failed = await fixTranscript(ctx, transcript, new AbortController().signal);
    expect(failed.words).toBeNull();
    expect(failed.info.error).toBeTruthy();
    expect(transcript.words[0]?.w).toBe('xin');
  });
});
