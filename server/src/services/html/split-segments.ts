/** Chia thời gian thuần: ranh giới nằm trong khoảng lặng, không lấy số giây do AI đoán. */
import { AppError } from '../../lib/errors.js';
import { speechRatio, type Transcript } from '../clips/transcript.js';

export interface SegmentBounds {
  idx: number;
  start_s: number;
  end_s: number;
}
export interface SegmentSentence {
  start: number;
  end: number;
  text?: string;
  words?: readonly { start: number; end: number }[];
}
const round = (n: number) => Math.round(n * 1000) / 1000;
export function splitSegments(
  totalS: number,
  sentences?: readonly SegmentSentence[],
  words?: readonly { start: number; end: number }[],
): SegmentBounds[] {
  if (!Number.isFinite(totalS) || totalS < 1 || totalS > 420)
    throw new AppError('INVALID_DURATION', 'Tổng thời lượng phải từ 1 đến 420 giây', 400);
  if (totalS <= 60) return [{ idx: 1, start_s: 0, end_s: totalS }];
  if (!sentences?.length) {
    const n = Math.ceil(totalS / 50);
    return Array.from({ length: n }, (_, i) => ({
      idx: i + 1,
      start_s: i ? Math.round(((totalS * i) / n) * 10) / 10 : 0,
      end_s: i === n - 1 ? totalS : Math.round(((totalS * (i + 1)) / n) * 10) / 10,
    }));
  }
  const ss = [...sentences].sort((a, b) => a.start - b.start);
  if (
    ss.some(
      (s, i) =>
        !Number.isFinite(s.start) ||
        !Number.isFinite(s.end) ||
        s.start < 0 ||
        s.end < s.start ||
        s.end > totalS + 0.001 ||
        (i > 0 && s.start < ss[i - 1]!.end - 0.001),
    )
  )
    throw new AppError('INVALID_TRANSCRIPT', 'Câu ASR không có mốc thời gian hợp lệ', 400);
  const ww = words ?? ss.flatMap((s) => s.words ?? []);
  const out: SegmentBounds[] = [];
  let start = 0;
  while (totalS - start > 60 + 1e-8) {
    const target = start + 50;
    const gaps = [
      { a: 0, b: ss[0]!.start },
      ...ss.slice(0, -1).map((s, i) => ({ a: s.end, b: ss[i + 1]!.start })),
      { a: ss.at(-1)!.end, b: totalS },
    ];
    const candidates = (items: { a: number; b: number }[]) =>
      items
        .filter((g) => g.b >= start + 0.001 && g.a <= start + 60)
        .map((g) => ({ at: Math.max(g.a, Math.min(g.b, round(target))), gap: g.b - g.a }))
        .filter((c) => c.at > start + 0.001 && c.at <= start + 60);
    const choose = (cs: { at: number; gap: number }[]) =>
      cs.sort((a, b) => b.gap - a.gap || Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    const sentenceCuts = candidates(gaps);
    let cut = choose(sentenceCuts.filter((c) => c.at >= start + 35 && c.at <= start + 55));
    if (!cut) cut = choose(sentenceCuts);
    if (!cut) {
      const wordCuts = candidates(
        ww
          .slice(0, -1)
          .map((w, i) => ({ a: w.end, b: ww[i + 1]!.start }))
          .filter((g) => g.b >= g.a),
      );
      cut = choose(wordCuts.filter((c) => c.at >= start + 35 && c.at <= start + 55)) ?? choose(wordCuts);
    }
    if (!cut)
      throw new AppError('SEGMENT_WORD_TIMESTAMPS_REQUIRED', 'Câu dài quá 60 giây cần timestamp từng từ để chia tại khoảng lặng', 400);
    out.push({ idx: out.length + 1, start_s: start, end_s: cut.at });
    start = cut.at;
  }
  out.push({ idx: out.length + 1, start_s: start, end_s: totalS });
  return out;
}

/** Dời mốc về 0 và đánh lại chỉ số từ; câu dài chia ở từ vẫn chỉ chứa chữ thuộc đoạn. */
export function transcriptForSegment(t: Transcript, s: Pick<SegmentBounds, 'start_s' | 'end_s'>): Transcript {
  const selected = t.words.filter((w) => w.start >= s.start_s - 1e-6 && w.end <= s.end_s + 1e-6);
  const words = selected.map((w, i) => ({ ...w, i, start: round(Math.max(0, w.start - s.start_s)), end: round(w.end - s.start_s) }));
  const sentences = t.sentences.flatMap((sentence) => {
    const indices = selected.flatMap((w, i) => (w.i >= sentence.start_word && w.i <= sentence.end_word ? [i] : []));
    if (!indices.length) return [];
    const first = indices[0]!,
      last = indices.at(-1)!;
    return [
      {
        ...sentence,
        start_word: first,
        end_word: last,
        start: words[first]!.start,
        end: words[last]!.end,
        text: words
          .slice(first, last + 1)
          .map((w) => w.w)
          .join(' '),
      },
    ];
  });
  return {
    ...t,
    duration_s: s.end_s - s.start_s,
    words,
    sentences,
    segments: sentences.map((x) => ({ id: x.id, start: x.start, end: x.end, text: x.text })),
    pauses: t.pauses
      ?.filter((p) => p.end > s.start_s && p.start < s.end_s)
      .map((p) => ({ start: round(Math.max(p.start, s.start_s) - s.start_s), end: round(Math.min(p.end, s.end_s) - s.start_s) })),
    speech_ratio: speechRatio(words, s.end_s - s.start_s),
  };
}
