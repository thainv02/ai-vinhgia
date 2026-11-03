/**
 * Lint bảo mật riêng của Video HTML (lint của HyperFrames KHÔNG bắt fetch/WebSocket/CDN). Đây là lớp 1 (từ chối sớm cho AI sửa);
 * lớp thật là CSP meta + allowlist request của runner. Quét mã nguồn theo chuỗi nên có thể dương tính giả khi từ khóa nằm trong chú thích — chấp nhận.
 */
import { decodeEntities, scanTags } from '../variables.js';
import type { LintIssue } from '../view.js';
import { HTML_ENGINE_MARK, HTML_FONT_FAMILY } from './head.js';

export interface SrcFile {
  path: string;
  content: string;
}

const ALLOWED_SCRIPT = /^(?:\.\.\/)?(?:__hf\/gsap\.min\.js|assets\/js\/[\p{L}\p{N}_.-]+\.js)$/u;
const LOCAL_CSS = /^(?:\.\.\/)?assets\/css\/[\p{L}\p{N}_.-]+\.css$/u;
const BANNED_TAGS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'portal', 'fencedframe']);
const URL_ATTRS = new Set(['src', 'href', 'poster', 'data', 'action', 'formaction', 'xlink:href', 'background', 'ping', 'manifest', 'icon', 'cite', 'longdesc', 'usemap', 'codebase']);
const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'arial', 'helvetica', 'verdana', 'tahoma', 'trebuchet ms', 'georgia', 'times new roman', 'courier new', 'segoe ui', 'impact',
]);

interface JsRule {
  code: string;
  re: RegExp;
  msg: string;
}
const JS_RULES: JsRule[] = [
  { code: 'sec_fetch', re: /(?<![\w$.])fetch\s*\(|\bwindow\s*\.\s*fetch\b|\bglobalThis\s*\.\s*fetch\b/, msg: 'không được dùng fetch()' },
  { code: 'sec_xhr', re: /\bXMLHttpRequest\b/, msg: 'không được dùng XMLHttpRequest' },
  { code: 'sec_websocket', re: /\bWebSocket\b|\bWebTransport\b|\bRTCPeerConnection\b/, msg: 'không được dùng WebSocket/WebTransport/WebRTC' },
  { code: 'sec_eventsource', re: /\bEventSource\b/, msg: 'không được dùng EventSource' },
  { code: 'sec_beacon', re: /\bsendBeacon\b/, msg: 'không được dùng navigator.sendBeacon' },
  { code: 'sec_import', re: /(?<![\w$.])import\s*\(|^\s*import\s*[\w{*"']|\bimportScripts\s*\(/m, msg: 'không được dùng import() / import / importScripts' },
  { code: 'sec_eval', re: /(?<![\w$.])eval\s*\(|\bnew\s+Function\b|(?<![\w$.])Function\s*\(|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]/, msg: 'không được dùng eval / new Function / setTimeout(chuỗi)' },
  { code: 'sec_worker', re: /\bnew\s+(?:Shared)?Worker\b|\bserviceWorker\b|\bWorklet\b/, msg: 'không được dùng Worker/ServiceWorker/Worklet' },
  { code: 'sec_navigation', re: /(?<![\w$.])(?:window\s*\.\s*|self\s*\.\s*|globalThis\s*\.\s*)?open\s*\(|\[\s*["'`]open["'`]\s*\]|\b(?:location|top\.location|parent\.location)\s*(?:\.\s*(?:href|assign|replace))?\s*=[^=]|\blocation\s*\.\s*(?:assign|replace)\s*\(/, msg: 'không được điều hướng/mở cửa sổ' },
  { code: 'sec_parent', re: /\b(?:window\s*\.\s*)?(?:parent|top)\s*\.\s*(?:postMessage|document|location|frames)\b|\bopener\b/, msg: 'không được truy cập cửa sổ cha/opener' },
  { code: 'sec_storage', re: /\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b/, msg: 'không được dùng localStorage/sessionStorage/indexedDB/cookie' },
  { code: 'sec_remote_url_js', re: /["'`](?:https?:)?\/\/[^"'`\s]+["'`]|["'`]wss?:\/\//i, msg: 'không được ghi URL từ xa (http/https/ws) trong mã' },
  { code: 'nondeterministic', re: /\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|\bcrypto\s*\.\s*getRandomValues\b/, msg: 'không xác định (Math.random/Date.now/performance.now/new Date()/crypto.random): video phải giống nhau mỗi lần dựng' },
];

function lineOf(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** URL không an toàn trong thuộc tính/CSS: có scheme (trừ data: ở nơi cho phép), `//host`, đường dẫn tuyệt đối. Trả mô tả lỗi hoặc null. */
export function badUrl(raw: string, opts: { allowData?: boolean } = {}): string | null {
  const v = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase(); // trình duyệt bỏ ký tự điều khiển/khoảng trắng trong scheme
  if (v === '' || v.startsWith('#')) return null;
  if (v.startsWith('data:')) return opts.allowData === false ? 'data: không được phép ở đây' : null;
  if (/^[a-z][a-z0-9+.-]*:/.test(v)) return `URL có scheme "${v.split(':')[0]}:" (chỉ file nội bộ của phiên bản)`;
  if (v.startsWith('//')) return 'URL từ xa (//host)';
  if (v.startsWith('/') || v.startsWith('\\')) return 'đường dẫn tuyệt đối (chỉ dùng đường dẫn tương đối như assets/u/<id>.png)';
  if (v.includes('\\')) return 'đường dẫn chứa dấu gạch ngược';
  return null;
}

function checkCss(css: string, file: string, base: number, text: string, out: LintIssue[]): void {
  const push = (code: string, message: string, i: number) => out.push({ code, message: `${message} (dòng ${lineOf(text, base + i)})`, file });
  for (const m of css.matchAll(/@import\b/gi)) push('sec_css_import', '@import không được phép', m.index);
  for (const m of css.matchAll(/@font-face\b/gi)) push('sec_font_face', `@font-face do server chèn; không tự khai báo (chỉ dùng font-family "${HTML_FONT_FAMILY}")`, m.index);
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const u = m[1] ?? m[2] ?? m[3] ?? '';
    const bad = badUrl(u);
    if (bad) push('sec_css_url', `url() không hợp lệ: ${bad}`, m.index);
  }
  for (const m of css.matchAll(/image-set\(\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const bad = badUrl(m[1] ?? m[2] ?? '');
    if (bad) push('sec_css_url', `image-set() không hợp lệ: ${bad}`, m.index);
  }
  for (const m of css.matchAll(/(?:expression\s*\(|-moz-binding|behavior\s*:)/gi)) push('sec_css_script', 'CSS thực thi mã không được phép', m.index);
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const part of m[1]!.split(',')) {
      const name = part.replace(/!important/i, '').trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
      if (!name || name.startsWith('var(') || name === HTML_FONT_FAMILY.toLowerCase() || GENERIC_FONTS.has(name)) continue;
      push('font_family_unsupported', `font-family "${name}" không có sẵn; chỉ dùng "${HTML_FONT_FAMILY}" (hoặc sans-serif)`, m.index);
    }
  }
}

function checkJs(js: string, file: string, base: number, text: string, out: LintIssue[]): void {
  for (const r of JS_RULES) {
    const m = r.re.exec(js);
    if (m) out.push({ code: r.code, message: `${r.msg} (dòng ${lineOf(text, base + m.index)})`, file });
  }
}

/** Quét một file HTML (index/compositions), CSS (assets/css), JS (assets/js). */
export function securityLintFile(f: SrcFile): LintIssue[] {
  const out: LintIssue[] = [];
  const lower = f.path.toLowerCase();
  // Dấu phần tử do server chèn (CSP/font/runtime): AI giả dấu này để lẫn với phần của server.
  const mark = f.content.toLowerCase().indexOf(HTML_ENGINE_MARK);
  if (mark >= 0) out.push({ code: 'sec_engine_mark', message: `không được dùng "${HTML_ENGINE_MARK}" (dành cho phần do server chèn) (dòng ${lineOf(f.content, mark)})`, file: f.path });
  if (lower.endsWith('.css')) {
    checkCss(f.content, f.path, 0, f.content, out);
    return out;
  }
  if (lower.endsWith('.js')) {
    checkJs(f.content, f.path, 0, f.content, out);
    return out;
  }
  if (!lower.endsWith('.html')) return out;
  const html = f.content;
  const line = (i: number) => lineOf(html, i);
  const add = (code: string, message: string, i: number) => out.push({ code, message: `${message} (dòng ${line(i)})`, file: f.path });

  // thẻ + thuộc tính
  for (const t of scanTags(html)) {
    if (BANNED_TAGS.has(t.name)) add('sec_tag', `thẻ <${t.name}> không được phép`, t.start);
    const attr = (n: string) => t.attrs.find((a) => a.name === n)?.value ?? null;
    if (t.name === 'meta' && attr('http-equiv') !== null) add('sec_meta_http_equiv', '<meta http-equiv> không được phép (CSP do server chèn)', t.start);
    if (t.name === 'link') {
      const href = decodeEntities(attr('href') ?? '').trim();
      const rel = (attr('rel') ?? '').toLowerCase();
      if (!(rel === 'stylesheet' && LOCAL_CSS.test(href))) add('sec_link', '<link> chỉ được dùng cho stylesheet assets/css/<tên>.css', t.start);
    }
    if (t.name === 'script') {
      const src = attr('src');
      const type = (attr('type') ?? '').toLowerCase();
      if (src !== null && !ALLOWED_SCRIPT.test(decodeEntities(src).trim())) add('sec_script_src', `<script src="${decodeEntities(src).slice(0, 80)}"> không được phép (chỉ __hf/gsap.min.js và assets/js/*.js)`, t.start);
      if (type === 'module' || type === 'importmap' || type === 'speculationrules') add('sec_script_type', `<script type="${type}"> không được phép`, t.start);
    }
    for (const a of t.attrs) {
      if (a.value === null) continue;
      if (a.name.startsWith('on')) {
        const tmp: LintIssue[] = [];
        checkJs(decodeEntities(a.value), f.path, 0, '', tmp);
        for (const i of tmp) out.push({ ...i, message: i.message.replace(/\(dòng \d+\)/, `(dòng ${line(a.start)})`) });
      } else if (a.name === 'style') {
        checkCss(`x{${decodeEntities(a.value)}}`, f.path, a.start, html, out);
      } else if (a.name === 'srcset' || a.name === 'imagesrcset') {
        for (const cand of decodeEntities(a.value).split(',')) {
          const bad = badUrl(cand.trim().split(/\s+/)[0] ?? '');
          if (bad) add('sec_srcset', `srcset không hợp lệ: ${bad}`, a.start);
        }
      } else if (URL_ATTRS.has(a.name) && t.name !== 'link' && !(t.name === 'script' && a.name === 'src')) {
        const bad = badUrl(a.value, { allowData: ['img', 'source', 'image', 'video', 'audio'].includes(t.name) || a.name === 'poster' });
        if (bad) add('sec_remote_url', `${a.name}="${decodeEntities(a.value).slice(0, 60)}": ${bad}`, a.start);
      }
    }
  }
  // nội dung <script>/<style>
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1] ?? '')) continue;
    const body = m[2] ?? '';
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1] ?? '')?.[1]?.toLowerCase() ?? '';
    if (type && !['text/javascript', 'application/javascript'].includes(type)) continue;
    checkJs(body, f.path, m.index + m[0].indexOf(body), html, out);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) checkCss(m[1] ?? '', f.path, m.index + m[0].indexOf(m[1] ?? ''), html, out);
  return out;
}

/** Gộp issue trùng (code+file) tối đa 3 mỗi nhóm để báo cáo ngắn cho AI. */
export function securityLint(files: SrcFile[]): LintIssue[] {
  const seen = new Map<string, number>();
  return files.flatMap(securityLintFile).filter((i) => {
    const k = `${i.code}|${i.file}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n <= 3;
  });
}
