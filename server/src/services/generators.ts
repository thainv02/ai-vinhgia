import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { parseJson } from './repo.js';

/**
 * Dịch vụ tạo video mà người dùng chọn khi bấm «Tạo video». Lựa chọn được ghi vào payload của job
 * (`payload.generator`); worker đọc để gọi Muse2API (WORKER-MUSE.md) hoặc Flow2API (WORKER-FLOW.md).
 * Khung hình luôn 9:16 nên chỉ dùng model portrait. Flow chạy chế độ reference-to-video (prompt + ảnh).
 */
export interface VideoGenerator {
  id: string;
  provider: 'muse' | 'flow';
  model: string;
  label: string;
  duration_s: number;
  /** Số ảnh tham chiếu tối đa trong một lần tạo (ảnh sản phẩm + storyboard). */
  max_images: number;
  /** Credit Google Flow mỗi video, theo mức Flow hiển thị; null với Muse (tính theo hạn mức tài khoản). */
  flow_credits: number | null;
  note: string;
}

export const VIDEO_GENERATORS: readonly VideoGenerator[] = [
  {
    id: 'muse',
    provider: 'muse',
    model: 'muse-video',
    label: 'Muse',
    duration_s: 10,
    max_images: 4,
    flow_credits: null,
    note: '10 giây, nhận tối đa 4 ảnh. Đã chạy thật nhiều lần.',
  },
  {
    id: 'flow-veo-fast',
    provider: 'flow',
    model: 'veo-3.1-fast-r2v-8s-portrait',
    label: 'Google Flow · Veo 3.1 Fast',
    duration_s: 8,
    max_images: 3,
    flow_credits: 20,
    note: '8 giây, tối đa 3 ảnh, 20 credit Flow mỗi video.',
  },
  {
    id: 'flow-veo-lite',
    provider: 'flow',
    model: 'veo-3.1-lite-r2v-8s-portrait',
    label: 'Google Flow · Veo 3.1 Lite',
    duration_s: 8,
    max_images: 3,
    flow_credits: 10,
    note: '8 giây, tối đa 3 ảnh, 10 credit Flow mỗi video. Chất lượng thấp hơn bản Fast.',
  },
  {
    id: 'flow-omni-10s',
    provider: 'flow',
    model: 'omni-1.1-flash-10s-portrait',
    label: 'Google Flow · Omni 1.1 Flash',
    duration_s: 10,
    max_images: 3,
    flow_credits: 15,
    note: '10 giây, tối đa 3 ảnh, 15 credit Flow mỗi video. Bản dọc kèm ảnh chưa được thử thật.',
  },
];

export const DEFAULT_GENERATOR_ID = 'muse';
export const GENERATOR_IDS = VIDEO_GENERATORS.map((g) => g.id) as [string, ...string[]];

export function getGenerator(id: string): VideoGenerator {
  const g = VIDEO_GENERATORS.find((x) => x.id === id);
  if (!g) throw new AppError('VALIDATION_ERROR', `Dịch vụ tạo video không hợp lệ: ${id}`, 400);
  return g;
}

/** Id dịch vụ ghi trong payload của job; job cũ (trước khi có lựa chọn) đều do Muse tạo. */
export function generatorIdOfPayload(payload: string | null | undefined): string {
  const g = parseJson<{ generator?: unknown }>(payload ?? '{}', {}).generator;
  const id = typeof g === 'string' ? g : g && typeof g === 'object' ? (g as { id?: unknown }).id : undefined;
  return typeof id === 'string' && VIDEO_GENERATORS.some((x) => x.id === id) ? id : DEFAULT_GENERATOR_ID;
}

/** Dịch vụ của job video gần nhất của cảnh, để «tạo lại đúng prompt» dùng lại cùng dịch vụ. */
export function lastGeneratorOfScene(ctx: AppContext, sceneId: number): string {
  const row = ctx.db
    .prepare("SELECT payload FROM jobs WHERE scene_id = ? AND type = 'video' ORDER BY id DESC LIMIT 1")
    .get(sceneId) as { payload: string } | undefined;
  return row ? generatorIdOfPayload(row.payload) : DEFAULT_GENERATOR_ID;
}

/**
 * Dịch vụ tạo ảnh storyboard, chọn theo dự án (`projects.storyboard_generator`) để mọi cảnh cùng một nguồn ảnh.
 * Ảnh Google Flow (Gemini) có logo: server tự xoá logo khi worker nộp kết quả (services/storyboard-logo.ts),
 * nên ảnh mang đi tạo video là bản đã xoá logo.
 */
export interface StoryboardGenerator {
  id: string;
  provider: 'muse' | 'flow';
  model: string;
  label: string;
  max_images: number;
  /** true: server chạy bước xoá logo Gemini trên ảnh trước khi lưu storyboard. */
  remove_logo: boolean;
  note: string;
}

export const STORYBOARD_GENERATORS: readonly StoryboardGenerator[] = [
  {
    id: 'muse',
    provider: 'muse',
    model: 'muse-image',
    label: 'Muse',
    max_images: 4,
    remove_logo: false,
    note: 'Ảnh không có logo. Đã chạy thật nhiều lần.',
  },
  {
    id: 'flow-image',
    provider: 'flow',
    model: 'gemini-3.1-flash-image-portrait',
    label: 'Google Flow · Gemini 3.1 Flash Image',
    max_images: 4,
    remove_logo: true,
    note: 'Ảnh có logo Gemini; server tự xoá logo trước khi dùng tạo video. Chưa chạy thật qua autovideo.',
  },
];

export const STORYBOARD_GENERATOR_IDS = STORYBOARD_GENERATORS.map((g) => g.id) as [string, ...string[]];

export function getStoryboardGenerator(id: string | null | undefined): StoryboardGenerator {
  return STORYBOARD_GENERATORS.find((g) => g.id === id) ?? STORYBOARD_GENERATORS[0]!;
}

/** Dịch vụ storyboard ghi trong payload job (chuỗi lúc tạo job, object sau khi claim); job cũ là Muse. */
export function storyboardGeneratorOfPayload(payload: string | null | undefined): StoryboardGenerator {
  const g = parseJson<{ generator?: unknown }>(payload ?? '{}', {}).generator;
  const id = typeof g === 'string' ? g : g && typeof g === 'object' ? (g as { id?: unknown }).id : undefined;
  return getStoryboardGenerator(typeof id === 'string' ? id : null);
}
