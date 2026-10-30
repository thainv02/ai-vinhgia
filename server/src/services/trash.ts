/**
 * Thùng rác dự án: xoá MỀM (khôi phục được) rồi xoá vĩnh viễn sau `TRASH_RETENTION_DAYS` ngày. Video trong dự án tốn credit thật nên KHÔNG có đường
 * xoá cứng tức thì: người dùng chỉ có `deleteProject` (vào thùng rác) và, từ app chính, `purgeProject` (xoá vĩnh viễn, phải gõ đúng tên).
 *
 * Xoá = (1) một transaction: kiểm tra điều kiện chặn, hủy job `queued`, đặt `deleted_at/deleted_by/trash_path`; (2) SAU commit, chuyển file bằng `rename`
 * (cùng ổ): `output/<slug>/` → `output/.trash/<id>-<slug>-<mốc>/output/`, `refs/<id>/` → `.../refs/`. Lỗi chuyển file → hoàn tác các file đã chuyển và
 * xoá `deleted_at` (không để nửa vời). Khôi phục chuyển ngược về đúng chỗ cũ và KHÔNG BAO GIỜ ghi đè. Dự án trong thùng rác không tồn tại với mọi API
 * (xem getter trong repo.ts); slug của nó vẫn bị giữ (hàng còn trong `projects`) nên không cấp lại cho dự án mới cho tới khi xoá vĩnh viễn.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import type { ProjectRow } from '../db/types.js';
import { creditsUsed } from './budget.js';
import { cancelJob } from './jobs.js';
import { hasLiveAction } from './managed.js';
import { emitProject, projectSummary } from './project-view.js';
import { getProject, getProjectAny, logEvent } from './repo.js';
import { JOB_TYPE_LABEL } from './rules.js';

export const TRASH_DIR = 'output/.trash';
const MS_DAY = 86_400_000;
/** Chu kỳ dọn thùng rác (tự xoá vĩnh viễn dự án quá hạn). Cũng chạy một lần lúc khởi động. */
export const TRASH_SWEEP_INTERVAL_MS = 60 * 60_000;

export type DeletedBy = 'app' | 'lan';

// ------------------------------------------------------------------ điều kiện chặn xoá

export interface DeleteBlock {
  code: 'JOB_RUNNING' | 'FINAL_CUT_ACTIVE' | 'ACTION_LIVE' | 'UPLOAD_ACTIVE' | 'CLIP_ACTIVE';
  message: string;
}

const jobLabel = (type: string): string => JOB_TYPE_LABEL[type] ?? type;

/**
 * Mọi lý do dự án CHƯA xoá được (rỗng = xoá được). Quy tắc:
 *  - JOB_RUNNING: có job `claimed`/`running` (worker đang giữ);
 *  - FINAL_CUT_ACTIVE: có bản dựng `planning`/`rendering`, hoặc bản dựng còn nằm trong hàng đợi render (kể cả bản vừa hủy mà tiến trình chưa dừng);
 *  - ACTION_LIVE: job managed (queued/claimed/running) có thao tác tạo bên ngoài còn sống (intent/uncertain/submitted/downloaded): phải đối soát trước
 *    để credit/lượt đã tốn được ghi đúng;
 *  - UPLOAD_ACTIVE: đang có video LAN được tải lên dự án (file đang ghi).
 * Job `queued` còn lại (không có thao tác sống) KHÔNG chặn: xoá sẽ hủy chúng. Job done/failed/cancelled không chặn.
 */
export function projectDeleteBlocks(ctx: AppContext, projectId: number): DeleteBlock[] {
  const out: DeleteBlock[] = [];
  const running = ctx.db
    .prepare("SELECT id, type, scene_id FROM jobs WHERE project_id = ? AND status IN ('claimed','running') ORDER BY id")
    .all(projectId) as { id: number; type: string; scene_id: number | null }[];
  if (running.length) {
    out.push({
      code: 'JOB_RUNNING',
      message:
        running.length === 1
          ? `Đang có job #${running[0]!.id} (${jobLabel(running[0]!.type)}) chạy trên worker; hãy đợi xong hoặc hủy job đó trước khi xoá.`
          : `Đang có ${running.length} job chạy trên worker (${running.map((j) => '#' + j.id).join(', ')}); hãy đợi xong hoặc hủy các job đó trước khi xoá.`,
    });
  }

  const cuts = ctx.db.prepare('SELECT id, version, status FROM final_cuts WHERE project_id = ? ORDER BY version DESC').all(projectId) as {
    id: number;
    version: number;
    status: string;
  }[];
  for (const c of cuts) {
    const queued = ctx.finalRender?.queueInfo('cut', c.id) ?? null;
    if (c.status === 'planning') {
      out.push({ code: 'FINAL_CUT_ACTIVE', message: `Bản hoàn chỉnh v${c.version} đang chờ AI chọn điểm cắt; hãy hủy bản dựng đó (hoặc đợi xong) trước khi xoá.` });
    } else if (c.status === 'rendering') {
      out.push({ code: 'FINAL_CUT_ACTIVE', message: `Bản hoàn chỉnh v${c.version} đang render hoặc xoá logo; hãy hủy hoặc đợi xong trước khi xoá.` });
    } else if (queued) {
      out.push({ code: 'FINAL_CUT_ACTIVE', message: `Bản hoàn chỉnh v${c.version} vẫn nằm trong hàng đợi render (đang dừng tiến trình); hãy thử lại sau ít giây.` });
    }
  }

  const live = (
    ctx.db
      .prepare(
        `SELECT DISTINCT j.id, j.type FROM jobs j JOIN external_actions e ON e.job_id = j.id
         WHERE j.project_id = ? AND j.status IN ('queued','claimed','running') ORDER BY j.id`,
      )
      .all(projectId) as { id: number; type: string }[]
  ).filter((j) => hasLiveAction(ctx, j.id));
  for (const j of live) {
    out.push({
      code: 'ACTION_LIVE',
      message: `Job #${j.id} (${jobLabel(j.type)}) đã gửi lệnh tạo sang Flow/ChatGPT mà chưa đối soát kết quả; hãy đối soát ở trang Hàng đợi trước khi xoá để credit và lượt đã tốn được ghi đúng.`,
    });
  }

  if (ctx.projectUploadsInFlight(projectId) > 0) {
    out.push({ code: 'UPLOAD_ACTIVE', message: 'Đang có video được tải lên kế hoạch này; hãy đợi tải xong rồi xoá.' });
  }

  // Dự án cắt clip: đang nhận dạng lời nói (đang ghi transcript/file tạm vào thư mục dự án) hoặc đang dựng/chờ dựng clip (ffmpeg đang ghi file).
  const transcribing = ctx.db.prepare("SELECT id FROM source_videos WHERE project_id = ? AND status = 'transcribing' LIMIT 1").get(projectId);
  if (transcribing) out.push({ code: 'CLIP_ACTIVE', message: 'Video đang được nhận dạng lời nói; hãy hủy hoặc đợi xong trước khi xoá.' });
  const rendering = ctx.db.prepare("SELECT COUNT(*) AS n FROM clip_cuts WHERE project_id = ? AND status = 'rendering'").get(projectId) as { n: number };
  if (rendering.n > 0) out.push({ code: 'CLIP_ACTIVE', message: `Đang dựng ${rendering.n} clip; hãy hủy hoặc đợi xong trước khi xoá.` });
  const stopping = (ctx.db.prepare('SELECT id FROM clip_cuts WHERE project_id = ?').all(projectId) as { id: number }[]).some((c) => ctx.finalRender?.queueInfo('clip', c.id));
  if (stopping && rendering.n === 0) out.push({ code: 'CLIP_ACTIVE', message: 'Một clip vẫn nằm trong hàng đợi dựng (đang dừng tiến trình); hãy thử lại sau ít giây.' });
  return out;
}

function blockedError(blocks: DeleteBlock[]): AppError {
  return new AppError('PROJECT_BUSY', `Chưa xoá được dự án: ${blocks.map((b) => b.message).join(' ')}`, 409, { reasons: blocks });
}

/** Tên xác nhận phải trùng tên dự án (chuẩn hoá Unicode NFC, bỏ khoảng trắng đầu/cuối; phân biệt hoa thường). */
export function assertConfirmName(project: Pick<ProjectRow, 'name'>, input: unknown): void {
  const norm = (s: string) => s.normalize('NFC').trim();
  if (typeof input !== 'string' || norm(input) !== norm(project.name)) {
    throw badRequest('CONFIRM_MISMATCH', `Tên xác nhận không khớp. Hãy gõ đúng tên "${project.name}" để tiếp tục`);
  }
}

// ------------------------------------------------------------------ file: đường dẫn an toàn, di chuyển có hoàn tác

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Thư mục hệ thống nằm cạnh các dự án trong `output/` (việc xoá logo LAN): slug trùng tên này không được chuyển vào thùng rác. */
const RESERVED_SLUGS = new Set(['lan-tools']);
const isSafeSegment = (s: string): boolean => SAFE_SEGMENT.test(s) && !s.startsWith('.') && !RESERVED_SLUGS.has(s);
const TRASH_PATH_RE = /^output\/\.trash\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Kind = 'none' | 'dir' | 'other';
function pathKind(abs: string): Kind {
  try {
    return fs.lstatSync(abs).isDirectory() ? 'dir' : 'other';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'other'; // lỗi quyền...: coi như "có gì đó" để không ghi đè
  }
}

/** Cây thư mục không có file nào (chỉ thư mục rỗng lồng nhau): xoá nó không mất dữ liệu nên khôi phục được phép thay thế. */
function isEmptyTree(abs: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return true;
  }
  if (!st.isDirectory()) return false;
  try {
    return fs.readdirSync(abs).every((f) => isEmptyTree(path.join(abs, f)));
  } catch {
    return false;
  }
}

function dirSize(abs: string): number {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* file biến mất giữa chừng */
        }
      }
    }
  }
  return total;
}
const sizeCache = new WeakMap<AppContext, Map<string, number>>();

/** Thư mục thùng rác tuyệt đối của dự án, hoặc null nếu `trash_path` thiếu/không đúng dạng `output/.trash/<tên>` (không bao giờ thao tác ngoài thùng rác). */
function trashDirOf(ctx: AppContext, p: ProjectRow): string | null {
  if (!p.trash_path || !TRASH_PATH_RE.test(p.trash_path)) return null;
  return path.join(ctx.config.rootDir, ...p.trash_path.split('/'));
}

interface Move {
  from: string;
  to: string;
}
class MoveFailure extends Error {
  constructor(
    message: string,
    /** Các thư mục đã chuyển mà KHÔNG hoàn tác ngược lại được (lỗi kép, hiếm). */
    readonly stuck: Move[],
  ) {
    super(message);
  }
}

/**
 * Chuyển lần lượt các thư mục bằng `rename` (nguyên tử, cùng ổ). Bỏ qua nguồn không tồn tại. Lỗi → hoàn tác những thư mục đã chuyển theo thứ tự ngược
 * rồi ném `MoveFailure` (kèm danh sách thư mục không hoàn tác được nếu có).
 */
function applyMoves(moves: Move[]): void {
  const done: Move[] = [];
  try {
    for (const m of moves) {
      if (pathKind(m.from) === 'none') continue;
      fs.mkdirSync(path.dirname(m.to), { recursive: true });
      fs.renameSync(m.from, m.to);
      done.push(m);
    }
  } catch (err) {
    const stuck: Move[] = [];
    for (const m of done.reverse()) {
      try {
        fs.renameSync(m.to, m.from);
      } catch {
        stuck.push(m);
      }
    }
    throw new MoveFailure(err instanceof Error ? err.message : String(err), stuck);
  }
}

const rel = (ctx: AppContext, abs: string): string => path.relative(ctx.config.rootDir, abs).split(path.sep).join('/');

function originals(ctx: AppContext, p: ProjectRow): { output: string; refs: string } {
  return { output: path.join(ctx.config.rootDir, 'output', p.slug), refs: path.join(ctx.config.rootDir, 'refs', String(p.id)) };
}

const compactStamp = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// ------------------------------------------------------------------ xoá (vào thùng rác)

/**
 * Chuyển dự án vào thùng rác. Ném 404 (không có/đã xoá), 409 `PROJECT_BUSY` (xem `projectDeleteBlocks`), 500 `TRASH_MOVE_FAILED` (đã hoàn tác).
 * `confirmName` (nếu truyền) phải trùng tên dự án: app chính luôn truyền; LAN xác nhận ở hộp thoại nên không có.
 */
export function deleteProject(ctx: AppContext, id: number, opts: { by: DeletedBy; confirmName?: string }): { id: number; name: string; trash_path: string } {
  const before = getProject(ctx, id);
  if (opts.confirmName !== undefined) assertConfirmName(before, opts.confirmName);
  if (!isSafeSegment(before.slug)) {
    throw conflict('UNSAFE_SLUG', `Slug "${before.slug}" có ký tự lạ nên không chuyển thư mục vào thùng rác an toàn được; hãy đổi tên thư mục thủ công`);
  }

  let trashRel = '';
  let deletedAt = '';
  ctx.tx(() => {
    const p = getProject(ctx, id);
    const blocks = projectDeleteBlocks(ctx, id);
    if (blocks.length) throw blockedError(blocks);
    // Job còn xếp hàng: hủy bằng đường hủy sẵn có (cảnh/ledger/bản dựng đúng). Phải làm TRƯỚC khi đánh dấu xoá vì getter chỉ thấy dự án chưa xoá.
    const queued = ctx.db.prepare("SELECT id FROM jobs WHERE project_id = ? AND status = 'queued' ORDER BY id").all(id) as { id: number }[];
    for (const j of queued) cancelJob(ctx, j.id);
    deletedAt = ctx.now();
    const base = `${TRASH_DIR}/${p.id}-${p.slug}-${compactStamp(deletedAt)}`;
    trashRel = base;
    for (let n = 2; fs.existsSync(path.join(ctx.config.rootDir, trashRel)); n++) trashRel = `${base}-${n}`;
    ctx.db.prepare('UPDATE projects SET deleted_at = ?, deleted_by = ?, trash_path = ? WHERE id = ?').run(deletedAt, opts.by, trashRel, id);
    logEvent(ctx, {
      project_id: id,
      type: 'project.deleted',
      message: `Chuyển dự án "${p.name}" vào thùng rác (${opts.by === 'lan' ? 'người tạo xoá từ trang LAN' : 'chủ máy xoá ở app chính'})${queued.length ? `; hủy ${queued.length} job đang xếp hàng` : ''}`,
    });
    ctx.publish('project.deleted', id, { project_id: id, name: p.name, deleted_by: opts.by });
  });

  // Sau commit: chuyển file. Lỗi → hoàn tác file và đưa dự án về trạng thái cũ.
  const o = originals(ctx, before);
  const trashAbs = path.join(ctx.config.rootDir, trashRel);
  try {
    fs.mkdirSync(path.dirname(trashAbs), { recursive: true });
    fs.mkdirSync(trashAbs);
    applyMoves([
      { from: o.output, to: path.join(trashAbs, 'output') },
      { from: o.refs, to: path.join(trashAbs, 'refs') },
    ]);
  } catch (err) {
    const stuck = err instanceof MoveFailure ? err.stuck : [];
    const msg = err instanceof Error ? err.message : String(err);
    if (stuck.length === 0) {
      try {
        fs.rmdirSync(trashAbs);
      } catch {
        /* thư mục không rỗng/không tạo được: bỏ qua */
      }
      ctx.tx(() => {
        ctx.db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL, trash_path = NULL WHERE id = ? AND deleted_at = ?').run(id, deletedAt);
        logEvent(ctx, { project_id: id, type: 'project.delete_failed', message: `Xoá dự án thất bại khi chuyển file vào thùng rác (${msg}); đã hoàn tác, dự án giữ nguyên` });
        emitProject(ctx, id);
      });
      throw new AppError('TRASH_MOVE_FAILED', `Không chuyển file vào thùng rác được (${msg}). Dự án được giữ nguyên, chưa xoá.`, 500);
    }
    // Lỗi kép (hiếm): file đã nằm trong thùng rác mà không chuyển ngược được. Giữ trạng thái "đã xoá" để dữ liệu nhất quán với vị trí file.
    throw new AppError(
      'TRASH_MOVE_FAILED',
      `Không chuyển hết file vào thùng rác được (${msg}) và cũng không hoàn tác được (${stuck.map((m) => rel(ctx, m.to)).join(', ')}). Dự án đã ở trong thùng rác; khôi phục để kiểm tra.`,
      500,
    );
  }
  return { id, name: before.name, trash_path: trashRel };
}

// ------------------------------------------------------------------ phục vụ file

/**
 * Đường dẫn tương đối (đã qua `cleanRelPath`) có bị thùng rác che không: mọi thứ dưới `output/.trash/` (kể cả viết hoa/thường khác trên ổ không phân biệt
 * hoa thường), file dưới `output/<slug>/` của dự án đã xoá và `refs/<id>/` của dự án đã xoá. `/files` và `/lan/files` đều gọi hàm này, nên file của dự án
 * đã xoá không phục vụ được dù còn sót ở chỗ cũ.
 */
export function isHiddenByTrash(ctx: AppContext, relPath: string): boolean {
  const seg = relPath.split('/');
  if (seg[0] === 'output' && seg[1]?.toLowerCase() === '.trash') return true;
  if (seg[0] === 'output' && seg[1]) {
    return !!ctx.db.prepare('SELECT 1 FROM projects WHERE lower(slug) = lower(?) AND deleted_at IS NOT NULL LIMIT 1').get(seg[1]);
  }
  if (seg[0] === 'refs' && seg[1] && /^\d+$/.test(seg[1])) {
    return !!ctx.db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NOT NULL').get(Number(seg[1]));
  }
  return false;
}

// ------------------------------------------------------------------ danh sách / khôi phục / xoá vĩnh viễn

function getTrashed(ctx: AppContext, id: number): ProjectRow {
  const p = getProjectAny(ctx, id);
  if (!p.deleted_at) throw notFound('dự án trong thùng rác');
  return p;
}

/** Thư mục cần chuyển ngược: [thùng rác → chỗ cũ]. */
function restoreMoves(ctx: AppContext, p: ProjectRow, trashAbs: string): Move[] {
  const o = originals(ctx, p);
  return [
    { from: path.join(trashAbs, 'output'), to: o.output },
    { from: path.join(trashAbs, 'refs'), to: o.refs },
  ];
}

/** Lý do chưa khôi phục được (chỗ cũ đã có thư mục cùng tên chứa file); null = khôi phục được. */
export function restoreConflict(ctx: AppContext, p: ProjectRow): string | null {
  const dir = trashDirOf(ctx, p);
  if (!dir) return null;
  for (const m of restoreMoves(ctx, p, dir)) {
    if (pathKind(m.from) === 'none') continue;
    const k = pathKind(m.to);
    if (k === 'none' || (k === 'dir' && isEmptyTree(m.to))) continue;
    return `Thư mục ${rel(ctx, m.to)} đã tồn tại và có nội dung (có thể tên thư mục đã bị dùng lại). Hệ thống không ghi đè: hãy đổi tên hoặc chuyển thư mục đó đi rồi khôi phục lại.`;
  }
  return null;
}

export function trashItemJson(ctx: AppContext, p: ProjectRow) {
  const deletedMs = Date.parse(p.deleted_at as string);
  const purgeMs = deletedMs + ctx.config.trashRetentionDays * MS_DAY;
  const dir = trashDirOf(ctx, p);
  let cache = sizeCache.get(ctx);
  if (!cache) sizeCache.set(ctx, (cache = new Map()));
  let size: number | null = null;
  if (dir && pathKind(dir) === 'dir') {
    const key = p.trash_path as string;
    size = cache.get(key) ?? dirSize(dir); // nội dung thùng rác không đổi nên nhớ lại kích thước
    cache.set(key, size);
  }
  const n = ctx.db.prepare('SELECT COUNT(*) AS scenes, COALESCE(SUM(status = \'done\'), 0) AS done FROM scenes WHERE project_id = ?').get(p.id) as { scenes: number; done: number };
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    source: p.source,
    created_by_name: p.created_by_name,
    status: p.status,
    created_at: p.created_at,
    deleted_at: p.deleted_at as string,
    /** 'app' (chủ máy) | 'lan' (người tạo kế hoạch xoá từ trang LAN). */
    deleted_by: p.deleted_by,
    /** Thời điểm tự xoá vĩnh viễn (deleted_at + TRASH_RETENTION_DAYS) và số ngày còn lại (làm tròn lên, tối thiểu 0). */
    purge_at: new Date(purgeMs).toISOString(),
    days_left: Math.max(0, Math.ceil((purgeMs - ctx.clock.now()) / MS_DAY)),
    retention_days: ctx.config.trashRetentionDays,
    /** Dung lượng file trong thùng rác (byte); null nếu thư mục thùng rác không còn. */
    size_bytes: size,
    scene_count: n.scenes,
    done_count: n.done,
    credits_used: creditsUsed(ctx, p.id),
    /** Lý do chưa khôi phục được lúc này (chỗ cũ bị chiếm); null = khôi phục được. */
    restore_block: restoreConflict(ctx, p),
  };
}
export type TrashItemJson = ReturnType<typeof trashItemJson>;

export function listTrash(ctx: AppContext): TrashItemJson[] {
  const rows = ctx.db.prepare('SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC').all() as ProjectRow[];
  return rows.map((p) => trashItemJson(ctx, p));
}

export function trashCount(ctx: AppContext): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NOT NULL').get() as { n: number }).n;
}

/** Khôi phục: chuyển file về đúng chỗ cũ (409 `RESTORE_CONFLICT` nếu chỗ cũ đã có nội dung, KHÔNG ghi đè), rồi bỏ đánh dấu xoá. */
export function restoreProject(ctx: AppContext, id: number): ProjectRow {
  const p = getTrashed(ctx, id);
  const dir = trashDirOf(ctx, p);
  const block = restoreConflict(ctx, p);
  if (block) throw conflict('RESTORE_CONFLICT', block);
  const moves = dir ? restoreMoves(ctx, p, dir) : [];
  // chỗ cũ là cây thư mục rỗng (vd còn sót sau một lần tải lên dở): bỏ đi để rename thay thế, không mất file nào
  for (const m of moves) {
    if (pathKind(m.from) !== 'none' && pathKind(m.to) === 'dir' && isEmptyTree(m.to)) fs.rmSync(m.to, { recursive: true, force: true });
  }
  try {
    applyMoves(moves);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stuck = err instanceof MoveFailure ? err.stuck : [];
    throw new AppError(
      'RESTORE_FAILED',
      `Không chuyển file về chỗ cũ được (${msg}). Dự án vẫn ở trong thùng rác${stuck.length ? `; ${stuck.map((m) => rel(ctx, m.to)).join(', ')} đã chuyển về nhưng không hoàn tác được` : ', chưa thay đổi gì'}.`,
      500,
    );
  }
  try {
    ctx.tx(() => {
      const info = ctx.db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL, trash_path = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id);
      if (info.changes !== 1) throw notFound('dự án trong thùng rác');
      logEvent(ctx, { project_id: id, type: 'project.restored', message: `Khôi phục dự án "${p.name}" từ thùng rác` });
      ctx.publish('project.restored', id, () => ({ project: projectSummary(ctx, getProject(ctx, id)) }));
      emitProject(ctx, id);
    });
  } catch (err) {
    // DB lỗi: đưa file về thùng rác để vị trí file khớp với trạng thái DB
    try {
      applyMoves(moves.map((m) => ({ from: m.to, to: m.from })).filter((m) => pathKind(m.from) !== 'none'));
    } catch {
      /* hiếm: để startup tự hoàn tất */
    }
    throw err;
  }
  if (dir) {
    try {
      fs.rmdirSync(dir); // chỉ xoá khi rỗng
    } catch {
      /* còn sót thứ lạ: để nguyên */
    }
  }
  return getProject(ctx, id);
}

/**
 * Xoá vĩnh viễn một dự án trong thùng rác: xoá thư mục thùng rác (và file còn sót ở chỗ cũ, nếu có) rồi `DELETE FROM projects`
 * (cascade tới cảnh, job, asset, bản dựng, ảnh tham chiếu, sổ credit, nhật ký, chính sách AI...). Không hoàn tác được.
 * `confirmName` (nếu truyền) phải trùng tên dự án.
 */
export function purgeProject(ctx: AppContext, id: number, opts: { confirmName?: string } = {}): { id: number; name: string } {
  const p = getTrashed(ctx, id);
  if (opts.confirmName !== undefined) assertConfirmName(p, opts.confirmName);
  const root = ctx.config.rootDir;
  const targets: string[] = [];
  const dir = trashDirOf(ctx, p);
  if (dir) targets.push(dir);
  // file còn ở chỗ cũ (chỉ khi lần chuyển vào thùng rác bị gián đoạn): slug này đang bị giữ cho dự án, xoá cùng để slug cấp lại sau không thừa hưởng file cũ
  if (isSafeSegment(p.slug)) targets.push(originals(ctx, p).output);
  targets.push(originals(ctx, p).refs);
  for (const t of targets) {
    if (!t.startsWith(root + path.sep)) continue;
    try {
      fs.rmSync(t, { recursive: true, force: true });
    } catch (err) {
      throw new AppError('PURGE_FAILED', `Không xoá được ${rel(ctx, t)} (${err instanceof Error ? err.message : String(err)}). Dự án vẫn nằm trong thùng rác; thử lại sau.`, 500);
    }
  }
  ctx.tx(() => {
    const info = ctx.db.prepare('DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL').run(id);
    if (info.changes !== 1) throw notFound('dự án trong thùng rác');
    ctx.publish('project.purged', id, { project_id: id });
  });
  sizeCache.get(ctx)?.delete(p.trash_path ?? '');
  return { id, name: p.name };
}

// ------------------------------------------------------------------ bảo trì: tự xoá quá hạn, hoàn tất việc chuyển file dở

/** Xoá vĩnh viễn mọi dự án nằm trong thùng rác quá `TRASH_RETENTION_DAYS` ngày. Lỗi ở một dự án không chặn các dự án khác. */
export function purgeExpiredTrash(ctx: AppContext): { purged: number[]; failed: { id: number; error: string }[] } {
  const cutoff = new Date(ctx.clock.now() - ctx.config.trashRetentionDays * MS_DAY).toISOString();
  const rows = ctx.db.prepare('SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY deleted_at, id').all(cutoff) as { id: number }[];
  const purged: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const r of rows) {
    try {
      purgeProject(ctx, r.id);
      purged.push(r.id);
    } catch (err) {
      failed.push({ id: r.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { purged, failed };
}

/**
 * Hoàn tất việc chuyển file bị gián đoạn: dự án đã đánh dấu xoá (commit) nhưng tiến trình chết trước khi chuyển hết file, nên file còn ở chỗ cũ.
 * Chuyển nốt vào thùng rác (chỉ khi chưa có bản trong thùng rác; không bao giờ ghi đè). Trả về số thư mục đã chuyển.
 */
export function finishInterruptedTrash(ctx: AppContext): number {
  let moved = 0;
  const rows = ctx.db.prepare('SELECT * FROM projects WHERE deleted_at IS NOT NULL').all() as ProjectRow[];
  for (const p of rows) {
    const dir = trashDirOf(ctx, p);
    if (!dir || !isSafeSegment(p.slug)) continue;
    const o = originals(ctx, p);
    const todo = [
      { from: o.output, to: path.join(dir, 'output') },
      { from: o.refs, to: path.join(dir, 'refs') },
    ].filter((m) => pathKind(m.from) !== 'none' && pathKind(m.to) === 'none');
    if (!todo.length) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      applyMoves(todo);
      moved += todo.length;
    } catch (err) {
      console.warn(`[trash] không hoàn tất chuyển file của dự án #${p.id} vào thùng rác:`, err instanceof Error ? err.message : err);
    }
  }
  return moved;
}

/** Bảo trì thùng rác (gọi lúc khởi động và mỗi giờ): hoàn tất việc dở rồi tự xoá vĩnh viễn dự án quá hạn. */
export function trashMaintenance(ctx: AppContext): { moved: number; purged: number[]; failed: { id: number; error: string }[] } {
  const moved = finishInterruptedTrash(ctx);
  return { moved, ...purgeExpiredTrash(ctx) };
}
