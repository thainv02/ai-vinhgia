import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { SceneRow } from '../db/types.js';
import { maybeAutoFinalCut } from './final-cuts.js';
import { insertJob } from './jobs.js';
import { nextStoryboardAttempt } from './payload.js';
import { getAsset, getProject, getScene, logEvent } from './repo.js';
import { PROMPT_EDITABLE, statusLabel } from './rules.js';
import { emitScene } from './scene-view.js';
import { transition } from './transition.js';

/** Người dùng tự sửa prompt: tạo version mới (created_by='user'). Không đổi trạng thái cảnh. */
export function editPrompt(ctx: AppContext, sceneId: number, prompt: string, reason?: string): SceneRow {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    if (!PROMPT_EDITABLE.includes(scene.status)) {
      throw conflict('INVALID_STATE', `Cảnh ${scene.code} đang ở trạng thái ${statusLabel(scene.status)}; không thể sửa prompt lúc này`);
    }
    if (prompt === scene.prompt) return scene; // không đổi gì
    const version =
      (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(scene.id) as { v: number }).v + 1;
    const now = ctx.now();
    ctx.db
      .prepare('INSERT INTO scene_prompt_versions (scene_id, version, prompt, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(scene.id, version, prompt, reason?.trim() || 'Người dùng sửa tay', 'user', now);
    ctx.db.prepare('UPDATE scenes SET prompt = ?, updated_at = ? WHERE id = ?').run(prompt, now, scene.id);
    logEvent(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'scene.prompt',
      message: `${scene.code}: người dùng sửa prompt (v${version})${reason ? ` — ${reason}` : ''}`,
    });
    emitScene(ctx, scene.id, scene.project_id);
    return getScene(ctx, scene.id);
  });
}

/** Chọn bản video chính thức. video_review → done; ở trạng thái done thì chỉ đổi video được chọn. */
export function selectVideo(ctx: AppContext, sceneId: number, assetId?: number): SceneRow {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    if (scene.status !== 'video_review' && scene.status !== 'done') {
      throw conflict('INVALID_STATE', `Cảnh ${scene.code} đang ở trạng thái ${statusLabel(scene.status)}; chỉ chọn video khi đang xem video hoặc đã hoàn tất`);
    }
    let id = assetId;
    if (id === undefined) {
      const row = ctx.db
        .prepare("SELECT id FROM assets WHERE scene_id = ? AND kind = 'video' ORDER BY id DESC LIMIT 1")
        .get(scene.id) as { id: number } | undefined;
      if (!row) throw conflict('INVALID_STATE', `Cảnh ${scene.code} chưa có video để chọn`);
      id = scene.selected_video_id ?? row.id;
    }
    const asset = getAsset(ctx, id);
    if (asset.scene_id !== scene.id || asset.kind !== 'video') throw badRequest('INVALID_ASSET', 'Asset không phải video của cảnh này');
    ctx.db.prepare('UPDATE scenes SET selected_video_id = ?, updated_at = ? WHERE id = ?').run(asset.id, ctx.now(), scene.id);
    logEvent(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'scene.video_selected',
      message: `${scene.code}: chọn video lượt ${asset.attempt} (asset #${asset.id})`,
    });
    if (scene.status === 'video_review') transition(ctx, scene.id, 'done', `người dùng chọn video lượt ${asset.attempt}`);
    else emitScene(ctx, scene.id, scene.project_id);
    // Mọi cảnh đã `done` có video được chọn → tự tạo bản dựng hoàn chỉnh + job edit_plan (idempotent theo chữ ký lựa chọn)
    maybeAutoFinalCut(ctx, scene.project_id);
    return getScene(ctx, scene.id);
  });
}

/** Đưa cảnh failed / blocked_budget về chờ duyệt (để sửa prompt hoặc duyệt lại). */
export function resetScene(ctx: AppContext, sceneId: number): SceneRow {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    if (scene.status !== 'failed' && scene.status !== 'blocked_budget') {
      throw conflict('INVALID_STATE', `Cảnh ${scene.code} đang ở trạng thái ${statusLabel(scene.status)}; chỉ đặt lại được cảnh lỗi hoặc hết hạn mức`);
    }
    return transition(ctx, scene.id, 'awaiting_approval', 'người dùng đặt lại về chờ duyệt');
  });
}

// ------------------------------------------------------------------ worker: upsert hàng loạt

const sceneInput = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/, 'mã cảnh chỉ gồm chữ, số, - và _ (tối đa 16 ký tự)'),
  order_index: z.number().int().optional(),
  title: z.string().default(''),
  prompt: z.string().min(1, 'prompt không được rỗng'),
  first_frame_desc: z.string().default(''),
  upload_refs: z.array(z.number().int()).default([]),
  use_prev_storyboard: z.boolean().default(false),
});
export const upsertScenesBody = z.object({
  project_id: z.number().int(),
  scenes: z.array(sceneInput).min(1, 'cần ít nhất một cảnh').max(100),
});
export type UpsertScenesBody = z.infer<typeof upsertScenesBody>;

const IN_FLIGHT = new Set(['storyboard_queued', 'storyboard_running', 'video_queued', 'video_running', 'needs_revision']);

/**
 * Worker tạo/cập nhật hàng loạt cảnh sau analyze_brief. Upsert theo (project_id, code).
 * Cảnh mới hoặc prompt đổi → thêm scene_prompt_versions (created_by='claude');
 * cảnh mới đi draft → prompt_ready → awaiting_approval (hoặc → storyboard_queued nếu REQUIRE_PROMPT_APPROVAL=false).
 */
export function upsertScenes(ctx: AppContext, body: UpsertScenesBody, actor: 'claude' | 'agent' = 'claude') {
  return ctx.tx(() => {
    const project = getProject(ctx, body.project_id);
    const validRefs = new Set(
      (ctx.db.prepare('SELECT id FROM project_refs WHERE project_id = ?').all(project.id) as { id: number }[]).map((r) => r.id),
    );
    const codes = new Set<string>();
    for (const s of body.scenes) {
      if (codes.has(s.code)) throw badRequest('VALIDATION_ERROR', `Mã cảnh bị lặp: ${s.code}`);
      codes.add(s.code);
      for (const r of s.upload_refs) {
        if (!validRefs.has(r)) throw badRequest('INVALID_REFS', `Cảnh ${s.code}: ảnh tham chiếu #${r} không thuộc dự án`);
      }
    }
    const now = ctx.now();
    const created: string[] = [];
    const updated: string[] = [];
    const skipped: { code: string; reason: string }[] = [];
    const ids: number[] = [];

    body.scenes.forEach((s, idx) => {
      const existing = ctx.db.prepare('SELECT * FROM scenes WHERE project_id = ? AND code = ?').get(project.id, s.code) as SceneRow | undefined;
      if (!existing) {
        const info = ctx.db
          .prepare(
            `INSERT INTO scenes (project_id, code, order_index, title, prompt, first_frame_desc, upload_refs, use_prev_storyboard, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          )
          .run(project.id, s.code, s.order_index ?? idx, s.title, s.prompt, s.first_frame_desc, JSON.stringify(s.upload_refs), s.use_prev_storyboard ? 1 : 0, now, now);
        const sceneId = Number(info.lastInsertRowid);
        ids.push(sceneId);
        ctx.db
          .prepare('INSERT INTO scene_prompt_versions (scene_id, version, prompt, reason, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?)')
          .run(sceneId, s.prompt, 'Bản đầu tiên do AI viết khi phân tích kịch bản', actor, now);
        logEvent(ctx, { project_id: project.id, scene_id: sceneId, type: 'scene.created', message: `${s.code}: AI tạo cảnh "${s.title}"` });
        transition(ctx, sceneId, 'prompt_ready', 'AI viết xong prompt');
        if (ctx.config.requirePromptApproval) {
          transition(ctx, sceneId, 'awaiting_approval', 'chờ người dùng duyệt prompt');
        } else {
          insertJob(ctx, {
            project_id: project.id,
            scene_id: sceneId,
            type: 'storyboard',
            requires_approval: true,
            approved: true,
            payload: { attempt: nextStoryboardAttempt(ctx, sceneId) },
          });
          transition(ctx, sceneId, 'storyboard_queued', 'REQUIRE_PROMPT_APPROVAL=false: tự tạo storyboard');
        }
        created.push(s.code);
        return;
      }

      ids.push(existing.id);
      // metadata luôn cập nhật; prompt chỉ cập nhật khi cảnh không đang xử lý
      ctx.db
        .prepare('UPDATE scenes SET order_index = ?, title = ?, first_frame_desc = ?, upload_refs = ?, use_prev_storyboard = ?, updated_at = ? WHERE id = ?')
        .run(s.order_index ?? existing.order_index, s.title, s.first_frame_desc, JSON.stringify(s.upload_refs), s.use_prev_storyboard ? 1 : 0, now, existing.id);
      if (s.prompt !== existing.prompt) {
        if (IN_FLIGHT.has(existing.status)) {
          skipped.push({ code: s.code, reason: `Cảnh đang ở trạng thái ${existing.status}; giữ nguyên prompt hiện tại` });
        } else {
          const version =
            (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(existing.id) as { v: number }).v + 1;
          ctx.db
            .prepare('INSERT INTO scene_prompt_versions (scene_id, version, prompt, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(existing.id, version, s.prompt, 'AI cập nhật prompt khi phân tích lại', actor, now);
          ctx.db.prepare('UPDATE scenes SET prompt = ? WHERE id = ?').run(s.prompt, existing.id);
          logEvent(ctx, { project_id: project.id, scene_id: existing.id, type: 'scene.prompt', message: `${s.code}: AI cập nhật prompt (v${version})` });
        }
      }
      emitScene(ctx, existing.id, project.id);
      updated.push(s.code);
    });
    return { created, updated, skipped, sceneIds: ids };
  });
}
