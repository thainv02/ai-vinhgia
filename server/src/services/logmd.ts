import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { VERDICT_LABEL, type AssetRow, type Verdict } from '../db/types.js';
import { getProject, parseJson } from './repo.js';
import { getGenerator, VIDEO_GENERATORS } from './generators.js';

export const LOG_HEADER = '| clip | lần | loại | lỗi thấy được | kết luận |\n|---|---|---|---|---|\n';

export interface LogRow {
  clip: string;
  attempt: number | string;
  type: string;
  issue: string;
  conclusion: string;
}

/** Nhãn của video tạo trước khi có lựa chọn dịch vụ (job không ghi `generator`). */
export const VIDEO_TYPE_TEXT = 'video (Flow; 9:16, 10s, x1, 720p)';

function generatorOfJob(jobPayload: string | null | undefined) {
  const g = parseJson<{ generator?: unknown }>(jobPayload ?? '{}', {}).generator;
  const id = typeof g === 'string' ? g : g && typeof g === 'object' ? (g as { id?: unknown }).id : undefined;
  return typeof id === 'string' && VIDEO_GENERATORS.some((x) => x.id === id) ? getGenerator(id) : null;
}

/** Tên dịch vụ đã tạo video; null với job cũ không ghi `generator`. */
export const videoGeneratorLabel = (jobPayload: string | null | undefined): string | null => generatorOfJob(jobPayload)?.label ?? null;

/** Cột «loại» của video theo dịch vụ trong payload job; job cũ không có `generator` giữ nhãn cũ. */
export function videoTypeText(jobPayload: string | null | undefined): string {
  const gen = generatorOfJob(jobPayload);
  return gen ? `video (${gen.label}; 9:16, ${gen.duration_s}s, x1, 720p)` : VIDEO_TYPE_TEXT;
}

const cell = (s: string): string => s.replace(/\r?\n+/g, ' ').replace(/\|/g, '/').trim();
const rowText = (r: LogRow): string =>
  `| ${cell(r.clip)} | ${r.attempt} | ${cell(r.type)} | ${cell(r.issue)} | ${cell(r.conclusion)} |\n`;

export function logFilePath(ctx: AppContext, slug: string): string {
  return path.join(ctx.config.rootDir, 'output', slug, 'log.md');
}

/** Thêm một dòng vào output/<slug>/log.md (tạo file + header nếu chưa có). Chạy SAU commit. */
export function appendLogRow(ctx: AppContext, slug: string, row: LogRow): void {
  ctx.afterCommit(() => {
    const file = logFilePath(ctx, slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      fs.writeFileSync(file, LOG_HEADER + rowText(row));
      return;
    }
    const existing = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, (existing.endsWith('\n') ? '' : '\n') + rowText(row));
  });
}

export const verdictText = (v: Verdict | null | undefined): string => (v ? VERDICT_LABEL[v] : 'Chưa đánh giá');

/** Sinh nội dung log.md từ assets (dùng cho `GET /api/projects/:id/log.md`). Grid không có dòng riêng. */
export function generateLogMd(ctx: AppContext, projectId: number): string {
  const project = getProject(ctx, projectId);
  const rows = ctx.db
    .prepare(
      `SELECT a.*, s.code AS scene_code, j.payload AS job_payload FROM assets a JOIN scenes s ON s.id = a.scene_id
       LEFT JOIN jobs j ON j.id = a.job_id
       WHERE s.project_id = ? AND a.kind IN ('storyboard','video')
       ORDER BY a.created_at, a.id`,
    )
    .all(project.id) as (AssetRow & { scene_code: string; job_payload: string | null })[];
  let out = LOG_HEADER;
  for (const a of rows) {
    const meta = parseJson<Record<string, unknown>>(a.meta, {});
    out += rowText({
      clip: a.scene_code,
      attempt: a.attempt,
      type: typeof meta.legacy_type === 'string' ? meta.legacy_type : a.kind === 'video' ? videoTypeText(a.job_payload) : 'storyboard',
      issue: a.verdict_note ?? '',
      conclusion: typeof meta.legacy_conclusion === 'string' ? meta.legacy_conclusion : verdictText(a.verdict),
    });
  }
  const cuts = ctx.db
    .prepare("SELECT version, renderer, summary, note, watermark_removed FROM final_cuts WHERE project_id = ? AND status = 'ready' ORDER BY version")
    .all(project.id) as { version: number; renderer: string | null; summary: string | null; note: string | null; watermark_removed: number }[];
  for (const c of cuts) {
    out += rowText({
      clip: 'FINAL',
      attempt: `v${c.version}`,
      type: `bản dựng (${c.renderer ?? '?'}, cắt thẳng${c.watermark_removed ? '; đã xoá logo Veo' : ''})`,
      issue: c.summary ?? c.note ?? '',
      conclusion: 'Sẵn sàng',
    });
  }
  return out;
}
