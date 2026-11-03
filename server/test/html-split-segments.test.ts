import { describe, expect, it } from 'vitest';
import { splitSegments, transcriptForSegment } from '../src/services/html/split-segments.js';
import { buildTranscript } from '../src/services/clips/transcript.js';
const continuous = (s: ReturnType<typeof splitSegments>, total: number) => {
  expect(s[0]!.start_s).toBe(0);
  expect(s.at(-1)!.end_s).toBe(total);
  s.forEach((a, i) => {
    expect(a.end_s - a.start_s).toBeLessThanOrEqual(60);
    expect(a.end_s).toBeGreaterThan(a.start_s);
    if (i) expect(a.start_s).toBe(s[i - 1]!.end_s);
  });
};
describe('chia đoạn HTML', () => {
  it('voice 7 phút cắt ở khoảng lặng giữa câu, ưu tiên khe lớn trong 35–55s', () => {
    const ss = Array.from({ length: 42 }, (_, i) => ({ start: i * 10 + (i === 5 ? 3 : 0), end: i * 10 + 8 }));
    const s = splitSegments(420, ss);
    continuous(s, 420);
    expect(s[0]!.end_s).toBe(50);
    for (const a of s.slice(0, -1)) expect(ss.some((x) => x.start < a.end_s && x.end > a.end_s)).toBe(false);
  });
  it('câu đơn >60s cắt tại khe giữa từ, không mất từ khi dời mốc', () => {
    const t = buildTranscript(
      { text: '', duration: 140, segments: [], words: Array.from({ length: 140 }, (_, i) => ({ word: `từ${i}`, start: i, end: i + 0.7 })) },
      { durationHintS: 140 },
    );
    const sentence = { id: 0, start: 0, end: 139.7, start_word: 0, end_word: 139, text: 'dài' };
    t.sentences = [sentence];
    const s = splitSegments(140, [sentence], t.words);
    continuous(s, 140);
    const clips = s.map((x) => transcriptForSegment(t, x));
    expect(clips.flatMap((c) => c.words).map((w) => w.w)).toEqual(t.words.map((w) => w.w));
    for (const c of clips) {
      expect(c.words[0]!.i).toBe(0);
      expect(c.words.every((w) => w.start >= 0 && w.end <= c.duration_s + 0.001)).toBe(true);
    }
  });
  it('không voice chia đều 0.1s; video ngắn giữ một đoạn; chặn quá 420s', () => {
    for (const t of [61, 125, 300, 419.95, 420]) continuous(splitSegments(t), t);
    expect(splitSegments(60)).toEqual([{ idx: 1, start_s: 0, end_s: 60 }]);
    expect(splitSegments(125).map((s) => s.end_s)).toEqual([41.7, 83.3, 125]);
    expect(() => splitSegments(421)).toThrow();
  });
});
