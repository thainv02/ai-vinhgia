/**
 * `GET <AI_API_URL>/models` dùng chung (Cài đặt, Video HTML): không cache cho kiểm tra key mới (`fetchModels`), cache 10 phút cho danh sách đã cấu hình (`listModels`).
 * Nằm ở lib/ (không phải services/ai/) vì listener LAN được import (routes-settings) mà không được import service của app chính. Key chỉ dùng phía server.
 */
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { AppError } from './errors.js';

/** Gọi `GET <url>/models` bằng `key` (không cache): danh sách ID, hoặc lỗi dễ hiểu (sai key, không kết nối được). */
export async function fetchModels(url: string, key: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  } catch {
    throw new AppError('AI_UNREACHABLE', `Không kết nối được API AI (${url}). Kiểm tra mạng nội bộ.`, 502);
  }
  if (res.status === 401 || res.status === 403) throw new AppError('AI_KEY_INVALID', 'API AI từ chối key này', 400);
  if (!res.ok) throw new AppError('AI_UNREACHABLE', `API AI trả lỗi ${res.status}`, 502);
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

export const MODELS_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; ids: string[] }>();
const cacheKey = (url: string, key: string) => `${url}\n${crypto.createHash('sha256').update(key).digest('hex')}`;

/** Danh sách model của API AI đã cấu hình, cache 10 phút (theo URL + key). `refresh` bỏ qua cache. Ném AppError khi chưa cấu hình/không gọi được. */
export async function listModels(ctx: AppContext, o: { refresh?: boolean } = {}): Promise<string[]> {
  const { aiApiUrl, aiApiKey } = ctx.config;
  if (!aiApiUrl) throw new AppError('AI_URL_MISSING', 'Chưa cấu hình địa chỉ API AI (AI_API_URL)', 409);
  if (!aiApiKey) throw new AppError('KEY_MISSING', 'Chưa nhập API key', 400);
  const k = cacheKey(aiApiUrl, aiApiKey);
  const hit = cache.get(k);
  if (!o.refresh && hit && ctx.clock.now() - hit.at < MODELS_TTL_MS) return hit.ids;
  const ids = await fetchModels(aiApiUrl, aiApiKey);
  cache.set(k, { at: ctx.clock.now(), ids });
  return ids;
}
export const clearModelCache = (): void => cache.clear();

