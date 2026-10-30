/** Shared by clip_plan worker and server. Resolve quotes to ASR words; never trust AI seconds. */
export interface BoundarySentence {
  id: number;
  start: number;
  end: number;
  text: string;
  start_word?: number;
  words?: { i: number; start: number; end: number }[];
}
export interface BoundaryInput {
  start_id: number;
  end_id: number;
  start_quote?: string;
  end_quote?: string;
  start_word?: number;
  end_word?: number;
}
export interface ResolvedBoundary {
  start_id: number;
  end_id: number;
  start_word: number;
  end_word: number;
  start: number;
  end: number;
  boundary: 'word_quote' | 'sentence_fallback';
}
export const quoteToken = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/[^\p{L}\p{N}]/gu, '');
const toks = (s: string): string[] => s.split(/\s+/).filter(Boolean);

function sentenceWords(s: BoundarySentence) {
  return toks(s.text).map((w, k, all) => ({
    i: s.words?.[k]?.i ?? (s.start_word ?? 0) + k,
    w,
    start: s.words?.[k]?.start ?? s.start + k / all.length * (s.end - s.start),
    end: s.words?.[k]?.end ?? s.start + (k + 1) / all.length * (s.end - s.start),
    sentence: s.id,
  }));
}
type Word = ReturnType<typeof sentenceWords>[number];

/** Ordered token match (LCS), accent insensitive; tolerate one inserted/omitted token. */
export function locateQuote(sentences: BoundarySentence[], anchor: number, quote: string | undefined, edge: 'start' | 'end'): Word | null {
  const q = toks(quote ?? '').map(quoteToken).filter(Boolean);
  if (!q.length || q.length > 16) return null;
  const ws = sentences.filter((s) => Math.abs(s.id - anchor) <= 1).flatMap(sentenceWords);
  let best: { word: Word; score: number; distance: number; length: number } | null = null;
  for (let i = 0; i < ws.length; i++) {
    for (let n = Math.max(1, q.length - 1); n <= q.length + 1 && i + n <= ws.length; n++) {
      const pool = ws.slice(i, i + n).map((w) => quoteToken(w.w));
      let dp = new Array<number>(n + 1).fill(0);
      for (const token of q) {
        const next = [0];
        for (let j = 1; j <= n; j++) next[j] = token === pool[j - 1] ? dp[j - 1]! + 1 : Math.max(dp[j]!, next[j - 1]!);
        dp = next;
      }
      const score = dp[n]! / Math.max(q.length, n);
      if (score < (q.length < 4 ? 1 : 0.7)) continue;
      const word = ws[edge === 'start' ? i : i + n - 1]!;
      const distance = Math.abs(word.sentence - anchor);
      if (!best || score > best.score || (score === best.score && (distance < best.distance || (distance === best.distance && Math.abs(n - q.length) < best.length)))) {
        best = { word, score, distance, length: Math.abs(n - q.length) };
      }
    }
  }
  return best?.word ?? null;
}

/** ID-only legacy results retain sentence bounds. Explicit word indices must agree with quotes or stay in the anchor's ±1 sentence window. */
export function resolveBoundaries(sentences: BoundarySentence[], input: BoundaryInput): ResolvedBoundary | null {
  const a = sentences.find((s) => s.id === input.start_id);
  const b = sentences.find((s) => s.id === input.end_id);
  if (!a || !b || a.id > b.id) return null;
  const aw = sentenceWords(a);
  const bw = sentenceWords(b);
  if (!aw.length || !bw.length) return null;
  const qs = locateQuote(sentences, a.id, input.start_quote, 'start');
  const qe = locateQuote(sentences, b.id, input.end_quote, 'end');
  // New protocol requires both quotes. Old workers used start_quote only: retain safe sentence bounds.
  const quoted = !!qs && !!qe;
  let first = quoted ? qs : aw[0]!;
  let last = quoted ? qe : bw[bw.length - 1]!;
  const explicit = input.start_word !== undefined || input.end_word !== undefined;
  if (explicit) {
    if (!Number.isInteger(input.start_word) || !Number.isInteger(input.end_word)) return null;
    const local = sentences.filter((s) => Math.abs(s.id - a.id) <= 1 || Math.abs(s.id - b.id) <= 1).flatMap(sentenceWords);
    const x = local.find((w) => w.i === input.start_word && Math.abs(w.sentence - a.id) <= 1);
    const y = local.find((w) => w.i === input.end_word && Math.abs(w.sentence - b.id) <= 1);
    if (!x || !y || (quoted && (x.i !== first.i || y.i !== last.i))) return null;
    // A failed quote must fall back to whole sentences, not arbitrary supplied words.
    if (!quoted && (input.start_quote || input.end_quote) && (x.i !== first.i || y.i !== last.i)) return null;
    first = x;
    last = y;
  }
  if (first.i > last.i) return null;
  return { start_id: first.sentence, end_id: last.sentence, start_word: first.i, end_word: last.i, start: first.start, end: last.end, boundary: quoted ? 'word_quote' : 'sentence_fallback' };
}
