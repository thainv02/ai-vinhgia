import { describe, expect, it } from 'vitest';
import { HARD_BREAK_GAP_S, assTime, assMetrics, buildAss, buildClipSrt, displayWords, escapeAssText, groupWords, lineBreakIndex, type CapWord } from '../src/services/clips/captions.js';
import { buildTranscript } from '../src/services/clips/transcript.js';
import { speechWords, verboseOf } from './helpers-clips.js';

const w = (text: string, start: number, end = start + 0.3): CapWord => ({ w: text, start, end });
const seq = (texts: string[], step = 0.4, t0 = 0): CapWord[] => texts.map((t, k) => w(t, t0 + k * step, t0 + k * step + 0.35));

describe('chia cụm phụ đề', () => {
  it('highlight/karaoke: cụm 3 từ', () => {
    const g = groupWords(seq(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'highlight');
    expect(g.map((x) => x.map((y) => y.w))).toEqual([['a', 'b', 'c'], ['d', 'e', 'f'], ['g']]);
    expect(groupWords(seq(['a', 'b', 'c', 'd']), 'karaoke').map((x) => x.length)).toEqual([3, 1]);
  });
  it('ngắt cứng ở khoảng lặng ≥ 0.6 s, KHÔNG ngắt ở 0.59 s', () => {
    const hard = [w('a', 0), w('b', 0.3 + HARD_BREAK_GAP_S), w('c', 1.3)];
    expect(groupWords(hard, 'highlight').map((x) => x.length)).toEqual([1, 2]);
    const near = [w('a', 0), w('b', 0.3 + 0.59), w('c', 1.3)];
    expect(groupWords(near, 'highlight').map((x) => x.length)).toEqual([3]);
  });
  it('ngắt mềm ở dấu phẩy hoặc khoảng lặng ≥ 0.35 s (cụm ≥ 2 từ)', () => {
    expect(groupWords([w('xin', 0), w('chào,', 0.4), w('cả', 0.8), w('nhà', 1.2)], 'highlight').map((x) => x.map((y) => y.w))).toEqual([['xin', 'chào,'], ['cả', 'nhà']]);
    const gap = [w('a', 0, 0.2), w('b', 0.3, 0.5), w('c', 0.9, 1.1), w('d', 1.2, 1.4)]; // lặng 0.4 giữa b và c
    expect(groupWords(gap, 'highlight').map((x) => x.map((y) => y.w))).toEqual([['a', 'b'], ['c', 'd']]);
    // một từ đứng riêng trước ngắt mềm thì KHÔNG ngắt (tránh cụm 1 từ)
    expect(groupWords([w('a', 0, 0.2), w('b', 0.65, 0.9), w('c', 1.0, 1.2)], 'highlight').map((x) => x.length)).toEqual([3]);
  });
  it('minimal: ≤ 8 từ, ≤ 42 ký tự, ≤ 3.2 giây', () => {
    const nine = groupWords(seq(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 0.2), 'minimal');
    expect(nine.map((x) => x.length)).toEqual([8, 1]);
    const long = groupWords(seq(['abcdefghij', 'abcdefghij', 'abcdefghij', 'abcdefghij', 'abcdefghij'], 0.2), 'minimal');
    expect(long.map((x) => x.length)).toEqual([3, 2]); // 4 từ = 43 ký tự > 42 nên cụm đầu chỉ có 3 từ (32 ký tự)
  });
  it('minimal: giới hạn 3.2 giây', () => {
    const slow = groupWords(seq(['a', 'b', 'c', 'd', 'e', 'f'], 0.8), 'minimal');
    for (const g of slow) expect(g[g.length - 1]!.end - g[0]!.start).toBeLessThanOrEqual(3.2 + 1e-9);
    expect(slow.length).toBeGreaterThan(1);
  });
});

describe('displayWords: chữ hiển thị', () => {
  const t = buildTranscript(verboseOf(speechWords(['xin chào cả nhà', 'giảm giá sốc'], { gap: 1 })));
  it('không có chữ đã sửa: dùng chữ ASR, viết hoa chữ đầu clip và đầu câu', () => {
    const d = displayWords(t, 0, 6, null);
    expect(d.map((x) => x.w)).toEqual(['Xin', 'chào', 'cả', 'nhà', 'Giảm', 'giá', 'sốc']);
    const mid = displayWords(t, 2, 6, null);
    expect(mid[0]!.w).toBe('Cả'); // đầu clip luôn viết hoa
  });
  it('có chữ đã sửa/khôi phục: dùng đúng chữ đó; "ca cao a tiso" → "Cacao" kéo dài qua các từ ẩn', () => {
    const t2 = buildTranscript(verboseOf([{ word: 'ca', start: 1, end: 1.3 }, { word: 'cao', start: 1.3, end: 1.6 }, { word: 'a', start: 1.6, end: 1.8 }, { word: 'tiso', start: 1.8, end: 2.2 }, { word: 'ngon', start: 2.3, end: 2.6 }]));
    const d = displayWords(t2, 0, 4, [{ i: 0, w: 'Cacao' }, { i: 1, w: '' }, { i: 2, w: 'Actiso' }, { i: 3, w: '' }, { i: 4, w: 'ngon!' }]);
    expect(d.map((x) => [x.w, x.start, x.end])).toEqual([['Cacao', 1, 1.6], ['Actiso', 1.6, 2.2], ['ngon!', 2.3, 2.6]]);
  });
});

describe('ASS', () => {
  const words = seq(['Xin', 'chào', 'cả', 'nhà', 'hôm', 'nay'], 0.4, 10.15);
  const clipStart = 10;
  const opts = { width: 1080, height: 1920, font: 'Arial', clipStart, clipEnd: 14 } as const;
  it('tiêu đề: PlayRes 1080×1920, WrapStyle 2, alignment 2, MarginV 300, viền 8, bóng 3, font đậm', () => {
    const ass = buildAss(words, { ...opts, preset: 'highlight' });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('WrapStyle: 2');
    expect(ass).toMatch(/Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,8,3,2,60,60,300,1/);
  });
  it('highlight: MỖI TỪ một Dialogue hiển thị cả cụm, từ đang nói tô vàng; thời gian tính từ đầu clip', () => {
    const lines = buildAss(words, { ...opts, preset: 'highlight' }).split('\n').filter((l) => l.startsWith('Dialogue'));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('{\\c&H00FFFF&}Xin{\\c&HFFFFFF&} chào cả');
    expect(lines[1]).toContain('Xin {\\c&H00FFFF&}chào{\\c&HFFFFFF&} cả');
    expect(lines[2]).toContain('Xin chào {\\c&H00FFFF&}cả{\\c&HFFFFFF&}');
    expect(lines[3]).toContain('{\\c&H00FFFF&}nhà{\\c&HFFFFFF&} hôm nay');
    expect(lines[0]).toMatch(/^Dialogue: 0,0:00:00\.15,0:00:00\.55,/); // từ đầu: 10.15 − 10 = 0.15
    // mỗi Dialogue kết thúc đúng lúc từ kế bắt đầu (không nhấp nháy giữa hai từ)
    expect(lines[0]).toMatch(/,0:00:00\.55,Default/);
    expect(lines[1]).toMatch(/^Dialogue: 0,0:00:00\.55,0:00:00\.95,/);
  });
  it('karaoke tô xanh lá; minimal một Dialogue mỗi cụm, không tô', () => {
    const k = buildAss(words, { ...opts, preset: 'karaoke' });
    expect(k).toContain('{\\c&H00FF00&}Xin');
    const m = buildAss(words, { ...opts, preset: 'minimal' }).split('\n').filter((l) => l.startsWith('Dialogue'));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('Xin chào cả nhà hôm nay');
    expect(m[0]).not.toContain('\\c&H');
    expect(assMetrics(1080, 1920, 'minimal').fontSize).toBe(60);
  });
  it('escape { } \\ trong chữ do người dùng/AI nhập; xuống dòng thành khoảng trắng; không còn thẻ override giả', () => {
    expect(escapeAssText('a{\\an8}b\\Nc}d\n e')).toBe('a(/an8)b/Nc)d e');
    const evil = buildAss([w('{\\fs500}to', 10.2), w('\\N', 10.6), w('x}', 11)], { ...opts, preset: 'minimal' });
    const body = evil.split('\n').find((l) => l.startsWith('Dialogue'))!;
    expect(body).not.toMatch(/\{\\fs500/);
    expect(body.split('Default,,0,0,0,,')[1]).not.toContain('{');
    expect(body.split('Default,,0,0,0,,')[1]).not.toContain('\\N');
  });
  it('cụm dài tự xuống 2 dòng bằng \\N (WrapStyle 2 không tự xuống dòng)', () => {
    expect(lineBreakIndex(['một', 'hai', 'ba'], 22)).toBeNull();
    expect(lineBreakIndex(['xuyên', 'suốt', 'chương', 'trình', 'khuyến', 'mãi'], 14)).toBe(3);
    const longWords = seq(['Khuyến', 'mãi', 'đặc', 'biệt', 'cuối', 'tuần', 'này', 'thôi', 'nhé'], 0.2, 10.1);
    const m = buildAss(longWords, { ...opts, preset: 'minimal' }).split('\n').find((l) => l.startsWith('Dialogue'))!;
    expect(m).toContain('\\N');
  });
  it('khung 1:1 và 16:9: MarginV theo chiều cao', () => {
    expect(assMetrics(1080, 1080, 'highlight').marginV).toBe(86);
    expect(assMetrics(1920, 1080, 'highlight').marginV).toBe(86);
    expect(assMetrics(1080, 1920, 'highlight').marginV).toBe(300);
  });
  it('định dạng thời gian ASS (centigiây)', () => {
    expect(assTime(3661.239)).toBe('1:01:01.24');
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(-5)).toBe('0:00:00.00');
  });
  it('SRT cùng lúc: cụm minimal, tính từ đầu clip', () => {
    const srt = buildClipSrt(words, clipStart, 14);
    expect(srt).toBe('1\n00:00:00,150 --> 00:00:02,500\nXin chào cả nhà hôm nay\n');
  });
});
