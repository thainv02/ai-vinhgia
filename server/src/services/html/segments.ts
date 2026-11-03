/** Đoạn dùng composition nội bộ để tái sử dụng nguyên vòng compose/lint/vision và snapshot bất biến. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { conflict } from '../../lib/errors.js';
import { parseJson, logEvent } from '../repo.js';
import { cancelJob } from '../jobs.js';
import { createComposingVersion, type NewComposeVersion } from './versions.js';
import { getVersionById, projectMeta, type HtmlVersionRow } from './repo.js';
import { snapshotVersionAssets } from './assets.js';
import { writeStaging, validateManifest } from './safe-path.js';
import { splitSegments, transcriptForSegment } from './split-segments.js';
import type { VoiceSnapshot } from './voice.js';

export interface HtmlSegmentRow {
  id: number;
  version_id: number;
  idx: number;
  start_s: number;
  end_s: number;
  status: 'queued' | 'composing' | 'ready' | 'failed';
  job_id: number | null;
  segment_version_id: number | null;
  files_dir: string | null;
  manifest_json: string;
  variables_json: string;
  content_hash: string | null;
  summary: string | null;
  error: string | null;
  updated_at: string;
}
export const listSegments = (ctx: AppContext, id: number) =>
  ctx.db.prepare('SELECT * FROM html_segments WHERE version_id=? ORDER BY idx').all(id) as HtmlSegmentRow[];
const wordsOf = (_ctx: AppContext, v: HtmlVersionRow) => parseJson<VoiceSnapshot | null>(v.voice_json ?? null, null);
export function affectedSegments(feedback: string, n: number): number[] | null {
  if (/toàn\s*bộ|cả\s*video|tất\s*cả/i.test(feedback)) return null;
  const out = [...feedback.matchAll(/đoạn\s*(\d+)/gi)].map((m) => Number(m[1])).filter((x) => x >= 1 && x <= n);
  return out.length ? [...new Set(out)] : null;
}
const outlineFor = (bounds: ReturnType<typeof splitSegments>, voice: VoiceSnapshot | null) =>
  bounds.map((b, i) =>
    voice
      ? (transcriptForSegment(voice.transcript, b).sentences[0]?.text.slice(0, 100) ?? `Đoạn ${i + 1}`)
      : `${i === 0 ? 'Mở đầu' : i === bounds.length - 1 ? 'Kết thúc' : 'Nội dung'} — đoạn ${i + 1}`,
  );
function basePayload(ctx: AppContext, owner: HtmlVersionRow): any {
  const first = listSegments(ctx, owner.id)[0];
  const row = first?.job_id
    ? (ctx.db.prepare('SELECT payload FROM jobs WHERE id=?').get(first.job_id) as { payload: string } | undefined)
    : undefined;
  const payload = parseJson<any>(row?.payload ?? null, {});
  return {
    ...payload,
    voice: wordsOf(ctx, owner),
    prompt: owner.prompt,
    feedback: owner.feedback,
    version: { id: owner.id, number: owner.version },
    spec: { ...payload.spec, duration_s: wordsOf(ctx, owner)?.duration_s ?? listSegments(ctx, owner.id).at(-1)?.end_s },
  };
}
function stylePack(ctx: AppContext, first: HtmlSegmentRow) {
  if (!first.files_dir) return null;
  const html = fs.readFileSync(path.join(ctx.config.rootDir, first.files_dir, 'index.html'), 'utf8');
  return {
    css: [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((m) => m[1])
      .join('\n')
      .slice(0, 32000),
    colors: parseJson<any[]>(first.variables_json, []).filter((v) => v.type === 'color'),
    fonts: [...new Set([...html.matchAll(/font-family\s*:\s*([^;}]+)/gi)].map((m) => m[1]))],
  };
}
function usedAssets(ctx: AppContext, rows: HtmlSegmentRow[], idx: number) {
  const ids = new Set<number>();
  for (const row of rows.filter((s) => s.idx < idx && s.status === 'ready' && s.files_dir)) {
    const html = fs.readFileSync(path.join(ctx.config.rootDir, row.files_dir!, 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|poster)\s*=\s*["']assets\/u\/(\d+)\./gi)) ids.add(Number(m[1]));
  }
  return [...ids];
}
function startSegment(ctx: AppContext, owner: HtmlVersionRow, row: HtmlSegmentRow, base: any) {
  const all = listSegments(ctx, owner.id),
    voice = wordsOf(ctx, owner);
  const original = row.segment_version_id ? getVersionById(ctx, row.segment_version_id) : null;
  const payload = { ...base, template: null };
  delete payload.segment;
  const created = createComposingVersion(ctx, {
    projectId: owner.project_id,
    prompt: owner.prompt,
    feedback: owner.feedback,
    createdBy: 'ai',
    parentId: original?.status === 'ready' ? original.id : null,
    policy: parseJson(owner.compose_policy_json, {}),
    payload,
    segment: {
      ownerId: owner.id,
      idx: row.idx,
      count: all.length,
      start_s: row.start_s,
      end_s: row.end_s,
      total_s: all.at(-1)!.end_s,
      outline: outlineFor(all, voice),
      style_pack: row.idx === 1 ? null : stylePack(ctx, all[0]!),
      used_assets: usedAssets(ctx, all, row.idx),
    },
    voiceOverride: voice
      ? { ...voice, duration_s: row.end_s - row.start_s, captionsOnly: true, transcript: transcriptForSegment(voice.transcript, row) }
      : null,
  });
  ctx.db
    .prepare("UPDATE html_segments SET job_id=?,segment_version_id=?,status='queued',error=NULL,updated_at=? WHERE id=?")
    .run(created.version.compose_job_id, created.version.id, ctx.now(), row.id);
}
export function createSegments(ctx: AppContext, owner: HtmlVersionRow, base: any, o: NewComposeVersion) {
  const voice = wordsOf(ctx, owner),
    bounds = splitSegments(base.spec.duration_s, voice?.transcript.sentences, voice?.transcript.words);
  ctx.db.prepare('UPDATE html_versions SET is_segmented=1 WHERE id=?').run(owner.id);
  // Giữ đầu vào ngay từ lúc chia đoạn: thử lại vẫn dùng được sau khi người dùng bỏ nguồn gốc.
  const project=ctx.db.prepare('SELECT slug FROM projects WHERE id=?').get(owner.project_id) as {slug:string};
  const inputs=`output/${project.slug}/html/segment-inputs/${owner.id}`;
  const inputDir=path.join(ctx.config.rootDir,inputs);
  fs.rmSync(inputDir,{recursive:true,force:true});
  for(const asset of snapshotVersionAssets(ctx,owner.id,inputDir)){
    const stored=`${inputs}/${asset.rel}`;
    ctx.db.prepare('UPDATE html_version_assets SET stored_path=?,snapshot_path=? WHERE version_id=? AND asset_ref=?').run(stored,stored,owner.id,asset.asset_id);
  }
  const previous = o.parentId ? listSegments(ctx, o.parentId) : [];
  const targets = o.segmentIndices ?? (o.feedback ? affectedSegments(o.feedback, bounds.length) : null);
  for (const b of bounds) {
    const old = previous.find((s) => s.idx === b.idx && s.start_s === b.start_s && s.end_s === b.end_s && s.status === 'ready');
    const copy = old && targets && !targets.includes(b.idx);
    ctx.db
      .prepare(
        `INSERT INTO html_segments(version_id,idx,start_s,end_s,status,job_id,segment_version_id,files_dir,manifest_json,variables_json,content_hash,summary,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        owner.id,
        b.idx,
        b.start_s,
        b.end_s,
        copy ? 'ready' : 'queued',
        copy ? old.job_id : null,
        old?.segment_version_id ?? null,
        copy ? old.files_dir : null,
        copy ? old.manifest_json : '[]',
        copy ? old.variables_json : '[]',
        copy ? old.content_hash : null,
        copy ? old.summary : null,
        ctx.now(),
      );
  }
  const rows = listSegments(ctx, owner.id);
  if (!o.deferSegmentCompose) {
    if (rows[0]!.status !== 'ready') startSegment(ctx, owner, rows[0]!, base);
    else for (const row of rows.filter((s) => s.status === 'queued')) startSegment(ctx, owner, row, base);
  }
  finishAggregate(ctx, owner.id);
  logEvent(ctx, {
    project_id: owner.project_id,
    type: 'html.segmented',
    message: `Video v${owner.version}: ${rows.length} đoạn, mỗi đoạn tối đa 60 giây`,
  });
}
export function refreshSegmentPayload(ctx: AppContext, job: JobRow) {
  const child = ctx.db.prepare('SELECT * FROM html_versions WHERE compose_job_id=?').get(job.id) as HtmlVersionRow | undefined;
  if (!child?.segment_owner_id) return;
  const rows = listSegments(ctx, child.segment_owner_id),
    row = rows.find((s) => s.job_id === job.id);
  if (!row) return;
  const payload = parseJson<any>(job.payload, {});
  if (row.idx > 1) {
    payload.segment.style_pack = stylePack(ctx, rows[0]!);
    payload.segment.used_assets = usedAssets(ctx, rows, row.idx);
  }
  job.payload = JSON.stringify(payload);
  ctx.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(job.payload, job.id);
}
export function segmentOwnerActive(ctx: AppContext, child: HtmlVersionRow) {
  return !child.segment_owner_id || getVersionById(ctx, child.segment_owner_id).status !== 'cancelled';
}
export function syncSegment(ctx: AppContext, child: HtmlVersionRow) {
  if (!child.segment_owner_id) return;
  const owner = getVersionById(ctx, child.segment_owner_id);
  ctx.db
    .prepare(
      'UPDATE html_segments SET status=?,files_dir=?,manifest_json=?,variables_json=?,content_hash=?,summary=?,error=?,updated_at=? WHERE version_id=? AND segment_version_id=?',
    )
    .run(
      child.status === 'ready' ? 'ready' : child.status === 'failed' || child.status === 'cancelled' ? 'failed' : 'composing',
      child.files_dir,
      child.manifest_json,
      child.variables_json,
      child.content_hash,
      child.summary,
      child.error,
      ctx.now(),
      owner.id,
      child.id,
    );
  if (owner.status === 'cancelled') return;
  const rows = listSegments(ctx, owner.id);
  if (child.status === 'failed' || child.status === 'cancelled')
    ctx.db
      .prepare("UPDATE html_versions SET status='failed',error=?,error_code='HTML_SEGMENT_FAILED' WHERE id=?")
      .run(`Đoạn ${rows.find((r) => r.segment_version_id === child.id)?.idx}: ${child.error ?? 'Không hoàn tất'}`, owner.id);
  if (rows[0]?.status === 'ready')
    for (const row of rows.filter((s) => s.idx > 1 && s.status === 'queued' && !s.job_id))
      startSegment(ctx, owner, row, basePayload(ctx, owner));
  finishAggregate(ctx, owner.id);
  ctx.publish('project.updated', owner.project_id, { project_id: owner.project_id });
}
function finishAggregate(ctx: AppContext, id: number) {
  const owner = getVersionById(ctx, id),
    rows = listSegments(ctx, id);
  if (owner.status === 'ready' || owner.status === 'cancelled' || !rows.length || rows.some((s) => s.status !== 'ready')) return;
  const project = ctx.db.prepare('SELECT slug FROM projects WHERE id=?').get(owner.project_id) as { slug: string };
  const rel = `output/${project.slug}/html/versions/v${owner.version}`,
    dir = path.join(ctx.config.rootDir, rel);
  // Thư mục chưa công bố có thể còn lại nếu transaction trước bị rollback.
  fs.rmSync(dir, { recursive: true, force: true });
  const m = projectMeta(ctx, owner.project_id);
  const manifest = writeStaging(
    dir,
    validateManifest([
      {
        path: 'index.html',
        content: `<!doctype html><html><head><meta charset="utf-8"></head><body><div data-composition-id="main" data-start="0" data-duration="${rows.at(-1)!.end_s}">Video gồm ${rows.length} đoạn. Chọn từng đoạn để xem trước.</div></body></html>`,
      },
    ]),
  );
  snapshotVersionAssets(ctx, id, dir);
  // Asset gốc đã có hard link trong aggregate, dùng bản này khi mux voice và sau khi xóa nguồn.
  for (const a of ctx.db.prepare('SELECT asset_ref,stored_path FROM html_version_assets WHERE version_id=?').all(id) as {
    asset_ref: number;
    stored_path: string;
  }[])
    ctx.db
      .prepare('UPDATE html_version_assets SET snapshot_path=? WHERE version_id=? AND asset_ref=?')
      .run(`${rel}/assets/u/${a.asset_ref}${path.extname(a.stored_path).toLowerCase()}`, id, a.asset_ref);
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([rows.map((s) => [s.content_hash, s.start_s, s.end_s]), owner.voice_json, m.aspect]))
    .digest('hex');
  ctx.db
    .prepare(
      "UPDATE html_versions SET status='ready',files_dir=?,manifest_json=?,variables_json='[]',content_hash=?,summary=?,published_at=?,error=NULL,error_code=NULL WHERE id=?",
    )
    .run(rel, JSON.stringify(manifest), hash, `Video ${rows.length} đoạn — ${rows.at(-1)!.end_s} giây`, ctx.now(), id);
}
export function retrySegment(ctx: AppContext, owner: HtmlVersionRow, idx: number) {
  return ctx.tx(() => {
    const row = listSegments(ctx, owner.id).find((s) => s.idx === idx);
    if (!row || row.status !== 'failed') throw conflict('SEGMENT_NOT_FAILED', 'Chỉ thử lại đoạn đang lỗi');
    if (owner.status === 'cancelled') throw conflict('VERSION_CANCELLED', 'Phiên bản đã hủy');
    const base = basePayload(ctx, owner);
    ctx.db.prepare("UPDATE html_versions SET status='composing',error=NULL,error_code=NULL WHERE id=?").run(owner.id);
    ctx.db.prepare("UPDATE html_segments SET status='queued',job_id=NULL,error=NULL WHERE id=?").run(row.id);
    if (idx === 1 || listSegments(ctx, owner.id)[0]?.status === 'ready') startSegment(ctx, getVersionById(ctx, owner.id), row, base);
    return getVersionById(ctx, owner.id);
  });
}
export function cancelSegments(ctx: AppContext, owner: HtmlVersionRow) {
  if (owner.status === 'ready' || owner.status === 'cancelled') throw conflict('INVALID_STATE', 'Phiên bản không còn đang tạo');
  ctx.db
    .prepare("UPDATE html_versions SET status='cancelled',error='Đã hủy bởi người dùng',error_code='CANCELLED' WHERE id=?")
    .run(owner.id);
  for (const row of listSegments(ctx, owner.id))
    if (row.job_id) {
      const j = ctx.db.prepare('SELECT status FROM jobs WHERE id=?').get(row.job_id) as { status: string } | undefined;
      if (j && ['queued', 'claimed', 'running'].includes(j.status)) cancelJob(ctx, row.job_id);
    }
  ctx.db
    .prepare("UPDATE html_segments SET status='failed',error='Đã hủy' WHERE version_id=? AND status IN ('queued','composing')")
    .run(owner.id);
}
