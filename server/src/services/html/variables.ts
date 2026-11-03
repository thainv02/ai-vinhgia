/**
 * Biến sửa nhanh của phiên bản Video HTML (plan mục 6.3): chữ / màu / ảnh. KHÔNG replace chuỗi mù và không nhận HTML tuỳ ý:
 *  - text: chỉ thay NỘI DUNG CHỮ của phần tử mang `data-hf-var="<target>"` khi phần tử đó không có thẻ con; giá trị được escape;
 *  - color: `#rrggbb`, ghi vào khối `<style data-hf-vars>:root{--hf-<id>:#rrggbb}</style>` của index.html (HTML dùng `var(--hf-<id>)`);
 *  - asset: id asset của dự án → thuộc tính `src` (img/video/audio/source) trỏ tới `assets/u/<id>.<ext>`; không nhập URL ngoài.
 * Bộ tách thẻ nhỏ, đủ cho HTML do AI sinh: bỏ qua chú thích, <script>/<style>/<textarea>/<title> (raw text), tôn trọng dấu nháy trong thuộc tính.
 */
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { ManifestFile } from './safe-path.js';
import type { HtmlVariable } from './view.js';

export const MAX_VARIABLES = 30;
export const TEXT_DEFAULT_MAX = 300;
export const TEXT_HARD_MAX = 2000;
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const noControl = (s: string) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(s);
const codePoints = (s: string): number => [...s].length;

export const variableSchema = z.object({
  id: z.string().regex(ID_RE, 'id biến: chữ thường, số, _ hoặc -, bắt đầu bằng chữ, tối đa 32 ký tự'),
  type: z.enum(['text', 'color', 'asset']),
  label: z.string().trim().min(1).max(80).refine(noControl, 'không được chứa ký tự điều khiển'),
  value: z.string().max(TEXT_HARD_MAX),
  target: z.string().regex(ID_RE, 'target phải là giá trị data-hf-var (cùng quy tắc id)').optional(),
  maxLength: z.number().int().min(1).max(TEXT_HARD_MAX).optional(),
});

export const variablesSchema = z
  .array(variableSchema)
  .max(MAX_VARIABLES, `tối đa ${MAX_VARIABLES} biến`)
  .superRefine((vars, ctx) => {
    const seen = new Set<string>();
    vars.forEach((v, i) => {
      if (seen.has(v.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `id biến trùng: ${v.id}` });
      seen.add(v.id);
    });
  });

const bad = (code: string, message: string): AppError => new AppError(code, message, 400);

/** Kiểm tra giá trị theo loại; trả về biến đã chuẩn hoá (target mặc định = id). */
export function normalizeVariable(v: z.infer<typeof variableSchema>, assetIds: ReadonlySet<number>): HtmlVariable {
  const out: HtmlVariable = { id: v.id, type: v.type, label: v.label, value: v.value, target: v.target ?? v.id, ...(v.maxLength ? { maxLength: v.maxLength } : {}) };
  assertValue(out, v.value, assetIds);
  return out;
}

/** Giá trị mới `value` có hợp lệ cho biến `v` không (ném 400 VARIABLE_INVALID). */
export function assertValue(v: HtmlVariable, value: string, assetIds: ReadonlySet<number>): void {
  if (typeof value !== 'string') throw bad('VARIABLE_INVALID', `Biến ${v.id}: giá trị phải là chuỗi`);
  if (v.type === 'color') {
    if (!COLOR_RE.test(value)) throw bad('VARIABLE_INVALID', `Biến ${v.id}: màu phải dạng #rrggbb`);
  } else if (v.type === 'asset') {
    if (!/^\d{1,9}$/.test(value) || !assetIds.has(Number(value))) throw bad('VARIABLE_INVALID', `Biến ${v.id}: asset không thuộc dự án`);
  } else {
    if (!noControl(value)) throw bad('VARIABLE_INVALID', `Biến ${v.id}: chữ không được chứa ký tự điều khiển hoặc xuống dòng`);
    const max = v.maxLength ?? TEXT_DEFAULT_MAX;
    if (codePoints(value) > max) throw bad('VARIABLE_INVALID', `Biến ${v.id}: chữ dài quá ${max} ký tự`);
  }
}

// ---------------------------------------------------------------- bộ tách thẻ

interface Attr {
  name: string;
  value: string | null;
  /** [start, end) của cả thuộc tính trong chuỗi HTML. */
  start: number;
  end: number;
}
interface Tag {
  name: string;
  start: number;
  /** Chỉ số ngay sau `>` của thẻ mở. */
  end: number;
  /** Chỉ số của `>` (hoặc `/>`) để chèn thuộc tính. */
  insertAt: number;
  attrs: Attr[];
  selfClosing: boolean;
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function parseTag(html: string, start: number): Tag | null {
  let i = start + 1;
  const m = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(i, i + 64));
  if (!m) return null;
  const name = m[0].toLowerCase();
  i += m[0].length;
  const attrs: Attr[] = [];
  const n = html.length;
  while (i < n) {
    while (i < n && /\s/.test(html[i]!)) i++;
    if (i >= n) return null;
    const c = html[i]!;
    if (c === '>') return { name, start, end: i + 1, insertAt: i, attrs, selfClosing: false };
    if (c === '/' && html[i + 1] === '>') return { name, start, end: i + 2, insertAt: i, attrs, selfClosing: true };
    if (c === '/') {
      i++;
      continue;
    }
    const as = i;
    while (i < n && !/[\s=>/]/.test(html[i]!)) i++;
    const an = html.slice(as, i).toLowerCase();
    if (i === as) {
      i++; // ký tự lạ: bỏ qua để không lặp vô hạn
      continue;
    }
    let j = i;
    while (j < n && /\s/.test(html[j]!)) j++;
    let value: string | null = null;
    let ae = i;
    if (html[j] === '=') {
      j++;
      while (j < n && /\s/.test(html[j]!)) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close < 0) return null;
        value = html.slice(j + 1, close);
        ae = close + 1;
      } else {
        let k = j;
        while (k < n && !/[\s>]/.test(html[k]!)) k++;
        value = html.slice(j, k);
        ae = k;
      }
      i = ae;
    }
    attrs.push({ name: an, value, start: as, end: ae });
  }
  return null;
}

/** Vị trí ngay sau chú thích bắt đầu ở `lt` — như trình duyệt: `<!-->`/`<!--->` đóng ngay, kết thúc ở `-->` hoặc `--!>` (cái nào trước). */
export function commentEnd(html: string, lt: number): number {
  if (html.startsWith('<!-->', lt)) return lt + 5;
  if (html.startsWith('<!--->', lt)) return lt + 6;
  const a = html.indexOf('-->', lt + 4);
  const b = html.indexOf('--!>', lt + 4);
  if (a < 0 && b < 0) return html.length;
  return a >= 0 && (b < 0 || a < b) ? a + 3 : b + 4;
}

/** Mọi thẻ mở (không gồm thẻ trong chú thích hoặc trong nội dung raw-text). */
export function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      i = commentEnd(html, lt);
      continue;
    }
    const nx = html[lt + 1];
    if (nx === '!' || nx === '?' || nx === '/') {
      const e = html.indexOf('>', lt + 1);
      i = e < 0 ? html.length : e + 1;
      continue;
    }
    const tag = parseTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    tags.push(tag);
    i = tag.end;
    if (RAW_TEXT.has(tag.name) && !tag.selfClosing) {
      const re = new RegExp(`</${tag.name}(?=[\\s/>])`, 'i');
      const m = re.exec(html.slice(i));
      i = m ? i + m.index : html.length;
    }
  }
  return tags;
}

const attrOf = (t: Tag, name: string): Attr | undefined => t.attrs.find((a) => a.name === name);
const targetsOf = (html: string, target: string): Tag[] => scanTags(html).filter((t) => attrOf(t, 'data-hf-var')?.value === target);

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Giải mã thực thể HTML cơ bản (chỉ để so sánh nội dung). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Phạm vi nội dung chữ của phần tử không có thẻ con: [start, end). Ném VARIABLE_TARGET_INVALID nếu có thẻ con/raw-text/void. */
function textRange(html: string, t: Tag, id: string): [number, number] {
  if (t.selfClosing || VOID.has(t.name) || RAW_TEXT.has(t.name)) throw bad('VARIABLE_TARGET_INVALID', `Biến ${id}: phần tử <${t.name}> không thay chữ được`);
  const j = html.indexOf('<', t.end);
  const closeRe = new RegExp(`^</${t.name}\\s*>`, 'i');
  if (j < 0 || !closeRe.test(html.slice(j, j + t.name.length + 8))) {
    throw bad('VARIABLE_TARGET_INVALID', `Biến ${id}: phần tử <${t.name} data-hf-var="${id}"> có thẻ con hoặc chưa đóng; chỉ thay được phần tử chỉ chứa chữ`);
  }
  return [t.end, j];
}

const HTML_FILE = (p: string): boolean => p === 'index.html' || (p.startsWith('compositions/') && p.endsWith('.html'));

/**
 * Kiểm tra biến AI/ người dùng khai báo KHỚP nội dung thực tế của các file: text → mọi phần tử đích có đúng chữ đó (so sánh sau khi giải mã
 * thực thể và gộp khoảng trắng); asset → phần tử đích là img/video/audio/source; mọi biến text/asset cần ≥ 1 phần tử đích. Ném 400 VARIABLE_MISMATCH.
 */
export function checkVariables(files: ManifestFile[], vars: HtmlVariable[]): void {
  const htmls = files.filter((f) => HTML_FILE(f.path));
  for (const v of vars) {
    if (v.type === 'color') continue;
    let found = 0;
    for (const f of htmls) {
      for (const t of targetsOf(f.content, v.target)) {
        found++;
        if (v.type === 'text') {
          const [a, b] = textRange(f.content, t, v.id);
          if (squash(decodeEntities(f.content.slice(a, b))) !== squash(v.value)) {
            throw bad('VARIABLE_MISMATCH', `Biến ${v.id}: giá trị khai báo không khớp chữ thực tế của phần tử data-hf-var="${v.target}" trong ${f.path}`);
          }
        } else if (!['img', 'video', 'audio', 'source'].includes(t.name)) {
          throw bad('VARIABLE_TARGET_INVALID', `Biến ${v.id}: biến ảnh chỉ áp cho img/video/audio/source (gặp <${t.name}>)`);
        }
      }
    }
    if (!found) throw bad('VARIABLE_TARGET_NOT_FOUND', `Biến ${v.id}: không có phần tử nào mang data-hf-var="${v.target}"`);
  }
}

const VARS_BLOCK = /<style data-hf-vars>[\s\S]*?<\/style>\s*/i;

/**
 * Áp toàn bộ giá trị biến lên các file (bản sao; không sửa đầu vào). `assetPath(id)` trả đường dẫn `assets/u/<id>.<ext>` của asset đã duyệt (hoặc null).
 * Idempotent: áp lại cùng giá trị cho cùng kết quả.
 */
export function applyVariables(files: ManifestFile[], vars: HtmlVariable[], assetPath: (id: number) => string | null): ManifestFile[] {
  const out = files.map((f) => ({ ...f }));
  const colors = vars.filter((v) => v.type === 'color');
  for (const v of vars) {
    if (v.type === 'color') {
      if (!COLOR_RE.test(v.value)) throw bad('VARIABLE_INVALID', `Biến ${v.id}: màu phải dạng #rrggbb`);
      continue;
    }
    let found = 0;
    for (const f of out) {
      if (!HTML_FILE(f.path)) continue;
      // áp từ cuối về đầu để chỉ số của các thẻ trước không bị lệch
      for (const t of targetsOf(f.content, v.target).reverse()) {
        found++;
        if (v.type === 'text') {
          assertValue(v, v.value, new Set());
          const [a, b] = textRange(f.content, t, v.id);
          f.content = f.content.slice(0, a) + escapeText(v.value) + f.content.slice(b);
        } else {
          if (!['img', 'video', 'audio', 'source'].includes(t.name)) throw bad('VARIABLE_TARGET_INVALID', `Biến ${v.id}: biến ảnh chỉ áp cho img/video/audio/source (gặp <${t.name}>)`);
          const p = /^\d{1,9}$/.test(v.value) ? assetPath(Number(v.value)) : null;
          if (!p) throw bad('VARIABLE_INVALID', `Biến ${v.id}: asset không thuộc dự án`);
          const src = attrOf(t, 'src');
          f.content = src ? f.content.slice(0, src.start) + `src="${p}"` + f.content.slice(src.end) : f.content.slice(0, t.insertAt) + ` src="${p}"` + f.content.slice(t.insertAt);
        }
      }
    }
    if (!found) throw bad('VARIABLE_TARGET_NOT_FOUND', `Biến ${v.id}: không có phần tử nào mang data-hf-var="${v.target}"`);
  }
  // biến màu → khối :root (tạo mới/thay thế/xoá)
  const idx = out.find((f) => f.path === 'index.html');
  if (idx) {
    const has = VARS_BLOCK.test(idx.content);
    const block = colors.length ? `<style data-hf-vars>:root{${colors.map((c) => `--hf-${c.id}:${c.value.toLowerCase()};`).join('')}}</style>\n` : '';
    if (has) idx.content = idx.content.replace(VARS_BLOCK, () => block);
    else if (block) {
      const head = /<\/head\s*>/i.exec(idx.content);
      idx.content = head ? idx.content.slice(0, head.index) + block + idx.content.slice(head.index) : block + idx.content;
    }
  } else if (colors.length) throw bad('VARIABLE_TARGET_NOT_FOUND', 'Thiếu index.html để ghi biến màu');
  return out;
}
