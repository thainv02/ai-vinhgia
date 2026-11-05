/** Shared, deterministic validation and timeline mapping. AI only names word ranges, never seconds. */
export interface CleanupWord { i: number; w: string; start: number; end: number }
export interface Segment { start: number; end: number }
export interface CleanupProposal extends Segment {
  id: number;
  start_word: number;
  end_word: number;
  text: string;
  kind: 'filler' | 'false_start' | 'repetition';
  reason: string;
  edited?: boolean;
  original?: { start_word: number; end_word: number };
  replacement?: { start_word: number; end_word: number; text: string; start: number; end: number };
}
export interface CleanupPlan {
  job_id: number;
  revision: number;
  proposals: CleanupProposal[];
  selected_ids: number[];
}
export interface EditSnapshot {
  start_word: number;
  end_word: number;
  caption_words: { i: number; w: string }[] | null;
  segments: Segment[];
  cleanup_ids: number[];
  /** Clip ghép nhiều đoạn: các đoạn theo thứ tự phát lúc xếp hàng dựng (không có = clip một đoạn / bản dựng cũ). */
  parts?: { start_word: number; end_word: number; start_s: number; end_s: number }[];
}
const round = (n: number) => Math.round(n * 1000) / 1000;
const norm = (s: string) => s.normalize('NFC').toLocaleLowerCase('vi').replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim();
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const filler = new Set(['ừm', 'ừ', 'ờ', 'ờm', 'à', 'uh', 'um', 'hmm', 'erm']);

/** Refuse invented quotes, invalid confidence, overlaps, large deletions, or a missing later correction. */
export function validateCleanup(words: CleanupWord[], start: number, end: number, raw: unknown): CleanupProposal[] {
  return validateCleanupSpans(words, [{ start, end }], raw);
}

const EPS = 0.001;
/** Đoạn (span) chứa trọn từ `w`, theo thời gian; -1 nếu không có. */
const spanOfWord = (spans: Segment[], w: { start: number; end: number }) => spans.findIndex((s) => w.start >= s.start - EPS && w.end <= s.end + EPS);

/**
 * Như `validateCleanup` nhưng cho clip nhiều đoạn: `spans` là các đoạn nguồn theo THỨ TỰ PHÁT, `words` là các từ của mọi đoạn.
 * Mỗi chỗ bỏ (và phần nói lại của nó) phải nằm trọn trong MỘT đoạn; từ ở đoạn khác không được coi là từ liền kề.
 * Mã đề xuất đánh 1..n theo thứ tự phát (đoạn trước, rồi thời gian trong đoạn).
 */
export function validateCleanupSpans(words: CleanupWord[], spans: Segment[], raw: unknown): CleanupProposal[] {
  if (!spans.length) throw new Error('Clip không có đoạn nào');
  if (!Array.isArray(raw) || raw.length > 40) throw new Error('Danh sách đề xuất không hợp lệ (tối đa 40 chỗ)');
  const byId = new Map(words.map((w) => [w.i, w]));
  const range = (a: unknown, b: unknown) => {
    if (!Number.isInteger(a) || !Number.isInteger(b) || (a as number) > (b as number)) throw new Error('Khoảng từ không hợp lệ');
    const selected = words.filter((w) => w.i >= (a as number) && w.i <= (b as number));
    if (!selected.length || selected.length !== (b as number) - (a as number) + 1) throw new Error('Khoảng từ nằm ngoài clip');
    return selected;
  };
  const withSpan = raw.map((value): { p: CleanupProposal; k: number } => {
    if (!rec(value) || !['filler', 'false_start', 'repetition'].includes(String(value.kind)) || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0.9 || value.confidence > 1) throw new Error('Đề xuất cần phân loại và độ chắc chắn từ 0,9 đến 1');
    if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(value.reason)) throw new Error('Thiếu lý do hợp lệ');
    const removed = range(value.start_word, value.end_word);
    const a = removed[0]!, b = removed.at(-1)!;
    const k = spanOfWord(spans, a);
    if (k < 0 || spanOfWord(spans, b) !== k) throw new Error('Chỗ bỏ phải nằm trọn trong một đoạn của clip');
    const span = spans[k]!;
    const text = removed.map((w) => w.w).join(' ');
    if (typeof value.quote !== 'string' || norm(value.quote) !== norm(text)) throw new Error('Câu trích không khớp lời thoại gốc');
    const sameSpan = (w: CleanupWord | undefined) => (w && spanOfWord(spans, w) === k ? w : undefined);
    const prev = sameSpan(byId.get(a.i - 1)), next = sameSpan(byId.get(b.i + 1));
    if ((prev && prev.end > a.start + 0.01) || (next && next.start < b.end - 0.01)) throw new Error('Mốc từ chồng nhau, không cắt an toàn được');
    let from = prev ? Math.min(a.start, Math.max(prev.end, (prev.end + a.start) / 2)) : span.start;
    let to = next ? Math.max(b.end, Math.min(next.start, (b.end + next.start) / 2)) : span.end;
    from = round(Math.max(span.start, from)); to = round(Math.min(span.end, to));
    if (!(to > from) || to - from > 30) throw new Error('Chỉ được bỏ các đoạn ngắn tối đa 30 giây');
    const kind = value.kind as CleanupProposal['kind'];
    let replacement: CleanupProposal['replacement'];
    if (kind === 'filler') {
      if (removed.length > 5 || removed.some((w) => !filler.has(norm(w.w)))) throw new Error('Tiếng đệm chứa từ có nội dung');
    } else {
      if (!rec(value.replacement)) throw new Error('Phải chỉ ra phần nói lại được giữ');
      const fixed = range(value.replacement.start_word, value.replacement.end_word);
      if (fixed[0]!.i <= b.i || fixed[0]!.start - b.end > 8) throw new Error('Phần nói lại phải nằm ngay sau đoạn bỏ (tối đa 8 giây)');
      if (spanOfWord(spans, fixed[0]!) !== k || spanOfWord(spans, fixed.at(-1)!) !== k) throw new Error('Phần nói lại phải cùng đoạn với chỗ bỏ');
      const replacementText = fixed.map((w) => w.w).join(' ');
      if (typeof value.replacement.quote !== 'string' || norm(value.replacement.quote) !== norm(replacementText)) throw new Error('Phần nói lại không khớp lời thoại');
      replacement = { start_word: fixed[0]!.i, end_word: fixed.at(-1)!.i, text: replacementText, start: fixed[0]!.start, end: fixed.at(-1)!.end };
    }
    return { k, p: { id: 0, start_word: a.i, end_word: b.i, text, start: from, end: to, kind, reason: value.reason.trim(), ...(replacement ? { replacement } : {}) } };
  }).sort((x, y) => x.k - y.k || x.p.start - y.p.start);
  const proposals = withSpan.map((x) => x.p);
  withSpan.forEach((x, i) => {
    x.p.id = i + 1;
    if (i && withSpan[i - 1]!.k === x.k && x.p.start < withSpan[i - 1]!.p.end) throw new Error('Các đề xuất chồng nhau');
  });
  // Even unapproved proposals must describe a feasible edit.
  cleanupSegmentsSpans(spans, proposals, proposals.map((p) => p.id));
  return proposals;
}

/** Subtract only approved proposals; all retained source segments remain in their original order. */
export function cleanupSegments(start: number, end: number, proposals: CleanupProposal[], ids: number[]): Segment[] {
  return cleanupSegmentsSpans([{ start, end }], proposals, ids);
}

/**
 * Clip nhiều đoạn: trừ các chỗ bỏ đã duyệt khỏi TỪNG đoạn, nối kết quả theo thứ tự phát của các đoạn (không sắp lại theo thời gian).
 * Mỗi chỗ bỏ phải nằm trọn trong một đoạn. Bản làm gọn phải còn ≥ 3 giây, giữ ≥ 60% tổng độ dài các đoạn và không có mảnh < 0,08 giây.
 */
export function cleanupSegmentsSpans(spans: Segment[], proposals: CleanupProposal[], ids: number[]): Segment[] {
  if (new Set(ids).size !== ids.length || ids.some((id) => !proposals.some((p) => p.id === id))) throw new Error('Danh sách chỗ bỏ không hợp lệ');
  const chosen = proposals.filter((p) => ids.includes(p.id)).sort((a, b) => a.start - b.start);
  for (const p of chosen) {
    if (p.replacement && chosen.some((q) => q.start_word <= p.replacement!.end_word && q.end_word >= p.replacement!.start_word)) throw new Error('Phần nói lại phải được giữ nguyên');
  }
  const out: Segment[] = [];
  let placed = 0;
  for (const span of spans) {
    const inside = chosen.filter((p) => p.start >= span.start - EPS && p.end <= span.end + EPS);
    placed += inside.length;
    let cursor = span.start;
    for (const p of inside) {
      if (!Number.isFinite(p.start) || !Number.isFinite(p.end) || p.start < cursor || p.end <= p.start || p.end > span.end) throw new Error('Điểm cắt không hợp lệ');
      if (p.start > cursor) out.push({ start: cursor, end: p.start });
      cursor = p.end;
    }
    if (cursor < span.end) out.push({ start: cursor, end: span.end });
  }
  if (placed !== chosen.length) throw new Error('Điểm cắt không hợp lệ');
  const duration = segmentDuration(out);
  const total = spans.reduce((n, s) => n + s.end - s.start, 0);
  if (duration < 3 - 0.001 || duration < total * 0.6 || out.some((s) => s.end - s.start < 0.08)) throw new Error('Bản làm gọn phải còn ít nhất 3 giây, giữ ít nhất 60% clip và không tạo mảnh quá ngắn');
  return out;
}
export const segmentDuration = (segments: Segment[]) => round(segments.reduce((sum, s) => sum + s.end - s.start, 0));

/** Place subtitles on the concatenated output clock, including hidden words spanning an edit. */
export function retimeWords<T extends { start: number; end: number }>(words: T[], segments: Segment[], sourceEnd = Math.max(...words.map((w) => w.end))): T[] {
  const out: T[] = [];
  const lastByWord = new Map<T, T>();
  let offset = 0;
  for (const s of segments) {
    for (const w of words) {
      const a = Math.max(w.start, s.start), b = Math.min(w.end, s.end);
      // Point words belong to [start,end); the final retained endpoint also belongs to the clip.
      // This avoids duplicating a word at adjacent joins or retaining a word at a removed start.
      const point = w.start === w.end && w.start >= s.start && (w.start < s.end || (w.start === sourceEnd && w.start === s.end));
      if (b > a || (point && !lastByWord.has(w))) {
        const mapped = { ...w, start: round(offset + a - s.start), end: round(offset + b - s.start) };
        const previous = lastByWord.get(w);
        if (previous && previous === out.at(-1) && mapped.start <= previous.end + 0.001) previous.end = mapped.end;
        else { out.push(mapped); lastByWord.set(w, mapped); }
      }
    }
    offset += s.end - s.start;
  }
  return out;
}

export interface CleanupEdit { id: number; start_word: number; end_word: number }

/** Manual handles snap to complete words; only source indices are accepted from the client. */
export function editCleanupCuts(words: CleanupWord[], start: number, end: number, proposals: CleanupProposal[], edits: CleanupEdit[]): CleanupProposal[] {
  return editCleanupCutsSpans(words, [{ start, end }], proposals, edits);
}

/** Như `editCleanupCuts` cho clip nhiều đoạn: hai đầu chỗ bỏ phải cùng một đoạn; kết quả giữ thứ tự phát (đoạn, rồi thời gian). */
export function editCleanupCutsSpans(words: CleanupWord[], spans: Segment[], proposals: CleanupProposal[], edits: CleanupEdit[]): CleanupProposal[] {
  if (new Set(edits.map((e) => e.id)).size !== edits.length) throw new Error('Trùng điểm cắt chỉnh sửa');
  const byId = new Map(words.map((w) => [w.i, w]));
  const changes = new Map<number, CleanupProposal>();
  for (const edit of edits) {
    const p = proposals.find((p) => p.id === edit.id);
    const a = byId.get(edit.start_word), b = byId.get(edit.end_word);
    if (!p || !a || !b || edit.start_word > edit.end_word) throw new Error('Khoảng từ chỉnh sửa nằm ngoài clip');
    const k = spanOfWord(spans, a);
    if (k < 0 || spanOfWord(spans, b) !== k) throw new Error('Chỗ bỏ phải nằm trọn trong một đoạn của clip');
    const span = spans[k]!;
    const sameSpan = (w: CleanupWord | undefined) => (w && spanOfWord(spans, w) === k ? w : undefined);
    const prev = sameSpan(byId.get(a.i - 1)), next = sameSpan(byId.get(b.i + 1));
    if ((prev && prev.end > a.start + 0.01) || (next && next.start < b.end - 0.01)) throw new Error('Mốc từ chồng nhau, chưa thể cắt ở từ này');
    const from = round(Math.max(span.start, prev ? (prev.end + a.start) / 2 : span.start));
    const to = round(Math.min(span.end, next ? (b.end + next.start) / 2 : span.end));
    if (from > a.start || to < b.end || to <= from) throw new Error('Điểm cắt đi vào giữa từ');
    changes.set(p.id, { ...p, start_word: a.i, end_word: b.i, start: from, end: to,
      text: words.filter((w) => w.i >= a.i && w.i <= b.i).map((w) => w.w).join(' '),
      edited: true, original: p.original ?? { start_word: p.start_word, end_word: p.end_word },
    });
  }
  const order = (p: CleanupProposal) => spans.findIndex((s) => p.start >= s.start - EPS && p.end <= s.end + EPS);
  return proposals.map((p) => changes.get(p.id) ?? p).sort((a, b) => order(a) - order(b) || a.start - b.start);
}
