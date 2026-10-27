import { sentenceOfWord } from './lib';
import type { TranscriptSentence, TranscriptWord } from './types';

export interface WordIndex {
  /** Chỉ số từ đầu của mỗi câu. */
  starts: number[];
  sentences: TranscriptSentence[];
  word(i: number): TranscriptWord | null;
  sentenceOf(i: number): number;
  /** Từ đầu / từ cuối của câu `si` (kẹp trong khoảng hợp lệ). */
  firstOf(si: number): number | null;
  lastOf(si: number): number | null;
  /** Chữ của các từ [a, b], tối đa `max` từ (cắt bằng "…"). */
  text(a: number, b: number, max?: number): string;
  lastWord: number;
}

/** Tra từ theo chỉ số toàn cục `i` trong transcript đã nạp (các câu liền nhau, từ liền nhau trong câu). */
export function makeWordIndex(sentences: TranscriptSentence[]): WordIndex {
  const starts = sentences.map((s, k) => s.words[0]?.i ?? (k ? 0 : 0));
  const lastWord = (() => {
    for (let k = sentences.length - 1; k >= 0; k--) {
      const w = sentences[k]!.words;
      if (w.length) return w[w.length - 1]!.i;
    }
    return -1;
  })();
  const sentenceOf = (i: number) => (starts.length ? sentenceOfWord(starts, i) : 0);
  const word = (i: number): TranscriptWord | null => {
    if (!sentences.length) return null;
    const s = sentences[sentenceOf(i)];
    if (!s || !s.words.length) return null;
    const guess = s.words[i - s.words[0]!.i];
    if (guess && guess.i === i) return guess;
    return s.words.find((w) => w.i === i) ?? null;
  };
  return {
    starts,
    sentences,
    word,
    sentenceOf,
    firstOf: (si) => sentences[si]?.words[0]?.i ?? null,
    lastOf: (si) => {
      const w = sentences[si]?.words;
      return w && w.length ? w[w.length - 1]!.i : null;
    },
    text(a, b, max = 14) {
      const out: string[] = [];
      for (let i = a; i <= b; i++) {
        const w = word(i);
        if (w) out.push(w.w);
        if (out.length >= max) return `${out.join(' ')}…`;
      }
      return out.join(' ');
    },
    lastWord,
  };
}
