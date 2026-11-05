/**
 * Clip ghép nhiều đoạn (montage): kiểu dữ liệu và tiện ích THUẦN dùng chung cho server, worker và web (không import gì).
 *
 * `clips.parts` (migration 017) là JSON các đoạn theo THỨ TỰ PHÁT (có thể khác thứ tự thời gian, vd đưa câu hook ở phút 45 lên đầu).
 * NULL = clip một đoạn như cũ (dùng `start_word/end_word/start_s/end_s` của dòng). Khi có `parts` (≥ 2 đoạn), các cột của dòng là KHUNG BAO:
 * start = nhỏ nhất, end = lớn nhất của các đoạn.
 */
export const MAX_CLIP_PARTS = 6;
/** Mỗi đoạn (sau khi bám khoảng lặng) dài tối thiểu bấy nhiêu giây. */
export const MIN_PART_S = 1.5;

export interface ClipPart {
  start_word: number;
  end_word: number;
  start_s: number;
  end_s: number;
  start_sentence?: number;
  end_sentence?: number;
}

export interface PartsHolder {
  start_word: number;
  end_word: number;
  start_s: number;
  end_s: number;
  /** Mảng (JSON API) hoặc chuỗi JSON (dòng DB) hoặc null. */
  parts?: ClipPart[] | string | null;
}

/** Các đoạn của clip theo thứ tự phát. Clip một đoạn → mảng một phần tử từ các cột của dòng. */
export function clipParts(c: PartsHolder): ClipPart[] {
  let raw: unknown = c.parts ?? null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (Array.isArray(raw) && raw.length >= 2) return raw as ClipPart[];
  return [{ start_word: c.start_word, end_word: c.end_word, start_s: c.start_s, end_s: c.end_s }];
}

export const isMultiPart = (c: PartsHolder): boolean => clipParts(c).length > 1;

/** Khoảng thời gian nguồn của các đoạn, theo thứ tự phát. */
export const partSpans = (parts: Pick<ClipPart, 'start_s' | 'end_s'>[]): { start: number; end: number }[] => parts.map((p) => ({ start: p.start_s, end: p.end_s }));

export const partsDuration = (parts: Pick<ClipPart, 'start_s' | 'end_s'>[]): number => Math.round(parts.reduce((n, p) => n + p.end_s - p.start_s, 0) * 1000) / 1000;

/** Chỉ số đoạn chứa từ `i` (theo chỉ số từ), -1 nếu không thuộc đoạn nào. */
export const partIndexOfWord = (parts: Pick<ClipPart, 'start_word' | 'end_word'>[], i: number): number => parts.findIndex((p) => i >= p.start_word && i <= p.end_word);

/** Chỉ số các từ của clip theo thứ tự phát. */
export function partWordIndices(parts: Pick<ClipPart, 'start_word' | 'end_word'>[]): number[] {
  const out: number[] = [];
  for (const p of parts) for (let i = p.start_word; i <= p.end_word; i++) out.push(i);
  return out;
}

/** Khung bao (theo thời gian và chỉ số từ) của các đoạn. */
export function partsEnvelope(parts: ClipPart[]): { start_word: number; end_word: number; start_s: number; end_s: number } {
  return {
    start_word: Math.min(...parts.map((p) => p.start_word)),
    end_word: Math.max(...parts.map((p) => p.end_word)),
    start_s: Math.min(...parts.map((p) => p.start_s)),
    end_s: Math.max(...parts.map((p) => p.end_s)),
  };
}

/** Các khoảng từ có chồng nhau không (hai đoạn của cùng một clip không được chồng). */
export function wordRangesOverlap(parts: Pick<ClipPart, 'start_word' | 'end_word'>[]): boolean {
  const s = [...parts].sort((a, b) => a.start_word - b.start_word);
  return s.some((p, k) => k > 0 && p.start_word <= s[k - 1]!.end_word);
}

/** Tỉ lệ chồng nhau giữa hai clip (tổng số từ chung / số từ của clip ít từ hơn), 0–1. Dùng để khử trùng đề xuất. */
export function partsOverlapRatio(a: Pick<ClipPart, 'start_word' | 'end_word'>[], b: Pick<ClipPart, 'start_word' | 'end_word'>[]): number {
  let inter = 0;
  for (const x of a) for (const y of b) inter += Math.max(0, Math.min(x.end_word, y.end_word) - Math.max(x.start_word, y.start_word) + 1);
  const len = (ps: Pick<ClipPart, 'start_word' | 'end_word'>[]) => ps.reduce((n, p) => n + p.end_word - p.start_word + 1, 0);
  const min = Math.min(len(a), len(b));
  return min > 0 ? inter / min : 0;
}
