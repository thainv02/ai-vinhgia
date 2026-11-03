/**
 * Vòng đời phiên bản Video HTML gắn với job `html_compose` (plan mục 6): chuẩn bị (staging) → kiểm tra → công bố nguyên tử.
 *
 * Luồng hoàn thành job (đường duy nhất): route `/api/worker/jobs/:id/complete` gọi `stageHtmlComposeCompletion` (async: schema, đường dẫn, ghi staging,
 * chụp asset, hook `validateComposition`), rồi `completeJob` (đồng bộ, trong transaction) gọi `completeHtmlComposeJob` → `finalizeVersion`:
 * kiểm tra lại phiên bản/job còn active ngay trước khi rename `staging/<versionId>-<attempt>` → `versions/v<n>` và đặt `ready`.
 * Kết quả về muộn sau khi hủy/lỗi/xoá bị từ chối (409 JOB_CANCELLED/VERSION_NOT_ACTIVE). Thư mục đã công bố bất biến: không bao giờ ghi đè.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { withVoice } from './voice-overlay.js';
import type { VoiceSnapshot } from './voice.js';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { AppError, conflict } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { emitJob, logEvent, parseJson } from '../repo.js';
import { snapshotVersionAssets } from './assets.js';
import { stagingDirRel, versionDirRel } from './config.js';
import { getVersionById, listVersionAssets, projectMeta, versionAssetIds, versionOfJob, type HtmlVersionRow } from './repo.js';
import { validateManifest, verifyTree, writeStaging, type ManifestEntry } from './safe-path.js';
import { checkVariables, normalizeVariable, variablesSchema } from './variables.js';
import type { HtmlVariable, LintReport } from './view.js';
import { segmentOwnerActive, syncSegment } from './segments.js';
import { prefixSegmentVariables } from './segment-files.js';


// ---------------------------------------------------------------- hook kiểm tra

export type CompositionValidator = (ctx: AppContext, version: HtmlVersionRow, stagingDir: string) => Promise<LintReport>;

/**
 * Kiểm tra mặc định (chỉ bảo mật/đường dẫn): quét lại staging — không symlink/junction, đúng manifest (kích thước + sha256), không file lạ.
 * Bước lint contract HyperFrames, chụp khung và vision thay thế hàm này bằng `setCompositionValidator`.
 */
export const defaultCompositionValidator: CompositionValidator = async (_ctx, version, stagingDir) => {
  const report: LintReport = { ok: true, errors: [], warnings: [], checks: ['manifest', 'paths'] };
  try {
    verifyTree(stagingDir, parseJson<ManifestEntry[]>(version.manifest_json, []));
  } catch (err) {
    report.ok = false;
    report.errors.push({ code: err instanceof AppError ? err.code : 'VALIDATION_FAILED', message: err instanceof Error ? err.message : String(err) });
  }
  return report;
};

let validator: CompositionValidator = defaultCompositionValidator;
/** Thay hàm kiểm tra (giai đoạn lint/capture/vision). `null` = quay về mặc định. */
export function setCompositionValidator(fn: CompositionValidator | null): void {
  validator = fn ?? defaultCompositionValidator;
}
/**
 * HOOK kiểm tra bộ file đã ghi vào staging TRƯỚC khi công bố (và lần cuối trên bộ file cuối sau vision). `report.ok=false` → không công bố.
 * Mặc định chỉ kiểm tra bảo mật/đường dẫn (xem `defaultCompositionValidator`).
 */
export function validateComposition(ctx: AppContext, version: HtmlVersionRow, stagingDir: string): Promise<LintReport> {
  return validator(ctx, version, stagingDir);
}

// ---------------------------------------------------------------- kết quả worker

export const htmlResultSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1, 'cần ít nhất index.html'),
  summary: z.string().trim().max(2000).default(''),
  variables: variablesSchema.default([]),
});
export type HtmlComposeResult = z.infer<typeof htmlResultSchema>;

const staging = new Set<number>(); // phiên bản đang ghi/kiểm tra staging (chống hai lần hoàn thành chạy chồng)
const rootOf = (ctx: AppContext): string => ctx.config.rootDir;
const slugOf = (ctx: AppContext, projectId: number): string => (ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as { slug: string }).slug;
const stagingAbs = (ctx: AppContext, v: HtmlVersionRow, attempt: number): string => path.join(rootOf(ctx), stagingDirRel(slugOf(ctx, v.project_id), v.id, attempt));

/** Job `html_compose` còn hợp lệ để giao cho worker không (phiên bản còn đang tạo). Trả lý do nếu cũ (claimNext/hàng đợi hủy job). */
export function htmlComposeStale(ctx: AppContext, job: JobRow): string | null {
  const v = versionOfJob(ctx, job.id);
  if (!v) return 'Không còn phiên bản Video HTML ứng với job này';
  if (!segmentOwnerActive(ctx, v)) return 'Phiên bản tổng đã hủy';
  if (v.status !== 'composing' && v.status !== 'validating') return `Phiên bản v${v.version} không còn ở trạng thái đang tạo (${v.status})`;
  return null;
}

/** Job lỗi: phiên bản đang tạo → failed (kèm mã lỗi). Gọi từ `applyJobFailure`. */
export function failHtmlCompose(ctx: AppContext, job: JobRow, code: string, error: string): void {
  endVersion(ctx, job, 'failed', code, error);
}
/** Job bị hủy: phiên bản đang tạo → cancelled. Gọi từ `cancelJob`. */
export function cancelHtmlCompose(ctx: AppContext, job: JobRow): void {
  endVersion(ctx, job, 'cancelled', 'CANCELLED', 'Đã hủy bởi người dùng');
}

function endVersion(ctx: AppContext, job: JobRow, status: 'failed' | 'cancelled', code: string, error: string): void {
  const v = versionOfJob(ctx, job.id);
  if (!v || (v.status !== 'composing' && v.status !== 'validating')) return;
  ctx.db.prepare('UPDATE html_versions SET status = ?, error = ?, error_code = ? WHERE id = ?').run(status, error.slice(0, 1000), code, v.id);
  logEvent(ctx, { project_id: v.project_id, type: status === 'failed' ? 'html.failed' : 'html.cancelled', message: `Phiên bản Video HTML v${v.version} ${status === 'failed' ? `lỗi [${code}]: ${error.slice(0, 200)}` : 'đã bị hủy'}` });
  ctx.afterCommit(() => removeStagingOf(ctx, v));
  syncSegment(ctx, getVersionById(ctx, v.id));
}

/** Xoá mọi thư mục staging của phiên bản (best effort, sau commit). */
export function removeStagingOf(ctx: AppContext, v: Pick<HtmlVersionRow, 'id' | 'project_id'>): void {
  try {
    const dir = path.join(rootOf(ctx), stagingDirRel(slugOf(ctx, v.project_id), v.id, 0), '..');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (name.startsWith(`${v.id}-`)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  } catch {
    /* dọn sau */
  }
}

// ---------------------------------------------------------------- staging

export interface StagedVersion {
  versionId: number;
  attempt: number;
  report: LintReport;
}

/**
 * Bước async của công bố: kiểm tra manifest/biến, ghi staging MỚI, chụp asset, chạy `validateComposition`. Không đổi sang `ready`.
 * `jobId` = job compose đang chạy (null với phiên bản người dùng sửa biến, trạng thái `validating` từ lúc tạo).
 * Lỗi dữ liệu (INVALID_MANIFEST/VARIABLE_xxx, HTML_VALIDATION_FAILED, 400): job giữ nguyên để worker sửa và gọi lại; phiên bản người dùng → failed.
 */
export async function stageVersionFiles(
  ctx: AppContext,
  versionId: number,
  jobId: number | null,
  input: { files: unknown; summary?: string; variables?: HtmlVariable[] | unknown },
): Promise<StagedVersion> {
  // 1. kiểm tra đồng bộ (chưa đụng trạng thái)
  const voiceVersion = getVersionById(ctx, versionId);
  const voiceSpec = projectMeta(ctx, voiceVersion.project_id);
  const segment = ctx.db.prepare('SELECT idx FROM html_segments WHERE version_id=? AND segment_version_id=?').get(voiceVersion.segment_owner_id ?? 0, versionId) as {idx:number}|undefined;
  const prefixed = prefixSegmentVariables(validateManifest(input.files), parse(variablesSchema, input.variables ?? [], 'Biến'), segment?.idx);
  const checked = validateManifest(withVoice(prefixed.files, parseJson<VoiceSnapshot | null>(voiceVersion.voice_json ?? null, null), voiceSpec.aspect, {captionsOnly:!!voiceVersion.segment_owner_id}));
  const assetIds = versionAssetIds(ctx, versionId);
  const vars = prefixed.variables.map((v) => normalizeVariable(v, assetIds));
  checkVariables(checked, vars);

  if (staging.has(versionId)) throw conflict('HTML_STAGING_BUSY', 'Phiên bản đang được kiểm tra bởi một yêu cầu khác');
  staging.add(versionId);
  let attempt = 0;
  let dir = '';
  try {
    // 2. xác nhận job/phiên bản còn active và đánh dấu validating
    ctx.tx(() => {
      const v = getVersionById(ctx, versionId);
      attempt = assertActive(ctx, v, jobId);
      if (v.status === 'composing') ctx.db.prepare("UPDATE html_versions SET status = 'validating' WHERE id = ?").run(v.id);
    });
    const version = getVersionById(ctx, versionId);
    dir = stagingAbs(ctx, version, attempt);
    fs.rmSync(dir, { recursive: true, force: true }); // staging cũ của chính lượt này (lần hoàn thành trước bị từ chối)
    // 3. ghi staging + asset
    const manifest = writeStaging(dir, checked);
    snapshotVersionAssets(ctx, versionId, dir);
    // 4. lưu manifest để hook đọc, chạy hook
    ctx.tx(() => {
      assertActive(ctx, getVersionById(ctx, versionId), jobId);
      ctx.db.prepare('UPDATE html_versions SET manifest_json = ?, summary = ?, variables_json = ? WHERE id = ?').run(JSON.stringify(manifest), input.summary ?? '', JSON.stringify(vars), versionId);
    });
    const report = await validateComposition(ctx, getVersionById(ctx, versionId), dir);
    // 5. kết quả
    let stillActive = true;
    ctx.tx(() => {
      const v = getVersionById(ctx, versionId);
      if (v.status !== 'validating') {
        stillActive = false;
        return;
      }
      ctx.db.prepare('UPDATE html_versions SET lint_report_json = ? WHERE id = ?').run(JSON.stringify(report), versionId);
      if (!report.ok) {
        if (jobId === null) ctx.db.prepare("UPDATE html_versions SET status = 'failed', error = ?, error_code = 'HTML_VALIDATION_FAILED' WHERE id = ?").run(report.errors.map((e) => e.message).join('; ').slice(0, 1000), versionId);
        else ctx.db.prepare("UPDATE html_versions SET status = 'composing' WHERE id = ?").run(versionId); // worker sửa rồi gọi lại
      }
    });
    if (!stillActive) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw conflict('JOB_CANCELLED', 'Phiên bản đã bị hủy hoặc lỗi trong lúc kiểm tra; kết quả không được nhận');
    }
    if (!report.ok) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new AppError('HTML_VALIDATION_FAILED', `Bộ file chưa đạt kiểm tra: ${report.errors.map((e) => e.message).join('; ').slice(0, 500)}`, 400, report);
    }
    return { versionId, attempt, report };
  } catch (err) {
    // lỗi dữ liệu/IO sau khi đã đánh dấu validating: trả về composing (job) hoặc failed (người dùng) để không kẹt
    ctx.tx(() => {
      const v = ctx.db.prepare('SELECT * FROM html_versions WHERE id = ?').get(versionId) as HtmlVersionRow | undefined;
      if (v?.status === 'validating') {
        if (jobId === null) ctx.db.prepare("UPDATE html_versions SET status = 'failed', error = ?, error_code = ? WHERE id = ?").run(err instanceof Error ? err.message.slice(0, 1000) : 'Lỗi không rõ', err instanceof AppError ? err.code : 'HTML_STAGE_FAILED', versionId);
        else ctx.db.prepare("UPDATE html_versions SET status = 'composing' WHERE id = ?").run(versionId);
      }
    });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    staging.delete(versionId);
  }
}

/** Phiên bản (và job nếu có) còn active? Trả `attempt` (lease_epoch của job, 0 với phiên bản người dùng). Ném 409 JOB_CANCELLED/VERSION_NOT_ACTIVE. */
function assertActive(ctx: AppContext, v: HtmlVersionRow, jobId: number | null): number {
  if (!segmentOwnerActive(ctx,v)) throw conflict('JOB_CANCELLED','Phiên bản tổng đã hủy');
  if (v.status !== 'composing' && v.status !== 'validating') throw conflict(v.status === 'cancelled' ? 'JOB_CANCELLED' : 'VERSION_NOT_ACTIVE', `Phiên bản v${v.version} đang ở trạng thái ${v.status}; kết quả không được nhận`);
  if (jobId === null) return 0;
  const job = ctx.db.prepare('SELECT status, lease_epoch, id FROM jobs WHERE id = ?').get(jobId) as { status: string; lease_epoch: number; id: number } | undefined;
  if (!job || v.compose_job_id !== job.id) throw conflict('VERSION_NOT_ACTIVE', 'Job không còn gắn với phiên bản này');
  if (job.status !== 'claimed' && job.status !== 'running') throw conflict('JOB_CANCELLED', `Job #${job.id} đang ở trạng thái ${job.status}; kết quả không được nhận`);
  return job.lease_epoch;
}

/** Pre-step của `/complete` cho job html_compose: kiểm tra schema kết quả rồi `stageVersionFiles`. Trả lỗi 400 để worker sửa (job giữ nguyên). */
export async function stageHtmlComposeCompletion(ctx: AppContext, jobId: number, result: unknown): Promise<StagedVersion> {
  const job = ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job || job.type !== 'html_compose') throw conflict('INVALID_STATE', 'Không phải job html_compose');
  const v = versionOfJob(ctx, jobId);
  if (!v) throw conflict('VERSION_NOT_ACTIVE', 'Không còn phiên bản Video HTML ứng với job này');
  const r = parse(htmlResultSchema, result ?? {}, 'Kết quả html_compose');
  return stageVersionFiles(ctx, v.id, jobId, r);
}

// ---------------------------------------------------------------- công bố (đồng bộ)

/**
 * Công bố: phải gọi TRONG ctx.tx. Kiểm tra lần cuối phiên bản `validating` (và job active nếu có), đã có staging đạt kiểm tra, thư mục đích chưa tồn tại;
 * đặt `ready` + content_hash + snapshot_path rồi rename nguyên tử staging → `versions/v<n>`. Rename lỗi → ném → transaction rollback.
 */
export function finalizeVersion(ctx: AppContext, versionId: number, jobId: number | null): HtmlVersionRow {
  const v = getVersionById(ctx, versionId);
  const attempt = assertActive(ctx, v, jobId);
  if (v.status !== 'validating') throw conflict('HTML_NOT_STAGED', 'Phiên bản chưa được kiểm tra/ghi staging');
  const report = parseJson<LintReport | null>(v.lint_report_json, null);
  if (!report?.ok) throw conflict('HTML_NOT_STAGED', 'Phiên bản chưa đạt kiểm tra');
  const slug = slugOf(ctx, v.project_id);
  const src = stagingAbs(ctx, v, attempt);
  const relDest = versionDirRel(slug, v.version);
  const dest = path.join(rootOf(ctx), relDest);
  if (!fs.existsSync(src)) throw conflict('HTML_NOT_STAGED', 'Không thấy thư mục staging của phiên bản');
  // Thư mục chỉ được công bố cùng transaction đặt `ready`. Dòng chưa ready mà thư mục đã có = rename của lần trước bị rollback
  // (lỗi sau rename trong completeJob): không ai tham chiếu tới nó (preview/render đòi ready) nên dọn rồi công bố lại.
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  const manifest = parseJson<ManifestEntry[]>(v.manifest_json, []);
  verifyTree(src, manifest); // lần cuối trước khi công bố
  const assets = listVersionAssets(ctx, v.id);
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([...manifest.map((m) => [m.path, m.sha256]), ...assets.map((a) => [`assets/u/${a.asset_id}`, a.content_hash])].sort()))
    .digest('hex');
  const now = ctx.now();
  ctx.db.prepare("UPDATE html_versions SET status = 'ready', files_dir = ?, content_hash = ?, published_at = ?, error = NULL, error_code = NULL WHERE id = ?").run(relDest, hash, now, v.id);
  for (const a of assets) ctx.db.prepare('UPDATE html_version_assets SET snapshot_path = ? WHERE version_id = ? AND asset_ref = ?').run(`${relDest}/assets/u/${a.asset_id}${/\.[A-Za-z0-9]+$/.exec(a.stored_path)?.[0]?.toLowerCase() ?? ''}`, v.id, a.asset_id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  syncSegment(ctx, getVersionById(ctx, v.id));
  logEvent(ctx, { project_id: v.project_id, type: 'html.ready', message: `Phiên bản Video HTML v${v.version} đã sẵn sàng (${manifest.length} file)` });
  ctx.publish('project.updated', v.project_id, { project_id: v.project_id });
  return getVersionById(ctx, v.id);
}

/**
 * Công bố bộ file như một thao tác (dùng cho phiên bản người dùng sửa biến, và cho test/công cụ): staging → hook → rename. `jobId` (nếu có) phải còn active
 * ngay trước khi rename; hàm KHÔNG hoàn thành job (job compose do `completeJob` hoàn thành).
 */
export async function publishVersionFiles(
  ctx: AppContext,
  versionId: number,
  jobId: number | null,
  files: unknown,
  summary: string,
  variables: unknown,
): Promise<HtmlVersionRow> {
  await stageVersionFiles(ctx, versionId, jobId, { files, summary, variables });
  return ctx.tx(() => finalizeVersion(ctx, versionId, jobId));
}

/** Nhánh `html_compose` của `completeJob` (đồng bộ, trong transaction): công bố phiên bản đã staging và thu gọn `result` (bỏ nội dung file). */
export function completeHtmlComposeJob(ctx: AppContext, job: JobRow, result: Record<string, unknown>): HtmlVersionRow {
  const v = versionOfJob(ctx, job.id);
  if (!v) throw conflict('VERSION_NOT_ACTIVE', 'Không còn phiên bản Video HTML ứng với job này');
  const done = finalizeVersion(ctx, v.id, job.id);
  const manifest = parseJson<ManifestEntry[]>(done.manifest_json, []);
  for (const k of Object.keys(result)) delete result[k];
  Object.assign(result, { version_id: done.id, version: done.version, files: manifest.map((m) => m.path), summary: done.summary ?? '', content_hash: done.content_hash });
  emitJob(ctx, job.id, job.project_id);
  return done;
}

/**
 * Khi khởi động: phiên bản người dùng đang `validating` (không có job) và staging dang dở do server tắt giữa chừng → failed, dọn staging.
 * Phiên bản của job giữ nguyên (job tiếp tục theo lease/heartbeat).
 */
export function recoverHtmlVersions(ctx: AppContext): number {
  const rows = ctx.db.prepare("SELECT * FROM html_versions WHERE status = 'validating' AND compose_job_id IS NULL").all() as HtmlVersionRow[];
  for (const v of rows) {
    ctx.tx(() => ctx.db.prepare("UPDATE html_versions SET status = 'failed', error = 'Bị gián đoạn do ứng dụng tắt', error_code = 'INTERRUPTED' WHERE id = ? AND status = 'validating'").run(v.id));
    removeStagingOf(ctx, v);
  }
  return rows.length;
}
