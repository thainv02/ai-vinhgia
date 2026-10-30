/**
 * Dịch vụ cho trang planner LAN: dự án `source='lan'`, hiển thị kế hoạch prompt của từng cảnh, tải storyboard người dùng tự tạo.
 * KHÔNG tạo job storyboard/video ở bất kỳ đâu trong file này (chỉ job analyze_brief qua `submitBrief`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import type { AssetRow, JobRow, ProjectRow, RefRow, SceneRow } from '../db/types.js';
import { assetJson, emitBudget, getProject, getScene, logEvent, parseJson, projectRefs } from './repo.js';
import { buildPlan, MAX_PLAN_REFS, planToMarkdown, VIDEO_SETTINGS, type PlanRef, type PlanSceneInput } from './plan.js';
import { createProject, submitBrief } from './projects.js';
import { aiQueueInfoById, type AiQueueInfo } from './job-queue.js';
import { nextStoryboardAttempt } from './payload.js';
import { refLibrary, type ImageType } from './refs.js';
import { LAN_UPLOAD_SOURCE, lanFileUrl, storyboardUploadBlock } from './lan-common.js';
import { LAN_VIDEO_MAX_S, LAN_VIDEO_MIN_S, MAX_VIDEOS_PER_SCENE, sceneVideosJson } from './lan-video.js';
import { emitScene } from './scene-view.js';
import { projectDeleteBlocks } from './trash.js';
import { isLanClipServable } from './clips/lan.js';
import { isOnline, getWorkerRow } from './worker.js';
import type { ZipEntry } from './zip.js';

export const MAX_STORYBOARD_UPLOADS_PER_SCENE = 8;
export { LAN_UPLOAD_SOURCE, lanFileUrl, storyboardUploadBlock };

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export const createPlanBody = z.object({
  name: z.string().trim().min(1, 'tên kế hoạch không được rỗng').max(200).refine(noControl, 'tên không được chứa ký tự điều khiển'),
  created_by_name: z.string().trim().min(1, 'cần nhập tên người tạo').max(60).refine(noControl, 'tên không được chứa ký tự điều khiển'),
  brief: z.string().max(50_000).default(''),
  style_lock: z.string().max(20_000).default(''),
});
export type CreatePlanBody = z.infer<typeof createPlanBody>;

export const analyzeBody = z.object({
  brief: z.string().max(50_000).optional(),
  style_lock: z.string().max(20_000).optional(),
});
export type AnalyzeBody = z.infer<typeof analyzeBody>;

/** Dự án LAN theo id (kế hoạch prompt); dự án thường (source='app') và dự án cắt clip trả 404 như thể không tồn tại. */
export function lanProject(ctx: AppContext, id: number): ProjectRow {
  const p = getProject(ctx, id);
  if (p.source !== 'lan' || p.kind !== 'scenes') throw notFound('kế hoạch');
  return p;
}

/** Dự án LAN bất kể loại (kế hoạch prompt hoặc cắt clip): dùng cho thao tác chung như xoá. */
export function lanProjectAny(ctx: AppContext, id: number): ProjectRow {
  const p = getProject(ctx, id);
  if (p.source !== 'lan') throw notFound('kế hoạch');
  return p;
}

/** `clientHash`: sha256 của cookie client của trình duyệt tạo kế hoạch; chỉ trình duyệt này xoá được kế hoạch từ trang LAN (kế hoạch cũ: NULL). */
export function createLanPlan(ctx: AppContext, body: CreatePlanBody, clientHash: string | null = null): ProjectRow {
  return createProject(
    ctx,
    { name: body.name, brief: body.brief, style_lock: body.style_lock, max_attempts_per_scene: 2, credit_per_video: 15 },
    { source: 'lan', created_by_name: body.created_by_name, lan_client_hash: clientHash },
  );
}

/** Trình duyệt gọi (băm cookie client) có phải trình duyệt đã tạo kế hoạch không. Kế hoạch cũ (không có băm) → luôn false. So sánh thời gian hằng số. */
export function ownsLanPlan(p: Pick<ProjectRow, 'lan_client_hash'>, clientHash: string | null): boolean {
  if (!p.lan_client_hash || !clientHash) return false;
  const a = Buffer.from(p.lan_client_hash, 'utf8');
  const b = Buffer.from(clientHash, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ trạng thái phân tích

export type PlanStatus = 'draft' | 'analyzing' | 'ready' | 'failed';

export interface AnalysisInfo {
  state: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  job_id: number | null;
  /** Thông báo cho người dùng khi job đang chờ (máy chủ AI chưa sẵn sàng, hết hạn mức...). */
  waiting: string | null;
  /** Thông báo lỗi chung (chi tiết kỹ thuật chỉ có trên app chính của chủ máy). */
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
  /** Vị trí job `analyze_brief` trong hàng đợi của worker AI (một worker, tuần tự); `null` khi chưa/không còn chờ. */
  queue: AiQueueInfo | null;
}

type AnalyzeJobRow = Pick<JobRow, 'id' | 'status' | 'wait_reason' | 'created_at' | 'finished_at'>;

function analysisInfo(ctx: AppContext, projectId: number): AnalysisInfo {
  const job = ctx.db
    .prepare("SELECT id, status, wait_reason, created_at, finished_at FROM jobs WHERE project_id = ? AND type = 'analyze_brief' ORDER BY id DESC LIMIT 1")
    .get(projectId) as AnalyzeJobRow | undefined;
  if (!job) return { state: 'idle', job_id: null, waiting: null, error: null, created_at: null, finished_at: null, queue: null };
  const base = { job_id: job.id, created_at: job.created_at, finished_at: job.finished_at, queue: null as AiQueueInfo | null };
  if (job.status === 'queued') {
    const ws = getWorkerRow(ctx);
    const waiting = ws.queue_paused
      ? 'Hàng đợi của máy chủ đang tạm dừng, yêu cầu đang xếp hàng.'
      : job.wait_reason === 'ai_quota'
        ? 'Tài khoản AI đang hết hạn mức, yêu cầu đang xếp hàng và sẽ tự thử lại.'
        : !isOnline(ctx, ws)
          ? 'Máy chủ AI chưa sẵn sàng, yêu cầu đang xếp hàng.'
          : 'Yêu cầu đang xếp hàng, chờ máy chủ AI nhận việc.';
    return { ...base, queue: aiQueueInfoById(ctx, job.id), state: 'queued', waiting, error: null };
  }
  if (job.status === 'claimed' || job.status === 'running') return { ...base, queue: aiQueueInfoById(ctx, job.id), state: 'running', waiting: null, error: null };
  if (job.status === 'done') return { ...base, state: 'done', waiting: null, error: null };
  return {
    ...base,
    state: 'failed',
    waiting: null,
    error: job.status === 'cancelled' ? 'Yêu cầu phân tích đã bị chủ máy hủy.' : 'Phân tích không thành công. Bấm "Phân tích lại" để thử lại; nếu vẫn lỗi, báo chủ máy.',
  };
}

function planStatus(analysis: AnalysisInfo, sceneCount: number): PlanStatus {
  if (analysis.state === 'queued' || analysis.state === 'running') return 'analyzing';
  if (analysis.state === 'failed') return 'failed';
  return sceneCount > 0 ? 'ready' : 'draft';
}

// ------------------------------------------------------------------ tóm tắt / danh sách

function counts(ctx: AppContext, projectId: number): { scene_count: number; ref_count: number } {
  return ctx.db
    .prepare('SELECT (SELECT COUNT(*) FROM scenes WHERE project_id = @id) AS scene_count, (SELECT COUNT(*) FROM project_refs WHERE project_id = @id) AS ref_count')
    .get({ id: projectId }) as { scene_count: number; ref_count: number };
}

export function planSummary(ctx: AppContext, p: ProjectRow, clientHash: string | null = null) {
  const analysis = analysisInfo(ctx, p.id);
  const c = counts(ctx, p.id);
  const canDelete = ownsLanPlan(p, clientHash);
  return {
    id: p.id,
    name: p.name,
    created_by_name: p.created_by_name,
    status: planStatus(analysis, c.scene_count),
    scene_count: c.scene_count,
    ref_count: c.ref_count,
    created_at: p.created_at,
    updated_at: p.updated_at,
    analysis,
    /** Trình duyệt này đã tạo kế hoạch → được xoá (DELETE /lan/api/plans/:id). Kế hoạch tạo trước tính năng xoá: luôn false (chỉ chủ máy xoá ở app chính). */
    can_delete: canDelete,
    /** Chỉ khi `can_delete`: lý do chưa xoá được lúc này (đang phân tích/dựng/tải lên...), null = xoá được. */
    delete_block: canDelete ? (projectDeleteBlocks(ctx, p.id)[0]?.message ?? null) : null,
  };
}

export function listLanPlans(ctx: AppContext, clientHash: string | null = null) {
  const rows = ctx.db.prepare("SELECT * FROM projects WHERE source = 'lan' AND kind = 'scenes' AND deleted_at IS NULL ORDER BY id DESC LIMIT 200").all() as ProjectRow[];
  return rows.map((p) => planSummary(ctx, p, clientHash));
}

// ------------------------------------------------------------------ chi tiết kế hoạch

const baseName = (filePath: string): string => path.posix.basename(filePath);

function planRef(r: RefRow): PlanRef {
  return { id: r.id, label: r.label, url: lanFileUrl(r.file_path), file_name: r.original_name || baseName(r.file_path) };
}

interface UploadedStoryboard {
  asset: AssetRow;
  promptVersion: number | null;
}

/** Storyboard LAN tải lên mới nhất của từng cảnh. */
function uploadedStoryboards(ctx: AppContext, sceneIds: number[]): Map<number, UploadedStoryboard> {
  const out = new Map<number, UploadedStoryboard>();
  for (const id of sceneIds) {
    const a = ctx.db
      .prepare("SELECT * FROM assets WHERE scene_id = ? AND kind = 'storyboard' AND json_extract(meta, '$.source') = ? ORDER BY id DESC LIMIT 1")
      .get(id, LAN_UPLOAD_SOURCE) as AssetRow | undefined;
    if (a) {
      const pv = parseJson<{ prompt_version?: number }>(a.meta, {}).prompt_version;
      out.set(id, { asset: a, promptVersion: typeof pv === 'number' ? pv : null });
    }
  }
  return out;
}

const promptVersionOf = (ctx: AppContext, sceneId: number): number =>
  (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(sceneId) as { v: number }).v;

export function planDetail(ctx: AppContext, p: ProjectRow, clientHash: string | null = null) {
  const refRows = projectRefs(ctx, p.id);
  const sceneRows = ctx.db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY order_index, id').all(p.id) as SceneRow[];
  const uploads = uploadedStoryboards(ctx, sceneRows.map((s) => s.id));
  const versions = new Map(sceneRows.map((s) => [s.id, promptVersionOf(ctx, s.id)]));

  const sceneInputs: PlanSceneInput[] = sceneRows.map((s) => {
    const up = uploads.get(s.id);
    return {
      code: s.code,
      title: s.title,
      prompt: s.prompt,
      first_frame_desc: s.first_frame_desc,
      upload_refs: parseJson<number[]>(s.upload_refs, []),
      use_prev_storyboard: !!s.use_prev_storyboard,
      storyboard: up
        ? {
            url: lanFileUrl(up.asset.file_path),
            file_name: baseName(up.asset.file_path),
            stale: up.promptVersion !== null && up.promptVersion < (versions.get(s.id) ?? 0),
          }
        : null,
    };
  });
  const plan = buildPlan({
    name: p.name,
    created_by_name: p.created_by_name,
    style_lock: p.style_lock,
    credit_per_video: p.credit_per_video,
    refs: refRows.map(planRef),
    scenes: sceneInputs,
  });

  const ws = getWorkerRow(ctx);
  const analysis = analysisInfo(ctx, p.id);
  return {
    plan: {
      ...planSummary(ctx, p, clientHash),
      brief: p.brief,
      style_lock: p.style_lock,
      credit_per_video: p.credit_per_video,
    },
    refs: refRows.map((r) => ({ ...planRef(r), order_index: r.order_index })),
    settings: plan.settings,
    scenes: sceneRows.map((s, i) => {
      const up = uploads.get(s.id);
      const sp = plan.scenes[i]!;
      return {
        id: s.id,
        code: s.code,
        title: s.title,
        order_index: s.order_index,
        use_prev_storyboard: !!s.use_prev_storyboard,
        step1: sp.storyboard,
        step2: sp.video,
        storyboard: up
          ? { url: lanFileUrl(up.asset.file_path), file_name: baseName(up.asset.file_path), uploaded_at: up.asset.created_at, stale: sceneInputs[i]!.storyboard!.stale }
          : null,
        storyboard_uploads: (ctx.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE scene_id = ? AND kind = 'storyboard' AND json_extract(meta, '$.source') = ?").get(s.id, LAN_UPLOAD_SOURCE) as { n: number }).n,
        upload_block: storyboardUploadBlock(ctx, s),
        // Bước 3: video người dùng tải lên (danh sách, bản được chọn, lý do chưa tải thêm được)
        videos: sceneVideosJson(ctx, s),
      };
    }),
    markdown: planToMarkdown(plan),
    worker: { online: isOnline(ctx, ws), queue_paused: !!ws.queue_paused },
    analysis,
    limits: lanLimits(ctx),
  };
}

export function lanLimits(ctx: AppContext) {
  return {
    max_refs: MAX_PLAN_REFS,
    max_upload_bytes: ctx.config.maxUploadBytes,
    max_storyboard_uploads_per_scene: MAX_STORYBOARD_UPLOADS_PER_SCENE,
    // video cảnh tải lên (bước 3)
    scene_video: { max_bytes: ctx.config.lanVideoMaxBytes, max_per_scene: MAX_VIDEOS_PER_SCENE, min_s: LAN_VIDEO_MIN_S, max_s: LAN_VIDEO_MAX_S },
    video: { ...VIDEO_SETTINGS },
  };
}

// ------------------------------------------------------------------ phân tích

/** Cập nhật yêu cầu/khóa nhất quán (nếu có) rồi gửi analyze_brief. Không tạo job nào khác. */
export function startAnalysis(ctx: AppContext, p: ProjectRow, body: AnalyzeBody): { jobId: number } {
  return ctx.tx(() => {
    const brief = (body.brief ?? p.brief).trim();
    if (!brief) throw new AppError('VALIDATION_ERROR', 'Cần nhập yêu cầu kịch bản trước khi phân tích', 400);
    const state = analysisInfo(ctx, p.id).state;
    if (state === 'queued' || state === 'running') throw conflict('JOB_ACTIVE', 'Kế hoạch đang được phân tích, hãy đợi kết quả');
    if (body.style_lock !== undefined) {
      ctx.db.prepare('UPDATE projects SET style_lock = ?, updated_at = ? WHERE id = ?').run(body.style_lock.trim(), ctx.now(), p.id);
    }
    return submitBrief(ctx, p.id, brief);
  });
}

// ------------------------------------------------------------------ storyboard người dùng tải lên

export interface StoryboardUpload {
  buf: Buffer;
  type: ImageType;
  originalName: string;
}

/**
 * Lưu ảnh storyboard người dùng LAN tự tạo thành asset storyboard bình thường của cảnh (output/<slug>/storyboard/…).
 * KHÔNG đổi trạng thái cảnh: bảng chuyển trạng thái không cho `awaiting_approval → storyboard_review`, và các trạng thái khác
 * hoặc đã hợp lệ (review/done) hoặc đang có job của chủ máy (bị từ chối). Chỉ lưu asset, ghi event và phát SSE.
 */
export function addLanStoryboard(ctx: AppContext, p: ProjectRow, sceneId: number, up: StoryboardUpload): AssetRow {
  const scene = getScene(ctx, sceneId);
  if (scene.project_id !== p.id) throw notFound('cảnh');
  let rel: string | null = null;
  try {
    return ctx.tx(() => {
      const block = storyboardUploadBlock(ctx, scene);
      if (block) throw conflict('SCENE_BUSY', block);
      const uploaded = (ctx.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE scene_id = ? AND kind = 'storyboard' AND json_extract(meta, '$.source') = ?").get(scene.id, LAN_UPLOAD_SOURCE) as { n: number }).n;
      if (uploaded >= MAX_STORYBOARD_UPLOADS_PER_SCENE) {
        throw conflict('TOO_MANY_UPLOADS', `Mỗi cảnh chỉ nhận tối đa ${MAX_STORYBOARD_UPLOADS_PER_SCENE} lần tải storyboard`);
      }
      const attempt = nextStoryboardAttempt(ctx, scene.id);
      // Tên riêng (`_lan_`) để không bao giờ trùng file do worker tạo (C1_storyboard.png, C1_storyboard_v2.png...).
      rel = cleanRelPath(`output/${p.slug}/storyboard/${scene.code}_storyboard_lan_v${attempt}.${up.type}`, ['output']);
      const abs = path.join(ctx.config.rootDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, up.buf, { flag: 'wx' });
      const meta = { source: LAN_UPLOAD_SOURCE, original_name: up.originalName.slice(0, 200), bytes: up.buf.length, prompt_version: promptVersionOf(ctx, scene.id) };
      const info = ctx.db
        .prepare("INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, meta, created_at) VALUES (?, NULL, 'storyboard', ?, ?, ?, ?)")
        .run(scene.id, rel, attempt, JSON.stringify(meta), ctx.now());
      const id = Number(info.lastInsertRowid);
      logEvent(ctx, { project_id: p.id, scene_id: scene.id, type: 'scene.storyboard_uploaded', message: `${scene.code}: người dùng LAN tải lên ảnh storyboard (lượt ${attempt})` });
      ctx.publish('asset.created', p.id, () => ({ asset: assetJson(ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow) }));
      emitScene(ctx, scene.id, p.id);
      emitBudget(ctx, p.id);
      return ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow;
    });
  } catch (err) {
    if (rel) fs.rmSync(path.join(ctx.config.rootDir, rel), { force: true }); // giao dịch lỗi: không để file mồ côi
    throw err;
  }
}

// ------------------------------------------------------------------ thư viện ảnh (chỉ dự án LAN) và gói ảnh

export function lanLibrary(ctx: AppContext, projectId?: number) {
  return refLibrary(ctx, projectId, { source: 'lan' }).map((r) => ({
    ref_id: r.ref_id,
    url: lanFileUrl(r.file_path),
    label: r.label,
    original_name: r.original_name ?? '',
    content_hash: r.content_hash,
    created_at: r.created_at,
    projects: r.projects,
    in_project: r.in_project,
  }));
}

const safeZipName = (label: string): string =>
  label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'anh';

/** Các mục của gói ảnh tham chiếu: `01-hop-3-4.png`, … theo thứ tự ảnh trong kế hoạch (file mất thì bỏ qua). */
export function refsZipEntries(ctx: AppContext, p: ProjectRow): ZipEntry[] {
  const entries: ZipEntry[] = [];
  projectRefs(ctx, p.id).forEach((r, i) => {
    let abs: string | null = null;
    try {
      abs = resolveInside(ctx.config.rootDir, cleanRelPath(r.file_path, ['refs']), ['refs']);
    } catch {
      abs = null;
    }
    if (!abs) return;
    const file = abs;
    entries.push({
      name: `${String(i + 1).padStart(2, '0')}-${safeZipName(r.label)}${path.extname(file).toLowerCase()}`,
      read: () => fs.readFileSync(file),
    });
  });
  return entries;
}

// ------------------------------------------------------------------ phục vụ file (dùng bởi listener LAN)

/**
 * Đường dẫn tương đối `rel` có được phục vụ qua listener LAN không. CHỈ:
 * - ảnh tham chiếu (`project_refs.file_path`) của dự án source='lan';
 * - storyboard và VIDEO người dùng LAN tự tải lên (`assets.meta.source='lan_upload'`) của cảnh thuộc dự án source='lan';
 * - file bản dựng của dự án source='lan': video sạch, bản raw còn logo, lưới khung hình (KHÔNG BAO GIỜ file dự án .mlt);
 * - bản sạch của việc công cụ (xoá logo) `ready` nếu `clientHash` là chủ của việc đó (cookie client).
 * Mọi thứ khác (output/video của dự án app, storyboard/video do worker tạo, file mồ côi, input của việc công cụ) → false.
 */
export function isLanServable(ctx: AppContext, rel: string, opts: { clientHash?: string | null } = {}): boolean {
  const ref = ctx.db
    .prepare("SELECT 1 FROM project_refs r JOIN projects p ON p.id = r.project_id WHERE r.file_path = ? AND p.source = 'lan' AND p.deleted_at IS NULL LIMIT 1")
    .get(rel);
  if (ref) return true;
  const upload = ctx.db
    .prepare(
      `SELECT 1 FROM assets a JOIN scenes s ON s.id = a.scene_id JOIN projects p ON p.id = s.project_id
       WHERE a.file_path = ? AND a.kind IN ('storyboard','video') AND json_extract(a.meta, '$.source') = ? AND p.source = 'lan' AND p.deleted_at IS NULL LIMIT 1`,
    )
    .get(rel, LAN_UPLOAD_SOURCE);
  if (upload) return true;
  const cut = ctx.db
    .prepare(
      `SELECT 1 FROM final_cuts f JOIN projects p ON p.id = f.project_id
       WHERE p.source = 'lan' AND p.deleted_at IS NULL AND (f.video_path = @rel OR f.raw_video_path = @rel OR f.contact_sheet_path = @rel) LIMIT 1`,
    )
    .get({ rel });
  if (cut) return true;
  // ảnh mẫu màu (ảnh gốc + thumb) của kế hoạch LAN; file LUT (.cube) KHÔNG BAO GIỜ phục vụ (kind='image' mới khớp)
  const cref = ctx.db
    .prepare(
      `SELECT 1 FROM color_refs c JOIN projects p ON p.id = c.project_id
       WHERE p.source = 'lan' AND p.deleted_at IS NULL AND c.kind = 'image' AND (c.file_path = @rel OR c.thumb_path = @rel) LIMIT 1`,
    )
    .get({ rel });
  if (cref) return true;
  // ảnh xem trước chỉnh màu của kế hoạch LAN: output/<slug>/final/preview/<tên>.jpg
  const pv = /^output\/([^/]+)\/final\/preview\/[A-Za-z0-9_.-]+\.jpg$/.exec(rel);
  if (pv) {
    const proj = ctx.db.prepare("SELECT 1 FROM projects WHERE slug = ? AND source = 'lan' AND deleted_at IS NULL LIMIT 1").get(pv[1]);
    if (proj) return true;
  }
  if (isLanClipServable(ctx, rel)) return true;
  if (opts.clientHash) {
    const tool = ctx.db.prepare("SELECT 1 FROM lan_tool_jobs WHERE output_path = ? AND status = 'ready' AND client_id_hash = ? LIMIT 1").get(rel, opts.clientHash);
    if (tool) return true;
  }
  return false;
}
