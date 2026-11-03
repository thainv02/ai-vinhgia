import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { autoRenderConcurrency } from '../config.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { setEnvValue } from '../lib/env.js';
import { parse } from '../lib/validate.js';
import { clearModelRouting } from '../lib/ai-routing.js';
import { fetchModels, clearModelCache } from '../lib/ai-models.js';
import { resolveFastModel } from '../services/clips/transcript-fix.js';
import { downloadSttModel, STT_MODEL, STT_MODEL_BYTES, SttModelDownloadError, sttModelStatus } from '../services/clips/stt-model.js';

/** Key chỉ gồm ký tự an toàn: không khoảng trắng/xuống dòng (chặn chèn thêm dòng vào config.env). */
const apiKey = z.string().trim().min(8, 'API key quá ngắn').max(300).regex(/^[\x21-\x7e]+$/, 'API key không được có khoảng trắng hay ký tự lạ');

/** Thông tin AI an toàn để trả cho giao diện: không bao giờ có key, chỉ 4 ký tự cuối để người dùng nhận ra. */
export function aiSettingsView(ctx: AppContext) {
  const { aiApiUrl, aiApiKey, aiModel } = ctx.config;
  return { url: aiApiUrl || null, model: aiModel, key_set: !!aiApiKey, key_hint: aiApiKey ? `…${aiApiKey.slice(-4)}` : null };
}

/** Lượt tải model nhận dạng lời nói đang chạy / vừa xong (một lượt mỗi thư mục model; giữ trong bộ nhớ, giao diện hỏi lại để lấy tiến độ). */
interface SttDownload {
  state: 'downloading' | 'done' | 'failed' | 'cancelled';
  received: number;
  total: number;
  error: string | null;
  abort: AbortController;
}
const sttDownloads = new Map<string, SttDownload>();

export async function sttSettingsView(ctx: AppContext) {
  const s = sttModelStatus(ctx.config.sttModelsDir);
  const d = sttDownloads.get(ctx.config.sttModelsDir);
  return {
    provider: ctx.config.sttProvider,
    model: { id: STT_MODEL.id, label: STT_MODEL.label, total_bytes: STT_MODEL_BYTES },
    installed: s.installed,
    dir: s.dir,
    threads: ctx.config.sttThreads,
    download: d ? { state: d.state, received: d.received, total: d.total, error: d.error } : null,
    // AI nhẹ chuẩn hoá chính tả kết quả nhận dạng (model: AI_FAST_MODEL hoặc tự chọn trong danh sách; cần API key)
    ai_fix: { enabled: ctx.config.sttAiFix, key_set: !!ctx.config.aiApiKey, model: ctx.config.sttAiFix && ctx.config.aiApiKey ? await resolveFastModel(ctx) : null },
  };
}

function startSttDownload(ctx: AppContext): void {
  const key = ctx.config.sttModelsDir;
  if (sttDownloads.get(key)?.state === 'downloading') return;
  const d: SttDownload = { state: 'downloading', received: 0, total: STT_MODEL_BYTES, error: null, abort: new AbortController() };
  sttDownloads.set(key, d);
  void downloadSttModel(key, { signal: d.abort.signal, onProgress: (p) => (d.received = p.received) }).then(
    () => (d.state = 'done'),
    (e: unknown) => {
      if (d.abort.signal.aborted) d.state = 'cancelled';
      else {
        d.state = 'failed';
        d.error = e instanceof SttModelDownloadError ? e.message : `Tải model thất bại: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  );
}

/**
 * Cài đặt của app (listener chỉ nghe 127.0.0.1): API AI, model nhận dạng lời nói trên máy.
 * Lưu vào file cấu hình (`config.env`) và áp dụng ngay.
 */
export function registerLanSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const renderView=()=>({concurrency:ctx.config.renderConcurrency,auto_concurrency:autoRenderConcurrency({cores:os.availableParallelism(),freeMemBytes:os.freemem()}),effective_concurrency:ctx.finalRender?.concurrency??1});
  app.get('/lan/api/settings/render',async()=>renderView());
  app.put('/lan/api/settings/render',async(req)=>{
    const body=parse(z.object({concurrency:z.union([z.literal('auto'),z.number().int().min(1).max(4)])}).strict(),req.body);
    if(!ctx.config.envFile)throw new AppError('CONFIG_READONLY','Không có file cấu hình để lưu',409);
    setEnvValue(ctx.config.envFile,'RENDER_CONCURRENCY',String(body.concurrency));ctx.config.renderConcurrency=body.concurrency;ctx.finalRender?.refreshConcurrency();return renderView();
  });
  // Model nhận dạng lời nói (installer đã tải; thiếu thì tải bù ở đây)
  app.get('/lan/api/settings/stt', async () => sttSettingsView(ctx));
  app.post('/lan/api/settings/stt/download', async () => {
    if (!sttModelStatus(ctx.config.sttModelsDir).installed) startSttDownload(ctx);
    return sttSettingsView(ctx);
  });
  app.post('/lan/api/settings/stt/download/cancel', async () => {
    sttDownloads.get(ctx.config.sttModelsDir)?.abort.abort();
    return sttSettingsView(ctx);
  });

  app.get('/lan/api/settings/ai', async () => aiSettingsView(ctx));

  // Kiểm tra key (key mới trong body, hoặc key đang lưu) mà không lưu
  app.post('/lan/api/settings/ai/check', async (req) => {
    const body = parse(z.object({ api_key: apiKey.optional() }), req.body ?? {});
    const key = body.api_key ?? ctx.config.aiApiKey;
    if (!ctx.config.aiApiUrl) throw new AppError('AI_URL_MISSING', 'Chưa cấu hình địa chỉ API AI (AI_API_URL)', 409);
    if (!key) throw new AppError('KEY_MISSING', 'Chưa nhập API key', 400);
    return { ok: true, models: await fetchModels(ctx.config.aiApiUrl, key) };
  });

  app.put('/lan/api/settings/ai', async (req) => {
    const body = parse(z.object({ api_key: apiKey.optional() }).strict(), req.body ?? {});
    if (!ctx.config.envFile) throw new AppError('CONFIG_READONLY', 'Không có file cấu hình để lưu', 409);
    if (body.api_key !== undefined) {
      setEnvValue(ctx.config.envFile, 'AI_API_KEY', body.api_key);
      ctx.config.aiApiKey = body.api_key;
      clearModelCache();
      clearModelRouting(ctx);
    }
    return aiSettingsView(ctx);
  });
}
