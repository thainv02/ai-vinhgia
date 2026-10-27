import path from 'node:path';
import { REPO_ROOT } from '../../server/src/config.js';
import { loadDotEnv } from '../../server/src/lib/env.js';

loadDotEnv(path.join(REPO_ROOT, '.env'));
export const root = REPO_ROOT;
export const apiUrl = process.env.AUTOVIDEO_API ?? 'http://127.0.0.1:8787';
export const workerId = process.env.AUTOVIDEO_WORKER_ID ?? `managed-${process.pid}`;
import { ApiFailure } from './api-failure.js';
export { ApiFailure };
export async function api<T = any>(method: string, url: string, body?: unknown, lease?: string, jobId?: number, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(apiUrl + url, { method, headers: {
    Authorization: `Bearer ${process.env.WORKER_TOKEN ?? ''}`, 'X-Worker-Id': workerId,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(lease ? { 'X-Job-Lease': lease } : {}), ...(jobId ? { 'X-Job-Id': String(jobId) } : {}), ...extra,
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(135_000), redirect: 'error' });
  if (res.status === 204) return null as T;
  const b = await res.json() as any;
  if (!res.ok) throw new ApiFailure(b.error?.code ?? 'HTTP_ERROR', b.error?.message ?? 'API request failed', b.error?.details);
  return b as T;
}
export interface Job {
  id: number; type: string; payload: any; lease_id: string; lease_epoch: number; checkpoint: any;
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
