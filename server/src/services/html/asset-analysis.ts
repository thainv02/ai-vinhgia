import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { ffmpegOf } from '../media.js';
import { runHtmlMedia as run } from './media-task.js';
import { parseJson } from '../repo.js';
import { getHtmlAsset, versionOfJob } from './repo.js';

const bounded = (max: number, required = false) => z.preprocess((v) => typeof v === 'string' ? v.trim().slice(0, max) : v, required ? z.string().min(1).max(max) : z.string().max(max).default(''));
export const imageDescriptionSchema = z.object({ summary: bounded(600, true), text: bounded(600), details: bounded(400), uncertain: z.boolean() });
function checkedAsset(ctx: AppContext, job: JobRow, id: number) {
  const version = versionOfJob(ctx, job.id);
  const a = getHtmlAsset(ctx, job.project_id, id);
  const snapshot = ctx.db.prepare('SELECT content_hash FROM html_version_assets WHERE version_id=? AND asset_ref=?').get(version?.id ?? -1, id) as { content_hash: string } | undefined;
  if (job.type !== 'html_compose' || !version || !['composing', 'validating'].includes(version.status) || !snapshot || snapshot.content_hash !== a.content_hash || a.kind !== 'image') throw new AppError('INVALID_ASSET', 'Ảnh không thuộc snapshot của job đang tạo', 409);
  return a;
}
export function saveImageDescription(ctx: AppContext, job: JobRow, id: number, input: unknown) {
  checkedAsset(ctx, job, id);
  const description = parse(imageDescriptionSchema, input);
  ctx.db.prepare('UPDATE html_assets SET description_json=?, scan_error_code=NULL WHERE id=?').run(JSON.stringify(description), id);
  return { description };
}
export function markImageScanFailure(ctx: AppContext, job: JobRow, id: number, code: string) {
  checkedAsset(ctx, job, id);
  ctx.db.prepare('UPDATE html_assets SET scan_error_code=?,label_confirmed=0,description_json=NULL WHERE id=?').run(code, id);
  return { needs_label: true };
}
/** Thumbnail local, chạy trong hàng đợi render; trả base64 chỉ qua API worker đã xác thực. */
export async function imageForAnalysis(ctx: AppContext, job: JobRow, id: number) {
  const a = checkedAsset(ctx, job, id);
  if (a.scan_error_code && !a.label_confirmed) return { scan_error: a.scan_error_code };
  const cached = a.description_json ?? (ctx.db.prepare('SELECT description_json FROM html_assets WHERE project_id=? AND content_hash=? AND description_json IS NOT NULL LIMIT 1').get(job.project_id, a.content_hash) as { description_json: string } | undefined)?.description_json;
  if (cached) return { description: parseJson(cached, null) };
  if (!ctx.finalRender) throw new AppError('SERVICE_UNAVAILABLE', 'Hàng đợi dựng chưa sẵn sàng', 503);
  return new Promise<{ image_url: string }>((resolve, reject) => {
    const key = `asset-${job.id}-${id}`;
    let running = false, settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearInterval(tick); fn(); } };
    const active = () => !!ctx.db.prepare("SELECT id FROM jobs WHERE id=? AND status IN ('claimed','running') AND lease_id=?").get(job.id, job.lease_id);
    const tick = setInterval(() => {
      if (!running && !ctx.finalRender?.queueInfo('html-capture', key)) { finish(() => reject(new AppError('SERVICE_UNAVAILABLE', 'Hàng đợi dựng đã dừng', 503))); return; }
      if (!active()) { ctx.finalRender?.cancelHtmlTask('html-capture', key); if (!running) finish(() => reject(new AppError('JOB_CANCELLED', 'Job đã hủy', 409))); }
    }, 500);
    tick.unref();
    ctx.finalRender!.enqueueHtmlTask('html-capture', key, true, async (abort) => {
      running = true;
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-image-'));
      try {
        const bin = await ffmpegOf(ctx.config); if (!bin) throw new Error('Không tìm thấy ffmpeg');
        const out = path.join(temp, 'image.jpg');
        await run(bin, ['-y','-hide_banner','-loglevel','error','-i',path.join(ctx.config.rootDir, a.stored_path),'-frames:v','1','-vf',"scale=1024:1024:force_original_aspect_ratio=decrease",'-q:v','3',out], abort.signal);
        if (!active() || abort.signal.aborted) throw new AppError('JOB_CANCELLED', 'Job đã hủy', 409);
        finish(() => resolve({ image_url: `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}` }));
      } catch (e) { finish(() => reject(e)); }
      finally { fs.rmSync(temp, { recursive: true, force: true }); }
    });
  });
}
