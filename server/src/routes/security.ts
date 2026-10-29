import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { allowedOriginsFor } from '../config.js';
import { AppError } from '../lib/errors.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Chặn Host lạ (DNS rebinding) và Origin lạ trên request ghi (trang web khác gọi API tốn credit). */
export function registerSecurity(app: FastifyInstance, ctx: AppContext): void {
  const origins = new Set(allowedOriginsFor(ctx.config.port, ctx.config.extraAllowedOrigins).map((o) => o.toLowerCase()));
  app.addHook('onRequest', async (req) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!ALLOWED_HOSTNAMES.has(host)) {
      throw new AppError('FORBIDDEN_HOST', 'Header Host không được phép (chỉ localhost / 127.0.0.1)', 403);
    }
    if (WRITE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
        throw new AppError('FORBIDDEN_ORIGIN', 'Origin không được phép gọi API này', 403);
      }
    }
  });
}
