import { describe, expect, it } from 'vitest';
import { alignWords, pickFastModel } from '../src/services/clips/transcript-fix.js';

const w = (text: string, t0 = 0, step = 0.5) => text.split(' ').map((x, k) => ({ w: x, start: t0 + k * step, end: t0 + k * step + 0.4, p: 0.9 }));

describe('chuẩn hoá chính tả bằng AI: ghép lại mốc thời gian', () => {
  it('chỉ thêm dấu câu/viết hoa: giữ nguyên mốc từng từ, không tính là sửa', () => {
    const orig = w('chào mọi người hôm nay');
    const r = alignWords(orig, 'Chào mọi người, hôm nay');
    expect(r.changed).toBe(0);
    expect(r.words.map((x) => x.w)).toEqual(['Chào', 'mọi', 'người,', 'hôm', 'nay']);
    expect(r.words.map((x) => [x.start, x.end])).toEqual(orig.map((x) => [x.start, x.end]));
  });

  it('sửa một từ: từ mới lấy mốc của từ gốc', () => {
    const orig = w('cao gan ác ti sô tốt');
    const r = alignWords(orig, 'cao gan Actiso tốt');
    expect(r.words.map((x) => x.w)).toEqual(['cao', 'gan', 'Actiso', 'tốt']);
    const actiso = r.words[2]!;
    expect(actiso.start).toBe(orig[2]!.start);
    expect(actiso.end).toBe(orig[4]!.end);
    expect(r.words[3]).toMatchObject({ start: orig[5]!.start, end: orig[5]!.end });
    expect(r.changed).toBe(3);
  });

  it('một từ gốc thành hai từ: chia thời gian theo độ dài chữ, liền mạch', () => {
    const orig = w('uống vitaminc mỗi ngày');
    const r = alignWords(orig, 'uống vitamin C mỗi ngày');
    const [a, b] = [r.words[1]!, r.words[2]!];
    expect(a.start).toBe(orig[1]!.start);
    expect(a.end).toBe(b.start);
    expect(b.end).toBe(orig[1]!.end);
    expect(a.end - a.start).toBeGreaterThan(b.end - b.start);
  });

  it('bỏ từ: từ còn lại giữ mốc', () => {
    const orig = w('sản phẩm phẩm này');
    const r = alignWords(orig, 'sản phẩm này');
    expect(r.words.map((x) => x.w)).toEqual(['sản', 'phẩm', 'này']);
    expect(r.words[2]).toMatchObject({ start: orig[3]!.start });
  });
});

describe('chọn model nhẹ', () => {
  const ids = ['claude-sonnet-4-6', 'claude-opus-4-1', 'claude-haiku-4-5', 'gpt-4.1-mini'];
  it('ưu tiên AI_FAST_MODEL nếu có trong danh sách, không thì tự chọn theo tên, cuối cùng là AI_MODEL', () => {
    expect(pickFastModel(ids, 'gpt-4.1-mini', 'claude-sonnet-4-6')).toBe('gpt-4.1-mini');
    expect(pickFastModel(ids, 'khong-co', 'claude-sonnet-4-6')).toBe('claude-haiku-4-5');
    expect(pickFastModel(ids, '', 'claude-sonnet-4-6')).toBe('claude-haiku-4-5');
    expect(pickFastModel(['claude-sonnet-4-6', 'gemini-2.5-flash'], '', 'claude-sonnet-4-6')).toBe('gemini-2.5-flash');
    expect(pickFastModel(['claude-sonnet-4-6'], '', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(pickFastModel(null, '', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});
