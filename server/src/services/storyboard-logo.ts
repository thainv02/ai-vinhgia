import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AppContext } from '../context.js';
import type { JobRow } from '../db/types.js';
import { AppError, badRequest } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { shortStderr, toolCwd } from './final-render/watermark.js';
import { storyboardGeneratorOfPayload } from './generators.js';
import type { CompleteBody } from './jobs.js';
import { assetJson, getAsset, logEvent, parseJson } from './repo.js';
import { activeJobOf } from './rules.js';
import { emitScene, sceneSummaryById } from './scene-view.js';

/**
 * Bước xoá logo Gemini trên ảnh storyboard do Google Flow tạo, chạy khi worker nộp kết quả (trước transaction complete),
 * để ảnh lưu ở `output.storyboard_path` (và mang đi tạo video) là bản đã xoá logo.
 *
 * - Ảnh gốc của worker được giữ ở `<tên>_raw_j<job>.<đuôi>` cạnh ảnh storyboard; complete gửi lại của cùng job luôn làm từ
 *   ảnh gốc đó (job khác ghi cùng đường dẫn thì có file gốc riêng).
 * - Tool không thấy logo: giữ nguyên byte ảnh gốc. Tool lỗi hoặc chưa cấu hình: giữ ảnh gốc và ghi lý do;
 *   storyboard vẫn được nhận để không chặn quy trình, giao diện cảnh báo "chưa xoá được logo".
 * Kết quả ghi vào `meta.logo` của asset storyboard: { status: removed | none | failed | skipped, detail, raw_path }.
 */
export interface LogoResult {
  status: 'removed' | 'none' | 'failed' | 'skipped';
  detail: string;
  raw_path: string;
}

export const rawPathOf = (rel: string, jobId: number): string => {
  const ext = path.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)}_raw_j${jobId}${ext}`;
};

function runGwr(cli: string, input: string, output: string, timeoutMs: number): Promise<{ applied: boolean; skip: string | null }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, 'remove', input, '--output', output, '--overwrite', '--json'],
      { cwd: toolCwd(cli), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          reject(new Error(`tool thoát với mã ${typeof code === 'number' ? code : '?'}: ${shortStderr(String(stderr || err.message))}`));
          return;
        }
        try {
          const out = JSON.parse(String(stdout)) as { meta?: { applied?: unknown; skipReason?: unknown } };
          resolve({ applied: out.meta?.applied === true, skip: typeof out.meta?.skipReason === 'string' ? out.meta.skipReason : null });
        } catch {
          reject(new Error('tool không trả JSON hợp lệ'));
        }
      },
    );
  });
}

/** Xoá logo cho một file storyboard (đường dẫn tương đối trong output/). Không ném lỗi: lỗi nằm trong kết quả. */
export async function removeStoryboardLogo(ctx: AppContext, rel: string, rawRel: string): Promise<LogoResult> {
  const { config } = ctx;
  const abs = path.join(config.rootDir, rel);
  const rawAbs = path.join(config.rootDir, rawRel);
  // Lần đầu: ảnh worker vừa ghi chính là ảnh gốc. Lần sau (complete gửi lại): làm lại từ ảnh gốc đã giữ.
  if (!fs.existsSync(rawAbs)) fs.copyFileSync(abs, rawAbs);
  const restoreRaw = () => fs.copyFileSync(rawAbs, abs);

  const cli = config.gwrCli;
  if (config.watermarkRemover === 'off' || !cli || !path.isAbsolute(cli) || !fs.existsSync(cli)) {
    restoreRaw();
    const why = config.watermarkRemover === 'off' ? 'WATERMARK_REMOVER=off' : 'chưa có tool xoá logo (GWR_CLI)';
    return { status: 'skipped', detail: `Bỏ qua xoá logo: ${why}`, raw_path: rawRel };
  }
  const ext = path.extname(rel) || '.png';
  const tmpAbs = path.join(path.dirname(abs), `.${path.basename(rel, ext)}.logo-tmp${ext}`);
  try {
    const r = await runGwr(cli, rawAbs, tmpAbs, 120_000);
    if (r.applied) {
      fs.renameSync(tmpAbs, abs);
      return { status: 'removed', detail: 'Đã xoá logo Gemini', raw_path: rawRel };
    }
    fs.rmSync(tmpAbs, { force: true });
    restoreRaw();
    return { status: 'none', detail: r.skip === 'no-watermark-detected' ? 'Không thấy logo Gemini trên ảnh' : `Tool không xoá: ${r.skip ?? 'không rõ lý do'}`, raw_path: rawRel };
  } catch (e) {
    fs.rmSync(tmpAbs, { force: true });
    restoreRaw();
    return { status: 'failed', detail: `Xoá logo thất bại: ${(e as Error).message}`, raw_path: rawRel };
  }
}

/**
 * Gọi trước `completeJob` cho job storyboard của dịch vụ có `remove_logo`: xoá logo trên từng ảnh storyboard và
 * trả body đã gắn `meta.logo`. Job khác, hoặc job không còn đang chạy (complete gửi lại sau khi xong), trả nguyên body.
 */
export async function prepareStoryboardComplete(ctx: AppContext, job: JobRow | undefined, body: CompleteBody): Promise<CompleteBody> {
  if (!job || job.type !== 'storyboard' || (job.status !== 'claimed' && job.status !== 'running')) return body;
  if (!storyboardGeneratorOfPayload(job.payload).remove_logo) return body;
  const assets = [];
  for (const a of body.assets ?? []) {
    if (a.kind !== 'storyboard') {
      assets.push(a);
      continue;
    }
    const rel = cleanRelPath(a.file_path, ['output']);
    if (!resolveInside(ctx.config.rootDir, rel, ['output'])) {
      assets.push(a); // completeJob báo FILE_NOT_FOUND như cũ
      continue;
    }
    const logo = await removeStoryboardLogo(ctx, rel, rawPathOf(rel, job.id));
    assets.push({ ...a, file_path: rel, meta: { ...(a.meta ?? {}), logo } });
  }
  return { ...body, assets };
}

/**
 * «Thử xoá logo lại» cho một ảnh storyboard đã lưu (vd tool lỗi hoặc lúc đó chưa cấu hình): làm lại từ ảnh gốc `meta.logo.raw_path`.
 * Chặn khi cảnh đang có job (worker có thể đang đọc ảnh để tạo video).
 */
export async function retryStoryboardLogo(ctx: AppContext, assetId: number) {
  const asset = getAsset(ctx, assetId);
  const meta = parseJson<Record<string, unknown>>(asset.meta, {});
  const logo = meta.logo as { raw_path?: unknown } | undefined;
  if (asset.kind !== 'storyboard' || !logo || typeof logo.raw_path !== 'string') {
    throw badRequest('INVALID_ASSET', 'Ảnh này không có bước xoá logo (chỉ storyboard tạo bằng Google Flow)');
  }
  const rawRel = cleanRelPath(logo.raw_path, ['output']);
  if (!resolveInside(ctx.config.rootDir, rawRel, ['output'])) throw badRequest('FILE_NOT_FOUND', 'Không còn ảnh gốc để xoá logo lại');
  if (activeJobOf(ctx, asset.scene_id)) throw new AppError('JOB_ACTIVE', 'Cảnh đang có job chạy; thử lại sau khi job xong', 409);
  const result = await removeStoryboardLogo(ctx, asset.file_path, rawRel);
  const updated = ctx.tx(() => {
    const cur = getAsset(ctx, assetId);
    const m = parseJson<Record<string, unknown>>(cur.meta, {});
    ctx.db.prepare('UPDATE assets SET meta = ? WHERE id = ?').run(JSON.stringify({ ...m, logo: result }), assetId);
    const scene = sceneSummaryById(ctx, cur.scene_id);
    logEvent(ctx, { project_id: scene.project_id, scene_id: cur.scene_id, type: 'asset.logo', message: `${scene.code}: ${result.detail}` });
    ctx.publish('asset.updated', scene.project_id, () => ({ asset: assetJson(getAsset(ctx, assetId)) }));
    emitScene(ctx, cur.scene_id, scene.project_id);
    return { asset: assetJson(getAsset(ctx, assetId)), scene: sceneSummaryById(ctx, cur.scene_id) };
  });
  return updated;
}
