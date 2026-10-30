import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, MIN_WIDTH, clampLayout, contentRect, moveLayout, overlayFontPx, pointToFrame, resizeLayout } from '../../web/src/clips/subtitleBox.js';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('contentRect: vùng nội dung video trong container (object-fit: contain)', () => {
  it('container đúng tỉ lệ thì phủ kín', () => {
    expect(contentRect({ w: 360, h: 640 }, 9 / 16)).toEqual({ x: 0, y: 0, w: 360, h: 640 });
  });
  it('container rộng hơn video (toàn màn hình ngang): letterbox hai bên', () => {
    const r = contentRect({ w: 1920, h: 1080 }, 9 / 16);
    close(r.w, 607.5);
    close(r.h, 1080);
    close(r.x, (1920 - 607.5) / 2);
    expect(r.y).toBe(0);
  });
  it('container hẹp hơn video: letterbox trên dưới', () => {
    const r = contentRect({ w: 300, h: 900 }, 9 / 16);
    close(r.w, 300);
    close(r.h, 300 * (16 / 9));
    expect(r.x).toBe(0);
    close(r.y, (900 - 300 * (16 / 9)) / 2);
  });
  it('kích thước 0 hoặc tỉ lệ 0 không ném lỗi và không cho NaN', () => {
    expect(contentRect({ w: 0, h: 0 }, 9 / 16)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(contentRect({ w: 100, h: 100 }, 0)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe('pointToFrame: con trỏ thành tỉ lệ khung (đã trừ letterbox, kẹp trong khung)', () => {
  const rect = contentRect({ w: 1000, h: 500 }, 9 / 16);
  it('góc và tâm của nội dung', () => {
    expect(pointToFrame({ x: rect.x, y: 0 }, rect)).toEqual({ fx: 0, fy: 0 });
    const c = pointToFrame({ x: rect.x + rect.w / 2, y: 250 }, rect);
    close(c.fx, 0.5);
    close(c.fy, 0.5);
  });
  it('con trỏ nằm trong dải letterbox bị kẹp về mép khung', () => {
    expect(pointToFrame({ x: 5, y: -20 }, rect)).toEqual({ fx: 0, fy: 0 });
    expect(pointToFrame({ x: 990, y: 900 }, rect)).toEqual({ fx: 1, fy: 1 });
  });
  it('rect rỗng không cho NaN', () => {
    expect(pointToFrame({ x: 10, y: 10 }, { x: 0, y: 0, w: 0, h: 0 })).toEqual({ fx: 0, fy: 0 });
  });
});

describe('moveLayout', () => {
  const l = { left: 0.2, width: 0.5, bottom: 0.3 };
  it('dịch theo con trỏ; kéo xuống (dy > 0) thì bottom giảm', () => {
    const m = moveLayout(l, 0.1, 0.1);
    close(m.left, 0.3);
    close(m.bottom, 0.2);
    expect(m.width).toBe(0.5);
  });
  it('kẹp trong khung: không ra trái/phải, không xuống dưới đáy, không quá 0.9 và không vượt đỉnh', () => {
    expect(moveLayout(l, -5, 5).left).toBe(0);
    expect(moveLayout(l, -5, 5).bottom).toBe(0);
    close(moveLayout(l, 5, -5).left, 0.5);
    expect(moveLayout(l, 0, -5).bottom).toBe(0.9);
    close(moveLayout(l, 0, -5, 0.2).bottom, 0.8);
  });
});

describe('resizeLayout: kéo mép', () => {
  const l = { left: 0.2, width: 0.5, bottom: 0.3 };
  it('mép phải: mép trái đứng yên', () => {
    const r = resizeLayout(l, 'right', 0.1);
    close(r.left, 0.2);
    close(r.width, 0.6);
  });
  it('mép trái: mép phải đứng yên', () => {
    const r = resizeLayout(l, 'left', -0.1);
    close(r.left, 0.1);
    close(r.left + r.width, 0.7);
  });
  it('tối thiểu 25% khi kéo mép qua mép đối diện', () => {
    const a = resizeLayout(l, 'right', -5);
    close(a.width, MIN_WIDTH);
    close(a.left, 0.2);
    const b = resizeLayout(l, 'left', 5);
    close(b.width, MIN_WIDTH);
    close(b.left + b.width, 0.7);
  });
  it('không ra ngoài khung và giữ nguyên bottom', () => {
    const r = resizeLayout(l, 'right', 5);
    close(r.left + r.width, 1);
    expect(resizeLayout(l, 'left', -5).left).toBe(0);
    expect(resizeLayout(l, 'left', -5).bottom).toBe(0.3);
  });
});

describe('khác', () => {
  it('clampLayout kéo giá trị lạ về khoảng hợp lệ của server', () => {
    expect(clampLayout({ left: 2, width: 3, bottom: 9 })).toEqual({ left: 0, width: 1, bottom: 0.9 });
    expect(clampLayout({ left: 0.9, width: 0.1, bottom: -1 })).toEqual({ left: 0.75, width: 0.25, bottom: 0 });
  });
  it('layout mặc định khớp lề mặc định của ASS (60 px mỗi bên, MarginV 300 trên 1080x1920)', () => {
    close(DEFAULT_LAYOUT.left * 1080, 60);
    close((1 - DEFAULT_LAYOUT.left - DEFAULT_LAYOUT.width) * 1080, 60);
    close(DEFAULT_LAYOUT.bottom * 1920, 300);
  });
  it('cỡ chữ overlay tỉ lệ theo chiều cao khung xem thử', () => {
    close(overlayFontPx('highlight', 1920), 72);
    close(overlayFontPx('karaoke', 960), 36);
    close(overlayFontPx('minimal', 640), 20);
  });
});
