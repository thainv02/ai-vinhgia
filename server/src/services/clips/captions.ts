/**
 * Phụ đề chạy theo từng từ: gom từ thành cụm, sinh ASS (libass) và SRT. Thuần (không DB/ffmpeg) để test được.
 *
 * Ý tưởng tô từng từ bằng một `Dialogue` cho mỗi từ (hiển thị cả cụm, từ đang nói đổi màu) port từ `build_ass.py` của
 * louisedesadeleer/clipify (MIT); quy tắc ngắt cụm (ngắt cứng ở khoảng lặng ≥ 0.6 s, ngắt mềm ở dấu phẩy hoặc khoảng lặng ≥ 0.35 s) tự viết lại.
 * Phần còn lại (độ dài cụm, ASS/SRT bằng TypeScript, escape, ẩn từ, gộp từ khi sửa tay) là code của dự án này.
 */
import { z } from 'zod';
import { CAPTION_PRESETS, type CaptionPreset } from '../../db/types.js';
import { pauseBefore, srtTime, type Transcript } from './transcript.js';

export interface CapWord {
  /** Chữ hiển thị (đã khôi phục dấu câu / sửa tay, hoặc chữ ASR viết hoa đầu câu). */
  w: string;
  /** Giây TUYỆT ĐỐI trong video nguồn. */
  start: number;
  end: number;
}

export const HARD_BREAK_GAP_S = 0.6;
export const SOFT_BREAK_GAP_S = 0.35;
export const HIGHLIGHT_WORDS = 3;
export const MINIMAL_MAX_WORDS = 8;
export const MINIMAL_MAX_CHARS = 42;
export const MINIMAL_MAX_S = 3.2;

/** ASS: &HBBGGRR& — vàng cho "highlight", xanh lá cho "karaoke". */
export const HIGHLIGHT_COLOR = '&H00FFFF&';
export const KARAOKE_COLOR = '&H00FF00&';

const capFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Từ hiển thị của clip. Có `captionWords` (đã khôi phục dấu câu hoặc sửa tay) thì dùng đúng chữ đó; ngược lại dùng chữ ASR, viết hoa chữ đầu câu.
 * Từ có chữ rỗng là từ bị ẩn: thời gian của nó được cộng vào từ hiển thị đứng trước (nên "ca cao a tiso" → "Cacao" kéo dài qua "ca" và "cao").
 */
export function displayWords(t: Pick<Transcript, 'words' | 'sentences' | 'pauses'>, startWord: number, endWord: number, captionWords: { i: number; w: string }[] | null): CapWord[] {
  const map = captionWords ? new Map(captionWords.map((c) => [c.i, c.w])) : null;
  const out: CapWord[] = [];
  for (let i = startWord; i <= endWord; i++) {
    const a = t.words[i];
    if (!a) break;
    const text = map?.has(i) ? map.get(i)! : i === startWord || pauseBefore(t, i) >= HARD_BREAK_GAP_S || /[.!?…]["'”’)]*$/.test(out.at(-1)?.w ?? '') ? capFirst(a.w) : a.w;
    if (!text.trim()) {
      const prev = out[out.length - 1];
      if (prev) prev.end = Math.max(prev.end, a.end);
      continue;
    }
    out.push({ w: text.trim(), start: a.start, end: a.end });
  }
  return out;
}

/** Chia cụm. `highlight`/`karaoke`: 3 từ; `minimal`: ≤ 8 từ, 42 ký tự, 3.2 giây. Ngắt cứng ở khoảng lặng ≥ 0.6 s, ngắt mềm ở dấu phẩy hoặc khoảng lặng ≥ 0.35 s. */
export function groupWords(words: CapWord[], preset: CaptionPreset): CapWord[][] {
  const wordsMode = preset === 'highlight' || preset === 'karaoke';
  const maxWords = wordsMode ? HIGHLIGHT_WORDS : MINIMAL_MAX_WORDS;
  const softMin = wordsMode ? 2 : 4;
  const groups: CapWord[][] = [];
  let cur: CapWord[] = [];
  const chars = (g: CapWord[]): number => g.reduce((a, w) => a + w.w.length, 0) + Math.max(0, g.length - 1);
  words.forEach((w, k) => {
    // thêm từ này có làm cụm vượt giới hạn không (chỉ áp dụng giới hạn ký tự/giây cho "minimal")
    if (cur.length && !wordsMode && (chars([...cur, w]) > MINIMAL_MAX_CHARS || w.end - cur[0]!.start > MINIMAL_MAX_S)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    const next = words[k + 1];
    const gap = next ? Math.round((next.start - w.end) * 1000) / 1000 : Infinity; // làm tròn mili giây: 0.6 s phải là 0.6, không phải 0.5999999
    const hard = gap >= HARD_BREAK_GAP_S;
    const soft = cur.length >= softMin && (/[,;:.!?…]$/.test(w.w) || gap >= SOFT_BREAK_GAP_S);
    if (!next || hard || soft || cur.length >= maxWords) {
      groups.push(cur);
      cur = [];
    }
  });
  if (cur.length) groups.push(cur);
  return groups;
}

// ---------------------------------------------------------------- ASS

/** Bỏ ký tự điều khiển của ASS trong chữ do người dùng/AI nhập: `{` `}` thành `(` `)`, `\` thành `/`, xuống dòng thành khoảng trắng. */
export function escapeAssText(s: string): string {
  return s.replace(/[{]/g, '(').replace(/[}]/g, ')').replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f\s]+/g, ' ');
}

const cs = (n: number): number => Math.max(0, Math.round(n * 100));
export function assTime(sec: number): string {
  const total = cs(sec);
  const h = Math.floor(total / 360000);
  const m = Math.floor((total % 360000) / 6000);
  const s = Math.floor((total % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(total % 100).padStart(2, '0')}`;
}

/**
 * Vị trí hộp phụ đề, tỉ lệ 0–1 của khung ĐẦU RA: `left` = mép trái, `width` = bề rộng hộp, `bottom` = khoảng cách từ đáy khung tới đáy hộp.
 * Thiếu layout = căn giữa-dưới như mặc định.
 */
export const captionLayoutSchema = z
  .object({
    left: z.number().min(0).max(1),
    width: z.number().min(0.25).max(1),
    bottom: z.number().min(0).max(0.9),
  })
  .refine((l) => l.left + l.width <= 1 + 1e-9, { message: 'left + width không được vượt quá 1' });
export type CaptionLayout = z.infer<typeof captionLayoutSchema>;

/** Lề ASS theo layout: MarginL/MarginR/MarginV (px của PlayRes). */
export function layoutMargins(l: CaptionLayout, width: number, height: number): { marginL: number; marginR: number; marginV: number } {
  return {
    marginL: Math.max(0, Math.round(l.left * width)),
    marginR: Math.max(0, Math.round((1 - l.left - l.width) * width)),
    marginV: Math.max(0, Math.round(l.bottom * height)),
  };
}

export interface CaptionStyle {
  preset: CaptionPreset;
  layout: CaptionLayout | null;
}

/** Kiểu phụ đề từ JSON đã lưu (clip hoặc bản dựng): preset mặc định `highlight`, layout hỏng/ngoài khoảng bị bỏ (về mặc định). */
export function parseCaptionStyle(raw: string | null | undefined): CaptionStyle {
  let o: { preset?: unknown; layout?: unknown } = {};
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === 'object') o = v as typeof o;
  } catch {
    /* JSON hỏng: dùng mặc định */
  }
  const preset = (CAPTION_PRESETS as readonly string[]).includes(o.preset as string) ? (o.preset as CaptionPreset) : 'highlight';
  const lay = captionLayoutSchema.safeParse(o.layout);
  return { preset, layout: lay.success ? lay.data : null };
}

/** Hai kiểu có giống nhau không (layout so sánh tới 4 chữ số thập phân). */
export function sameCaptionStyle(a: CaptionStyle, b: CaptionStyle): boolean {
  if (a.preset !== b.preset) return false;
  if (!a.layout || !b.layout) return !a.layout && !b.layout;
  const r = (x: number): number => Math.round(x * 1e4);
  return r(a.layout.left) === r(b.layout.left) && r(a.layout.width) === r(b.layout.width) && r(a.layout.bottom) === r(b.layout.bottom);
}

/** JSON lưu vào `clips.captions` / `clip_cuts.captions`: `{preset}` và thêm `layout` chỉ khi có (bản mặc định giữ đúng dạng cũ). */
export function captionStyleJson(s: CaptionStyle): string {
  return JSON.stringify(s.layout ? { preset: s.preset, layout: s.layout } : { preset: s.preset });
}

export interface AssOptions {
  preset: Exclude<CaptionPreset, 'none'>;
  /** Độ phân giải đầu ra (PlayRes). */
  width: number;
  height: number;
  font: string;
  /** Giây tuyệt đối của đầu clip: mọi thời gian trong ASS tính từ đây. */
  clipStart: number;
  clipEnd: number;
  /** Vị trí hộp phụ đề do người dùng kéo; thiếu = mặc định (căn giữa-dưới). */
  layout?: CaptionLayout | null;
}

/** Cỡ chữ, viền, lề theo kích thước khung (chuẩn của đặc tả: 1080×1920, viền 8, bóng 3, MarginV 300). */
export function assMetrics(width: number, height: number, preset: Exclude<CaptionPreset, 'none'>) {
  const scale = Math.min(width, height) / 1080;
  const portrait = height >= width * 1.5;
  const fontSize = Math.round((preset === 'minimal' ? 60 : 72) * scale);
  const marginX = Math.round(60 * scale);
  return {
    fontSize,
    outline: Math.max(2, Math.round(8 * scale)),
    shadow: Math.max(1, Math.round(3 * scale)),
    marginX,
    marginV: portrait ? Math.round(300 * scale) : Math.round(height * 0.08),
    /** Số ký tự tối đa trên một dòng để không tràn khung (WrapStyle 2 không tự xuống dòng). */
    maxLineChars: Math.max(10, Math.floor((width - 2 * marginX) / (fontSize * 0.6))),
  };
}

/** Chia chữ của một cụm thành tối đa 2 dòng tại ranh giới từ gần giữa nhất khi dài hơn `maxLineChars`. Trả chỉ số từ bắt đầu dòng 2 (null = một dòng). */
export function lineBreakIndex(words: string[], maxLineChars: number): number | null {
  const total = words.join(' ').length;
  if (total <= maxLineChars || words.length < 2) return null;
  let best = 1;
  let bestDiff = Infinity;
  let acc = 0;
  for (let k = 1; k < words.length; k++) {
    acc += words[k - 1]!.length + 1;
    const diff = Math.abs(acc - (total - acc));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = k;
    }
  }
  return best;
}

/**
 * ASS đầy đủ: PlayRes = độ phân giải đầu ra, `WrapStyle: 2`, alignment 2 (giữa-dưới), viền 8, bóng 3, MarginV 300 (cho 9:16). `highlight`/`karaoke`: mỗi từ một `Dialogue`
 * hiển thị cả cụm, từ đang nói tô màu (vàng/xanh lá); `minimal`: mỗi cụm một `Dialogue`, không tô.
 */
export function buildAss(words: CapWord[], o: AssOptions): string {
  const m = assMetrics(o.width, o.height, o.preset);
  const lay = o.layout ? layoutMargins(o.layout, o.width, o.height) : null;
  const marginL = lay?.marginL ?? m.marginX;
  const marginR = lay?.marginR ?? m.marginX;
  const marginV = lay?.marginV ?? m.marginV;
  // có layout: ngắt dòng theo bề rộng hộp (đã trừ lề) và để libass tự xuống dòng nếu vẫn tràn (WrapStyle 0); mặc định giữ nguyên WrapStyle 2
  const maxLineChars = lay ? Math.max(4, Math.floor((o.width - lay.marginL - lay.marginR) / (m.fontSize * 0.6))) : m.maxLineChars;
  const font = o.font.replace(/[,\r\n]/g, ' ').trim() || 'Arial';
  const color = o.preset === 'karaoke' ? KARAOKE_COLOR : HIGHLIGHT_COLOR;
  const lines: string[] = [
    '[Script Info]',
    '; Phụ đề sinh bởi autovideo (ý tưởng từng-từ-một-Dialogue theo clipify build_ass.py, MIT)',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    `WrapStyle: ${lay ? 0 : 2}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${m.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${m.outline},${m.shadow},2,${marginL},${marginR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Name, Style, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const rel = (t: number): number => Math.min(Math.max(0, t - o.clipStart), o.clipEnd - o.clipStart);
  const groups = groupWords(words, o.preset);
  groups.forEach((g, gi) => {
    const texts = g.map((w) => escapeAssText(w.w));
    const brk = lineBreakIndex(texts, maxLineChars);
    const render = (active: number | null): string =>
      texts
        .map((t, k) => {
          const piece = active === k ? `{\\c${color}}${t}{\\c&HFFFFFF&}` : t;
          return `${brk === k ? '\\N' : k > 0 ? ' ' : ''}${piece}`;
        })
        .join('');
    const nextGroupStart = groups[gi + 1]?.[0]?.start ?? Infinity;
    const tailEnd = Math.min(g[g.length - 1]!.end + 0.2, nextGroupStart);
    if (o.preset === 'minimal') {
      lines.push(`Dialogue: 0,${assTime(rel(g[0]!.start))},${assTime(rel(Math.max(tailEnd, g[0]!.start + 0.1)))},Default,,0,0,0,,${render(null)}`);
      return;
    }
    g.forEach((w, k) => {
      const start = w.start;
      // đến từ kế trong cụm (không để cụm nhấp nháy giữa hai từ); từ cuối giữ thêm một chút
      const end = k < g.length - 1 ? g[k + 1]!.start : tailEnd;
      lines.push(`Dialogue: 0,${assTime(rel(start))},${assTime(rel(Math.max(end, start + 0.05)))},Default,,0,0,0,,${render(k)}`);
    });
  });
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- SRT

/** Chữ trong SRT: người chơi (VLC...) đọc `{\an8}` và `<b>` như thẻ định dạng, nên bỏ các ký tự đó như với ASS. */
export function escapeSrtText(s: string): string {
  return escapeAssText(s).replace(/</g, '‹').replace(/>/g, '›');
}

/** SRT của clip: cụm kiểu "minimal" (≤ 8 từ / 42 ký tự / 3.2 giây), thời gian tính từ đầu clip. */
export function buildClipSrt(words: CapWord[], clipStart: number, clipEnd: number): string {
  const rel = (t: number): number => Math.min(Math.max(0, t - clipStart), clipEnd - clipStart);
  return groupWords(words, 'minimal')
    .map((g, k) => {
      const end = Math.max(g[g.length - 1]!.end, g[0]!.start + 0.1);
      return `${k + 1}\n${srtTime(rel(g[0]!.start))} --> ${srtTime(rel(end))}\n${g.map((w) => escapeSrtText(w.w)).join(' ')}\n`;
    })
    .join('\n');
}
