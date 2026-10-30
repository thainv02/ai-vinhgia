import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { registerClipEndpoints } from '../services/clips/http.js';

/**
 * Cắt clip từ video dài (app chính): xem docs mục "Cắt clip từ video dài" trong server/API.md. Cùng bộ endpoint với listener LAN
 * (`lan/routes-clips.ts`), khác tiền tố và hạn mức.
 */
export function registerClipRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerClipEndpoints(app, ctx, { lan: false, prefix: '/api', view: () => ({ lan: false }), scope: () => undefined });
}
