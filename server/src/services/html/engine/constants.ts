/** Hằng số thuần (không import config/app) — dùng được cả trong tiến trình runner. */
import type { HtmlAspect, HtmlQuality } from '../view.js';

/** Canvas gốc khi soạn (px). Xuất 720p = ×2, 1080p = ×3 (hệ số nguyên) qua `outputResolution` của producer. */
export const HTML_BASE_CANVAS: Record<HtmlAspect, { w: number; h: number }> = {
  '9:16': { w: 360, h: 640 },
  '16:9': { w: 640, h: 360 },
  '1:1': { w: 360, h: 360 },
};

/** Preset `outputResolution` của @hyperframes/core: 720p → `*-720p`, 1080p → tên trần. */
export function outputResolutionOf(aspect: HtmlAspect, quality: HtmlQuality): string {
  const o = aspect === '9:16' ? 'portrait' : aspect === '16:9' ? 'landscape' : 'square';
  return quality === '720p' ? `${o}-720p` : o;
}

/**
 * CSP của composition (spike §6): chặn mọi mạng (cả WebSocket), chỉ nội bộ + data:/blob:. `worker-src 'none'`: worker chỉ nhận CSP từ header phản hồi
 * (file-server của producer không gửi) nên phải cấm hẳn, không thì worker mở WebSocket ra ngoài được.
 */
export const HTML_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
