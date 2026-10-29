/**
 * Toán kéo-thả hộp phụ đề trên khung xem thử 9:16. THUẦN (không DOM/React) để test được.
 * Mọi toạ độ của layout là tỉ lệ 0–1 của khung ĐẦU RA: `left` = mép trái, `width` = bề rộng hộp, `bottom` = khoảng cách từ đáy khung tới đáy hộp
 * (khớp `captionLayoutSchema` ở server). Khung hình thật nằm trong vùng xem (container) có thể bị letterbox, nên mọi con trỏ phải quy đổi theo
 * hình chữ nhật NỘI DUNG video chứ không theo container.
 */

export interface CaptionLayout {
  left: number;
  width: number;
  bottom: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_WIDTH = 0.25;
export const MAX_BOTTOM = 0.9;

/** Đầu ra 9:16 của bản dựng. */
export const OUT_W = 1080;
export const OUT_H = 1920;

/** Vị trí mặc định của server (căn giữa-dưới: lề ngang 60 px, MarginV 300 px trên khung 1080×1920) — dùng để vẽ hộp khi clip chưa lưu layout. */
export const DEFAULT_LAYOUT: CaptionLayout = { left: 60 / OUT_W, width: 1 - 120 / OUT_W, bottom: 300 / OUT_H };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Hình chữ nhật nội dung video (tỉ lệ `aspect` = rộng/cao) nằm giữa container theo kiểu `object-fit: contain`. */
export function contentRect(container: Size, aspect: number): Rect {
  if (!(container.w > 0) || !(container.h > 0) || !(aspect > 0)) return { x: 0, y: 0, w: Math.max(0, container.w), h: Math.max(0, container.h) };
  if (container.w / container.h > aspect) {
    const w = container.h * aspect;
    return { x: (container.w - w) / 2, y: 0, w, h: container.h };
  }
  const h = container.w / aspect;
  return { x: 0, y: (container.h - h) / 2, w: container.w, h };
}

/** Điểm (px, tương đối với container) → tỉ lệ trong khung đầu ra (0–1; góc trên-trái là 0,0), kẹp trong khung. */
export function pointToFrame(p: { x: number; y: number }, rect: Rect): { fx: number; fy: number } {
  if (!(rect.w > 0) || !(rect.h > 0)) return { fx: 0, fy: 0 };
  return { fx: clamp((p.x - rect.x) / rect.w, 0, 1), fy: clamp((p.y - rect.y) / rect.h, 0, 1) };
}

/** Kẹp layout: bề rộng ≥ 25%, hộp nằm trong khung ngang, `bottom` trong 0..0.9 và hộp (cao `boxH`, tỉ lệ khung) không vượt đỉnh khung. */
export function clampLayout(l: CaptionLayout, boxH = 0): CaptionLayout {
  const width = clamp(l.width, MIN_WIDTH, 1);
  const left = clamp(l.left, 0, 1 - width);
  const bottom = clamp(l.bottom, 0, Math.max(0, Math.min(MAX_BOTTOM, 1 - boxH)));
  return { left, width, bottom };
}

/** Kéo cả hộp: `dx`/`dy` là độ dịch của con trỏ tính theo tỉ lệ khung (dy > 0 = xuống dưới). Chiều rộng giữ nguyên. */
export function moveLayout(start: CaptionLayout, dx: number, dy: number, boxH = 0): CaptionLayout {
  return clampLayout({ left: start.left + dx, width: start.width, bottom: start.bottom - dy }, boxH);
}

/** Kéo mép trái/phải: mép đối diện đứng yên, bề rộng tối thiểu 25%, không ra ngoài khung. `bottom` giữ nguyên. */
export function resizeLayout(start: CaptionLayout, edge: 'left' | 'right', dx: number): CaptionLayout {
  const right = start.left + start.width;
  if (edge === 'left') {
    const left = clamp(start.left + dx, 0, right - MIN_WIDTH);
    return { left, width: right - left, bottom: start.bottom };
  }
  const r = clamp(right + dx, start.left + MIN_WIDTH, 1);
  return { left: start.left, width: r - start.left, bottom: start.bottom };
}

/** Cỡ chữ của hộp trên khung xem thử cao `previewH` px: cùng tỉ lệ với cỡ chữ ASS (72 px, `minimal` 60 px trên khung 1080×1920). */
export function overlayFontPx(preset: 'highlight' | 'karaoke' | 'minimal', previewH: number): number {
  return ((preset === 'minimal' ? 60 : 72) * previewH) / OUT_H;
}
