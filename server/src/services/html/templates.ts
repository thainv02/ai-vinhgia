/**
 * Mẫu Video HTML dựng sẵn (`server/assets/html-templates/<id>/`): `meta.json` + `index.html` (+ `compositions/*.html`, `assets/css|js`).
 * Quyết định thiết kế: MỘT bộ file cho cả ba tỉ lệ. HTML dùng chỗ giữ chỗ `{{w}}` `{{h}}` `{{aspect}}` (a-p | a-l | a-s: lớp CSS của canvas gốc 360×640 /
 * 640×360 / 360×360) và `{{d}}` (thời lượng giây) hoặc `{{d:0.25}}` (= d × 0.25, làm tròn 0,01) hoặc `{{r:0.67}}` (= d − làm tròn(d × 0.67): phần còn lại tới hết video). CSS rẽ nhánh theo lớp `a-*`. Giá trị là số/chuỗi cố định,
 * không có biểu thức hay eval. Mẫu chỉ là điểm xuất phát đưa vào payload job; AI được phép sửa tự do trong khuôn khổ hợp đồng composition.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { APP_DIR } from '../../config.js';
import { parseJson } from '../repo.js';
import { ALLOWED_DIRS, type ManifestFile } from './safe-path.js';
import { variablesSchema } from './variables.js';
import type { HtmlAspect, HtmlVariable } from './view.js';

export const BASE_CANVAS: Record<HtmlAspect, { w: number; h: number }> = { '9:16': { w: 360, h: 640 }, '16:9': { w: 640, h: 360 }, '1:1': { w: 360, h: 360 } };
export const ASPECT_CLASS: Record<HtmlAspect, string> = { '9:16': 'a-p', '16:9': 'a-l', '1:1': 'a-s' };

export const templatesDir = (appDir = APP_DIR): string => path.join(appDir, 'server', 'assets', 'html-templates');

const metaSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  label: z.string().min(1).max(80),
  description: z.string().max(400),
  aspects: z.array(z.enum(['9:16', '16:9', '1:1'])).min(1),
  variables: variablesSchema.default([]),
});
export interface HtmlTemplateMeta {
  id: string;
  label: string;
  description: string;
  aspects: HtmlAspect[];
  variables: HtmlVariable[];
}

/** Danh sách mẫu (đọc từ đĩa mỗi lần: nhỏ, và cho phép bổ sung mẫu mà không cần khởi động lại). Mẫu lỗi bị bỏ qua. */
export function listHtmlTemplates(dir = templatesDir()): HtmlTemplateMeta[] {
  if (!fs.existsSync(dir)) return [];
  const out: HtmlTemplateMeta[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = readMeta(dir, name);
    if (m) out.push(m);
  }
  return out;
}

function readMeta(dir: string, name: string): HtmlTemplateMeta | null {
  try {
    const raw = parseJson<unknown>(fs.readFileSync(path.join(dir, name, 'meta.json'), 'utf8'), null);
    const r = metaSchema.safeParse(raw);
    if (!r.success || r.data.id !== name) return null;
    return { ...r.data, variables: r.data.variables.map((v) => ({ ...v, target: v.target ?? v.id })) };
  } catch {
    return null;
  }
}

/** Thay chỗ giữ chỗ trong một file mẫu. Chỗ giữ chỗ lạ → ném lỗi (mẫu hỏng bị phát hiện bởi test, không lọt vào prompt). */
export function fillPlaceholders(text: string, aspect: HtmlAspect, durationS: number): string {
  const c = BASE_CANVAS[aspect];
  const num = (x: number) => String(Math.round(x * 100) / 100);
  return text.replace(/\{\{\s*([a-z]+)(?::([0-9.]+))?\s*\}\}/g, (all, key: string, frac?: string) => {
    if (key === 'w' && !frac) return String(c.w);
    if (key === 'h' && !frac) return String(c.h);
    if (key === 'aspect' && !frac) return ASPECT_CLASS[aspect];
    if (key === 'd') return num(frac === undefined ? durationS : durationS * Number(frac));
    if (key === 'r' && frac !== undefined) return num(durationS - Math.round(durationS * Number(frac) * 100) / 100); // phần còn lại tới hết video (cảnh cuối khỏi lệch làm tròn)
    throw new Error(`Chỗ giữ chỗ không hợp lệ trong mẫu: ${all}`);
  });
}

function walk(root: string, rel: string, out: string[]): void {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r === 'compositions' || r === 'assets' || r.startsWith('assets/')) walk(root, r, out);
    } else if (e.isFile() && e.name !== 'meta.json' && e.name !== 'README.md') out.push(r);
  }
}

/** Dựng bộ file của mẫu cho tỉ lệ/thời lượng cụ thể (đã thay chỗ giữ chỗ). `null` nếu không có mẫu hoặc không hỗ trợ tỉ lệ. */
export function instantiateTemplate(id: string, o: { aspect: HtmlAspect; durationS: number }, dir = templatesDir()): { meta: HtmlTemplateMeta; files: ManifestFile[] } | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) return null;
  const meta = readMeta(dir, id);
  if (!meta || !meta.aspects.includes(o.aspect)) return null;
  const root = path.join(dir, id);
  const rels: string[] = [];
  walk(root, '', rels);
  const allowedDir = (r: string) => r === 'index.html' || Object.entries(ALLOWED_DIRS).some(([d, ext]) => r.startsWith(`${d}/`) && r.endsWith(ext) && !r.slice(d.length + 1).includes('/'));
  const files = rels
    .filter(allowedDir)
    .sort()
    .map((r) => ({ path: r, content: fillPlaceholders(fs.readFileSync(path.join(root, ...r.split('/')), 'utf8'), o.aspect, o.durationS) }));
  if (!files.some((f) => f.path === 'index.html')) return null;
  return { meta, files };
}
