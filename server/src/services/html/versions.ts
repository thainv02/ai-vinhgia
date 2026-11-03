/**
 * Phiên bản Video HTML: tạo (compose/revise → job `html_compose`; sửa biến → phiên bản người dùng), liệt kê, hủy.
 * Số phiên bản = MAX(version)+1 trong cùng transaction (phiên bản không bao giờ bị xoá riêng lẻ nên số đã cấp không bị dùng lại).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { conflict } from '../../lib/errors.js';
import { insertJob } from '../job-create.js';
import { cancelJob } from '../jobs.js';
import { logEvent, parseJson } from '../repo.js';
import { ALLOWED_DIRS, ENTRY_FILE, MANIFEST_LIMITS, USER_ASSET_DIR, type ManifestEntry, type ManifestFile } from './safe-path.js';
import { aspectSize, HTML_MAX_DURATION_S } from './config.js';
import { createSegments, cancelSegments } from './segments.js';
import { removeStagingOf, stageVersionFiles, finalizeVersion, publishVersionFiles } from './compose-lifecycle.js';
import { getHtmlProject, getVersion, getVersionById, listVersionAssets, projectAssets, projectMeta, type HtmlVersionRow } from './repo.js';
import { applyVariables, assertValue, checkVariables } from './variables.js';
import { assetPathOf, extOf, versionView, type HtmlVariable, type HtmlVersionView } from './view.js';
import { voiceSnapshot, type VoiceSnapshot } from './voice.js';

export { publishVersionFiles };

export interface ModelPolicy {
  compose?: string;
  vision?: string;
  /** Lý do chọn model (từ resolveHtmlPolicy), chỉ để hiển thị/gỡ lỗi. */
  reason?: string;
}

export interface NewComposeVersion {
  projectId: number;
  parentId?: number | null;
  prompt: string;
  feedback?: string | null;
  createdBy?: 'ai' | 'user';
  /** Snapshot chính sách model (ghi vào phiên bản và payload job); mặc định lấy từ cấu hình dự án. */
  policy?: ModelPolicy;
  /** Trường bổ sung đưa vào payload job (không ghi đè các trường chuẩn). */
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  /** Composition nội bộ của một đoạn; không nhận trực tiếp từ API người dùng. */
  segment?: { ownerId:number; idx:number; count:number; start_s:number; end_s:number; total_s:number; outline:string[]; style_pack?:unknown; used_assets?:number[] };
  voiceOverride?: VoiceSnapshot | null;
  segmentIndices?:number[];
  deferSegmentCompose?:boolean;
}

const readFilesOf = (ctx: AppContext, v: HtmlVersionRow): ManifestFile[] => {
  if (!v.files_dir) throw conflict('VERSION_NOT_READY', `Phiên bản v${v.version} chưa sẵn sàng`);
  const dir = path.join(ctx.config.rootDir, v.files_dir);
  return parseJson<ManifestEntry[]>(v.manifest_json, []).map((m) => ({ path: m.path, content: fs.readFileSync(path.join(dir, ...m.path.split('/')), 'utf8') }));
};

/** Phiên bản cha: cùng dự án và đã `ready`. Ném 404/409. */
function requireParent(ctx: AppContext, projectId: number, parentId: number): HtmlVersionRow {
  const p = ctx.db.prepare('SELECT * FROM html_versions WHERE id = ? AND project_id = ?').get(parentId, projectId) as HtmlVersionRow | undefined;
  if (!p) throw conflict('INVALID_PARENT', 'Phiên bản cha không thuộc dự án này');
  if (p.status !== 'ready') throw conflict('PARENT_NOT_READY', `Chỉ sửa được từ phiên bản đã sẵn sàng (v${p.version} đang ${p.status})`);
  return p;
}

const nextVersion = (ctx: AppContext, projectId: number): number =>
  (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM html_versions WHERE project_id = ? AND segment_owner_id IS NULL').get(projectId) as { n: number }).n;

/** Trả phiên bản đã tạo bằng cùng idempotency key (hoặc undefined). Khác nội dung yêu cầu → 409 IDEMPOTENCY_CONFLICT. */
function existingByKey(ctx: AppContext, projectId: number, key: string | null | undefined, same: (v: HtmlVersionRow) => boolean): HtmlVersionRow | undefined {
  if (!key) return undefined;
  const v = ctx.db.prepare('SELECT * FROM html_versions WHERE project_id = ? AND idempotency_key = ?').get(projectId, key) as HtmlVersionRow | undefined;
  if (v && !same(v)) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key này đã được dùng cho một yêu cầu khác');
  return v;
}

/**
 * Tạo phiên bản `composing` + job `html_compose` + `compose_job_id` trong MỘT transaction. Payload job (snapshot bất biến, KHÔNG tính lại lúc claim):
 * `{project:{id,slug,name,brief}, version:{id,number,parent_version}, prompt, feedback, spec:{aspect,width,height,fps,duration_s,quality,template_id}, policy,
 *   assets:[{id,path,kind,...}], parent:{version,summary,variables,files}|null, limits, allowed_paths}`.
 * Cùng `idempotencyKey` → trả lại phiên bản cũ (`created:false`). Cha phải cùng dự án và `ready`.
 */
export function createComposingVersion(ctx: AppContext, o: NewComposeVersion): { version: HtmlVersionRow; created: boolean } {
  return ctx.tx(() => {
    const project = getHtmlProject(ctx, o.projectId);
    const parent = o.parentId ? requireParent(ctx, project.id, o.parentId) : null;
    const old = existingByKey(ctx, project.id, o.idempotencyKey, (v) => v.prompt === o.prompt && (v.feedback ?? null) === (o.feedback ?? null) && (v.parent_id ?? null) === (parent?.id ?? null));
    if (old) return { version: old, created: false };
    const meta = projectMeta(ctx, project.id);
    const base = parseJson<ModelPolicy>(meta.model_json, {});
    const policy = { compose: o.policy?.compose ?? base.compose ?? 'auto', vision: o.policy?.vision ?? base.vision ?? 'auto', ...(o.policy?.reason ? { reason: o.policy.reason } : {}) };
    const now = ctx.now();
    const number = o.segment ? (ctx.db.prepare('SELECT MAX(1000000000,COALESCE(MAX(version),1000000000))+1 AS n FROM html_versions WHERE project_id=? AND segment_owner_id IS NOT NULL').get(project.id) as {n:number}).n : nextVersion(ctx, project.id);
    const info = ctx.db
      .prepare(
        `INSERT INTO html_versions (project_id, version, parent_id, status, prompt, feedback, compose_policy_json, created_by, idempotency_key, created_at)
         VALUES (?, ?, ?, 'composing', ?, ?, ?, ?, ?, ?)`,
      )
      .run(project.id, number, parent?.id ?? null, o.prompt, o.feedback ?? null, JSON.stringify(policy), o.createdBy ?? 'user', o.idempotencyKey ?? null, now);
    const versionId = Number(info.lastInsertRowid);
    if(o.segment)ctx.db.prepare('UPDATE html_versions SET segment_owner_id=? WHERE id=?').run(o.segment.ownerId,versionId);
    const voice = o.voiceOverride !== undefined ? o.voiceOverride : parent?.voice_json ? parseJson<VoiceSnapshot | null>(parent.voice_json, null) : voiceSnapshot(ctx, project.id);
    ctx.db.prepare('UPDATE html_versions SET voice_json=? WHERE id=?').run(voice ? JSON.stringify(voice) : null, versionId);
    // gắn mọi asset hiện có của dự án (đường dẫn gốc + hash); bản chụp vào thư mục phiên bản làm lúc công bố
    let assets = projectAssets(ctx, project.id);
    const sourceVersion=o.segment?getVersionById(ctx,o.segment.ownerId):parent;
    if(sourceVersion){
      const byId=new Map(assets.map(a=>[a.id,a]));
      const snapshots=listVersionAssets(ctx,sourceVersion.id);
      const scanJob=sourceVersion.compose_job_id??(ctx.db.prepare('SELECT job_id FROM html_segments WHERE version_id=? ORDER BY idx LIMIT 1').get(sourceVersion.id) as {job_id:number|null}|undefined)?.job_id;
      const scanState=scanJob?(ctx.db.prepare('SELECT checkpoint FROM jobs WHERE id=?').get(scanJob) as {checkpoint:string|null}|undefined)?.checkpoint:null;
      const scans=parseJson<{asset_descriptions?:Record<string,unknown>}>(scanState??null,{}).asset_descriptions??{};
      const restored=snapshots.map(a=>{
        const current=byId.get(a.asset_id);
        const stored=a.snapshot_path??a.stored_path;
        if(current)return {...current,stored_path:stored,content_hash:a.content_hash};
        const ext=extOf(stored),kind=/\.(png|jpe?g|webp|gif|svg)$/.test(ext)?'image' as const:/\.(mp4|webm|mov|mkv)$/.test(ext)?'video' as const:'audio' as const;
        return {id:a.asset_id,project_id:project.id,original_name:`Asset #${a.asset_id}`,stored_path:stored,content_hash:a.content_hash,kind,media_type:kind==='image'?`image/${ext==='.jpg'?'jpeg':ext.slice(1)}`:kind==='video'?'video/mp4':'audio/mp4',bytes:fs.statSync(path.join(ctx.config.rootDir,stored)).size,width:null,height:null,duration_s:voice?.asset_id===a.asset_id?voice.duration_s:null,has_audio:kind==='image'?0 as const:1 as const,description_json:scans[String(a.asset_id)]?JSON.stringify(scans[String(a.asset_id)]):null,created_at:now};
      });
      assets=o.segment?restored:[...assets,...restored.filter(a=>!byId.has(a.id))];
    }
    // Góp ý bản cũ vẫn dùng voice của bản đó, kể cả người dùng đã bỏ/xóa file gốc.
    if (parent && voice && !assets.some((a) => a.id === voice.asset_id)) {
      const previous = listVersionAssets(ctx, parent.id).find((a) => a.asset_id === voice.asset_id);
      if (!previous?.snapshot_path) throw conflict('ASSET_MISSING', 'Không tìm thấy bản chụp lời đọc của phiên bản cha');
      assets.push({ id: voice.asset_id, project_id: project.id, original_name: `Lời đọc từ v${parent.version}`, stored_path: previous.snapshot_path, content_hash: previous.content_hash, kind: 'audio', media_type: 'audio/mp4', bytes: fs.statSync(path.join(ctx.config.rootDir, previous.snapshot_path)).size, width: null, height: null, duration_s: voice.duration_s, has_audio: 1, created_at: now });
    }
    for (const a of assets) ctx.db.prepare('INSERT INTO html_version_assets (version_id, asset_ref, stored_path, content_hash) VALUES (?, ?, ?, ?)').run(versionId, a.id, a.stored_path, a.content_hash);
    const size = aspectSize(meta.aspect, meta.quality);
    const payload = {
      ...(o.payload ?? {}),
      voice,
      project: { id: project.id, slug: project.slug, name: project.name, brief: project.brief },
      version: { id: versionId, number:o.segment?getVersionById(ctx,o.segment.ownerId).version:number, parent_version: parent?.version ?? null },
      ...(o.segment?{segment:o.segment}:{}),
      prompt: o.prompt,
      feedback: o.feedback ?? null,
      spec: { aspect: meta.aspect, ...size, fps: 30, duration_s: o.segment ? o.segment.end_s-o.segment.start_s : voice?.duration_s ?? meta.duration_s, quality: meta.quality, template_id: meta.template_id },
      policy,
      assets: assets.map((a) => ({
        id: a.id,
        path: assetPathOf(a),
        kind: a.kind,
        media_type: a.media_type,
        label: a.original_name, // dữ liệu của người dùng, không phải chỉ dẫn
        bytes: a.bytes,
        width: a.width,
        height: a.height,
        duration_s: a.duration_s,
        has_audio: a.has_audio === null ? null : a.has_audio === 1,
        description: parseJson(a.description_json ?? null, null),
      })),
      parent: parent ? { version: parent.version, summary: parent.summary, variables: parseJson<HtmlVariable[]>(parent.variables_json, []), files: readFilesOf(ctx, parent) } : null,
      limits: { max_files: MANIFEST_LIMITS.maxFiles, max_file_bytes: MANIFEST_LIMITS.maxFileBytes, max_total_bytes: MANIFEST_LIMITS.maxTotalBytes, max_depth: MANIFEST_LIMITS.maxDepth },
      allowed_paths: { entry: ENTRY_FILE, dirs: ALLOWED_DIRS, user_assets: USER_ASSET_DIR },
    };
    if(!o.segment&&payload.spec.duration_s>HTML_MAX_DURATION_S){
      createSegments(ctx,getVersionById(ctx,versionId),payload,o);
      return {version:getVersionById(ctx,versionId),created:true};
    }
    const jobId = insertJob(ctx, { project_id: project.id, scene_id: null, type: 'html_compose', requires_approval: false, approved: true, payload });
    ctx.db.prepare('UPDATE html_versions SET compose_job_id = ? WHERE id = ?').run(jobId, versionId);
    logEvent(ctx, { project_id: project.id, type: 'html.compose_created', message: `${parent ? `Sửa v${parent.version} → v${number}` : `Tạo v${number}`} bằng AI (job #${jobId})` });
    ctx.publish('project.updated', project.id, { project_id: project.id });
    return { version: getVersionById(ctx, versionId), created: true };
  });
}

export const variableValuesBody = z.object({ values: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.string().max(2000)).refine((o) => Object.keys(o).length > 0, 'cần ít nhất một giá trị') });

/**
 * Sửa nhanh bằng biến: tạo phiên bản `created_by='user'` từ phiên bản cha `ready` với giá trị biến mới (chỉ các id đã khai báo), áp bằng `applyVariables`
 * (an toàn, không HTML tuỳ ý), kiểm tra lại bảo mật/đường dẫn (hook) rồi công bố. Có idempotency key. Lỗi kiểm tra → phiên bản `failed` (số vẫn bị tiêu).
 */
export async function createVariableVersion(
  ctx: AppContext,
  o: { projectId: number; parentId: number; values: Record<string, string>; idempotencyKey?: string | null; segmentOwnerId?:number; segmentRowId?:number },
): Promise<{ version: HtmlVersionRow; created: boolean }> {
  const prep = ctx.tx(() => {
    const project = getHtmlProject(ctx, o.projectId);
    const parent = requireParent(ctx, project.id, o.parentId);
    const vars = parseJson<HtmlVariable[]>(parent.variables_json, []);
    const sig = JSON.stringify(Object.entries(o.values).sort());
    const old = existingByKey(ctx, project.id, o.idempotencyKey, (v) => v.created_by === 'user' && v.parent_id === parent.id && v.feedback === sig);
    if (old) return { old };
    const parentAssets = listVersionAssets(ctx, parent.id);
    const projAssets = new Map(projectAssets(ctx, project.id).map((a) => [a.id, a]));
    const known = new Set(vars.map((v) => v.id));
    for (const id of Object.keys(o.values)) if (!known.has(id)) throw conflict('UNKNOWN_VARIABLE', `Phiên bản v${parent.version} không có biến "${id}"`);
    // tập asset hợp lệ cho biến ảnh = asset của bản cha (đã chụp) + asset hiện có của dự án
    const allowed = new Set<number>([...parentAssets.map((a) => a.asset_id), ...projAssets.keys()]);
    const next = vars.map((v) => (v.id in o.values ? { ...v, value: o.values[v.id]! } : v));
    for (const v of next) if (v.id in o.values) assertValue(v, v.value, allowed);
    const files = readFilesOf(ctx, parent);
    const pathOf = new Map<number, string>();
    const rows = new Map<number, { stored: string; hash: string }>();
    for (const a of parentAssets) {
      // asset đã chụp: dùng bản trong thư mục bản cha (sống kể cả khi asset gốc đã xoá)
      rows.set(a.asset_id, { stored: a.snapshot_path ?? a.stored_path, hash: a.content_hash });
      pathOf.set(a.asset_id, `${USER_ASSET_DIR}/${a.asset_id}${extOf(a.stored_path)}`);
    }
    for (const v of next) {
      if (v.type !== 'asset' || !(v.id in o.values)) continue;
      const id = Number(v.value);
      const pa = projAssets.get(id);
      if (!rows.has(id) && pa) {
        rows.set(id, { stored: pa.stored_path, hash: pa.content_hash });
        pathOf.set(id, assetPathOf(pa));
      }
    }
    const applied = applyVariables(files, next, (id) => pathOf.get(id) ?? null);
    checkVariables(applied, next.filter((v) => v.type !== 'color'));
    const now = ctx.now();
    const number = o.segmentOwnerId ? (ctx.db.prepare('SELECT MAX(1000000000,COALESCE(MAX(version),1000000000))+1 AS n FROM html_versions WHERE project_id=? AND segment_owner_id IS NOT NULL').get(project.id) as {n:number}).n : nextVersion(ctx, project.id);
    const info = ctx.db
      .prepare(
        `INSERT INTO html_versions (project_id, version, parent_id, status, prompt, feedback, summary, variables_json, compose_policy_json, created_by, idempotency_key, created_at)
         VALUES (?, ?, ?, 'validating', ?, ?, ?, ?, ?, 'user', ?, ?)`,
      )
      .run(project.id, number, parent.id, `Sửa biến: ${Object.keys(o.values).join(', ')}`, sig, parent.summary, JSON.stringify(next), parent.compose_policy_json, o.idempotencyKey ?? null, now);
    const versionId = Number(info.lastInsertRowid);
    if(o.segmentOwnerId)ctx.db.prepare('UPDATE html_versions SET segment_owner_id=? WHERE id=?').run(o.segmentOwnerId,versionId);
    if(o.segmentRowId)ctx.db.prepare("UPDATE html_segments SET segment_version_id=?,status='composing',job_id=NULL WHERE id=?").run(versionId,o.segmentRowId);
    ctx.db.prepare('UPDATE html_versions SET voice_json=? WHERE id=?').run(parent.voice_json ?? null, versionId);
    for (const [assetId, r] of rows) ctx.db.prepare('INSERT INTO html_version_assets (version_id, asset_ref, stored_path, content_hash) VALUES (?, ?, ?, ?)').run(versionId, assetId, r.stored, r.hash);
    logEvent(ctx, { project_id: project.id, type: 'html.variables', message: `Sửa biến của v${parent.version} → v${number}: ${Object.keys(o.values).join(', ')}` });
    return { versionId, files: applied, summary: parent.summary ?? '', vars: next };
  });
  if ('old' in prep) return { version: prep.old!, created: false };
  await stageVersionFiles(ctx, prep.versionId, null, { files: prep.files, summary: prep.summary, variables: prep.vars });
  const version = ctx.tx(() => finalizeVersion(ctx, prep.versionId, null));
  return { version, created: true };
}

export function listVersions(ctx: AppContext, projectId: number): HtmlVersionView[] {
  getHtmlProject(ctx, projectId);
  return (ctx.db.prepare('SELECT * FROM html_versions WHERE project_id = ? AND segment_owner_id IS NULL ORDER BY version DESC').all(projectId) as HtmlVersionRow[]).map((v) => versionView(ctx, v));
}

export function getVersionView(ctx: AppContext, projectId: number, n: number): HtmlVersionView {
  getHtmlProject(ctx, projectId);
  return versionView(ctx, getVersion(ctx, projectId, n));
}

/** Hủy phiên bản đang composing/validating: hủy job (nếu còn) và đánh dấu cancelled. Phiên bản đã ready/failed/cancelled → 409. */
export function cancelHtmlVersion(ctx: AppContext, projectId: number, n: number): HtmlVersionRow {
  return ctx.tx(() => {
    getHtmlProject(ctx, projectId);
    const v = getVersion(ctx, projectId, n);
    if(v.is_segmented){cancelSegments(ctx,v);return getVersionById(ctx,v.id);}
    if (v.status !== 'composing' && v.status !== 'validating') throw conflict('INVALID_STATE', `Phiên bản v${v.version} đang ở trạng thái ${v.status}, không thể hủy`);
    const job = v.compose_job_id ? (ctx.db.prepare('SELECT status FROM jobs WHERE id = ?').get(v.compose_job_id) as { status: string } | undefined) : undefined;
    if (job && ['queued', 'claimed', 'running'].includes(job.status)) cancelJob(ctx, v.compose_job_id!); // nhánh html_compose của cancelJob đánh dấu cancelled
    if (getVersionById(ctx, v.id).status !== 'cancelled') {
      ctx.db.prepare("UPDATE html_versions SET status = 'cancelled', error = 'Đã hủy bởi người dùng', error_code = 'CANCELLED' WHERE id = ?").run(v.id);
      logEvent(ctx, { project_id: projectId, type: 'html.cancelled', message: `Phiên bản Video HTML v${v.version} đã bị hủy` });
      ctx.afterCommit(() => removeStagingOf(ctx, v));
    }
    return getVersionById(ctx, v.id);
  });
}

