/**
 * Danh sách model của API AI (dùng chung cho Cài đặt và Video HTML), registry năng lực đã kiểm chứng và chính sách model của job `html_compose`.
 * Key chỉ dùng phía server: không vào payload/prompt/log/client. `/models` chỉ xác nhận ID tồn tại; năng lực (vision/code…) chỉ lấy từ registry.
 */
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { listModels } from '../../lib/ai-models.js';
import { parseJson } from '../repo.js';

export { fetchModels, listModels, clearModelCache, MODELS_TTL_MS } from '../../lib/ai-models.js';

// ---------------------------------------------------------------- registry năng lực

export { MODEL_PROFILES, profileOf, type ModelProfile } from '../../lib/ai-routing.js';
import { profileOf } from '../../lib/ai-routing.js';

// ---------------------------------------------------------------- chính sách của Video HTML

export interface HtmlPolicy {
  /** Model viết/sửa HTML. */
  compose: string;
  /** Model xem ảnh khung hình; `null` = không có model vision hợp lệ (bỏ bước vision). */
  vision: string | null;
  reason: string;
}
/** Giá trị lưu trong snapshot khi không có vision (cột/JSON chỉ chứa chuỗi). */
export const NO_VISION = 'none';

const AUTO = 'auto';
const isAuto = (s: string | undefined) => !s || s === AUTO;

/**
 * Chọn model cho job html_compose. `choice` = lựa chọn của người dùng/dự án ('auto' hoặc ID; vision 'none' = tắt).
 * 'auto': compose = `aiModel` đã cấu hình nếu có trong danh sách (hoặc danh sách không lấy được); vision = chính compose nếu registry nói có vision,
 * không thì model đầu tiên trong danh sách mà registry xác nhận vision, không có thì null. ID cụ thể phải có trong `/models` (hoặc trong registry khi
 * danh sách không có). Ném 409 MODEL_UNAVAILABLE / 400 MODEL_NO_VISION.
 */
export async function resolveHtmlPolicy(ctx: AppContext, choice: { compose?: string; vision?: string } = {}): Promise<HtmlPolicy> {
  let list: string[] | null = null;
  let listNote = '';
  if (ctx.config.aiApiUrl && ctx.config.aiApiKey) {
    try {
      list = await listModels(ctx);
    } catch (e) {
      listNote = ` (không lấy được danh sách model: ${e instanceof AppError ? e.message : 'lỗi'})`;
    }
  }
  const exists = (id: string) => (list ? list.includes(id) : !ctx.config.aiApiUrl || !!profileOf(id) || id === ctx.config.aiModel);
  const notes: string[] = [];

  let compose: string;
  if (isAuto(choice.compose)) {
    const cfg = ctx.config.aiModel;
    if (!list || list.includes(cfg)) {
      compose = cfg;
      notes.push(`compose: model đã cấu hình ${cfg}`);
    } else {
      const alt = list.find((id) => profileOf(id)?.code);
      if (!alt) throw new AppError('MODEL_UNAVAILABLE', `Model ${cfg} không có trong danh sách của API AI và chưa có model nào được kiểm chứng để thay thế`, 409);
      compose = alt;
      notes.push(`compose: ${cfg} không khả dụng, dùng ${alt}`);
    }
  } else {
    compose = choice.compose!;
    if (!exists(compose)) throw new AppError('MODEL_UNAVAILABLE', `Model "${compose}" không có trong danh sách của API AI`, 409);
    notes.push(`compose: người dùng chọn ${compose}`);
  }

  let vision: string | null;
  if (choice.vision === NO_VISION) {
    vision = null;
    notes.push('vision: tắt');
  } else if (isAuto(choice.vision)) {
    if (profileOf(compose)?.vision) vision = compose;
    else vision = (list ?? []).find((id) => profileOf(id)?.vision) ?? null;
    notes.push(vision ? `vision: ${vision}` : 'vision: không có model vision đã kiểm chứng, bỏ bước xem ảnh');
  } else {
    vision = choice.vision!;
    if (!exists(vision)) throw new AppError('MODEL_UNAVAILABLE', `Model vision "${vision}" không có trong danh sách của API AI`, 409);
    if (profileOf(vision) && !profileOf(vision)!.vision) throw badRequest("MODEL_NO_VISION", `Model "${vision}" không hỗ trợ ảnh`);
    notes.push(`vision: người dùng chọn ${vision}`);
  }
  return { compose, vision, reason: notes.join('; ') + listNote };
}

/** Dạng ghi vào snapshot (`policy` của payload + `compose_policy_json`). */
export const policySnapshot = (p: HtmlPolicy): { compose: string; vision: string; reason: string } => ({ compose: p.compose, vision: p.vision ?? NO_VISION, reason: p.reason });

const SAFE_MODEL = /^[\w.:/-]{1,100}$/;

/**
 * Model dùng cho một lời gọi `/infer` của job. CHỈ job `html_compose` có override, chọn phía server theo `purpose` từ snapshot policy trong payload
 * (worker không chọn được model tùy ý). Job loại khác → `undefined` (dùng `aiModel` như cũ). Vision mà snapshot không có model → 400.
 */
export function modelForJob(job: Pick<JobRow, 'type' | 'payload'>, purpose: 'compose' | 'vision' | 'asset_vision' | undefined): string | undefined {
  if (job.type !== 'html_compose') return undefined;
  const policy = parseJson<{ policy?: { compose?: unknown; vision?: unknown } }>(job.payload, {}).policy;
  const pick = purpose === 'asset_vision' ? parseJson<{ asset_vision_model?: string }>(job.payload, {}).asset_vision_model : (purpose ?? 'compose') === 'vision' ? policy?.vision : policy?.compose;
  if (purpose === 'asset_vision' && !pick) throw new AppError('AI_INVALID_REQUEST', 'Job không yêu cầu quét ảnh', 400);
  if (pick === undefined || pick === null) return undefined;
  if (pick === NO_VISION) throw new AppError('AI_INVALID_REQUEST', 'Job này không có model vision', 400);
  if (typeof pick !== 'string' || !SAFE_MODEL.test(pick)) return undefined;
  return pick === AUTO ? undefined : pick;
}
