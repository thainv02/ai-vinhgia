/**
 * Phần "head" do SERVER sở hữu của mọi composition Video HTML: CSP (meta, đứng đầu <head>) + @font-face inline Be Vietnam Pro (+ runtime cho preview/capture).
 * AI không bao giờ viết các thứ này (lint từ chối). Dòng chèn không chứa xuống dòng để số dòng của lint trùng với file gốc.
 */
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '../../../config.js';
import { HTML_CSP } from './constants.js';

export { HTML_BASE_CANVAS, HTML_CSP, outputResolutionOf } from './constants.js';

const UNICODE: Record<string, string> = {
  vietnamese: 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};
export const HTML_FONT_FAMILY = 'Be Vietnam Pro';
export const HTML_FONT_WEIGHTS = [400, 600, 700, 800] as const;
const SUBSETS = ['vietnamese', 'latin-ext', 'latin'] as const;
export const HTML_FONT_FILES: string[] = HTML_FONT_WEIGHTS.flatMap((w) => SUBSETS.map((s) => `be-vietnam-pro-${s}-${w}-normal.woff2`));

/** Thư mục asset runtime của server: `<APP_DIR>/server/assets/html-runtime` (dev: thư mục repo; bản cài: cạnh server.mjs). */
export const htmlRuntimeDir = (appDir = APP_DIR): string => path.join(appDir, 'server', 'assets', 'html-runtime');

/** File runtime server cung cấp, đường dẫn đích (posix, dưới gốc composition) → file nguồn tương đối trong html-runtime. */
export function runtimeFileMap(): Record<string, string> {
  const m: Record<string, string> = { '__hf/gsap.min.js': 'gsap.min.js', '__hf/runtime.js': 'runtime.js' };
  for (const f of HTML_FONT_FILES) m[`__hf/fonts/${f}`] = `fonts/${f}`;
  return m;
}

const fontCss = (base: string): string =>
  HTML_FONT_WEIGHTS.flatMap((w) => SUBSETS.map((s) => `@font-face{font-family:'${HTML_FONT_FAMILY}';font-style:normal;font-weight:${w};font-display:block;src:url(${base}__hf/fonts/be-vietnam-pro-${s}-${w}-normal.woff2) format('woff2');unicode-range:${UNICODE[s]}}`)).join('');

/** Dấu của phần tử do server chèn. File AI chứa chuỗi này bị lint bảo mật từ chối (`sec_engine_mark`). */
export const HTML_ENGINE_MARK = 'data-hf-engine';
const MARK = HTML_ENGINE_MARK;

export interface InjectOptions {
  mode: 'render' | 'capture' | 'preview';
  /** URL script runtime cho preview/capture (mặc định `__hf/runtime.js`, hoặc `../__hf/runtime.js` khi `base='../'`). */
  runtimeSrc?: string;
  /** Tiền tố đường dẫn tới thư mục gốc composition (file trong `compositions/` dùng `../`). */
  base?: string;
  /** Là file vào (index.html): chèn @font-face + runtime. false cho compositions/*.html (được nhúng vào index) chỉ chèn CSP. Mặc định true. */
  fonts?: boolean;
}

/**
 * Chèn CSP + @font-face inline (+ <script> runtime với preview/capture) vào ĐẦU tài liệu (ngay sau doctype), KHÔNG dò thẻ <head> của AI:
 * theo thuật toán phân tích HTML, <meta>/<style>/<script> gặp trước <html>/<head> luôn vào <head> ngầm định, trước mọi nội dung của AI
 * (thẻ <html>/<head> viết sau chỉ gộp thuộc tính hoặc bị bỏ). Dò thẻ bằng chuỗi thì bị lừa bởi `<title><head>`, thuộc tính, `--!>`… và CSP
 * có thể rơi vào body (bị bỏ qua) hoặc sau một <script>. Luôn chèn (không bỏ qua khi thấy dấu): file AI chứa dấu đã bị lint từ chối.
 */
export function injectHead(html: string, opts: InjectOptions): string {
  const base = opts.base ?? '';
  const parts = [`<meta ${MARK} http-equiv="Content-Security-Policy" content="${HTML_CSP}">`];
  if (opts.fonts !== false) parts.push(`<style ${MARK}>${fontCss(base)}</style>`);
  if (opts.mode !== 'render' && opts.fonts !== false) parts.push(`<script ${MARK} src="${opts.runtimeSrc ?? `${base}__hf/runtime.js`}"></script>`);
  const block = parts.join('');
  // Doctype (chỉ khi là thứ đầu tiên, sau BOM/khoảng trắng) giữ trước block để không vào quirks mode
  const dt = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  const at = dt ? dt[0].length : 0;
  return `${html.slice(0, at)}${block}${html.slice(at)}`;
}

export const readRuntimeFile = (rel: string): Buffer => fs.readFileSync(path.join(htmlRuntimeDir(), rel));
