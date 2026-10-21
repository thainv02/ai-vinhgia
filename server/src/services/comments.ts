import { z } from 'zod';
import type { AppContext } from '../context.js';
import { conflict, badRequest } from '../lib/errors.js';
import { COMMENT_ACTIONS, type CommentAction, type CommentRow } from '../db/types.js';
import { approveStoryboard, approveVideo } from './approvals.js';
import { insertJob } from './jobs.js';
import { commentJson, getAsset, getComment, getScene, logEvent } from './repo.js';
import { activeJobOf, REVISABLE, statusLabel } from './rules.js';
import { transition } from './transition.js';
import { emitScene } from './scene-view.js';

export const commentBody = z.object({
  body: z.string().trim().min(1, 'nội dung comment không được rỗng').max(5000),
  timecode: z.number().min(0).max(86_400).nullable().optional(),
  action: z.enum(COMMENT_ACTIONS).default('note'),
  asset_id: z.number().int().nullable().optional(),
});
export type CommentInput = z.infer<typeof commentBody>;

/**
 * Tạo comment. Với người dùng, `action` có tác dụng phụ (trong CÙNG transaction, nếu lỗi thì comment cũng không được lưu):
 *  - note: chỉ lưu
 *  - revise_and_regenerate: cảnh → needs_revision + job revise_prompt (KHÔNG tạo job video)
 *  - regenerate_same: approveVideo (kiểm tra credit/lượt)
 *  - regenerate_storyboard: approveStoryboard
 * Comment của Claude (author='claude') luôn là ghi chú, không có tác dụng phụ.
 */
export function createComment(ctx: AppContext, sceneId: number, input: CommentInput, author: 'user' | 'claude') {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    if (input.asset_id != null) {
      const asset = getAsset(ctx, input.asset_id);
      if (asset.scene_id !== scene.id) throw badRequest('INVALID_ASSET', 'Asset không thuộc cảnh này');
    }
    const action: CommentAction = author === 'user' ? input.action : 'note';
    let jobId: number | null = null;

    if (action === 'revise_and_regenerate') {
      if (activeJobOf(ctx, scene.id)) {
        throw conflict('JOB_ACTIVE', `Cảnh ${scene.code} đang có job chạy; hãy đợi hoặc hủy job đó trước`);
      }
      if (!REVISABLE.includes(scene.status)) {
        throw conflict('INVALID_STATE', `Cảnh ${scene.code} đang ở trạng thái ${statusLabel(scene.status)}; không thể yêu cầu sửa prompt`);
      }
    }

    const info = ctx.db
      .prepare(
        'INSERT INTO comments (scene_id, asset_id, author, body, timecode, action, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      )
      .run(scene.id, input.asset_id ?? null, author, input.body, input.timecode ?? null, action, ctx.now());
    const commentId = Number(info.lastInsertRowid);

    if (action === 'revise_and_regenerate') {
      transition(ctx, scene.id, 'needs_revision', 'comment yêu cầu sửa prompt');
      jobId = insertJob(ctx, {
        project_id: scene.project_id,
        scene_id: scene.id,
        type: 'revise_prompt',
        requires_approval: false,
        approved: false,
      });
    } else if (action === 'regenerate_same') {
      jobId = approveVideo(ctx, scene.id).jobId;
    } else if (action === 'regenerate_storyboard') {
      jobId = approveStoryboard(ctx, scene.id).jobId;
    }

    logEvent(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'comment.created',
      message: `${scene.code}: ${author === 'user' ? 'Người dùng' : 'Claude'} comment${action !== 'note' ? ` [${action}]` : ''}: ${input.body.slice(0, 120)}`,
    });
    ctx.publish('comment.created', scene.project_id, () => ({ comment: commentJson(getComment(ctx, commentId)) }));
    emitScene(ctx, scene.id, scene.project_id);
    return { commentId, jobId };
  });
}

/** Đánh dấu comment đã xử lý / chưa xử lý. */
export function setCommentResolved(ctx: AppContext, id: number, resolved: boolean): CommentRow {
  return ctx.tx(() => {
    const c = getComment(ctx, id);
    ctx.db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
    const scene = getScene(ctx, c.scene_id);
    ctx.publish('comment.updated', scene.project_id, () => ({ comment: commentJson(getComment(ctx, id)) }));
    emitScene(ctx, scene.id, scene.project_id);
    return getComment(ctx, id);
  });
}
