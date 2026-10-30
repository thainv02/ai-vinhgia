import { z } from 'zod';

export const WAIT_MIN_SECONDS = 5;
export const WAIT_MAX_SECONDS = 60;

export const definitions = [
  ['browser_open', 'Mở ChatGPT (job storyboard) hoặc Google Flow (job video); không mở trang khác hay site của loại job kia.', { url: { type: 'string' } }, ['url']],
  ['browser_select', 'Chọn tab có sẵn theo chỉ số từ snapshot (đúng site của job).', { tab: { type: 'integer' } }, ['tab']],
  ['browser_snapshot', 'Đọc trang hiện tại và ảnh screenshot; lấy ref mới trước mỗi thao tác.', {}, []],
  ['browser_click', 'Bấm điều khiển UI không gửi/tạo nội dung (mở menu, chọn cài đặt, mở menu Download). Nút gửi/tạo phải dùng browser_submit.', { ref: { type: 'integer' } }, ['ref']],
  ['browser_submit', 'Gửi prompt/tạo nội dung đúng một lần cho job; có kiểm tra cứng (upload đủ, cài đặt, credit, prompt) và action journal. Lỗi PRECHECK_FAILED nghĩa là chưa bấm gì.', { ref: { type: 'integer' } }, ['ref']],
  ['browser_fill', 'Điền prompt nguyên văn; không được nhập phím Enter để gửi.', { ref: { type: 'integer' }, text: { type: 'string' } }, ['ref', 'text']],
  ['browser_upload', 'Upload đúng file trong payload.upload_files, đúng thứ tự (có thể từng file một). Không upload file output của job.', { ref: { type: 'integer' }, files: { type: 'array', items: { type: 'string' } } }, ['ref', 'files']],
  ['browser_download', 'Bấm nút/mục tải asset hoàn chỉnh (Download, hoặc mục 720p Original); lưu theo output path của job. Không chọn 1080p/4K/upscale/GIF.', { ref: { type: 'integer' } }, ['ref']],
  ['browser_wait', `Chờ ${WAIT_MIN_SECONDS}-${WAIT_MAX_SECONDS} giây (có heartbeat, không tốn lượt inference trong lúc chờ). Dùng khi ChatGPT/Flow đang tạo, rồi browser_snapshot lại.`, { seconds: { type: 'integer', minimum: WAIT_MIN_SECONDS, maximum: WAIT_MAX_SECONDS } }, ['seconds']],
] as const;

export const tools = definitions.map(([name, description, properties, required]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }));

export const toolArgs = z.object({
  ref: z.number().int().min(0).optional(), tab: z.number().int().min(0).optional(), text: z.string().max(50000).optional(),
  url: z.string().url().optional(), files: z.array(z.string()).max(20).optional(), seconds: z.number().int().optional(),
});
export const isToolName = (name: string) => definitions.some(([n]) => n === name);
