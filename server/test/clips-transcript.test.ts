import { describe, expect, it } from 'vitest';
import { buildClipSrt } from '../src/services/clips/captions.js';
import { buildTranscript, buildWindows, clockTime, excerptOf, normToken, sentenceOfWord, snapBounds, speechRatio, srtTime, transcriptPage, transcriptSrt, transcriptTxt, validateCaptionWords } from '../src/services/clips/transcript.js';
import { speechWords, verboseOf } from './helpers-clips.js';

const build = (words: ReturnType<typeof speechWords>, extra: Record<string, unknown> = {}) => buildTranscript({ ...verboseOf(words), ...extra } as never);

describe('transcript: chuẩn hoá và dựng câu', () => {
  it('ranh giới segment của dịch vụ và khoảng lặng ≥ 0.7 s tách câu; ID tăng dần từ 0', () => {
    const t = build(speechWords(['một hai ba', 'bốn năm', 'sáu bảy tám chín'], { gap: 1 }));
    expect(t.sentences.map((s) => s.text)).toEqual(['một hai ba', 'bốn năm', 'sáu bảy tám chín']);
    expect(t.sentences.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(t.sentences[1]).toMatchObject({ start_word: 3, end_word: 4 });
    expect(t.words.map((w) => w.i)).toEqual([...t.words.keys()]);
  });

  it('khoảng lặng 0.69 s KHÔNG tách, 0.7 s tách (khi segment của dịch vụ gộp cả hai)', () => {
    const words = [
      { word: 'a', start: 0, end: 0.4 },
      { word: 'b', start: 1.09, end: 1.5 }, // lặng 0.69
      { word: 'c', start: 2.2, end: 2.6 }, // lặng 0.70
    ];
    const t = buildTranscript({ text: 'a b c', segments: [{ id: 0, start: 0, end: 2.6, text: 'a b c' }], words });
    expect(t.sentences.map((s) => s.text)).toEqual(['a b', 'c']);
  });

  it('từ có end <= start được sửa thành start + 0.08; sắp theo thời gian', () => {
    const t = buildTranscript({ text: 'x', segments: [], words: [{ word: 'sau', start: 2, end: 2.5 }, { word: 'lỗi', start: 1, end: 1 }, { word: 'ngược', start: 1.5, end: 1.2 }] });
    expect(t.words.map((w) => w.w)).toEqual(['lỗi', 'ngược', 'sau']);
    expect(t.words[0]).toMatchObject({ start: 1, end: 1.08 });
    expect(t.words[1]).toMatchObject({ start: 1.5, end: 1.58 });
  });

  it('câu > 25 giây cắt ở khoảng lặng LỚN NHẤT bên trong; câu > 60 từ cũng cắt', () => {
    // 80 từ liền nhau (0.4 s/từ = 32 s) có đúng một chỗ lặng 0.5 s (< 0.7) ở giữa-lệch
    const words: { word: string; start: number; end: number }[] = [];
    let t0 = 0;
    for (let i = 0; i < 80; i++) {
      words.push({ word: `w${i}`, start: t0, end: t0 + 0.4 });
      t0 += 0.4 + (i === 29 ? 0.5 : 0);
    }
    const t = buildTranscript({ text: '', segments: [{ id: 0, start: 0, end: t0, text: '' }], words });
    expect(t.sentences.length).toBeGreaterThanOrEqual(2);
    expect(t.sentences[0]!.end_word).toBe(29); // cắt đúng chỗ lặng lớn nhất
    for (const s of t.sentences) {
      expect(s.end - s.start).toBeLessThanOrEqual(25 + 1e-6);
      expect(s.end_word - s.start_word + 1).toBeLessThanOrEqual(60);
    }
    // 70 từ trong 14 giây (≤ 25 s nhưng > 60 từ)
    const dense = Array.from({ length: 70 }, (_, i) => ({ word: `d${i}`, start: i * 0.2, end: i * 0.2 + 0.15 }));
    const d = buildTranscript({ text: '', segments: [{ id: 0, start: 0, end: 14, text: '' }], words: dense });
    expect(d.sentences.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...d.sentences.map((s) => s.end_word - s.start_word + 1))).toBeLessThanOrEqual(60);
  });

  it('không có words nhưng có segments → từ được suy ra theo segment; không có gì → rỗng', () => {
    const t = buildTranscript({ text: 'xin chào các bạn', segments: [{ id: 0, start: 1, end: 3, text: 'xin chào các bạn' }], words: [] });
    expect(t.words.map((w) => w.w)).toEqual(['xin', 'chào', 'các', 'bạn']);
    expect(t.words[0]!.start).toBe(1);
    expect(t.words[3]!.end).toBeCloseTo(3, 2);
    const e = buildTranscript({ text: '', segments: [], words: [] });
    expect(e.words).toEqual([]);
    expect(e.sentences).toEqual([]);
    expect(e.speech_ratio).toBe(0);
  });

  it('speech_ratio = thời gian có lời ÷ thời lượng', () => {
    expect(speechRatio([{ start: 0, end: 1 }, { start: 1.2, end: 2 }, { start: 5, end: 6 }], 10)).toBeCloseTo(0.3, 2);
    expect(speechRatio([], 10)).toBe(0);
  });

  it('sentenceOfWord tìm nhị phân đúng câu', () => {
    const t = build(speechWords(['một hai', 'ba bốn năm', 'sáu']));
    expect(sentenceOfWord(t, 0)!.id).toBe(0);
    expect(sentenceOfWord(t, 2)!.id).toBe(1);
    expect(sentenceOfWord(t, 5)!.id).toBe(2);
    expect(sentenceOfWord(t, 6)).toBeUndefined();
  });
});

describe('bám khoảng lặng: ánh xạ chỉ số từ → giây (không bao giờ lấy giây của AI)', () => {
  const t = build(speechWords(['một hai ba', 'bốn năm sáu'], { gap: 1, start: 10 }));
  it('start = đầu từ − 0.15, end = cuối từ + 0.30 khi có chỗ trống', () => {
    // câu 0: từ 0..2 (10.0–11.2); câu 1: từ 3..5 (12.2–13.4)
    const b = snapBounds(t, 3, 5);
    expect(b.start_s).toBeCloseTo(12.05, 3);
    expect(b.end_s).toBeCloseTo(13.7, 3);
  });
  it('không lùi quá end của từ trước + 0.02 và không quá start của từ sau − 0.02', () => {
    const tight = buildTranscript({ text: '', segments: [], words: [{ word: 'a', start: 1, end: 1.9 }, { word: 'b', start: 2, end: 2.5 }, { word: 'c', start: 2.6, end: 3 }] });
    const b = snapBounds(tight, 1, 1);
    expect(b.start_s).toBeCloseTo(1.92, 3); // từ trước kết thúc 1.9 → 1.92 (không phải 1.85)
    expect(b.end_s).toBeCloseTo(2.58, 3); // từ sau bắt đầu 2.6 → 2.58 (không phải 2.8)
  });
  it('từ trước chồng lên từ đầu → không đẩy start ra sau từ đầu; end không vượt thời lượng video', () => {
    const o = buildTranscript({ text: '', segments: [], words: [{ word: 'a', start: 1, end: 2.2 }, { word: 'b', start: 2, end: 3 }], duration: 3.1 } as never);
    expect(snapBounds(o, 1, 1).start_s).toBeLessThanOrEqual(2);
    expect(snapBounds(o, 1, 1).end_s).toBeLessThanOrEqual(3.1);
    expect(snapBounds(o, 1, 1).end_s).toBeGreaterThanOrEqual(3);
  });
  it('chỉ số sai → RangeError', () => {
    expect(() => snapBounds(t, 3, 2)).toThrow(RangeError);
    expect(() => snapBounds(t, 0, 99)).toThrow(RangeError);
  });
});

describe('cửa sổ cho AI (theo ID câu)', () => {
  const longSentences = (minutes: number) => {
    // mỗi câu 10 giây, cách 0 → số câu = minutes*6
    return Array.from({ length: minutes * 6 }, (_, i) => ({ id: i, start: i * 10, end: i * 10 + 9.5 }));
  };
  it('video ≤ 20 phút: một cửa sổ', () => {
    expect(buildWindows(longSentences(15))).toEqual([{ from_id: 0, to_id: 89 }]);
    expect(buildWindows([])).toEqual([]);
  });
  it('video 60 phút: cửa sổ ≤ 20 phút, chồng ~60 giây, phủ mọi câu, ID tuyệt đối tăng dần', () => {
    const s = longSentences(60);
    const w = buildWindows(s);
    expect(w.length).toBeGreaterThanOrEqual(3);
    expect(w[0]!.from_id).toBe(0);
    expect(w[w.length - 1]!.to_id).toBe(s.length - 1);
    for (let i = 0; i < w.length; i++) {
      const span = s[w[i]!.to_id]!.end - s[w[i]!.from_id]!.start;
      expect(span).toBeLessThanOrEqual(23 * 60);
      if (i > 0) {
        expect(w[i]!.from_id).toBeGreaterThan(w[i - 1]!.from_id);
        expect(w[i]!.from_id).toBeLessThanOrEqual(w[i - 1]!.to_id); // có chồng
        const overlapS = s[w[i - 1]!.to_id]!.end - s[w[i]!.from_id]!.start;
        expect(overlapS).toBeGreaterThanOrEqual(55);
        expect(overlapS).toBeLessThanOrEqual(80);
      }
    }
    const covered = new Set<number>();
    for (const x of w) for (let id = x.from_id; id <= x.to_id; id++) covered.add(id);
    expect(covered.size).toBe(s.length);
  });
});

describe('xuất SRT / TXT / trang', () => {
  const t = build(speechWords(['xin chào cả nhà', 'giảm giá sốc'], { gap: 1, start: 3661.5 }));
  it('định dạng thời gian', () => {
    expect(srtTime(3661.5)).toBe('01:01:01,500');
    expect(srtTime(0.0004)).toBe('00:00:00,000');
    expect(clockTime(3661.9)).toBe('01:01:01');
  });
  it('SRT viết hoa chữ đầu câu, TXT có mốc [hh:mm:ss]', () => {
    expect(transcriptSrt(t)).toContain('1\n01:01:01,500 --> 01:01:03,100\nXin chào cả nhà\n');
    expect(transcriptTxt(t)).toBe('[01:01:01] Xin chào cả nhà\n[01:01:04] Giảm giá sốc\n');
  });
  it('trang phân theo câu kèm từ', () => {
    const p = transcriptPage(t, 1, 5);
    expect(p.total).toBe(2);
    expect(p.sentences).toHaveLength(1);
    expect(p.sentences[0]!.words.map((w) => w.w)).toEqual(['giảm', 'giá', 'sốc']);
    expect(p.sentences[0]!.words[0]).toMatchObject({ i: 4 });
    expect(transcriptPage(t, 0, 1).sentences).toHaveLength(1);
  });
  it('excerptOf cắt ở ranh giới từ', () => {
    expect(excerptOf([{ w: 'một' }, { w: 'hai' }], 400)).toBe('một hai');
    const long = Array.from({ length: 200 }, () => ({ w: 'abcdefgh' }));
    const e = excerptOf(long, 400);
    expect(e.length).toBeLessThanOrEqual(400);
    expect(e.endsWith('…')).toBe(true);
  });
});

describe('khôi phục dấu câu giữ nguyên dãy từ', () => {
  const t = build(speechWords(['cả nhà ơi hôm nay có ưu đãi']));
  it('chuẩn hoá từ: NFC, chữ thường, bỏ dấu câu hai đầu', () => {
    expect(normToken('"Ưu-đãi,"')).toBe('ưu-đãi');
    expect(normToken('Cả!')).toBe('cả');
    expect(normToken('...')).toBe('');
  });
  const make = (ws: string[]) => ws.map((w, k) => ({ i: k, w }));
  it('đúng dãy từ (chỉ đổi hoa/thường + dấu câu) → chấp nhận', () => {
    const r = validateCaptionWords(t, 0, 7, make(['Cả', 'nhà', 'ơi,', 'hôm', 'nay', 'có', 'ưu', 'đãi.']));
    expect(r).not.toBeNull();
    expect(r![2]!.w).toBe('ơi,');
    expect(r![7]!.w).toBe('đãi.');
  });
  it('khác từ, thừa/thiếu từ, sai chỉ số, từ rỗng → từ chối (dùng bản ASR)', () => {
    const ok = ['Cả', 'nhà', 'ơi', 'hôm', 'nay', 'có', 'ưu', 'đãi'];
    expect(validateCaptionWords(t, 0, 7, make(ok.map((w) => (w === 'đãi' ? 'giảm' : w))))).toBeNull(); // đổi từ
    expect(validateCaptionWords(t, 0, 7, make(ok.slice(0, 7)))).toBeNull(); // thiếu
    expect(validateCaptionWords(t, 0, 7, [...make(ok), { i: 8, w: 'x' }])).toBeNull(); // thừa
    expect(validateCaptionWords(t, 0, 7, make(ok).map((w) => ({ ...w, i: w.i + 1 })))).toBeNull(); // sai chỉ số
    expect(validateCaptionWords(t, 0, 7, make([...ok.slice(0, 7), '']))).toBeNull(); // từ rỗng
    expect(validateCaptionWords(t, 0, 7, 'không phải mảng')).toBeNull();
  });
  it('SRT của clip dùng cụm minimal, thời gian tính từ đầu clip', () => {
    const w = t.words.slice(0, 4).map((x) => ({ w: x.w, start: x.start, end: x.end }));
    const srt = buildClipSrt(w, w[0]!.start - 0.15, w[3]!.end + 0.3);
    expect(srt.startsWith('1\n00:00:00,150 --> ')).toBe(true);
    expect(srt).toContain('cả nhà ơi hôm');
  });
});
