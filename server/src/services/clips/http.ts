/**
 * Các endpoint cắt clip, dùng chung cho app chính (`/api/...`) và listener LAN (`/lan/api/...`): cùng đường dẫn con, cùng hình dạng JSON (hợp đồng mục 5 của đặc tả).
 * Khác nhau do `ClipHttpEnv` quyết định: phạm vi dự án (LAN chỉ thấy dự án LAN), JSON (URL `/lan/files`, lỗi không lộ đường dẫn), hạn mức/giới hạn đồng thời (LAN).
 * Hàm này CHỈ đăng ký route khi được gọi: listener LAN không import route nào của app chính.
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { ProjectRow } from '../../db/types.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { intParam, optionalIntParam, parse } from '../../lib/validate.js';
import { streamVideoToDisk } from '../../lib/video-upload.js';
import { assertLanQueueRoom } from '../lan-queue.js';
import { probeUploadedVideo } from '../media.js';
import { getJobRow } from '../repo.js';
import { zipChunks } from '../zip.js';
import { captionsBody, clipsZipEntries, createClipBody, createManualClip, patchClip, patchClipBody, putCaptions } from './clips.js';
import { clipLimits } from './lan.js';
import { clipPlanBody, createClipPlan } from './plan.js';
import { previewBody, renderPreviewFrame } from './preview-frame.js';
import { cancelClipCut, renderBody, startClipRender } from './render.js';
import { getClipProject, getClipRow, getCutRow, getSourceRow, projectClips, projectSource, readTranscript } from './repo.js';
import { assertDiskRoom, assertSourceProbe, createClipProject, createClipProjectBody, makePoster, patchClipProject, patchClipProjectBody, queuePreview, registerSource, sourceLimits, sourceTmpDir } from './source.js';
import { startTranscription, sttConfigured, STT_NOT_CONFIGURED } from './stt.js';
import { transcriptPage, transcriptSrt, transcriptTxt } from './transcript.js';
import { clipJson, clipProjectDetail, cutJson, planJobJson, sourceJson, type ViewOpts } from './view.js';

/** `upload`: tải video nguồn (hạn mức giờ + cổng đồng thời); `source`: nhận dạng lại (cùng hạn mức giờ, không có cổng). */
export type LimitKind = 'project' | 'upload' | 'source' | 'plan' | 'render' | 'edit';

export interface LimitHandle {
  /** Ghi nhận một lượt (gọi SAU KHI thành công). */
  record(): void;
  /** Nhả cổng (gọi trong finally). */
  release?(): void;
}

export interface ClipHttpEnv {
  lan: boolean;
  /** `/api` hoặc `/lan/api`. */
  prefix: string;
  view(req: FastifyRequest): ViewOpts;
  /** Phạm vi dự án: app thấy mọi dự án cắt clip; LAN chỉ thấy dự án LAN (còn lại 404). */
  scope(project: ProjectRow): void;
  /** Kiểm tra hạn mức TRƯỚC khi làm (ném 429 nếu hết) và trả tay cầm ghi nhận/nhả. Chỉ LAN có. */
  limit?(kind: LimitKind, req: FastifyRequest, reply: FastifyReply): LimitHandle;
  /** Nguồn gốc dự án khi tạo (LAN: ghi băm cookie client). */
  origin?(req: FastifyRequest, reply: FastifyReply): { source: 'app' | 'lan'; lan_client_hash: string | null };
}

const asId = (req: FastifyRequest, name = 'id'): number => intParam((req.params as Record<string, string>)[name], name);

/** `limit/record/release` bọc quanh một thao tác. */
async function limited<T>(env: ClipHttpEnv, kind: LimitKind, req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T> | T): Promise<T> {
  const h = env.limit?.(kind, req, reply);
  try {
    const r = await fn();
    h?.record();
    return r;
  } finally {
    h?.release?.();
  }
}

export function registerClipEndpoints(app: FastifyInstance, ctx: AppContext, env: ClipHttpEnv): void {
  const p = env.prefix;
  const projectOf = (id: number): ProjectRow => {
    const proj = getClipProject(ctx, id);
    env.scope(proj);
    return proj;
  };
  const sourceOf = (id: number) => {
    const s = getSourceRow(ctx, id);
    const proj = projectOf(s.project_id);
    return { source: s, project: proj };
  };
  const clipOf = (id: number) => {
    const c = getClipRow(ctx, id);
    return { clip: c, project: projectOf(c.project_id) };
  };

  // ---------------------------------------------------------------- dự án
  app.post(`${p}/clip-projects`, async (req, reply) => {
    const body = parse(createClipProjectBody, req.body ?? {});
    const detail = await limited(env, 'project', req, reply, () => {
      const origin = env.origin?.(req, reply);
      const project = createClipProject(ctx, body, origin ?? {});
      // lần đầu chưa có cookie client trong request: dùng băm vừa cấp để người tạo thấy can_delete=true ngay
      return clipProjectDetail(ctx, project, { ...env.view(req), ...(origin?.lan_client_hash ? { clientHash: origin.lan_client_hash } : {}) });
    });
    return reply.code(201).send(detail);
  });

  app.get(`${p}/clip-projects/:id`, async (req) => clipProjectDetail(ctx, projectOf(asId(req)), env.view(req)));

  app.patch(`${p}/clip-projects/:id`, async (req, reply) => {
    const id = asId(req);
    projectOf(id);
    const patch = parse(patchClipProjectBody, req.body ?? {});
    return limited(env, 'edit', req, reply, () => clipProjectDetail(ctx, patchClipProject(ctx, id, patch), env.view(req)));
  });

  // ---------------------------------------------------------------- video nguồn
  app.post(`${p}/projects/:id/source`, async (req, reply) => {
    const project = projectOf(asId(req));
    const lim = sourceLimits(ctx, env.lan);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 0) assertDiskRoom(ctx, declared); // báo ngay, không nhận file
    if (env.lan) assertLanQueueRoom(ctx);
    const h = env.limit?.('upload', req, reply);
    const uploadDone = ctx.beginProjectUpload(project.id); // đang ghi file vào thư mục dự án: không cho xoá dự án cho tới khi xong
    let tmp: string | null = null;
    try {
      const maxGb = (lim.max_bytes / 1024 ** 3).toFixed(0);
      const up = await streamVideoToDisk(req, {
        tmpDir: sourceTmpDir(ctx, project.slug),
        maxBytes: lim.max_bytes,
        magic: 'video',
        hash: true,
        tooLargeMessage: `Video vượt quá ${maxGb} GB`,
      });
      tmp = up.tmpAbs;
      assertDiskRoom(ctx, up.bytes);
      const probe = assertSourceProbe(await probeUploadedVideo(ctx.config, up.tmpAbs), lim.max_s);
      const { source, reused } = registerSource(ctx, project, { tmpAbs: up.tmpAbs, bytes: up.bytes, originalName: up.originalName, sha256: up.sha256!, container: up.container!, probe });
      tmp = null; // đã đổi tên hoặc xoá
      if (!reused) {
        startTranscription(ctx, source.id);
        void makePoster(ctx, source, project.slug);
        if (env.lan) queuePreview(ctx, source.id);
      } else if (['failed', 'cancelled', 'uploaded'].includes(source.status)) {
        startTranscription(ctx, source.id); // tải lại đúng file đó = thử lại
      }
      h?.record();
      return reply.code(201).send({ source: sourceJson(ctx, getSourceRow(ctx, source.id), env.view(req)) });
    } finally {
      uploadDone();
      h?.release?.();
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  });

  app.post(`${p}/sources/:id/transcribe`, async (req, reply) => {
    const { source, project } = sourceOf(asId(req));
    return limited(env, 'source', req, reply, () => {
      if (!sttConfigured(ctx)) throw new AppError('STT_NOT_CONFIGURED', STT_NOT_CONFIGURED, 409);
      if (source.deleted_at) throw conflict('SOURCE_DELETED', 'Video gốc đã bị xoá nên không nhận dạng lại được');
      if (source.status === 'transcribing') throw conflict('INVALID_STATE', 'Video đang được nhận dạng lời nói');
      if (source.status === 'transcribed') {
        const had = (JSON.parse(source.stt_meta ?? '{}') as { terms?: string | null }).terms ?? null;
        if (had === (project.stt_terms?.trim() || null)) throw conflict('INVALID_STATE', 'Đã nhận dạng xong và tên riêng/thuật ngữ không đổi; hãy sửa "Tên riêng/thuật ngữ" trước khi nhận dạng lại');
        if (projectClips(ctx, project.id).length) throw conflict('CLIPS_EXIST', 'Dự án đã có clip nên không nhận dạng lại được (chỉ số từ sẽ đổi); hãy tạo dự án mới với tên riêng mong muốn');
      }
      startTranscription(ctx, source.id);
      return { source: sourceJson(ctx, getSourceRow(ctx, source.id), env.view(req)) };
    });
  });

  app.post(`${p}/sources/:id/cancel`, async (req) => {
    const { source, project } = sourceOf(asId(req));
    if (source.status !== 'transcribing' && source.status !== 'uploaded') throw conflict('INVALID_STATE', `Video đang ở trạng thái ${source.status}, không có gì để hủy`);
    ctx.tx(() => {
      ctx.db.prepare("UPDATE source_videos SET status = 'cancelled', progress = NULL, error = NULL, error_code = NULL WHERE id = ?").run(source.id);
      ctx.afterCommit(() => ctx.stt?.cancel(source.id));
    });
    ctx.publish('source.updated', project.id, () => ({ source: sourceJson(ctx, getSourceRow(ctx, source.id), { lan: false }) }));
    return { source: sourceJson(ctx, getSourceRow(ctx, source.id), env.view(req)) };
  });

  // ---------------------------------------------------------------- transcript
  const transcriptOf = (id: number) => {
    const { source, project } = sourceOf(id);
    const t = source.status === 'transcribed' ? readTranscript(ctx, source) : null;
    if (!t) throw conflict('NOT_TRANSCRIBED', 'Video chưa được nhận dạng lời nói xong');
    return { source, project, t };
  };

  app.get(`${p}/sources/:id/transcript`, async (req) => {
    const { t } = transcriptOf(asId(req));
    const q = req.query as { from?: string; limit?: string };
    const fromIdx = q.from === undefined || q.from === '' ? 0 : /^\d+$/.test(q.from) ? Number(q.from) : NaN;
    if (!Number.isSafeInteger(fromIdx)) throw new AppError('VALIDATION_ERROR', 'Tham số from không hợp lệ', 400);
    const limit = Math.min(optionalIntParam(q.limit, 'limit') ?? 200, 500);
    return transcriptPage(t, fromIdx, limit);
  });

  app.get(`${p}/sources/:id/transcript.srt`, async (req, reply) => {
    const { project, t } = transcriptOf(asId(req));
    return reply.header('Content-Type', 'application/x-subrip; charset=utf-8').header('Content-Disposition', `attachment; filename="transcript-${project.slug}.srt"`).send(transcriptSrt(t));
  });

  app.get(`${p}/sources/:id/transcript.txt`, async (req, reply) => {
    const { project, t } = transcriptOf(asId(req));
    return reply.header('Content-Type', 'text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename="transcript-${project.slug}.txt"`).send(transcriptTxt(t));
  });

  // ---------------------------------------------------------------- AI chọn đoạn
  app.post(`${p}/projects/:id/clip-plan`, async (req, reply) => {
    const project = projectOf(asId(req));
    const body = parse(clipPlanBody, req.body ?? {});
    const jobId = await limited(env, 'plan', req, reply, () => {
      if (env.lan) assertLanQueueRoom(ctx);
      return createClipPlan(ctx, project.id, body);
    });
    return reply.code(201).send({ job: planJobJson(ctx, getJobRow(ctx, jobId), env.view(req)) });
  });

  // ---------------------------------------------------------------- clip
  app.get(`${p}/projects/:id/clips`, async (req) => {
    const project = projectOf(asId(req));
    const src = projectSource(ctx, project.id);
    const transcript = src ? readTranscript(ctx, src) : null;
    return projectClips(ctx, project.id).map((c) => clipJson(ctx, c, env.view(req), { transcript }));
  });

  app.get(`${p}/clips/:id`, async (req) => ({ clip: clipJson(ctx, clipOf(asId(req)).clip, env.view(req)) }));

  app.get(`${p}/clips/:id/cuts`, async (req) => {
    const { clip } = clipOf(asId(req));
    const rows = ctx.db.prepare('SELECT * FROM clip_cuts WHERE clip_id = ? ORDER BY version DESC').all(clip.id) as Parameters<typeof cutJson>[1][];
    return rows.map((r) => cutJson(ctx, r, env.view(req)));
  });

  app.patch(`${p}/clips/:id`, async (req, reply) => {
    const { clip } = clipOf(asId(req));
    const body = parse(patchClipBody, req.body ?? {});
    return limited(env, 'edit', req, reply, () => ({ clip: clipJson(ctx, patchClip(ctx, clip.id, body), env.view(req)) }));
  });

  app.post(`${p}/projects/:id/clips`, async (req, reply) => {
    const project = projectOf(asId(req));
    const body = parse(createClipBody, req.body ?? {});
    const row = await limited(env, 'edit', req, reply, () => createManualClip(ctx, project.id, body));
    return reply.code(201).send({ clip: clipJson(ctx, row, env.view(req)) });
  });

  app.put(`${p}/clips/:id/captions`, async (req, reply) => {
    const { clip } = clipOf(asId(req));
    const body = parse(captionsBody, req.body ?? {});
    return limited(env, 'edit', req, reply, () => ({ clip: clipJson(ctx, putCaptions(ctx, clip.id, body), env.view(req)) }));
  });

  // Xem thử một khung hình (ffmpeg + ASS thật): cùng hạn mức với sửa clip; tối đa 1 tiến trình, yêu cầu mới thay yêu cầu cũ.
  app.post(`${p}/clips/:id/preview-frame`, async (req, reply) => {
    const { clip } = clipOf(asId(req));
    const body = parse(previewBody, req.body ?? {});
    return limited(env, 'edit', req, reply, () => renderPreviewFrame(ctx, clip.id, body, { lan: env.lan }));
  });

  // ---------------------------------------------------------------- dựng
  app.post(`${p}/clips/:id/render`, async (req, reply) => {
    const { clip } = clipOf(asId(req));
    const body = parse(renderBody, req.body ?? {});
    const cut = await limited(env, 'render', req, reply, () => startClipRender(ctx, clip.id, body, { lan: env.lan }));
    return reply.code(201).send({ cut: cutJson(ctx, cut, env.view(req)) });
  });

  app.post(`${p}/clip-cuts/:id/cancel`, async (req) => {
    const cut = getCutRow(ctx, asId(req));
    projectOf(cut.project_id);
    return { cut: cutJson(ctx, cancelClipCut(ctx, cut.id), env.view(req)) };
  });

  // ---------------------------------------------------------------- tải về
  app.get(`${p}/projects/:id/clips.zip`, async (req, reply) => {
    const project = projectOf(asId(req));
    const entries = clipsZipEntries(ctx, project.id);
    if (entries.length === 0) throw notFound('clip nào đã dựng xong');
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="clips-${project.slug}.zip"`)
      .send(Readable.from(zipChunks(entries, new Date(ctx.clock.now())), { objectMode: false }));
  });

  // ---------------------------------------------------------------- trạng thái / giới hạn (bổ sung hợp đồng)
  app.get(`${p}/clip-status`, async () => ({
    ...clipLimits(ctx, env.lan),
    duration_presets: ['15_30', '30_60', '60_90', '90_180'],
    caption_presets: ['highlight', 'karaoke', 'minimal', 'none'],
    aspects: ['9:16', '1:1', '16:9', 'source'],
    reframe_modes: ['fit', 'center'],
  }));
}
