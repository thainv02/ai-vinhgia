import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { intParam, parse } from '../lib/validate.js';
import { readImageUploads } from '../lib/uploads.js';
import {
  addLanStoryboard,
  analyzeBody,
  createLanPlan,
  createPlanBody,
  isLanServable,
  lanFileUrl,
  lanLibrary,
  lanLimits,
  lanProject,
  lanProjectAny,
  listLanPlans,
  ownsLanPlan,
  planDetail,
  planSummary,
  refsZipEntries,
  startAnalysis,
} from '../services/lan-plans.js';
import { MAX_PLAN_REFS } from '../services/plan.js';
import { storeRef, addRefsFromLibrary } from '../services/refs.js';
import { projectRefs } from '../services/repo.js';
import { lanFinalSummary, lanWatermarkInfo } from '../services/lan-final.js';
import { clipLimits } from '../services/clips/lan.js';
import { lanQueueLoad } from '../services/lan-queue.js';
import { deleteProject, isHiddenByTrash } from '../services/trash.js';
import { getWorkerRow, isOnline } from '../services/worker.js';
import { zipChunks } from '../services/zip.js';
import { LanSessions, SESSION_TTL_MS, clearSessionCookie, codeMatches, sessionCookie } from './session.js';
import { lanIp, sessionTokenOf } from './security.js';
import { ensureClientHash, peekClientHash } from './client-id.js';
import { LAN_RATE, makeLimiters, tooMany } from './limits.js';
import { registerLanClipRoutes } from './routes-clips.js';
import { registerLanColorRoutes } from './routes-color.js';
import { registerLanMediaRoutes } from './routes-media.js';
import { registerLanToolRoutes } from './routes-tools.js';

export { LAN_RATE };

const refJson = (r: { id: number; label: string; file_path: string; original_name: string | null; order_index: number }) => ({
  id: r.id,
  label: r.label,
  url: lanFileUrl(r.file_path),
  file_name: r.original_name || path.posix.basename(r.file_path),
  order_index: r.order_index,
});

/** Route của trang planner LAN. CHỈ các route này (và file tĩnh của trang) tồn tại trên listener LAN. */
export async function registerLanRoutes(app: FastifyInstance, ctx: AppContext, sessions: LanSessions): Promise<void> {
  const now = () => ctx.clock.now();
  const L = makeLimiters(now);
  const { loginFails, analyze: analyzeLimit, createPlan: createLimit, uploadFiles: uploadLimit } = L;
  const planId = (req: FastifyRequest) => intParam((req.params as { id: string }).id);

  // ---- trang và assets build (công khai, không có dữ liệu) ----
  const dist = ctx.config.lanDistDir;
  // Range bật để video (bước 3, bản hoàn chỉnh) tua được; ảnh không bị ảnh hưởng
  await app.register(fastifyStatic, { root: ctx.config.rootDir, serve: false, acceptRanges: true });
  const page = (_req: FastifyRequest, reply: FastifyReply): void => {
    if (!fs.existsSync(path.join(dist, 'planner.html'))) {
      void reply.code(503).type('text/plain; charset=utf-8').send('Chưa có bản build giao diện planner. Chủ máy chạy "npm run build" rồi tải lại trang.');
      return;
    }
    reply.header('Cache-Control', 'no-cache');
    void reply.sendFile('planner.html', dist, { cacheControl: false });
  };
  app.get('/', page);
  app.get('/planner.html', page);
  app.get('/assets/:file', (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith('.') || !fs.existsSync(path.join(dist, 'assets', file))) throw notFound('file');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    void reply.sendFile(`assets/${file}`, dist, { cacheControl: false });
  });

  // ---- đăng nhập bằng mã truy cập (chỉ khi LAN_REQUIRE_CODE=true; mặc định không có đăng nhập, không có phiên) ----
  const requireCode = ctx.config.lanRequireCode;
  app.post('/lan/api/login', async (req, reply) => {
    // Không cần mã: không tạo phiên, không đọc body. Trả ok để trang/bản cũ đang mở không báo lỗi.
    if (!requireCode) return { ok: true, code_required: false, expires_at: null };
    const ip = lanIp(req);
    const lim = loginFails.check(ip);
    if (!lim.allowed) throw tooMany(reply, 'Nhập sai mã quá nhiều lần.', lim.retryAfterMs);
    const body = parse(z.object({ code: z.string().max(200) }), req.body);
    if (!codeMatches(body.code, ctx.config.lanAccessCode)) {
      loginFails.record(ip);
      req.log.warn({ ip }, 'Đăng nhập LAN sai mã'); // không bao giờ ghi mã đã nhập
      throw new AppError('INVALID_CODE', 'Mã truy cập không đúng', 401);
    }
    const s = sessions.create();
    reply.header('Set-Cookie', sessionCookie(s.token, Math.floor(SESSION_TTL_MS / 1000)));
    return { ok: true, code_required: true, expires_at: new Date(s.expiresAt).toISOString() };
  });

  app.post('/lan/api/logout', async (req, reply) => {
    sessions.destroy(sessionTokenOf(req));
    reply.header('Set-Cookie', clearSessionCookie()); // xoá luôn cookie phiên còn sót từ lúc còn đòi mã
    return { ok: true };
  });

  // Công khai: cho trang biết có cần mã không và đã có phiên hay chưa (không lộ gì khác). Không cần mã → luôn `authenticated: true`, không có hạn phiên.
  app.get('/lan/api/session', async (req) => {
    if (!requireCode) return { authenticated: true, code_required: false, expires_at: null };
    const exp = sessions.valid(sessionTokenOf(req));
    return exp === null ? { authenticated: false, code_required: true } : { authenticated: true, code_required: true, expires_at: new Date(exp).toISOString() };
  });

  /** Trạng thái worker (chỉ đọc, rút gọn) và giới hạn để trang hiển thị. */
  app.get('/lan/api/status', async (req) => {
    const ws = getWorkerRow(ctx);
    return {
      worker: { online: isOnline(ctx, ws), queue_paused: !!ws.queue_paused },
      code_required: requireCode,
      limits: lanLimits(ctx),
      rate: LAN_RATE,
      // lượt phân tích còn lại của CHÍNH người gọi (theo IP) trong giờ này
      analyze_remaining: analyzeLimit.check(lanIp(req)).remaining,
      // hạn mức còn lại của CHÍNH người gọi cho video tải lên, dựng/render lại, xoá logo (theo IP, trong giờ này)
      remaining: {
        analyze: analyzeLimit.check(lanIp(req)).remaining,
        upload_video: L.uploadVideo.check(lanIp(req)).remaining,
        create_final: L.createFinal.check(lanIp(req)).remaining,
        remove_logo: L.removeLogo.check(lanIp(req)).remaining,
        feedback: L.feedback.check(lanIp(req)).remaining,
        grade: L.grade.check(lanIp(req)).remaining,
        grade_preview: L.gradePreview.check(lanIp(req)).remaining,
        color_ref: L.colorRef.check(lanIp(req)).remaining,
        // cắt clip từ video dài
        clip_project: L.clipProject.check(lanIp(req)).remaining,
        clip_source: Math.max(0, L.clipSource.check(lanIp(req)).remaining - L.clipGate.inflight(lanIp(req))),
        clip_plan: L.clipPlan.check(lanIp(req)).remaining,
        clip_render: L.clipRender.check(lanIp(req)).remaining,
        clip_edit: L.clipEdit.check(lanIp(req)).remaining,
      },
      /** Giới hạn cắt clip: dung lượng/thời lượng video nguồn, hạn lưu, nhận dạng lời nói và phụ đề có sẵn không. */
      clip: clipLimits(ctx, true),
      // việc từ LAN đang trong hàng đợi / trần toàn cục
      queue: lanQueueLoad(ctx),
      // hàng đợi render chung (bản dựng + xoá logo, của app và LAN): đang chạy / đang chờ / số việc chạy cùng lúc
      render: ctx.finalRender?.summary() ?? null,
      server_time: ctx.now(),
    };
  });

  // ---- kế hoạch ----
  // `can_delete`/`delete_block` chỉ đúng với trình duyệt đã tạo kế hoạch (cookie client `autovideo_lan_client`); không có cookie → không ai xoá được
  app.get('/lan/api/plans', async (req) => listLanPlans(ctx, peekClientHash(req)));

  app.post('/lan/api/plans', async (req, reply) => {
    const ip = lanIp(req);
    const body = parse(createPlanBody, req.body ?? {});
    const lim = createLimit.check(ip);
    if (!lim.allowed) throw tooMany(reply, 'Bạn đã tạo quá nhiều kế hoạch trong một giờ.', lim.retryAfterMs);
    // Cấp cookie client (nếu chưa có) và ghi SHA-256 của nó vào kế hoạch: chỉ trình duyệt này xoá được kế hoạch từ trang LAN.
    const hash = ensureClientHash(req, reply);
    const p = createLanPlan(ctx, body, hash);
    createLimit.record(ip);
    return reply.code(201).send({ plan: planSummary(ctx, p, hash) });
  });

  app.get('/lan/api/plans/:id', async (req) => {
    const p = lanProject(ctx, planId(req));
    const wm = ctx.finalRender ? lanWatermarkInfo(await ctx.finalRender.watermarkStatus()) : { active: false, reason: 'Chưa có trình dựng' };
    // `final`: điều kiện dựng bản hoàn chỉnh (mọi cảnh có video được chọn), bản mới nhất, và tool xoá logo có bật không
    return { ...planDetail(ctx, p, peekClientHash(req)), final: { ...lanFinalSummary(ctx, p), watermark: wm } };
  });

  // Xoá kế hoạch = chuyển vào thùng rác của chủ máy (30 ngày, chủ máy khôi phục được; LAN không có khôi phục/xoá vĩnh viễn).
  // CHỈ trình duyệt đã tạo kế hoạch (băm cookie client trùng `lan_client_hash`); kế hoạch cũ hoặc của người khác → 403. 10 lần/giờ/IP.
  app.delete('/lan/api/plans/:id', async (req, reply) => {
    const ip = lanIp(req);
    const lim = L.deletePlan.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được xoá tối đa ${LAN_RATE.deletePlan.max} kế hoạch mỗi giờ.`, lim.retryAfterMs);
    const p = lanProjectAny(ctx, planId(req)); // 404 nếu không có / đã xoá / không phải dự án LAN (kế hoạch prompt hoặc cắt clip)
    L.deletePlan.record(ip);
    if (!ownsLanPlan(p, peekClientHash(req))) {
      throw new AppError('NOT_PLAN_OWNER', 'Chỉ người tạo (trình duyệt đã tạo kế hoạch) mới xoá được; nhờ chủ máy xoá', 403);
    }
    deleteProject(ctx, p.id, { by: 'lan' });
    return { ok: true, id: p.id, restorable_days: ctx.config.trashRetentionDays };
  });

  // Ảnh tham chiếu: tải lên (multipart, ≤10 MB mỗi ảnh, magic bytes), tối đa 12 ảnh mỗi kế hoạch
  app.post('/lan/api/plans/:id/refs', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    assertEditable(ctx, p.id);
    const items = await readImageUploads(req);
    const lim = uploadLimit.check(ip, items.length);
    if (!lim.allowed) throw tooMany(reply, 'Bạn đã tải lên quá nhiều ảnh trong một giờ.', lim.retryAfterMs);
    if (projectRefs(ctx, p.id).length + items.length > MAX_PLAN_REFS) {
      throw conflict('TOO_MANY_REFS', `Mỗi kế hoạch chỉ có tối đa ${MAX_PLAN_REFS} ảnh tham chiếu`);
    }
    const created = items.map((it) => storeRef(ctx, p.id, it.name, it.buf, it.type, it.label));
    uploadLimit.record(ip, items.length);
    return reply.code(201).send(created.map(refJson));
  });

  // Thư viện ảnh: chỉ ảnh của các kế hoạch LAN (không bao giờ ảnh của dự án trên app chính)
  app.get('/lan/api/ref-library', async (req) => {
    const q = (req.query as { planId?: string }).planId;
    return lanLibrary(ctx, q === undefined || q === '' ? undefined : lanProject(ctx, intParam(q, 'planId')).id);
  });

  app.post('/lan/api/plans/:id/refs/from-library', async (req, reply) => {
    const p = lanProject(ctx, planId(req));
    assertEditable(ctx, p.id);
    const body = parse(
      z.object({
        ref_ids: z.array(z.number().int().positive()).min(1).max(MAX_PLAN_REFS),
        labels: z.record(z.string(), z.string().max(100)).optional(),
      }),
      req.body,
    );
    const refs = addRefsFromLibrary(ctx, p.id, body.ref_ids, body.labels, { sourceProjectSource: 'lan', maxRefs: MAX_PLAN_REFS });
    return reply.code(201).send(refs.map(refJson));
  });

  // Gửi phân tích (analyze_brief). Mỗi lượt, kể cả phân tích lại, tính vào giới hạn 6 lượt/giờ theo IP.
  app.post('/lan/api/plans/:id/analyze', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const body = parse(analyzeBody, req.body ?? {});
    const lim = analyzeLimit.check(ip);
    if (!lim.allowed) throw tooMany(reply, `Mỗi người chỉ được gửi tối đa ${LAN_RATE.analyze.max} lượt phân tích mỗi giờ.`, lim.retryAfterMs);
    startAnalysis(ctx, p, body);
    analyzeLimit.record(ip);
    return reply.code(201).send({ plan: planSummary(ctx, lanProject(ctx, p.id), peekClientHash(req)), rate: { analyze_remaining: analyzeLimit.check(ip).remaining } });
  });

  // Tải lên ảnh storyboard người dùng vừa tạo ở bước 1 (chỉ lưu asset, không tạo job, không đổi trạng thái cảnh)
  app.post('/lan/api/plans/:id/scenes/:sceneId/storyboard', async (req, reply) => {
    const ip = lanIp(req);
    const p = lanProject(ctx, planId(req));
    const sceneId = intParam((req.params as { sceneId: string }).sceneId, 'sceneId');
    const items = await readImageUploads(req);
    if (items.length !== 1) throw badRequest('VALIDATION_ERROR', 'Mỗi lần chỉ tải lên một ảnh storyboard');
    const lim = uploadLimit.check(ip);
    if (!lim.allowed) throw tooMany(reply, 'Bạn đã tải lên quá nhiều ảnh trong một giờ.', lim.retryAfterMs);
    const it = items[0]!;
    const asset = addLanStoryboard(ctx, p, sceneId, { buf: it.buf, type: it.type, originalName: it.name });
    uploadLimit.record(ip);
    return reply.code(201).send({ storyboard: { url: lanFileUrl(asset.file_path), attempt: asset.attempt, uploaded_at: asset.created_at } });
  });

  // Tải kế hoạch (.md) và gói ảnh tham chiếu (.zip)
  app.get('/lan/api/plans/:id/plan.md', async (req, reply) => {
    const p = lanProject(ctx, planId(req));
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="ke-hoach-${p.slug}.md"`)
      .send(planDetail(ctx, p).markdown);
  });

  app.get('/lan/api/plans/:id/refs.zip', async (req, reply) => {
    const p = lanProject(ctx, planId(req));
    const entries = refsZipEntries(ctx, p);
    if (entries.length === 0) throw notFound('ảnh tham chiếu nào trong kế hoạch');
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="anh-tham-chieu-${p.slug}.zip"`)
      .send(Readable.from(zipChunks(entries, new Date(ctx.clock.now())), { objectMode: false }));
  });

  // ---- tệp: CHỈ ảnh tham chiếu/storyboard/video tải lên và file bản dựng của kế hoạch LAN, và bản sạch của việc xoá logo (đúng chủ) ----
  app.get('/lan/files/*', (req, reply) => {
    let rel: string;
    try {
      rel = cleanRelPath((req.params as { '*': string })['*'], ['refs', 'output']);
    } catch {
      throw notFound('file');
    }
    if (isHiddenByTrash(ctx, rel) || !isLanServable(ctx, rel, { clientHash: peekClientHash(req) }) || !resolveInside(ctx.config.rootDir, rel, ['refs', 'output'])) throw notFound('file');
    reply.header('Cache-Control', 'private, no-cache');
    void reply.sendFile(rel, ctx.config.rootDir, { cacheControl: false });
  });

  registerLanMediaRoutes(app, ctx, L);
  registerLanColorRoutes(app, ctx, L);
  registerLanToolRoutes(app, ctx, L);
  registerLanClipRoutes(app, ctx, L);

  app.setNotFoundHandler(() => {
    throw new AppError('NOT_FOUND', 'Không tìm thấy đường dẫn', 404);
  });
}

/** Kế hoạch đang phân tích thì không thêm ảnh (AI đang đọc danh sách ảnh hiện tại). */
function assertEditable(ctx: AppContext, projectId: number): void {
  const active = ctx.db.prepare("SELECT 1 FROM jobs WHERE project_id = ? AND type = 'analyze_brief' AND status IN ('queued','claimed','running') LIMIT 1").get(projectId);
  if (active) throw conflict('JOB_ACTIVE', 'Kế hoạch đang được phân tích, chưa thể thêm ảnh lúc này');
}
