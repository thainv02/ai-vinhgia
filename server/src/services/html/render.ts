/**
 * Dựng MP4 cho Video HTML (plan mục 8): bản ghi `html_renders` + chạy qua hàng đợi render chung (`FinalRenderService`, kind `html`).
 *
 * Luồng `runHtmlRender`: queued → rendering → materialize (bản bất biến → thư mục tạm, mode render) → engine.runRender → `.video.tmp.mp4`
 * → ffprobe kiểm tra (h264, đúng kích thước, 30 fps, thời lượng ±0.1 s, audio đúng kỳ vọng) → rename nguyên tử `video.mp4` → poster → ready.
 * Trước MỌI lần ghi đều kiểm tra abort + dòng vẫn `rendering`; slot hàng đợi chỉ nhả khi hàm này settle (tiến trình con đã thoát).
 *
 * SEAM CHO TEST: engine (W1a) gọi qua `HtmlEngine`; test đặt engine giả bằng `setHtmlEngine(fake)`. Mặc định nạp `./engine/index.js` khi cần.
 * Việc mở Explorer đi qua `setHtmlRevealer` (test thay bằng hàm ghi nhận).
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { ffmpegOf, ffprobeOf } from '../media.js';
import { parseJson } from '../repo.js';
import { aspectSize, HTML_FPS, mediaEnv } from './config.js';
import { getHtmlProject, getVersion, getVersionById, projectMeta, type HtmlVersionRow } from './repo.js';
import type { HtmlAspect, HtmlQuality } from './view.js';
import { renderSegments } from './segment-render.js';
import { listSegments } from './segments.js';

// ---------------------------------------------------------------- seam engine

export interface HtmlEngine {
  browserPath(ctx: AppContext): string;
  materialize(versionDir: string, workDir: string, opts: { mode: 'render' | 'capture' | 'preview' }): Promise<void>;
  runRender(
    ctx: AppContext,
    o: { workDir: string; outPath: string; aspect: HtmlAspect; quality: HtmlQuality; durationS: number; workers?: number; signal: AbortSignal; onProgress: (pct: number, stage: string) => void },
  ): Promise<{ warnings: string[] }>;
  captureFrames(ctx: AppContext, o: { workDir: string; aspect: HtmlAspect; times: number[]; signal: AbortSignal; scale?: number }): Promise<Buffer[]>;
}

let engineOverride: HtmlEngine | null = null;
/** Thay engine (test). `null` = dùng engine thật. */
export function setHtmlEngine(e: HtmlEngine | null): void {
  engineOverride = e;
}
async function engine(): Promise<HtmlEngine> {
  if (engineOverride) return engineOverride;
  return (await import('./engine/index.js')) as unknown as HtmlEngine;
}

export type HtmlRevealer = (absPath: string) => void;
let revealer: HtmlRevealer = defaultReveal;
/** Thay hàm mở Explorer (test). `null` = mặc định (`explorer.exe /select,`). */
export function setHtmlRevealer(fn: HtmlRevealer | null): void {
  revealer = fn ?? defaultReveal;
}
/** Mở Explorer chọn sẵn file (đường dẫn tuyệt đối do server dựng). */
export function revealFile(abs: string): void {
  revealer(abs);
}
function defaultReveal(abs: string): void {
  if (process.platform !== 'win32') throw new AppError('NOT_SUPPORTED', 'Chỉ mở được thư mục trên Windows', 501);
  const c = spawn('explorer.exe', [`/select,${path.resolve(abs)}`], { detached: true, stdio: 'ignore', windowsHide: false });
  c.on('error', () => undefined);
  c.unref();
}

// ---------------------------------------------------------------- kiểu và truy vấn

export interface HtmlRenderRow {
  id: number;
  version_id: number;
  idempotency_key: string;
  quality: HtmlQuality;
  status: 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled';
  settings_json: string;
  source_hash: string | null;
  video_path: string | null;
  poster_path: string | null;
  progress: number | null;
  error: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface HtmlRenderView {
  id: number;
  version_id: number;
  version: number;
  quality: HtmlQuality;
  status: HtmlRenderRow['status'];
  progress: number | null;
  queue: { state: 'waiting' | 'running'; position: number } | null;
  error: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  video_url: string | null;
  poster_url: string | null;
  duration_s: number | null;
  bytes: number | null;
  width: number;
  height: number;
}

interface RenderSettings {
  quality: HtmlQuality;
  aspect: HtmlAspect;
  width: number;
  height: number;
  fps: number;
  duration_s: number;
  source_hash: string | null;
  output?: { duration_s: number; bytes: number };
  warnings?: string[];
}

export const INTERRUPTED_MESSAGE = 'Bị gián đoạn do ứng dụng tắt';
export const renderDirRel = (slug: string, id: number): string => `output/${slug}/html/renders/${id}`;

const getRenderRow = (ctx: AppContext, id: number): HtmlRenderRow | undefined => ctx.db.prepare('SELECT * FROM html_renders WHERE id = ?').get(id) as HtmlRenderRow | undefined;

/** Bản dựng thuộc dự án `projectId` (404 nếu không). */
export function getProjectRender(ctx: AppContext, projectId: number, renderId: number): HtmlRenderRow {
  const r = ctx.db
    .prepare('SELECT r.* FROM html_renders r JOIN html_versions v ON v.id = r.version_id WHERE r.id = ? AND v.project_id = ?')
    .get(renderId, projectId) as HtmlRenderRow | undefined;
  if (!r) throw notFound('bản dựng video');
  return r;
}

export function renderView(ctx: AppContext, r: HtmlRenderRow): HtmlRenderView {
  const v = getVersionById(ctx, r.version_id);
  const s = parseJson<Partial<RenderSettings>>(r.settings_json, {});
  const q = r.status === 'queued' || r.status === 'rendering' ? ctx.finalRender?.queueInfo('html', r.id) ?? null : null;
  const size = s.width && s.height ? { width: s.width, height: s.height } : aspectSize(projectMeta(ctx, v.project_id).aspect, r.quality);
  const base = `/lan/api/html-projects/${v.project_id}/renders/${r.id}`;
  return {
    id: r.id,
    version_id: r.version_id,
    version: v.version,
    quality: r.quality,
    status: r.status,
    progress: r.status === 'ready' ? 100 : r.progress,
    queue: q ? { state: q.state, position: q.state === 'running' ? 0 : q.position ?? 0 } : null,
    error: r.error,
    error_code: r.error_code,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    video_url: r.status === 'ready' && r.video_path ? `${base}/video` : null,
    poster_url: r.status === 'ready' && r.poster_path ? `${base}/poster` : null,
    duration_s: r.status === 'ready' ? s.output?.duration_s ?? null : null,
    bytes: r.status === 'ready' ? s.output?.bytes ?? null : null,
    width: size.width,
    height: size.height,
  };
}

/** Bản dựng mới nhất của mỗi chất lượng cho một phiên bản (đưa vào view phiên bản). */
export function latestRenders(ctx: AppContext, versionId: number): HtmlRenderView[] {
  const rows = ctx.db.prepare('SELECT * FROM html_renders WHERE version_id = ? ORDER BY id DESC').all(versionId) as HtmlRenderRow[];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.quality) ? false : (seen.add(r.quality), true))).map((r) => renderView(ctx, r));
}

export function listRenders(ctx: AppContext, projectId: number): HtmlRenderView[] {
  getHtmlProject(ctx, projectId);
  const rows = ctx.db
    .prepare('SELECT r.* FROM html_renders r JOIN html_versions v ON v.id = r.version_id WHERE v.project_id = ? ORDER BY r.id DESC')
    .all(projectId) as HtmlRenderRow[];
  return rows.map((r) => renderView(ctx, r));
}

// ---------------------------------------------------------------- tạo / hủy / thử lại

export interface NewRender {
  projectId: number;
  version: number;
  quality: HtmlQuality;
  idempotencyKey: string;
}

/**
 * Tạo bản dựng `queued` + xếp hàng SAU commit. Phiên bản phải `ready`. Cùng `idempotencyKey` → trả lại bản cũ (`created:false`, khác chất lượng → 409).
 * Đã có bản active (queued/rendering) cùng phiên bản+chất lượng → 409 `HTML_RENDER_ACTIVE`. Thiếu trình duyệt dựng → 409 `HTML_RENDERER_MISSING` TRƯỚC khi tạo dòng.
 */
export async function createRender(ctx: AppContext, o: NewRender): Promise<{ render: HtmlRenderRow; created: boolean }> {
  const project = getHtmlProject(ctx, o.projectId);
  const v = getVersion(ctx, project.id, o.version);
  const dup = ctx.db.prepare('SELECT * FROM html_renders WHERE version_id = ? AND idempotency_key = ?').get(v.id, o.idempotencyKey) as HtmlRenderRow | undefined;
  if (dup) {
    if (dup.quality !== o.quality) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key này đã được dùng cho một yêu cầu khác');
    return { render: dup, created: false };
  }
  if (v.status !== 'ready' || !v.files_dir) throw conflict('VERSION_NOT_READY', `Phiên bản v${v.version} chưa sẵn sàng để dựng video (đang ${v.status})`);
  const active = ctx.db.prepare("SELECT id FROM html_renders WHERE version_id = ? AND quality = ? AND status IN ('queued','rendering')").get(v.id, o.quality);
  if (active) throw conflict('HTML_RENDER_ACTIVE', `Phiên bản v${v.version} đang được dựng ở ${o.quality}; hãy đợi xong hoặc hủy trước`);
  // Thiếu trình duyệt: báo ngay (409 có hướng dẫn), không tạo dòng
  (await engine()).browserPath(ctx);

  const meta = projectMeta(ctx, project.id);
  const size = aspectSize(meta.aspect, o.quality);
  const voice = parseJson<{ duration_s: number } | null>(v.voice_json ?? null, null);
  const settings: RenderSettings = { quality: o.quality, aspect: meta.aspect, ...size, fps: HTML_FPS, duration_s: v.is_segmented ? listSegments(ctx,v.id).at(-1)!.end_s : voice?.duration_s ?? meta.duration_s, source_hash: v.content_hash };
  const id = ctx.tx(() => {
    if (ctx.db.prepare("SELECT 1 FROM html_renders WHERE version_id = ? AND quality = ? AND status IN ('queued','rendering')").get(v.id, o.quality)) throw conflict('HTML_RENDER_ACTIVE', `Phiên bản v${v.version} đang được dựng ở ${o.quality}`);
    try {
      const info = ctx.db
        .prepare("INSERT INTO html_renders (version_id, idempotency_key, quality, status, settings_json, source_hash, progress, created_at) VALUES (?, ?, ?, 'queued', ?, ?, NULL, ?)")
        .run(v.id, o.idempotencyKey, o.quality, JSON.stringify(settings), v.content_hash, ctx.now());
      const newId = Number(info.lastInsertRowid);
      ctx.afterCommit(() => enqueueRender(ctx, newId));
      return newId;
    } catch (err) {
      if (/UNIQUE constraint/i.test(err instanceof Error ? err.message : '')) throw conflict('HTML_RENDER_ACTIVE', `Phiên bản v${v.version} đang được dựng ở ${o.quality}`);
      throw err;
    }
  });
  return { render: getRenderRow(ctx, id)!, created: true };
}

function enqueueRender(ctx: AppContext, id: number): void {
  ctx.finalRender?.enqueueHtmlTask('html', id, true, (abort) => runHtmlRender(ctx, id, abort));
}

/** Hủy bản đang chờ/đang chạy. Đang chạy: abort (engine kill cây tiến trình); slot chỉ nhả khi tiến trình đã thoát. */
export function cancelRender(ctx: AppContext, projectId: number, renderId: number): HtmlRenderRow {
  return ctx.tx(() => {
    const r = getProjectRender(ctx, projectId, renderId);
    if (r.status !== 'queued' && r.status !== 'rendering') throw conflict('INVALID_STATE', `Bản dựng đang ở trạng thái ${r.status}, không thể hủy`);
    ctx.db
      .prepare("UPDATE html_renders SET status = 'cancelled', progress = NULL, error = NULL, error_code = 'CANCELLED', finished_at = ? WHERE id = ? AND status IN ('queued','rendering')")
      .run(ctx.now(), r.id);
    ctx.afterCommit(() => ctx.finalRender?.cancelHtmlTask('html', r.id));
    return getRenderRow(ctx, r.id)!;
  });
}

/** Thử lại bản `failed`/`cancelled`: dòng MỚI (khoá idempotency do client cấp), không đụng dòng cũ. */
export async function retryRender(ctx: AppContext, projectId: number, renderId: number, idempotencyKey: string): Promise<{ render: HtmlRenderRow; created: boolean }> {
  const r = getProjectRender(ctx, projectId, renderId);
  const v = getVersionById(ctx, r.version_id);
  const dup = ctx.db.prepare('SELECT id FROM html_renders WHERE version_id = ? AND idempotency_key = ?').get(v.id, idempotencyKey);
  if (!dup && r.status !== 'failed' && r.status !== 'cancelled') throw conflict('INVALID_STATE', `Chỉ thử lại được bản dựng lỗi hoặc đã hủy (đang ${r.status})`);
  return createRender(ctx, { projectId, version: v.version, quality: r.quality, idempotencyKey });
}

// ---------------------------------------------------------------- chạy

/** Đã ffprobe: chỉ phần cần để kiểm tra. */
interface VideoProbe {
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  duration_s: number | null;
  has_audio: boolean;
}

const fraction = (s: unknown): number | null => {
  const [n, d] = String(s ?? '').split('/').map(Number);
  return n && Number.isFinite(n) ? n / (d && Number.isFinite(d) ? d : 1) : null;
};

async function probeVideo(ctx: AppContext, abs: string, signal: AbortSignal): Promise<VideoProbe | null> {
  const bin = await ffprobeOf(ctx.config);
  if (!bin) throw new AppError('HTML_RENDER_FAILED', 'Không tìm thấy ffprobe để kiểm tra video', 500);
  const out = await new Promise<string | null>((resolve) => {
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 30_000, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: mediaEnv() }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (!out) return null;
  try {
    const j = JSON.parse(out) as { format?: { duration?: string }; streams?: Record<string, unknown>[] };
    const v = j.streams?.find((s) => s.codec_type === 'video');
    if (!v) return null;
    const dur = Number(j.format?.duration ?? v.duration);
    return {
      codec: typeof v.codec_name === 'string' ? v.codec_name : null,
      width: Number(v.width) || null,
      height: Number(v.height) || null,
      fps: fraction(v.avg_frame_rate) ?? fraction(v.r_frame_rate),
      duration_s: Number.isFinite(dur) ? dur : null,
      has_audio: !!j.streams?.some((s) => s.codec_type === 'audio'),
    };
  } catch {
    return null;
  }
}

/** Composition có tiếng không: `<audio>` hoặc `<video>` không `muted` trong index.html / compositions/*.html. */
function expectsAudio(versionDirAbs: string): boolean {
  const files: string[] = [];
  const idx = path.join(versionDirAbs, 'index.html');
  if (fs.existsSync(idx)) files.push(idx);
  const cdir = path.join(versionDirAbs, 'compositions');
  try {
    for (const f of fs.readdirSync(cdir)) if (f.endsWith('.html')) files.push(path.join(cdir, f));
  } catch {
    /* không có thư mục compositions */
  }
  return files.some((f) => {
    const html = fs.readFileSync(f, 'utf8');
    return /<audio\b/i.test(html) || /<video\b(?![^>]*\bmuted\b)[^>]*>/i.test(html);
  });
}

const verifyFail = (msg: string): AppError => new AppError('HTML_RENDER_VERIFY_FAILED', `Video dựng ra không đạt kiểm tra: ${msg}`, 500);

async function verifyOutput(ctx: AppContext, abs: string, spec: { width: number; height: number; duration_s: number; audio: boolean }, signal: AbortSignal): Promise<VideoProbe> {
  const p = await probeVideo(ctx, abs, signal);
  if (!p) throw verifyFail('không đọc được file video');
  if (p.codec !== 'h264') throw verifyFail(`codec ${p.codec ?? '?'} (cần h264)`);
  if (p.width !== spec.width || p.height !== spec.height) throw verifyFail(`kích thước ${p.width}x${p.height} (cần ${spec.width}x${spec.height})`);
  if (p.fps === null || Math.abs(p.fps - HTML_FPS) > 0.01) throw verifyFail(`${p.fps ?? '?'} fps (cần ${HTML_FPS})`);
  if (p.duration_s === null || Math.abs(p.duration_s - spec.duration_s) > 0.1) throw verifyFail(`thời lượng ${p.duration_s ?? '?'} s (cần ${spec.duration_s} s ±0.1)`);
  if (spec.audio !== p.has_audio) throw verifyFail(spec.audio ? 'thiếu âm thanh dù bản HTML có audio/video có tiếng' : 'có âm thanh dù bản HTML không có audio');
  return p;
}

async function makePoster(ctx: AppContext, videoAbs: string, posterAbs: string, durationS: number, signal: AbortSignal): Promise<boolean> {
  const ff = await ffmpegOf(ctx.config);
  if (!ff) return false;
  const tmp = `${posterAbs}.tmp.jpg`;
  const t = Math.min(1, durationS / 2);
  const ok = await new Promise<boolean>((resolve) => {
    execFile(ff, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', videoAbs, '-frames:v', '1', '-q:v', '3', tmp], { timeout: 30_000, signal, windowsHide: true, env: mediaEnv() }, (err) => resolve(!err));
  });
  if (ok && fs.existsSync(tmp)) {
    fs.renameSync(tmp, posterAbs);
    return true;
  }
  fs.rmSync(tmp, { force: true });
  return false;
}

/**
 * Chạy một bản dựng (do hàng đợi gọi). Mọi kết cục đều ghi vào DB; không ném lỗi ra ngoài. Hủy/tắt app: dọn file, KHÔNG ghi trạng thái
 * (hủy do `cancelRender` ghi; tắt app để lại `rendering` cho `recoverHtmlRenders`).
 */
export async function runHtmlRender(ctx: AppContext, id: number, abort: AbortController): Promise<void> {
  const row = getRenderRow(ctx, id);
  if (!row || row.status !== 'queued') return; // đã hủy khi còn chờ
  if (abort.signal.aborted) return;
  const claimed = ctx.db.prepare("UPDATE html_renders SET status = 'rendering', progress = 0, started_at = ?, error = NULL, error_code = NULL WHERE id = ? AND status = 'queued'").run(ctx.now(), id);
  if (claimed.changes !== 1) return;
  const live = (): boolean => !abort.signal.aborted && getRenderRow(ctx, id)?.status === 'rendering';

  const v = getVersionById(ctx, row.version_id);
  const project = ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').get(v.project_id) as { slug: string } | undefined;
  const slug = project?.slug ?? '';
  const settings = parseJson<RenderSettings>(row.settings_json, null as unknown as RenderSettings);
  const outDirRel = renderDirRel(slug, id);
  const outDirAbs = path.join(ctx.config.rootDir, ...outDirRel.split('/'));
  let workDir: string | null = null;
  try {
    const versionDir = v.files_dir ? path.join(ctx.config.rootDir, v.files_dir) : null;
    if (!versionDir || !fs.existsSync(path.join(versionDir, 'index.html'))) throw new AppError('HTML_RENDER_FAILED', 'Không thấy file của phiên bản (có thể đã bị xoá)', 500);
    const eng = await engine();
    if (!live()) return;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avhtml-render-'));
    if(!v.is_segmented)await eng.materialize(versionDir, workDir, { mode: 'render' });
    if (!live()) return;
    fs.rmSync(outDirAbs, { recursive: true, force: true });
    fs.mkdirSync(outDirAbs, { recursive: true });
    const tmpAbs = path.join(outDirAbs, '.video.tmp.mp4');

    const throttle = ctx.finalRender?.progressThrottleMs ?? 1000;
    let lastWrite = 0;
    let lastPct = -1;
    const onProgress = (pct: number): void => {
      if (!live()) return;
      const now = Date.now();
      const p = Math.max(0, Math.min(99, Math.round(pct * 10) / 10));
      if (p === lastPct || (now - lastWrite < throttle && p < 99)) return;
      lastWrite = now;
      lastPct = p;
      ctx.db.prepare("UPDATE html_renders SET progress = ? WHERE id = ? AND status = 'rendering'").run(p, id);
    };

    const { warnings } = v.is_segmented ? await renderSegments(ctx,v,eng,{workDir,outPath:tmpAbs,aspect:settings.aspect,quality:row.quality,width:settings.width,height:settings.height,signal:abort.signal,onProgress}) : await eng.runRender(ctx, {
      workDir,
      outPath: tmpAbs,
      aspect: settings.aspect,
      quality: row.quality,
      durationS: settings.duration_s,
      workers: 1,
      signal: abort.signal,
      onProgress,
    });
    if (!live()) return;
    const probe = await verifyOutput(ctx, tmpAbs, { width: settings.width, height: settings.height, duration_s: settings.duration_s, audio: v.is_segmented ? !!v.voice_json : expectsAudio(versionDir) }, abort.signal);
    if (!live()) return;
    const videoAbs = path.join(outDirAbs, 'video.mp4');
    fs.renameSync(tmpAbs, videoAbs); // nguyên tử: video.mp4 chỉ xuất hiện khi đã đạt kiểm tra
    const posterAbs = path.join(outDirAbs, 'poster.jpg');
    const hasPoster = await makePoster(ctx, videoAbs, posterAbs, settings.duration_s, abort.signal).catch(() => false);
    if (!live()) return;
    const next: RenderSettings = { ...settings, output: { duration_s: Math.round((probe.duration_s ?? settings.duration_s) * 1000) / 1000, bytes: fs.statSync(videoAbs).size }, warnings };
    const done = ctx.db
      .prepare("UPDATE html_renders SET status = 'ready', progress = 100, video_path = ?, poster_path = ?, settings_json = ?, error = NULL, error_code = NULL, finished_at = ? WHERE id = ? AND status = 'rendering'")
      .run(`${outDirRel}/video.mp4`, hasPoster ? `${outDirRel}/poster.jpg` : null, JSON.stringify(next), ctx.now(), id);
    if (done.changes !== 1) fs.rmSync(outDirAbs, { recursive: true, force: true });
  } catch (err) {
    fs.rmSync(outDirAbs, { recursive: true, force: true });
    if (abort.signal.aborted || !live()) return; // hủy: trạng thái do cancelRender ghi; tắt app: recover ghi
    const code = err instanceof AppError && /^HTML_/.test(err.code) ? err.code : 'HTML_RENDER_FAILED';
    const msg = err instanceof Error ? err.message : String(err);
    ctx.db
      .prepare("UPDATE html_renders SET status = 'failed', progress = NULL, error = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = 'rendering'")
      .run(code === 'HTML_RENDER_FAILED' && !/^Dựng video thất bại/.test(msg) ? `Dựng video thất bại: ${msg}` : msg, code, ctx.now(), id);
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- khởi động lại, xoá dự án

/** Khi khởi động: bản queued/rendering của tiến trình cũ → failed (không tự dựng lại), dọn thư mục dở và thư mục tạm cũ (> 1 giờ). */
export function recoverHtmlRenders(ctx: AppContext): number {
  const rows = ctx.db
    .prepare("SELECT r.id AS id, p.slug AS slug FROM html_renders r JOIN html_versions v ON v.id = r.version_id JOIN projects p ON p.id = v.project_id WHERE r.status IN ('queued','rendering')")
    .all() as { id: number; slug: string }[];
  for (const r of rows) {
    ctx.tx(() =>
      ctx.db.prepare("UPDATE html_renders SET status = 'failed', progress = NULL, error = ?, error_code = 'HTML_RENDER_FAILED', finished_at = ? WHERE id = ? AND status IN ('queued','rendering')").run(INTERRUPTED_MESSAGE, ctx.now(), r.id),
    );
    fs.rmSync(path.join(ctx.config.rootDir, ...renderDirRel(r.slug, r.id).split('/')), { recursive: true, force: true });
  }
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (!f.startsWith('avhtml-render-')) continue;
      const abs = path.join(os.tmpdir(), f);
      if (Date.now() - fs.statSync(abs).mtimeMs > 3_600_000) fs.rmSync(abs, { recursive: true, force: true });
    }
  } catch {
    /* không dọn được thì bỏ qua */
  }
  return rows.length;
}

/** Id các bản dựng của dự án còn nằm trong hàng đợi (kể cả bản vừa hủy mà tiến trình chưa dừng). */
export function stoppingRenderIds(ctx: AppContext, projectId: number): number[] {
  const rows = ctx.db.prepare('SELECT r.id AS id FROM html_renders r JOIN html_versions v ON v.id = r.version_id WHERE v.project_id = ?').all(projectId) as { id: number }[];
  return rows.filter((r) => ctx.finalRender?.queueInfo('html', r.id)).map((r) => r.id);
}

/** Chờ tối đa `timeoutMs` cho các bản đã hủy (còn trong hàng đợi) dừng hẳn trước khi xoá dự án. */
export async function waitHtmlRendersStopped(ctx: AppContext, projectId: number, timeoutMs = 8_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  const cancelledOnly = () => stoppingRenderIds(ctx, projectId).filter((id) => getRenderRow(ctx, id)?.status === 'cancelled' || getRenderRow(ctx, id)?.status === 'failed');
  while (cancelledOnly().length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

// ---------------------------------------------------------------- chụp khung cho vision

let captureSeq = 0;

/**
 * Chụp khung hình của thư mục staging cho AI vision, QUA hàng đợi chung (kind `html-capture`, id `<projectId>-<n>`): mỗi lần gọi một mục,
 * không chiếm slot rồi enqueue con. `abort` → hủy mục (đang chờ: bỏ khỏi hàng; đang chạy: abort engine). Trả PNG theo thứ tự `times`.
 */
export function captureForVision(
  ctx: AppContext,
  o: { projectId: number; aspect: HtmlAspect; durationS: number; stagingDir: string; times: number[]; signal: AbortSignal },
): Promise<Buffer[]> {
  const stagingAbs = path.isAbsolute(o.stagingDir) ? o.stagingDir : path.join(ctx.config.rootDir, o.stagingDir);
  const id = `${o.projectId}-${++captureSeq}`;
  const cancelled = () => new AppError('CANCELLED', 'Đã hủy chụp khung hình', 409);
  return new Promise<Buffer[]>((resolve, reject) => {
    if (o.signal.aborted) return reject(cancelled());
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      o.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      ctx.finalRender?.cancelHtmlTask('html-capture', id);
      finish(() => reject(cancelled()));
    };
    o.signal.addEventListener('abort', onAbort, { once: true });
    const run = async (abort: AbortController): Promise<void> => {
      const linked = () => abort.abort();
      o.signal.addEventListener('abort', linked, { once: true });
      let workDir: string | null = null;
      try {
        if (abort.signal.aborted) return finish(() => reject(cancelled()));
        const eng = await engine();
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avhtml-capture-'));
        await eng.materialize(stagingAbs, workDir, { mode: 'capture' });
        if (abort.signal.aborted) return finish(() => reject(cancelled()));
        const frames = await eng.captureFrames(ctx, { workDir, aspect: o.aspect, times: o.times, signal: abort.signal });
        finish(() => resolve(frames));
      } catch (err) {
        finish(() => reject(abort.signal.aborted ? cancelled() : err));
      } finally {
        o.signal.removeEventListener('abort', linked);
        if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      }
    };
    if (!ctx.finalRender) {
      void run(new AbortController());
      return;
    }
    ctx.finalRender.enqueueHtmlTask('html-capture', id, true, run);
    if (!ctx.finalRender.queueInfo('html-capture', id)) finish(() => reject(new AppError('SERVICE_UNAVAILABLE', 'Hàng đợi dựng đã tắt', 503)));
  });
}

export type { HtmlVersionRow };
