import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { listHtmlTemplates } from '../services/html/templates.js';

/** Mẫu Video HTML dựng sẵn. `GET /lan/api/html-templates` → `[{id, label, description, aspects}]`. */
export function registerLanHtmlTemplateRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/lan/api/html-templates', async () => listHtmlTemplates().map(({ id, label, description, aspects }) => ({ id, label, description, aspects })));
}
