import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { VERDICTS, VERDICT_LABEL, type AssetRow, type Verdict } from '../db/types.js';
import { appendLogRow } from './logmd.js';
import { assetJson, getAsset, getProject, getScene, logEvent } from './repo.js';
import { emitScene } from './scene-view.js';

export const verdictBody = z.object({
  verdict: z.enum(VERDICTS).nullable(),
  verdict_note: z.string().max(5000).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
});

/** Người dùng đổi/đặt kết luận (Đạt / Sửa khi dựng / Tạo lại) cho asset video hoặc storyboard. */
export function setVerdict(ctx: AppContext, assetId: number, verdict: Verdict | null, note: string | null | undefined): AssetRow {
  return ctx.tx(() => {
    const asset = getAsset(ctx, assetId);
    if (asset.kind === 'grid') throw badRequest('INVALID_ASSET', 'Chỉ đặt kết luận cho storyboard hoặc video');
    const scene = getScene(ctx, asset.scene_id);
    const project = getProject(ctx, scene.project_id);
    const newNote = note === undefined ? asset.verdict_note : note;
    ctx.db.prepare('UPDATE assets SET verdict = ?, verdict_note = ? WHERE id = ?').run(verdict, newNote, asset.id);
    logEvent(ctx, {
      project_id: scene.project_id,
      scene_id: scene.id,
      type: 'asset.verdict',
      message: `${scene.code} lượt ${asset.attempt}: kết luận ${verdict ? VERDICT_LABEL[verdict] : '(bỏ kết luận)'}`,
    });
    if (verdict) {
      appendLogRow(ctx, project.slug, {
        clip: scene.code,
        attempt: asset.attempt,
        type: `${asset.kind} (kết luận của người dùng)`,
        issue: newNote ?? '',
        conclusion: VERDICT_LABEL[verdict],
      });
    }
    ctx.publish('asset.updated', scene.project_id, () => ({ asset: assetJson(getAsset(ctx, asset.id)) }));
    emitScene(ctx, scene.id, scene.project_id);
    return getAsset(ctx, asset.id);
  });
}
