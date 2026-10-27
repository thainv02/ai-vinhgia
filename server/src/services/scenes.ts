import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../lib/errors.js';
import type { SceneRow } from '../db/types.js';
import { maybeAutoFinalCut } from './final-cuts.js';
import { insertJob } from './jobs.js';
import { nextStoryboardAttempt } from './payload.js';
import { emitBudget, getAsset, getProject, getScene, logEvent } from './repo.js';
import { PROMPT_EDITABLE, activeJobOf, hasAsset, statusLabel } from './rules.js';
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

/** Số thứ tự cảnh suy ra từ mã AI hay đặt (C1, c01, scene_01, Scene 1, S1, 01, 1…); null nếu không đọc được. */
function sceneNumber(code: string): number | null {
  const m = /^\s*(?:c|clip|canh|scene|s)?[\s_\-#.]*0*(\d{1,3})\s*$/i.exec(code);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Chuẩn hóa mã cảnh của dự án LAN về dạng `C1, C2, …` theo THỨ TỰ ĐẦU VÀO. Cách làm an toàn, xác định và không mất cảnh:
 * 1. mọi mã đọc được số thứ tự và các số khác nhau → `C<số>` (scene_01 → C1, giữ khoảng trống nếu AI bỏ số);
 * 2. có mã không đọc được (vd "intro") hoặc hai mã trùng số (scene_01 và scene-1) → đánh số lại C1..Cn theo order_index
 *    (hòa thì theo vị trí trong mảng). Không bao giờ ném lỗi và không bao giờ để hai cảnh cùng mã.
 */
export function normalizeSceneCodes(scenes: { code: string; order_index?: number }[]): string[] {
  const mapped = scenes.map((s) => {
    const n = sceneNumber(s.code);
    return n === null ? null : `C${n}`;
  });
  if (mapped.every((c): c is string => c !== null) && new Set(mapped).size === mapped.length) return mapped;
  const out: string[] = new Array(scenes.length);
  scenes
    .map((s, i) => ({ i, o: s.order_index ?? i }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .forEach((x, rank) => {
      out[x.i] = `C${rank + 1}`;
    });
  return out;
}

/** Cảnh chỉ mới là kế hoạch (chưa ai duyệt/tạo gì): an toàn để thay khi phân tích lại dự án LAN. */
const PLAN_ONLY = new Set(['draft', 'prompt_ready', 'awaiting_approval']);

/**
 * Worker tạo/cập nhật hàng loạt cảnh sau analyze_brief. Upsert theo (project_id, code).
 * Cảnh mới hoặc prompt đổi → thêm scene_prompt_versions (created_by='claude');
 * cảnh mới đi draft → prompt_ready → awaiting_approval (hoặc → storyboard_queued nếu REQUIRE_PROMPT_APPROVAL=false).
 */
export function upsertScenes(ctx: AppContext, input: UpsertScenesBody, actor: 'claude' | 'agent' = 'claude') {
  return ctx.tx(() => {
    const project = getProject(ctx, input.project_id);
    // Dự án LAN: mã cảnh luôn là C1, C2, … (managed worker từng trả scene_01).
    const renamed: { from: string; to: string }[] = [];
    let body = input;
    if (project.source === 'lan') {
      const codes = normalizeSceneCodes(input.scenes);
      body = { ...input, scenes: input.scenes.map((s, i) => ({ ...s, code: codes[i]! })) };
      input.scenes.forEach((s, i) => {
        if (s.code !== codes[i]) renamed.push({ from: s.code, to: codes[i]! });
      });
      if (renamed.length) {
        logEvent(ctx, { project_id: project.id, type: 'scene.codes_normalized', message: `Chuẩn hóa mã cảnh: ${renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}` });
      }
    }
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
        // Dự án LAN chỉ lập kế hoạch: KHÔNG BAO GIỜ tự tạo job storyboard, kể cả khi REQUIRE_PROMPT_APPROVAL=false.
        if (ctx.config.requirePromptApproval || project.source === 'lan') {
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

    // Dự án LAN phân tích lại: cảnh cũ không còn trong kết quả mới và chỉ mới là kế hoạch (chưa có job/duyệt) thì bỏ, để trang
    // kế hoạch khớp với lần phân tích mới nhất. Cảnh đã được chủ máy duyệt/sản xuất luôn được giữ.
    const pruned: string[] = [];
    if (project.source === 'lan') {
      const keep = new Set(body.scenes.map((s) => s.code));
      const old = ctx.db.prepare('SELECT * FROM scenes WHERE project_id = ?').all(project.id) as SceneRow[];
      for (const o of old) {
        // Cảnh đã có video người dùng LAN tải lên cũng được giữ (không xoá mất video của họ khi phân tích lại).
        if (keep.has(o.code) || !PLAN_ONLY.has(o.status) || activeJobOf(ctx, o.id) || hasAsset(ctx, o.id, 'video')) continue;
        ctx.db.prepare('DELETE FROM scenes WHERE id = ?').run(o.id);
        pruned.push(o.code);
      }
      if (pruned.length) {
        logEvent(ctx, { project_id: project.id, type: 'scene.pruned', message: `Phân tích lại: bỏ cảnh không còn trong kế hoạch mới (${pruned.join(', ')})` });
        emitBudget(ctx, project.id); // SSE budget.updated làm web tải lại danh sách cảnh
      }
    }
    return { created, updated, skipped, sceneIds: ids, renamed, pruned };
  });
}
