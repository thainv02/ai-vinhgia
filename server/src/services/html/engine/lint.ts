/** Lint một thư mục composition: @hyperframes/lint (đã lọc) + lint bảo mật riêng + khớp canvas/thời lượng dự án. `installHtmlValidator` gắn vào vòng đời phiên bản. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../../context.js';
import { defaultCompositionValidator, setCompositionValidator } from '../compose-lifecycle.js';
import { projectMeta } from '../repo.js';
import { decodeEntities, scanTags } from '../variables.js';
import type { HtmlAspect, LintIssue, LintReport } from '../view.js';
import { HTML_BASE_CANVAS } from './constants.js';
import { materialize } from './materialize.js';
import { securityLint, type SrcFile } from './security-lint.js';
import { parseJson } from '../../repo.js';

/** Mã lint của HyperFrames bỏ qua (không áp dụng cho app này). */
const IGNORED_LINT_CODES = new Set(['studio_missing_editable_id']);
const MAX_ISSUES = 60;

/** Đọc các file nguồn cho phép của phiên bản (index, compositions, css, js). Không đọc asset nhị phân. */
function readSources(dir: string): SrcFile[] {
  const out: SrcFile[] = [];
  const add = (rel: string, ext: string) => {
    const abs = path.join(dir, ...rel.split('/'));
    let names: string[] = [];
    try {
      names = fs.readdirSync(abs);
    } catch {
      return;
    }
    for (const n of names.sort()) if (n.toLowerCase().endsWith(ext) && fs.statSync(path.join(abs, n)).isFile()) out.push({ path: `${rel}/${n}`, content: fs.readFileSync(path.join(abs, n), 'utf8') });
  };
  const index = path.join(dir, 'index.html');
  if (fs.existsSync(index)) out.push({ path: 'index.html', content: fs.readFileSync(index, 'utf8') });
  add('compositions', '.html');
  add('assets/css', '.css');
  add('assets/js', '.js');
  return out;
}

function checkCanvas(index: string, aspect: HtmlAspect, durationS: number): LintIssue[] {
  const base = HTML_BASE_CANVAS[aspect];
  const root = scanTags(index).find((t) => t.attrs.some((a) => a.name === 'data-composition-id' && a.value === 'main'));
  const issue = (code: string, message: string): LintIssue => ({ code, message, file: 'index.html' });
  if (!root) return [issue('canvas_root_missing', 'index.html thiếu phần tử gốc có data-composition-id="main"')];
  const num = (n: string) => Number(decodeEntities(root.attrs.find((a) => a.name === n)?.value ?? '').trim());
  const out: LintIssue[] = [];
  const w = num('data-width');
  const h = num('data-height');
  if (w !== base.w || h !== base.h) out.push(issue('canvas_size_mismatch', `Phần tử gốc phải có data-width="${base.w}" data-height="${base.h}" (canvas gốc cho ${aspect}); đang là ${Number.isFinite(w) ? w : '?'}x${Number.isFinite(h) ? h : '?'}`));
  const d = num('data-duration');
  if (!Number.isFinite(d) || Math.abs(d - durationS) > 0.1) out.push(issue('duration_mismatch', `Phần tử gốc phải có data-duration="${durationS}" (thời lượng dự án); đang là ${Number.isFinite(d) ? d : '?'}`));
  return out;
}

interface RawFinding {
  code: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  fixHint?: string;
}

export async function lintComposition(dir: string, opts: { aspect: HtmlAspect; durationS: number }): Promise<LintReport> {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const checks: string[] = [];
  const files = readSources(dir);
  const index = files.find((f) => f.path === 'index.html');
  if (!index) return { ok: false, errors: [{ code: 'index_missing', message: 'Thiếu index.html' }], warnings, checks: ['manifest'] };

  // 1. bảo mật (nguồn gốc của AI, trước khi chèn head)
  errors.push(...securityLint(files));
  checks.push('security');
  // 2. canvas/thời lượng
  errors.push(...checkCanvas(index.content, opts.aspect, opts.durationS));
  checks.push('canvas');
  // 3. lint HyperFrames trên bản đã materialize (có __hf/, font inline, asset snapshot) — dòng chèn không có xuống dòng nên số dòng khớp
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hflint-'));
  try {
    await materialize(dir, tmp, { mode: 'render' });
    const { lintProject } = await import('@hyperframes/lint');
    const r = await lintProject(tmp, undefined, { host: 'cli' });
    for (const pr of r.results) {
      for (const f of pr.result.findings as RawFinding[]) {
        if (IGNORED_LINT_CODES.has(f.code) || f.severity === 'info') continue;
        const file = f.file ? path.relative(tmp, path.resolve(tmp, f.file)).split(path.sep).join('/') : (pr.file ? path.relative(tmp, path.resolve(tmp, pr.file)).split(path.sep).join('/') : undefined);
        const issue: LintIssue = { code: f.code, message: `${f.message}${f.line ? ` (dòng ${f.line})` : ''}${f.fixHint ? ` Gợi ý: ${f.fixHint}` : ''}`.slice(0, 900), ...(file && !file.startsWith('..') ? { file } : {}) };
        (f.severity === 'error' ? errors : warnings).push(issue);
      }
    }
    checks.push('lint');
  } catch (e) {
    errors.push({ code: 'lint_failed', message: `Không chạy được lint: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const uniq = (l: LintIssue[]) => [...new Map(l.map((i) => [`${i.code}|${i.file ?? ''}|${i.message}`, i])).values()].slice(0, MAX_ISSUES);
  const e2 = uniq(errors);
  return { ok: e2.length === 0, errors: e2, warnings: uniq(warnings), checks };
}

/** Gắn lint thật vào vòng đời phiên bản: manifest/đường dẫn (mặc định) + lintComposition. Gọi một lần lúc khởi động app (index.ts). */
export function installHtmlValidator(): void {
  setCompositionValidator(async (ctx: AppContext, version, dir) => {
    const base = await defaultCompositionValidator(ctx, version, dir);
    if (!base.ok) return base;
    const meta = projectMeta(ctx, version.project_id);
    const voice = parseJson<{ duration_s: number } | null>(version.voice_json ?? null, null);
    const segment=ctx.db.prepare('SELECT start_s,end_s FROM html_segments WHERE segment_version_id=?').get(version.id) as {start_s:number;end_s:number}|undefined;
    const lint = await lintComposition(dir, { aspect: meta.aspect, durationS: segment ? segment.end_s-segment.start_s : voice?.duration_s ?? meta.duration_s });
    return { ok: lint.ok, errors: lint.errors, warnings: lint.warnings, checks: [...base.checks, ...lint.checks] };
  });
}
