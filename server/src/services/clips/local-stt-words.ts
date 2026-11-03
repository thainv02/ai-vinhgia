/**
 * Ghép kết quả token của gipformer (sherpa-onnx, offline transducer) thành từ có mốc thời gian, dạng `SttVerbose` như dịch vụ STT trả.
 * Token bắt đầu từ mới có khoảng trắng đầu (BPE `▁` được sherpa đổi thành dấu cách): `[" LẠI", " ĐƯỢC", " PH", "Ẩ", "Y"]` → LẠI | ĐƯỢC | PHẨY.
 * Model trả CHỮ HOA, không dấu câu: đổi sang chữ thường, viết hoa từ đầu câu (đầu đoạn VAD hoặc sau khoảng lặng ≥ `SENTENCE_GAP_S`).
 * Cuối từ = đầu token đầu của từ kế (cùng đoạn), kẹp tối đa `MAX_WORD_S`; từ cuối đoạn kết thúc ở cuối đoạn VAD (cũng kẹp).
 */
import type { SttSegment, SttVerbose, SttWord } from './stt-client.js';

export interface DecodedSegment {
  /** Giây bắt đầu của đoạn VAD trong cả file. */
  offset: number;
  /** Độ dài đoạn (giây). */
  duration: number;
  tokens: string[];
  /** Mốc đầu từng token, tính từ đầu đoạn (giây). */
  timestamps: number[];
  /** log xác suất từng token (có thể thiếu). */
  logProbs?: number[];
}

const MAX_WORD_S = 1.2;
const SENTENCE_GAP_S = 0.8;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const lower = (s: string) => s.toLocaleLowerCase('vi');
const capitalize = (s: string) => (s ? s[0]!.toLocaleUpperCase('vi') + s.slice(1) : s);

export function segmentWords(seg: DecodedSegment): { w: string; start: number; end: number; p: number }[] {
  const groups: { text: string; start: number; logps: number[] }[] = [];
  seg.tokens.forEach((tok, i) => {
    const t = seg.timestamps[i] ?? 0;
    const lp = seg.logProbs?.[i];
    const startsWord = /^\s/.test(tok) || groups.length === 0;
    const piece = tok.replace(/^\s+/, '');
    if (!piece) return;
    if (startsWord) groups.push({ text: piece, start: t, logps: [] });
    else groups[groups.length - 1]!.text += piece;
    if (typeof lp === 'number' && Number.isFinite(lp)) groups[groups.length - 1]!.logps.push(lp);
  });
  return groups.map((g, i) => {
    const start = seg.offset + g.start;
    const next = i + 1 < groups.length ? seg.offset + groups[i + 1]!.start : seg.offset + seg.duration;
    const end = Math.max(start + 0.05, Math.min(next, start + MAX_WORD_S));
    const p = g.logps.length ? Math.exp(g.logps.reduce((a, b) => a + b, 0) / g.logps.length) : 1;
    return { w: lower(g.text), start: round3(start), end: round3(end), p: round3(Math.min(1, Math.max(0, p))) };
  });
}

/** Các đoạn VAD đã nhận dạng (theo thứ tự thời gian) → `SttVerbose`. Đoạn không có chữ bị bỏ. */
export function toVerbose(segs: DecodedSegment[], meta: { duration: number; model: string; elapsedMs: number }): SttVerbose {
  const words: SttWord[] = [];
  const segments: SttSegment[] = [];
  let prevEnd = -Infinity;
  for (const seg of segs) {
    const ws = segmentWords(seg);
    if (!ws.length) continue;
    ws.forEach((w, k) => {
      const sentenceStart = (k === 0 && ws[0]!.start - prevEnd >= SENTENCE_GAP_S) || (k > 0 && w.start - ws[k - 1]!.end >= SENTENCE_GAP_S) || words.length === 0;
      words.push({ word: sentenceStart ? capitalize(w.w) : w.w, start: w.start, end: w.end, probability: w.p });
    });
    const from = words.length - ws.length;
    segments.push({ id: segments.length, start: ws[0]!.start, end: ws[ws.length - 1]!.end, text: words.slice(from).map((w) => w.word).join(' ') });
    prevEnd = ws[ws.length - 1]!.end;
  }
  return { language: 'vi', duration: meta.duration, text: segments.map((s) => s.text).join(' '), segments, words, elapsed_ms: meta.elapsedMs, model: meta.model };
}
