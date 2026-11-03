import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadSttModel, sttModelDir } from '../src/services/clips/stt-model.js';

// All downloads and waits are simulated; no model service is contacted.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async (_ms, _value, options) => options?.signal?.throwIfAborted()) }));
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-stt-retry-'));
  vi.mocked(delay).mockClear();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('waits for Retry-After on 429, releases the response, then still verifies downloaded bytes', async () => {
  const limited = new Response('busy', { status: 429, headers: { 'Retry-After': '12' } });
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(limited)
    .mockResolvedValueOnce(new Response('invalid model'));
  const onRetry = vi.fn();
  await expect(downloadSttModel(dir, { fetchImpl, onRetry })).rejects.toThrow(/SHA256/);
  expect(limited.bodyUsed).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(delay).toHaveBeenCalledWith(12_000, undefined, { signal: undefined });
  expect(onRetry).toHaveBeenCalledWith({ file: 'encoder.int8.onnx', attempt: 1, waitMs: 12_000 });
  expect(fs.readdirSync(sttModelDir(dir))).toEqual([]);
});

it('bounds retries and gives actionable guidance for persistent rate limits', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('busy', { status: 429 }));
  await expect(downloadSttModel(dir, { fetchImpl })).rejects.toThrow(/HTTP 429.*không cần cài lại app/);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([5_000, 10_000, 20_000]);
  expect(fs.readdirSync(sttModelDir(dir))).toEqual([]);
});

it('uses the Hugging Face RateLimit reset window when Retry-After is absent', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { RateLimit: '"resolvers";r=0;t=55' } }))
    .mockResolvedValueOnce(new Response('missing', { status: 404 }));
  await expect(downloadSttModel(dir, { fetchImpl })).rejects.toThrow(/HTTP 404/);
  expect(delay).toHaveBeenCalledWith(55_000, undefined, { signal: undefined });
});

it('honors HTTP-date Retry-After and avoids an early retry for long cooldowns', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('busy', {
    status: 429, headers: { 'Retry-After': new Date(Date.now() + 600_000).toUTCString() },
  }));
  await expect(downloadSttModel(dir, { fetchImpl })).rejects.toThrow(/HTTP 429/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it('cancels during the retry wait without another request or partial files', async () => {
  const abort = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('busy', { status: 503 }));
  await expect(downloadSttModel(dir, { fetchImpl, signal: abort.signal, onRetry: () => abort.abort() }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(sttModelDir(dir))).toEqual([]);
});

it('does not retry permanent HTTP errors', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('missing', { status: 404 }));
  await expect(downloadSttModel(dir, { fetchImpl })).rejects.toThrow(/HTTP 404/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});
