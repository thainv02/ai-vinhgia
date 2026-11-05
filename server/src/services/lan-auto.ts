/**
 * Tab Autovideo của trang LAN: dự án `source='lan'`, `lan_mode='auto'`. Người dùng LAN làm như chủ máy trên app chính: AI chia cảnh,
 * bấm tạo storyboard, bấm tạo video (chọn Muse hoặc một model Google Flow), chọn video dùng cho bản hoàn chỉnh.
 * Mọi job đi qua ĐÚNG đường của app chính (`approveStoryboard` / `approveVideo` / `approveAll`, `selectVideo`, `editPrompt`, `cancelJob`),
 * nên luật lượt video mỗi cảnh, số ảnh tối đa của dịch vụ, cảnh đang có job… giữ nguyên. Chỉ thêm:
 * - công tắc `LAN_AUTOVIDEO` của chủ máy;
 * - trần LAN_AUTO_QUEUE_CAP job storyboard/video từ LAN đang chờ/chạy (mọi người dùng LAN cộng lại);
 * - `claimNext` xếp storyboard/video của dự án Autovideo SAU việc của chủ máy (xem LAN_MEDIA_LAST trong jobs.ts);
 * - JSON an toàn cho LAN: URL qua `/lan/files`, lỗi đã che đường dẫn, lý do tạm dừng hàng đợi viết lại thành câu chung.
 * Job do worker nền (`npm run worker:media`, WORKER-MUSE.md / WORKER-FLOW.md) xử lý, tốn hạn mức Muse / credit Flow của chủ máy.
 */
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { SCENE_STATUS_LABEL, type AssetRow, type JobRow, type ProjectRow, type SceneRow } from '../db/types.js';
import { approveAll, approveStoryboard, approveVideo, previewApproveAll, type ApproveStage } from './approvals.js';
import { attemptsUsed } from './budget.js';
import { GENERATOR_IDS, STORYBOARD_GENERATORS, STORYBOARD_GENERATOR_IDS, VIDEO_GENERATORS, generatorIdOfPayload, getGenerator, getStoryboardGenerator } from './generators.js';
import { LAN_MEDIA_LAST, cancelJob } from './jobs.js';
import { lanFileUrl, scrubForLan } from './lan-common.js';
import { analysisInfo, createPlanBody, ownsLanPlan, planStatus } from './lan-plans.js';
import { createProject } from './projects.js';
import { emitProject } from './project-view.js';
import { getProject, getScene, logEvent, parseJson, projectRefs } from './repo.js';
import { PROMPT_EDITABLE, activeJobOf, storyboardApproveError, videoApproveError, videoImageCount } from './rules.js';
import { editPrompt, selectVideo } from './scenes.js';
import { projectDeleteBlocks } from './trash.js';
import { getWorkerRow, isOnline } from './worker.js';

/** Số lượt tạo video mỗi cảnh của dự án Autovideo (lượt đầu + tạo lại; lỗi trước khi dịch vụ nhận lệnh không tính). */
export const LAN_AUTO_MAX_ATTEMPTS = 5;

/** Số job storyboard/video từ LAN (mọi dự án Autovideo) được cùng lúc ở trạng thái chờ/chạy. */
export const LAN_AUTO_QUEUE_CAP = 20;

export const createAutoBody = createPlanBody.extend({
  storyboard_generator: z.enum(STORYBOARD_GENERATOR_IDS).default('muse'),
});
export type CreateAutoBody = z.infer<typeof createAutoBody>;

export const patchAutoBody = z.object({ storyboard_generator: z.enum(STORYBOARD_GENERATOR_IDS) });
export const videoBody = z.object({ generator: z.enum(GENERATOR_IDS).optional() });
export const approveAllBody = z.object({ stage: z.enum(['storyboard', 'video']), generator: z.enum(GENERATOR_IDS).optional() });
export const promptBody = z.object({ prompt: z.string().trim().min(1, 'prompt không được rỗng').max(20_000) });
export const selectBody = z.object({ asset_id: z.number().int().positive() });

/** Dự án Autovideo theo id; dự án khác (app, kế hoạch prompt, highlight, đã xoá) trả 404 như không tồn tại. */
export function lanAutoProject(ctx: AppContext, id: number): ProjectRow {
  const p = getProject(ctx, id);
  if (p.source !== 'lan' || p.kind !== 'scenes' || p.lan_mode !== 'auto') throw notFound('dự án Autovideo');
  return p;
}

/**
 * Trang LAN chọn MỘT dịch vụ cho cả storyboard lẫn video: video phải cùng hãng (Muse / Google Flow) với dịch vụ storyboard của dự án.
 * Không gửi `generator` → model đầu tiên của hãng đó.
 */
function autoGeneratorFor(p: ProjectRow, generator?: string): string {
  const provider = getStoryboardGenerator(p.storyboard_generator).provider;
  if (!generator) return VIDEO_GENERATORS.find((g) => g.provider === provider)!.id;
  const g = getGenerator(generator);
  if (g.provider !== provider) {
    throw conflict('GENERATOR_MISMATCH', `Dự án đang dùng ${provider === 'flow' ? 'Google Flow' : 'Muse'}; chọn lại dịch vụ của dự án trước khi tạo video bằng ${g.label}`);
  }
  return g.id;
}

function autoScene(ctx: AppContext, p: ProjectRow, sceneId: number): SceneRow {
  const scene = getScene(ctx, sceneId);
  if (scene.project_id !== p.id) throw notFound('cảnh');
  return scene;
}

export function assertAutoEnabled(ctx: AppContext): void {
  if (!ctx.config.lanAutovideo) throw new AppError('FEATURE_DISABLED', 'Chủ máy đang tắt tạo ảnh/video tự động cho trang LAN', 403);
}

/** `clientHash`: băm cookie client của trình duyệt tạo dự án (chỉ trình duyệt đó xoá được dự án). Tối đa LAN_AUTO_MAX_ATTEMPTS lượt video mỗi cảnh. */
export function createLanAuto(ctx: AppContext, body: CreateAutoBody, clientHash: string | null): ProjectRow {
  return createProject(
    ctx,
    { name: body.name, brief: body.brief, style_lock: body.style_lock, max_attempts_per_scene: LAN_AUTO_MAX_ATTEMPTS },
    { source: 'lan', lan_mode: 'auto', created_by_name: body.created_by_name, lan_client_hash: clientHash, storyboard_generator: body.storyboard_generator },
  );
}

export function setAutoStoryboardGenerator(ctx: AppContext, p: ProjectRow, id: string): ProjectRow {
  return ctx.tx(() => {
    const g = getStoryboardGenerator(id);
    if (p.storyboard_generator !== g.id) {
      ctx.db.prepare('UPDATE projects SET storyboard_generator = ?, updated_at = ? WHERE id = ?').run(g.id, ctx.now(), p.id);
      logEvent(ctx, { project_id: p.id, type: 'project.updated', message: `Người dùng LAN đổi dịch vụ tạo storyboard sang ${g.label}` });
      emitProject(ctx, p.id);
    }
    return getProject(ctx, p.id);
  });
}

// ------------------------------------------------------------------ máy tạo ảnh/video và hàng đợi

const MEDIA_TYPES = "('storyboard','video')";

/** Số job storyboard/video của dự án Autovideo đang chờ/chạy (mọi người dùng LAN). */
export function lanAutoLoad(ctx: AppContext): number {
  return (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs j JOIN projects p ON p.id = j.project_id
         WHERE p.source = 'lan' AND p.lan_mode = 'auto' AND p.deleted_at IS NULL AND j.type IN ${MEDIA_TYPES} AND j.status IN ('queued','claimed','running')`,
      )
      .get() as { n: number }
  ).n;
}

function assertAutoRoom(ctx: AppContext, adding: number): void {
  const load = lanAutoLoad(ctx);
  if (load + adding > LAN_AUTO_QUEUE_CAP) {
    throw new AppError(
      'QUEUE_FULL',
      load >= LAN_AUTO_QUEUE_CAP
        ? `Hàng đợi tạo ảnh/video của trang LAN đã đủ ${LAN_AUTO_QUEUE_CAP} việc, thử lại sau ít phút`
        : `Hàng đợi tạo ảnh/video của trang LAN chỉ còn chỗ cho ${LAN_AUTO_QUEUE_CAP - load} việc`,
      429,
      { retry_after_s: 120 },
    );
  }
}

/** Câu chung cho người dùng LAN khi hàng đợi tạm dừng (lý do gốc của chủ máy có thể chứa chi tiết tài khoản). */
function pauseText(code: string | null): string {
  if (code === 'LOGIN_REQUIRED') return 'Tài khoản dịch vụ tạo ảnh/video của chủ máy cần đăng nhập lại.';
  if (code === 'CAPTCHA') return 'Dịch vụ tạo video đang đòi xác minh, chủ máy cần xử lý.';
  if (code === 'FLOW_OUT_OF_CREDIT') return 'Tài khoản Google Flow của chủ máy đã hết credit.';
  return 'Chủ máy đang tạm dừng hàng đợi.';
}

export function mediaStatus(ctx: AppContext) {
  const ws = getWorkerRow(ctx);
  const cutoff = new Date(ctx.clock.now() - ctx.config.workerOnlineSeconds * 1000).toISOString();
  // worker nền ảnh/video (và worker Claude legacy) nhận job ở chế độ legacy
  const online = !!ctx.db.prepare("SELECT 1 FROM worker_sessions WHERE mode = 'legacy' AND last_seen_at >= ? LIMIT 1").get(cutoff);
  return {
    enabled: ctx.config.lanAutovideo,
    online,
    paused: !!ws.queue_paused,
    pause_text: ws.queue_paused ? `${pauseText(ws.pause_code)} Việc đã gửi vẫn giữ trong hàng đợi và chạy tiếp khi chủ máy bật lại.` : null,
    load: lanAutoLoad(ctx),
    cap: LAN_AUTO_QUEUE_CAP,
  };
}

/** Vị trí của job storyboard/video `queued` trong hàng đợi worker ảnh/video (cùng thứ tự `claimNext`: việc chủ máy trước, rồi theo id). */
function mediaPosition(ctx: AppContext, job: JobRow): number {
  const rows = ctx.db
    .prepare(
      `SELECT j.id, ${LAN_MEDIA_LAST} AS prio FROM jobs j JOIN projects p ON p.id = j.project_id
       WHERE j.status = 'queued' AND p.deleted_at IS NULL AND j.type IN ${MEDIA_TYPES} AND (j.requires_approval = 0 OR j.approved_at IS NOT NULL)
       ORDER BY prio, j.id`,
    )
    .all() as { id: number }[];
  const i = rows.findIndex((r) => r.id === job.id);
  return i < 0 ? rows.length + 1 : i + 1;
}

const FAIL_TEXT: Record<string, string> = {
  LOGIN_REQUIRED: 'Tài khoản dịch vụ cần đăng nhập lại (chủ máy xử lý).',
  CAPTCHA: 'Dịch vụ đòi xác minh (chủ máy xử lý).',
  FLOW_OUT_OF_CREDIT: 'Tài khoản Google Flow hết credit.',
};

function jobInfo(ctx: AppContext, scene: SceneRow) {
  const active = activeJobOf(ctx, scene.id);
  if (active && (active.type === 'storyboard' || active.type === 'video')) {
    const queued = active.status === 'queued';
    return {
      type: active.type,
      state: queued ? ('queued' as const) : ('running' as const),
      position: queued ? mediaPosition(ctx, active) : null,
      generator: active.type === 'video' ? getGenerator(generatorIdOfPayload(active.payload)).label : getStoryboardGenerator(storyboardGeneratorId(active.payload)).label,
      created_at: active.created_at,
      started_at: active.claimed_at,
      can_cancel: queued,
    };
  }
  return null;
}

const storyboardGeneratorId = (payload: string): string | null => {
  const g = parseJson<{ generator?: unknown }>(payload, {}).generator;
  return typeof g === 'string' ? g : g && typeof g === 'object' && typeof (g as { id?: unknown }).id === 'string' ? (g as { id: string }).id : null;
};

/** Lỗi của job storyboard/video gần nhất nếu cảnh đang lỗi hoặc job đó lỗi sau lần có kết quả cuối. */
function lastError(ctx: AppContext, scene: SceneRow): string | null {
  const job = ctx.db
    .prepare(`SELECT * FROM jobs WHERE scene_id = ? AND type IN ${MEDIA_TYPES} AND status IN ('done','failed','cancelled') ORDER BY id DESC LIMIT 1`)
    .get(scene.id) as JobRow | undefined;
  if (!job || job.status !== 'failed') return null;
  const what = job.type === 'video' ? 'Tạo video' : 'Tạo storyboard';
  const why = (job.error_code && FAIL_TEXT[job.error_code]) ?? scrubForLan(job.error, 'Lỗi phía máy chủ.') ?? 'Lỗi phía máy chủ.';
  return `${what} không thành công: ${why}`;
}

// ------------------------------------------------------------------ JSON

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sceneJson(ctx: AppContext, p: ProjectRow, scene: SceneRow, refs: Map<number, { id: number; label: string; url: string }>) {
  const assets = ctx.db.prepare("SELECT * FROM assets WHERE scene_id = ? AND kind IN ('storyboard','video','grid') ORDER BY id").all(scene.id) as AssetRow[];
  const storyboards = assets.filter((a) => a.kind === 'storyboard');
  const sb = storyboards[storyboards.length - 1];
  const grids = assets.filter((a) => a.kind === 'grid');
  const videos = assets
    .filter((a) => a.kind === 'video')
    .map((a) => {
      const m = parseJson<Record<string, unknown>>(a.meta, {});
      const grid = [...grids].reverse().find((g) => g.attempt === a.attempt);
      return {
        id: a.id,
        attempt: a.attempt,
        url: lanFileUrl(a.file_path),
        grid_url: grid ? lanFileUrl(grid.file_path) : null,
        created_at: a.created_at,
        duration_s: num(m.duration_s),
        generator: typeof m.generator === 'string' ? m.generator : null,
        selected: a.id === scene.selected_video_id,
      };
    });
  const sbLogo = sb ? parseJson<{ logo?: { status?: unknown } }>(sb.meta, {}).logo : undefined;
  const job = jobInfo(ctx, scene);
  const sErr = storyboardApproveError(ctx, scene);
  // Muse nhận nhiều ảnh nhất: lỗi "thừa ảnh" của từng dịch vụ do giao diện tính theo `image_count`
  const vErr = videoApproveError(ctx, scene, p, 'muse');
  const disabled = ctx.config.lanAutovideo ? null : 'Chủ máy đang tắt tạo ảnh/video tự động';
  return {
    id: scene.id,
    code: scene.code,
    title: scene.title,
    order_index: scene.order_index,
    status: scene.status,
    status_label: SCENE_STATUS_LABEL[scene.status],
    prompt: scene.prompt ?? '',
    use_prev_storyboard: !!scene.use_prev_storyboard,
    refs: parseJson<number[]>(scene.upload_refs, []).flatMap((id) => (refs.has(id) ? [refs.get(id)!] : [])),
    image_count: videoImageCount(scene),
    storyboard: sb
      ? {
          id: sb.id,
          url: lanFileUrl(sb.file_path),
          attempt: sb.attempt,
          created_at: sb.created_at,
          logo: typeof sbLogo?.status === 'string' ? sbLogo.status : null,
        }
      : null,
    storyboard_count: storyboards.length,
    videos,
    selected_video_id: videos.some((v) => v.selected) ? scene.selected_video_id : null,
    attempts_used: attemptsUsed(ctx, scene.id),
    max_attempts: p.max_attempts_per_scene,
    job,
    error: job ? null : lastError(ctx, scene),
    blocks: {
      storyboard: disabled ?? sErr?.message ?? null,
      video: disabled ?? vErr?.message ?? null,
      select: scene.status === 'video_review' || scene.status === 'done' ? null : 'Chỉ chọn video khi cảnh đã có video và không còn việc đang chạy',
      prompt: job ? 'Cảnh đang có việc chạy' : PROMPT_EDITABLE.includes(scene.status) ? null : `Không sửa prompt khi cảnh ở trạng thái ${SCENE_STATUS_LABEL[scene.status]}`,
    },
  };
}
export type AutoSceneJson = ReturnType<typeof sceneJson>;

function autoProgress(ctx: AppContext, projectId: number) {
  const r = ctx.db
    .prepare(
      `SELECT COUNT(*) AS scenes,
         SUM(EXISTS(SELECT 1 FROM assets a WHERE a.scene_id = s.id AND a.kind = 'storyboard')) AS storyboards,
         SUM(s.selected_video_id IS NOT NULL) AS videos,
         SUM(EXISTS(SELECT 1 FROM jobs j WHERE j.scene_id = s.id AND j.type IN ${MEDIA_TYPES} AND j.status IN ('queued','claimed','running'))) AS active
       FROM scenes s WHERE s.project_id = ?`,
    )
    .get(projectId) as { scenes: number; storyboards: number | null; videos: number | null; active: number | null };
  const thumb = ctx.db
    .prepare(
      `SELECT a.file_path FROM assets a JOIN scenes s ON s.id = a.scene_id WHERE s.project_id = ? AND a.kind = 'storyboard' ORDER BY s.order_index, s.id, a.id DESC LIMIT 1`,
    )
    .get(projectId) as { file_path: string } | undefined;
  const last = ctx.db.prepare('SELECT status FROM final_cuts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as { status: string } | undefined;
  return {
    scene_count: r.scenes,
    thumbnail_url: thumb ? lanFileUrl(thumb.file_path) : null,
    progress: { storyboards: r.storyboards ?? 0, videos: r.videos ?? 0, active: r.active ?? 0, final_status: last?.status ?? null },
  };
}

export function autoSummary(ctx: AppContext, p: ProjectRow, clientHash: string | null = null) {
  const analysis = analysisInfo(ctx, p.id);
  const c = autoProgress(ctx, p.id);
  const canDelete = ownsLanPlan(p, clientHash);
  return {
    id: p.id,
    name: p.name,
    created_by_name: p.created_by_name,
    status: planStatus(analysis, c.scene_count),
    scene_count: c.scene_count,
    thumbnail_url: c.thumbnail_url,
    progress: c.progress,
    storyboard_generator: getStoryboardGenerator(p.storyboard_generator).id,
    created_at: p.created_at,
    updated_at: p.updated_at,
    analysis,
    can_delete: canDelete,
    delete_block: canDelete ? (projectDeleteBlocks(ctx, p.id)[0]?.message ?? null) : null,
  };
}

export function listLanAuto(ctx: AppContext, clientHash: string | null = null) {
  const rows = ctx.db
    .prepare("SELECT * FROM projects WHERE source = 'lan' AND kind = 'scenes' AND lan_mode = 'auto' AND deleted_at IS NULL ORDER BY id DESC LIMIT 200")
    .all() as ProjectRow[];
  return rows.map((p) => autoSummary(ctx, p, clientHash));
}

/** Danh sách dịch vụ (không có model nội bộ hay khoá): giao diện LAN dùng chung bộ chọn với app chính. */
export const autoGenerators = () => ({ generators: VIDEO_GENERATORS, storyboard: STORYBOARD_GENERATORS });

export function autoDetail(ctx: AppContext, p: ProjectRow, clientHash: string | null = null) {
  const refRows = projectRefs(ctx, p.id);
  const refs = new Map(refRows.map((r) => [r.id, { id: r.id, label: r.label, url: lanFileUrl(r.file_path) }]));
  const scenes = ctx.db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY order_index, id').all(p.id) as SceneRow[];
  const ws = getWorkerRow(ctx);
  return {
    project: { ...autoSummary(ctx, p, clientHash), brief: p.brief, style_lock: p.style_lock, max_attempts_per_scene: p.max_attempts_per_scene },
    refs: refRows.map((r) => ({ id: r.id, label: r.label, url: lanFileUrl(r.file_path), file_name: r.original_name || r.file_path.split('/').pop() || '', order_index: r.order_index })),
    scenes: scenes.map((s) => sceneJson(ctx, p, s, refs)),
    analysis: analysisInfo(ctx, p.id),
    worker: { online: isOnline(ctx, ws), queue_paused: !!ws.queue_paused },
    media: mediaStatus(ctx),
  };
}

// ------------------------------------------------------------------ thao tác (gọi đúng dịch vụ của app chính)

export function autoStoryboard(ctx: AppContext, p: ProjectRow, sceneId: number): { jobId: number } {
  assertAutoEnabled(ctx);
  return ctx.tx(() => {
    autoScene(ctx, p, sceneId);
    assertAutoRoom(ctx, 1);
    return { jobId: approveStoryboard(ctx, sceneId).jobId };
  });
}

export function autoVideo(ctx: AppContext, p: ProjectRow, sceneId: number, generator?: string): { jobId: number } {
  assertAutoEnabled(ctx);
  return ctx.tx(() => {
    autoScene(ctx, p, sceneId);
    assertAutoRoom(ctx, 1);
    return { jobId: approveVideo(ctx, sceneId, autoGeneratorFor(p, generator)).jobId };
  });
}

/** Số cảnh sẽ tạo (để kiểm tra hạn mức theo IP trước khi tạo). */
export function autoAllCount(ctx: AppContext, p: ProjectRow, stage: ApproveStage, generator?: string): number {
  return previewApproveAll(ctx, p.id, stage, stage === 'video' ? autoGeneratorFor(p, generator) : undefined).count;
}

export function autoAll(ctx: AppContext, p: ProjectRow, stage: ApproveStage, generator?: string) {
  assertAutoEnabled(ctx);
  return ctx.tx(() => {
    const g = stage === 'video' ? autoGeneratorFor(p, generator) : undefined;
    assertAutoRoom(ctx, previewApproveAll(ctx, p.id, stage, g).count);
    return approveAll(ctx, p.id, stage, g);
  });
}

export function autoSelectVideo(ctx: AppContext, p: ProjectRow, sceneId: number, assetId: number): SceneRow {
  autoScene(ctx, p, sceneId);
  return selectVideo(ctx, sceneId, assetId);
}

export function autoEditPrompt(ctx: AppContext, p: ProjectRow, sceneId: number, prompt: string): SceneRow {
  return ctx.tx(() => {
    const scene = autoScene(ctx, p, sceneId);
    if (activeJobOf(ctx, scene.id)) throw conflict('JOB_ACTIVE', `Cảnh ${scene.code} đang có việc chạy, chưa sửa prompt được`);
    return editPrompt(ctx, sceneId, prompt, 'Người dùng LAN sửa tay');
  });
}

/** Hủy việc storyboard/video đang CHỜ của cảnh. Việc worker đã nhận thì không hủy (dịch vụ đã nhận lệnh, hủy chỉ làm mất kết quả). */
export function autoCancel(ctx: AppContext, p: ProjectRow, sceneId: number) {
  return ctx.tx(() => {
    const scene = autoScene(ctx, p, sceneId);
    const job = activeJobOf(ctx, scene.id);
    if (!job || (job.type !== 'storyboard' && job.type !== 'video')) throw conflict('NO_ACTIVE_JOB', `Cảnh ${scene.code} không có việc đang chờ`);
    if (job.status !== 'queued') throw conflict('JOB_RUNNING', 'Máy chủ đã bắt đầu tạo, không hủy được nữa; hãy đợi kết quả');
    return cancelJob(ctx, job.id);
  });
}
