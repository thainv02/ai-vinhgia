/**
 * Snapshot chính sách model + dữ liệu bổ sung cho payload job `html_compose` (plan mục 3 và 6.1). Gọi từ route compose/revise (async: có gọi `/models`)
 * rồi truyền vào `createComposingVersion` (đồng bộ, trong transaction). Đổi cài đặt sau đó chỉ ảnh hưởng job mới.
 */
import type { AppContext } from '../../context.js';
import { policySnapshot, resolveHtmlPolicy } from '../ai/models.js';
import { parseJson } from '../repo.js';
import { projectAssets, projectMeta } from './repo.js';
import { assertImageLabels } from './image-review.js';
import { BASE_CANVAS, instantiateTemplate } from './templates.js';
import type { ModelPolicy } from './versions.js';

export interface ComposeExtras {
  policy: ModelPolicy;
  payload: Record<string, unknown>;
}

/** `choice` = lựa chọn model của request (ghi đè lựa chọn lưu ở dự án). Ném 409 MODEL_UNAVAILABLE nếu model không khả dụng. */
export async function composeExtras(ctx: AppContext, projectId: number, choice: { compose?: string; vision?: string } = {}): Promise<ComposeExtras> {
  const meta = projectMeta(ctx, projectId);
  const stored = parseJson<{ compose?: string; vision?: string }>(meta.model_json, {});
  const policy = policySnapshot(await resolveHtmlPolicy(ctx, { compose: choice.compose ?? stored.compose, vision: choice.vision ?? stored.vision }));
  const images = projectAssets(ctx, projectId).filter((a) => a.kind === 'image' && !a.description_json);
  assertImageLabels(ctx, projectId);
  let assetVision: string | null = null;
  try { if (images.length) assetVision = (await resolveHtmlPolicy(ctx, { compose: policy.compose, vision: 'auto' })).vision; }
  catch { /* Không chặn tạo job: ảnh không quét được chuyển sang bước gán nhãn. */ }
  const tpl = meta.template_id ? instantiateTemplate(meta.template_id, { aspect: meta.aspect, durationS: meta.duration_s }) : null;
  return {
    policy,
    payload: {
      asset_vision_model: assetVision,
      base_canvas: BASE_CANVAS[meta.aspect],
      template: tpl ? { id: tpl.meta.id, label: tpl.meta.label, variables: tpl.meta.variables, files: tpl.files } : null,
    },
  };
}
