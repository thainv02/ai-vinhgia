/**
 * Transcript của video nguồn: chuẩn hoá phản hồi STT thành `transcript.json`, dựng câu TẤT ĐỊNH, bám khoảng lặng cho điểm cắt, cửa sổ cho AI, SRT/TXT.
 * Chỉ chứa logic thuần (không DB/ffmpeg) để test được.
 *
 * Thời gian cắt KHÔNG BAO GIỜ lấy từ số giây do LLM viết: AI trả ID câu, server ánh xạ ID → từ → giây ở đây (xem `snapBounds`).
 */
import type { SttVerbose } from './stt-client.js';

export interface TWord {
  /** Chỉ số toàn cục, tăng dần theo thời gian (0-based). */
  i: number;
  w: string;
  start: number;
  end: number;
  /** Xác suất của dịch vụ (0–1). */
  p: number;
}
export interface TSentence {
  id: number;
  start_word: number;
  end_word: number;
  start: number;
  end: number;
  text: string;
}
/** Khoảng lặng thật trong audio (ffmpeg `silencedetect`, xem pauses.ts), giây tuyệt đối. */
export interface Pause {
  start: number;
  end: number;
}
export interface PauseDetectInfo {
  /** Ngưỡng `silencedetect` (dB) đã chọn theo audio, mức ồn nền và mức tiếng nói đo được. */
  threshold_db: number;
  floor_db: number;
  speech_db: number;
  min_s: number;
  method: string;
}

export interface Transcript {
  version: 1;
  /** Khoảng lặng thật (silencedetect) dùng để tách câu, siết cuối từ và bám điểm cắt. Thiếu = dò lỗi / transcript cũ (dựng câu theo cách cũ). */
  pauses?: Pause[];
  pause_detect?: PauseDetectInfo | null;
  model: string | null;
  duration_s: number;
  terms: string | null;
  content_hash: string | null;
  words: TWord[];
  sentences: TSentence[];
  /** Giữ nguyên segment của dịch vụ. */
  segments: { id: number; start: number; end: number; text: string }[];
  speech_ratio: number;
}

// ---- hằng số dựng câu (đặc tả 4.2) ----
export const SENTENCE_GAP_S = 0.7;
export const SENTENCE_MAX_S = 25;
export const SENTENCE_MAX_WORDS = 60;
export const MIN_WORD_S = 0.08;
// ---- dựng câu theo khoảng lặng thật (silencedetect) ----
/** Khoảng lặng ≥ ngưỡng này luôn là ranh giới câu. */
export const PAUSE_STRONG_S = 0.3;
/** Khoảng lặng ngắn nhất được tính (khớp `silencedetect d=`). */
export const PAUSE_MIN_S = 0.15;
/** Mục tiêu 2–12 giây một câu và tối đa 30 từ; dài hơn thì cắt ở các khoảng lặng ngắn hơn (quy hoạch động), không có thì ở khe lớn nhất giữa hai từ. */
export const PAUSE_SENTENCE_MAX_S = 12;
export const PAUSE_SENTENCE_MAX_WORDS = 30;
export const PAUSE_SENTENCE_MIN_S = 2;
export const PAUSE_SENTENCE_TARGET_S = 5;
/** Khoảng lặng ≥ ngưỡng này (hoặc dấu câu kết câu đã khôi phục) mới cho phép viết hoa chữ đầu câu khi phụ đề dùng chữ ASR. */
export const CAPITALIZE_PAUSE_S = 0.6;
/** Điểm cắt rơi vào khoảng lặng nếu có khoảng lặng trong vòng này quanh từ biên. */
export const SNAP_PAUSE_REACH_S = 0.4;

// ---- bám khoảng lặng (đặc tả 4.3) ----
export const SNAP_START_PAD_S = 0.15;
export const SNAP_END_PAD_S = 0.3;
export const SNAP_NEIGHBOR_GAP_S = 0.02;

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Sinh từ giả từ segment khi dịch vụ không trả `words`: chia đều thời gian theo số ký tự. */
function synthesizeWords(segments: { start: number; end: number; text: string }[]): { w: string; start: number; end: number; p: number }[] {
  const out: { w: string; start: number; end: number; p: number }[] = [];
  for (const s of segments) {
    const toks = s.text.split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const total = toks.reduce((a, t) => a + t.length, 0) || 1;
    const span = Math.max(s.end - s.start, toks.length * MIN_WORD_S);
    let t = s.start;
    for (const tok of toks) {
      const d = (tok.length / total) * span;
      out.push({ w: tok, start: t, end: t + d, p: 1 });
      t += d;
    }
  }
  return out;
}

/** Cắt một câu (mảng từ liên tiếp) tại khoảng lặng lớn nhất bên trong cho tới khi mọi mảnh ≤ 25 giây và ≤ 60 từ. */
function splitLong(words: TWord[], from: number, to: number, out: [number, number][]): void {
  const n = to - from + 1;
  const span = words[to]!.end - words[from]!.start;
  if (n < 2 || (span <= SENTENCE_MAX_S && n <= SENTENCE_MAX_WORDS)) {
    out.push([from, to]);
    return;
  }
  let best = from;
  let bestGap = -Infinity;
  for (let k = from; k < to; k++) {
    const gap = words[k + 1]!.start - words[k]!.end;
    // gap bằng nhau (vd mọi từ liền nhau): ưu tiên điểm gần giữa để không sinh mảnh vụn
    const centered = Math.abs(k - (from + to) / 2);
    if (gap > bestGap + 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && centered < Math.abs(best - (from + to) / 2))) {
      bestGap = gap;
      best = k;
    }
  }
  splitLong(words, from, best, out);
  splitLong(words, best + 1, to, out);
}

/**
 * Dựng `Transcript` từ phản hồi STT. Từ: `end <= start` → `start + 0.08`; sắp theo thời gian. Câu: ranh giới segment của dịch vụ + khoảng lặng giữa hai từ ≥ 0.7 s;
 * câu > 25 giây hoặc > 60 từ thì cắt ở khoảng lặng lớn nhất bên trong. ID câu tăng dần từ 0.
 *
 * Có `meta.pauses` (khoảng lặng thật từ silencedetect) thì dùng chúng thay cho mốc segment/khe giữa các từ: dịch vụ STT trả mốc từ LIỀN NHAU (end = start của từ kế)
 * và segment ~20 giây (ghép VAD), nên không thể tách câu theo khe giữa các từ. Xem `segmentByPauses` và `tightenWordEnds`.
 */
export function buildTranscript(
  v: SttVerbose,
  meta: { terms?: string | null; contentHash?: string | null; durationHintS?: number | null; pauses?: Pause[] | null; pauseDetect?: PauseDetectInfo | null } = {},
): Transcript {
  const segments = v.segments.map((s, k) => ({ id: s.id ?? k, start: s.start, end: s.end, text: s.text }));
  let raw: { w: string; start: number; end: number; p: number }[] = v.words.map((w) => ({ w: w.word, start: w.start, end: w.end, p: w.probability ?? 1 }));
  if (raw.length === 0 && segments.length > 0) raw = synthesizeWords(segments);
  // sắp ổn định theo thời gian bắt đầu rồi sửa từ có thời lượng không dương
  raw = raw
    .map((w, idx) => ({ ...w, idx }))
    .sort((a, b) => a.start - b.start || a.idx - b.idx)
    .map(({ idx: _idx, ...w }) => w);
  const words: TWord[] = raw.map((w, i) => {
    const start = Math.max(0, w.start);
    const end = w.end > start ? w.end : start + MIN_WORD_S;
    return { i, w: w.w, start: round3(start), end: round3(end), p: round3(Math.max(0, Math.min(1, w.p))) };
  });

  const pauses = meta.pauses ? normalizePauses(meta.pauses) : null;
  if (pauses) tightenWordEnds(words, pauses);

  // segment của từng từ: con trỏ đơn điệu theo giữa từ
  const segOf: number[] = new Array(words.length).fill(0);
  if (segments.length) {
    const segs = [...segments].sort((a, b) => a.start - b.start);
    let ptr = 0;
    words.forEach((w, k) => {
      const mid = (w.start + w.end) / 2;
      while (ptr < segs.length - 1 && segs[ptr]!.end < mid - 0.05) ptr++;
      segOf[k] = ptr;
    });
  }

  let ranges: [number, number][] = [];
  if (pauses && words.length) {
    ranges = segmentByPauses(words, pauses);
  } else {
    let begin = 0;
    for (let k = 1; k <= words.length; k++) {
      const boundary = k === words.length || segOf[k] !== segOf[k - 1] || words[k]!.start - words[k - 1]!.end >= SENTENCE_GAP_S;
      if (boundary && words.length) {
        splitLong(words, begin, k - 1, ranges);
        begin = k;
      }
    }
  }
  const sentences: TSentence[] = ranges.map(([a, b], id) => ({
    id,
    start_word: a,
    end_word: b,
    start: words[a]!.start,
    end: words[b]!.end,
    text: words.slice(a, b + 1).map((w) => w.w).join(' '),
  }));

  const lastEnd = words.length ? words[words.length - 1]!.end : 0;
  const duration = round3(Math.max(v.duration ?? 0, meta.durationHintS ?? 0, lastEnd));
  return {
    version: 1,
    ...(pauses ? { pauses, pause_detect: meta.pauseDetect ?? null } : {}),
    model: v.model ?? null,
    duration_s: duration,
    terms: meta.terms?.trim() ? meta.terms.trim() : null,
    content_hash: meta.contentHash ?? null,
    words,
    sentences,
    segments,
    speech_ratio: speechRatio(words, duration),
  };
}


// ---------------------------------------------------------------- khoảng lặng thật

/** Sắp theo thời gian, bỏ khoảng lặng ngắn hơn `PAUSE_MIN_S` hoặc hỏng, gộp khoảng chồng nhau, làm tròn mili giây. */
export function normalizePauses(pauses: Pause[]): Pause[] {
  const sorted = pauses
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end - p.start >= PAUSE_MIN_S - 1e-9)
    .map((p) => ({ start: Math.max(0, p.start), end: p.end }))
    .filter((p) => p.end - p.start >= PAUSE_MIN_S - 1e-9)
    .sort((a, b) => a.start - b.start);
  const out: Pause[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else out.push({ ...p });
  }
  return out.map((p) => ({ start: round3(p.start), end: round3(p.end) }));
}

/**
 * Siết cuối từ: dịch vụ STT trả mốc từ liền nhau (end = start của từ kế), nên cuối từ = min(start của từ kế, đầu khoảng lặng bắt đầu BÊN TRONG từ đó).
 * Nhờ vậy giữa các từ có khe thật ở chỗ nói ngắt: phụ đề không giữ từ đang nói qua khoảng lặng và điểm cắt bám được vào khe.
 */
export function tightenWordEnds(words: TWord[], pauses: Pause[]): void {
  let pi = 0;
  for (const w of words) {
    while (pi < pauses.length && pauses[pi]!.end <= w.start) pi++;
    for (let k = pi; k < pauses.length && pauses[k]!.start < w.end; k++) {
      const a = pauses[k]!.start;
      if (a > w.start + MIN_WORD_S / 2) {
        w.end = round3(Math.max(a, w.start + MIN_WORD_S));
        break;
      }
    }
  }
}

/** Khoảng lặng trước từ `i` (giây): lớn nhất giữa khe giữa hai từ và các khoảng lặng thật chạm vào khe đó. */
export function pauseBefore(t: Pick<Transcript, 'words' | 'pauses'>, i: number): number {
  const cur = t.words[i];
  const prev = t.words[i - 1];
  if (!cur || !prev) return Infinity;
  let best = Math.max(0, cur.start - prev.end);
  const ps = t.pauses;
  if (ps?.length) {
    // tìm nhị phân khoảng lặng đầu tiên có end > prev.end − 0.1
    let lo = 0;
    let hi = ps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid]!.end > prev.end - 0.1) hi = mid;
      else lo = mid + 1;
    }
    for (let k = lo; k < ps.length && ps[k]!.start < cur.start + 0.1; k++) best = Math.max(best, ps[k]!.end - ps[k]!.start);
  }
  return round3(best);
}

/** Gán mỗi khoảng lặng (thật hoặc khe ≥ 0.15 s giữa hai từ) vào ranh giới giữa hai từ gần nó nhất; khoảng lặng nằm giữa một từ dài (không có ranh giới gần) bị bỏ. */
function boundaryCandidates(words: TWord[], pauses: Pause[]): Map<number, number> {
  const n = words.length;
  const all: Pause[] = [...pauses];
  for (let k = 1; k < n; k++) {
    const gap = words[k]!.start - words[k - 1]!.end;
    if (gap >= PAUSE_MIN_S) all.push({ start: words[k - 1]!.end, end: words[k]!.start });
  }
  const best = new Map<number, number>();
  for (const p of all) {
    const dur = p.end - p.start;
    const pm = (p.start + p.end) / 2;
    // từ đầu tiên có start ≥ pm
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid]!.start >= pm) hi = mid;
      else lo = mid + 1;
    }
    let pick = -1;
    let pickD = Infinity;
    for (const k of [lo - 1, lo, lo + 1]) {
      if (k < 1 || k > n - 1) continue;
      const bt = (words[k - 1]!.end + words[k]!.start) / 2;
      const d = Math.abs(bt - pm);
      if (d <= 0.4 + dur / 2 && d < pickD) {
        pick = k;
        pickD = d;
      }
    }
    if (pick > 0) best.set(pick, Math.max(best.get(pick) ?? 0, dur));
  }
  return best;
}

const spanOf = (words: TWord[], a: number, b: number): number => words[b - 1]!.end - words[a]!.start;
const fits = (words: TWord[], a: number, b: number): boolean => b - a <= PAUSE_SENTENCE_MAX_WORDS && spanOf(words, a, b) <= PAUSE_SENTENCE_MAX_S;

/** Chia [s, e) (chỉ số từ) thành các câu 2–12 s, ≤ 30 từ, ưu tiên cắt ở khoảng lặng dài và độ dài gần ~5 s (quy hoạch động). */
function dpSplit(words: TWord[], s: number, e: number, cand: Map<number, number>): [number, number][] {
  const pts = new Set<number>([s, e]);
  for (const k of cand.keys()) if (k > s && k < e) pts.add(k);
  // ép thêm ranh giới (ở khe lớn nhất giữa hai từ) cho tới khi hai điểm liên tiếp nào cũng vừa giới hạn
  for (;;) {
    const arr = [...pts].sort((x, y) => x - y);
    let inserted = false;
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i]!;
      const b = arr[i + 1]!;
      if (fits(words, a, b) || b - a < 2) continue;
      let bestK = a + 1;
      let bestGap = -Infinity;
      for (let k = a + 1; k < b; k++) {
        const gap = words[k]!.start - words[k - 1]!.end;
        const centered = Math.abs(k - (a + b) / 2);
        if (gap > bestGap + 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && centered < Math.abs(bestK - (a + b) / 2))) {
          bestGap = gap;
          bestK = k;
        }
      }
      pts.add(bestK);
      inserted = true;
      break;
    }
    if (!inserted) break;
  }
  const B = [...pts].sort((x, y) => x - y);
  const m = B.length - 1;
  const cost: number[] = new Array(m + 1).fill(Infinity);
  const from: number[] = new Array(m + 1).fill(-1);
  cost[0] = 0;
  for (let j = 1; j <= m; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (!fits(words, B[i]!, B[j]!) && j - i > 1) break; // quá giới hạn: các i nhỏ hơn cũng quá
      const L = spanOf(words, B[i]!, B[j]!);
      const lenPenalty = 0.6 * ((L - PAUSE_SENTENCE_TARGET_S) / PAUSE_SENTENCE_TARGET_S) ** 2 + (L < PAUSE_SENTENCE_MIN_S ? 0.6 : 0);
      const reward = j < m ? Math.min(cand.get(B[j]!) ?? 0, 0.6) : 0;
      const c = cost[i]! + 0.2 + lenPenalty - reward;
      if (c < cost[j]!) {
        cost[j] = c;
        from[j] = i;
      }
    }
  }
  const out: [number, number][] = [];
  for (let j = m; j > 0; j = from[j]!) out.push([B[from[j]!]!, B[j]! - 1]);
  return out.reverse();
}

/**
 * Tách câu theo khoảng lặng thật. Ranh giới BẮT BUỘC ở khoảng lặng ≥ 0.3 s (gán vào ranh giới giữa hai từ gần nhất); đoạn giữa hai ranh giới dài hơn 12 s hoặc hơn 30 từ
 * được chia tiếp ở các khoảng lặng ngắn hơn (ưu tiên khoảng lặng dài, độ dài gần 5 s, không dưới 2 s); không còn khoảng lặng nào thì cắt ở khe lớn nhất giữa hai từ.
 * Mốc segment ~20 s của dịch vụ KHÔNG dùng làm ranh giới câu.
 */
export function segmentByPauses(words: TWord[], pauses: Pause[]): [number, number][] {
  const n = words.length;
  if (!n) return [];
  const cand = boundaryCandidates(words, pauses);
  const mandatory = [...cand].filter(([, strength]) => strength >= PAUSE_STRONG_S - 1e-9).map(([k]) => k).sort((a, b) => a - b);
  const cuts = [0, ...mandatory, n];
  const out: [number, number][] = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c]!;
    const b = cuts[c + 1]!;
    if (fits(words, a, b)) out.push([a, b - 1]);
    else out.push(...dpSplit(words, a, b, cand));
  }
  return out;
}

/** Tổng thời gian có lời ÷ thời lượng: gộp các từ cách nhau < 0.5 giây thành một khoảng nói. */
export function speechRatio(words: { start: number; end: number }[], durationS: number): number {
  if (!words.length || durationS <= 0) return 0;
  let total = 0;
  let curStart = words[0]!.start;
  let curEnd = words[0]!.end;
  for (let k = 1; k < words.length; k++) {
    const w = words[k]!;
    if (w.start - curEnd < 0.5) curEnd = Math.max(curEnd, w.end);
    else {
      total += curEnd - curStart;
      curStart = w.start;
      curEnd = w.end;
    }
  }
  total += curEnd - curStart;
  return round3(Math.min(1, total / durationS));
}

// ---------------------------------------------------------------- tra cứu / bám khoảng lặng

/** Câu chứa từ `wordIdx` (tìm nhị phân); undefined nếu ngoài khoảng. */
export function sentenceOfWord(t: Pick<Transcript, 'sentences'>, wordIdx: number): TSentence | undefined {
  let lo = 0;
  let hi = t.sentences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = t.sentences[mid]!;
    if (wordIdx < s.start_word) hi = mid - 1;
    else if (wordIdx > s.end_word) lo = mid + 1;
    else return s;
  }
  return undefined;
}

/**
 * Điểm cắt bám khoảng lặng từ chỉ số từ: start = start của từ đầu − 0.15 s nhưng không lùi quá end của từ trước + 0.02 s;
 * end = end của từ cuối + 0.30 s nhưng không quá start của từ sau − 0.02 s và ≤ thời lượng video. Không bao giờ cắt vào giữa một từ.
 */
export function snapBounds(t: Pick<Transcript, 'words' | 'duration_s'> & { pauses?: Pause[] }, startWord: number, endWord: number): { start_s: number; end_s: number } {
  const a = t.words[startWord];
  const b = t.words[endWord];
  if (!a || !b || endWord < startWord) throw new RangeError(`chỉ số từ không hợp lệ: ${startWord}..${endWord}`);
  const prev = t.words[startWord - 1];
  const next = t.words[endWord + 1];
  let start = a.start - SNAP_START_PAD_S;
  if (prev) start = Math.max(start, prev.end + SNAP_NEIGHBOR_GAP_S);
  start = Math.min(start, a.start); // từ trước chồng lên từ đầu: không đẩy start ra sau từ đầu
  let end = b.end + SNAP_END_PAD_S;
  if (next) end = Math.min(end, next.start - SNAP_NEIGHBOR_GAP_S);
  end = Math.max(end, b.end); // từ sau chồng lên từ cuối: không cắt vào từ cuối
  // khoảng lặng thật gần từ biên (≤ 0.4 s) thì đặt điểm cắt BÊN TRONG khoảng lặng đó
  const ps = t.pauses;
  if (ps?.length) {
    let before: Pause | undefined;
    let after: Pause | undefined;
    for (const p of ps) {
      if (p.end <= a.start + 0.05 && a.start - p.end <= SNAP_PAUSE_REACH_S) before = p;
      if (!after && p.end > b.end && p.start >= b.end - 0.05 && p.start - b.end <= SNAP_PAUSE_REACH_S) after = p;
      if (p.start > b.end + SNAP_PAUSE_REACH_S) break;
    }
    if (before && before.end - before.start > 2 * SNAP_NEIGHBOR_GAP_S) {
      const lo = before.start + SNAP_NEIGHBOR_GAP_S;
      const hi = Math.max(lo, before.end - SNAP_NEIGHBOR_GAP_S);
      start = Math.min(a.start, Math.max(lo, Math.min(a.start - SNAP_START_PAD_S, hi)));
    }
    if (after && after.end - after.start > 2 * SNAP_NEIGHBOR_GAP_S) {
      const lo = Math.max(b.end, after.start + SNAP_NEIGHBOR_GAP_S);
      const hi = Math.max(lo, after.end - SNAP_NEIGHBOR_GAP_S);
      end = Math.max(b.end, Math.min(hi, Math.max(lo, b.end + SNAP_END_PAD_S)));
    }
  }
  // A pause near a boundary may span a neighboring word: preserve the neighbor clamps too.
  if (prev) start = Math.min(a.start, Math.max(start, prev.end + SNAP_NEIGHBOR_GAP_S));
  if (next) end = Math.max(b.end, Math.min(end, next.start - SNAP_NEIGHBOR_GAP_S));
  if (t.duration_s > 0) end = Math.min(end, Math.max(t.duration_s, b.end));
  return { start_s: round3(Math.max(0, start)), end_s: round3(end) };
}

/** Đoạn trích lời thoại (≤ max ký tự, cắt ở ranh giới từ, thêm "…"). */
export function excerptOf(words: { w: string }[], max = 400): string {
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w.w}` : w.w;
    if (next.length > max - 1) return `${out}…`;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------- cửa sổ cho AI

export interface ClipWindow {
  from_id: number;
  to_id: number;
}

/**
 * Chia câu thành cửa sổ 15–20 phút, chồng 60 giây, tính theo ID câu (kết thúc ở ranh giới câu). Video ≤ 20 phút: một cửa sổ.
 * Cửa sổ cuối ngắn hơn 3 phút được nuốt vào cửa sổ trước nếu tổng ≤ 23 phút. Mỗi câu thuộc ít nhất một cửa sổ.
 */
export function buildWindows(sentences: Pick<TSentence, 'id' | 'start' | 'end'>[], o: { targetS?: number; maxS?: number; overlapS?: number; tailS?: number } = {}): ClipWindow[] {
  const target = o.targetS ?? 17 * 60;
  const max = o.maxS ?? 20 * 60;
  const overlap = o.overlapS ?? 60;
  const tail = o.tailS ?? 180;
  const n = sentences.length;
  if (n === 0) return [];
  if (sentences[n - 1]!.end - sentences[0]!.start <= max) return [{ from_id: sentences[0]!.id, to_id: sentences[n - 1]!.id }];
  const windows: ClipWindow[] = [];
  let i0 = 0;
  for (;;) {
    const startT = sentences[i0]!.start;
    let j = i0;
    while (j + 1 < n && sentences[j + 1]!.end - startT <= target) j++;
    // đuôi còn lại ngắn: nuốt luôn nếu không quá dài
    if (j < n - 1 && sentences[n - 1]!.end - sentences[j]!.end < tail && sentences[n - 1]!.end - startT <= max + tail) j = n - 1;
    windows.push({ from_id: sentences[i0]!.id, to_id: sentences[j]!.id });
    if (j >= n - 1) break;
    // cửa sổ kế bắt đầu ở câu đầu tiên có start ≥ end(j) − overlap (luôn tiến lên ít nhất 1 câu)
    let k = j + 1;
    while (k - 1 > i0 && sentences[k - 1]!.start >= sentences[j]!.end - overlap) k--;
    i0 = Math.max(i0 + 1, k);
  }
  return windows;
}

// ---------------------------------------------------------------- xuất SRT / TXT / trang

const pad = (n: number, w = 2): string => String(Math.floor(n)).padStart(w, '0');

export function srtTime(s: number): string {
  const ms = Math.round(Math.max(0, s) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms % 1000, 3)}`;
}

export function clockTime(s: number): string {
  const t = Math.floor(Math.max(0, s));
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

const capFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** SRT theo câu (viết hoa chữ đầu câu). */
export function transcriptSrt(t: Pick<Transcript, 'sentences'>): string {
  return t.sentences.map((s, k) => `${k + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${capFirst(s.text)}\n`).join('\n');
}

/** TXT: mỗi câu một dòng `[hh:mm:ss] nội dung`. */
export function transcriptTxt(t: Pick<Transcript, 'sentences'>): string {
  return t.sentences.map((s) => `[${clockTime(s.start)}] ${capFirst(s.text)}`).join('\n') + (t.sentences.length ? '\n' : '');
}

/** Một trang câu cho `GET /api/sources/:id/transcript`: phân trang theo câu, mỗi câu kèm từ. */
export function transcriptPage(t: Pick<Transcript, 'sentences' | 'words'>, from: number, limit: number) {
  const f = Math.max(0, Math.floor(from));
  const slice = t.sentences.slice(f, f + Math.max(1, Math.floor(limit)));
  return {
    total: t.sentences.length,
    sentences: slice.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      words: t.words.slice(s.start_word, s.end_word + 1).map((w) => ({ i: w.i, w: w.w, start: w.start, end: w.end })),
    })),
  };
}

// ---------------------------------------------------------------- so khớp từ (khôi phục dấu câu, start_quote)

/** Chuẩn hoá một từ để so khớp: NFC, chữ thường, bỏ dấu câu ở hai đầu. */
export function normToken(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * `captionWords` (khôi phục chữ thường/dấu câu) có GIỮ NGUYÊN dãy từ ASR không: đủ từ `startWord..endWord` liên tiếp và từng từ, bỏ dấu câu + chữ thường,
 * trùng từ ASR. Sai ở đâu thì không dùng (bản ASR được dùng). Trả danh sách đã chuẩn hoá `{i, w}` hoặc null.
 */
export function validateCaptionWords(
  t: Pick<Transcript, 'words'>,
  startWord: number,
  endWord: number,
  captionWords: unknown,
): { i: number; w: string }[] | null {
  if (!Array.isArray(captionWords) || captionWords.length !== endWord - startWord + 1) return null;
  const out: { i: number; w: string }[] = [];
  for (let k = 0; k < captionWords.length; k++) {
    const c = captionWords[k] as { i?: unknown; w?: unknown } | null;
    const i = startWord + k;
    if (!c || c.i !== i || typeof c.w !== 'string') return null;
    const asr = t.words[i];
    if (!asr) return null;
    const w = c.w.replace(/\s+/g, ' ').trim();
    if (!w || w.length > 60 || normToken(w) !== normToken(asr.w)) return null;
    out.push({ i, w });
  }
  return out;
}
