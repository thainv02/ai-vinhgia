import { runWorker } from './loop.js';

/**
 * Worker AI của app desktop: nhận các job văn bản/ảnh (phân tích, chọn điểm cắt, chọn clip, Video HTML). Server luôn chạy file này làm tiến trình con (xem server/src/services/embedded-worker.ts).
 */
const TEXT_TYPES = 'analyze_brief,revise_prompt,edit_plan,clip_plan,html_compose';

await runWorker({
  types: process.env.WORKER_TYPES ?? TEXT_TYPES,
});
