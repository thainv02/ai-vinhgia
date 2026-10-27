/**
 * Bước 3 của planner LAN: người dùng tải lên video cảnh họ tự tạo trên Google Flow. Video lưu thành asset `video` bình thường của cảnh
 * (`output/<slug>/video/<code>_v<n>.mp4`, `job_id=NULL`, `meta.source='lan_upload'`) và TRỞ THÀNH video được chọn của cảnh.
 * KHÔNG đổi trạng thái cảnh (không qua `transition`), không tạo job, không tốn credit; điều kiện dựng bản hoàn chỉnh của dự án LAN chỉ
 * là "mọi cảnh có video được chọn" (xem lan-final.ts). Dự án `app` không đi qua file này.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { conflict, notFound, AppError } from '../lib/errors.js';
import { cleanRelPath } from '../lib/paths.js';
import type { AssetRow, ProjectRow, SceneRow } from '../db/types.js';
import { emitProject } from './project-view.js';
import { assetJson, emitBudget, getAsset, getScene, logEvent, parseJson } from './repo.js';
import { emitScene } from './scene-view.js';
import { LAN_UPLOAD_SOURCE, lanFileUrl, storyboardUploadBlock } from './lan-common.js';
import type { UploadedVideoProbe } from './media.js';

export const MAX_VIDEOS_PER_SCENE = 5;
export const LAN_VIDEO_MIN_S = 1;
export const LAN_VIDEO_MAX_S = 60;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Lỗi nghiệp vụ nếu ffprobe không đọc được hoặc thời lượng ngoài [min, max] giây. */
export function assertVideoProbe(probe: UploadedVideoProbe | null, limits: { min: number; max: number }): UploadedVideoProbe {
  if (!probe || !probe.info.width || !probe.info.height) {
    throw new AppError('INVALID_VIDEO', 'Không đọc được video (file hỏng hoặc không có luồng hình)', 422);
  }
  const d = probe.info.duration_s;
  if (d === null || !Number.isFinite(d)) throw new AppError('INVALID_VIDEO', 'Không đọc được thời lượng video', 422);
  const dur = round3(d);
  if (dur < limits.min || dur > limits.max) {
    throw new AppError('VIDEO_DURATION', `Video dài ${dur.toFixed(1).replace('.', ',')} giây; chỉ nhận video từ ${limits.min} đến ${limits.max} giây`, 422, { duration_s: dur, min_s: limits.min, max_s: limits.max });
  }
  return probe;
}

export function videoMeta(up: { originalName: string; bytes: number; probe: UploadedVideoProbe }) {
  const i = up.probe.info;
  return {
    source: LAN_UPLOAD_SOURCE,
    original_name: up.originalName.slice(0, 200),
    bytes: up.bytes,
    duration_s: round3(i.duration_s ?? 0),
    width: i.width,
    height: i.height,
    fps: i.fps === null ? null : round3(i.fps),
    has_audio: i.has_audio,
    ffprobe: { format_name: up.probe.format_name, video_codec: up.probe.video_codec, audio_codec: up.probe.audio_codec, video_streams: up.probe.video_streams },
  };
}

const lanVideoRows = (ctx: AppContext, sceneId: number): AssetRow[] =>
  ctx.db.prepare("SELECT * FROM assets WHERE scene_id = ? AND kind = 'video' AND json_extract(meta, '$.source') = ? ORDER BY id").all(sceneId, LAN_UPLOAD_SOURCE) as AssetRow[];

export interface LanVideoJson {
  id: number;
  attempt: number;
  url: string;
  file_name: string;
  uploaded_at: string;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  has_audio: boolean | null;
  selected: boolean;
}

function videoJson(a: AssetRow, selectedId: number | null): LanVideoJson {
  const m = parseJson<Record<string, unknown>>(a.meta, {});
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: a.id,
    attempt: a.attempt,
    url: lanFileUrl(a.file_path),
    file_name: typeof m.original_name === 'string' && m.original_name ? m.original_name : path.posix.basename(a.file_path),
    uploaded_at: a.created_at,
    duration_s: n(m.duration_s),
    width: n(m.width),
    height: n(m.height),
    bytes: n(m.bytes),
    has_audio: typeof m.has_audio === 'boolean' ? m.has_audio : null,
    selected: a.id === selectedId,
  };
}

/** Lý do chưa tải thêm video lên cảnh (null = được). Dùng chung luật "chủ máy đang sản xuất cảnh này" với storyboard. */
export function videoUploadBlock(ctx: AppContext, scene: SceneRow): string | null {
  const busy = storyboardUploadBlock(ctx, scene);
  if (busy) return busy.replace('storyboard', 'video');
  if (lanVideoRows(ctx, scene.id).length >= MAX_VIDEOS_PER_SCENE) return `Đã tải tối đa ${MAX_VIDEOS_PER_SCENE} video cho cảnh này`;
  return null;
}

/** Ném 409 (SCENE_BUSY / TOO_MANY_UPLOADS) nếu cảnh chưa nhận thêm video; gọi TRƯỚC khi nhận file để khỏi tải 200 MB rồi mới báo bận. */
export function assertVideoUploadable(ctx: AppContext, scene: SceneRow): void {
  const block = videoUploadBlock(ctx, scene);
  if (block) throw conflict(block.startsWith('Đã tải tối đa') ? 'TOO_MANY_UPLOADS' : 'SCENE_BUSY', block);
}

/** Bước 3 của một cảnh trong chi tiết kế hoạch. `selected_id` chỉ tính nếu video được chọn là bản tải lên (file phục vụ được qua LAN). */
export function sceneVideosJson(ctx: AppContext, scene: SceneRow) {
  const rows = lanVideoRows(ctx, scene.id);
  const selectedId = rows.some((r) => r.id === scene.selected_video_id) ? scene.selected_video_id : null;
  return {
    items: rows.map((r) => videoJson(r, selectedId)),
    selected_id: selectedId,
    count: rows.length,
    max: MAX_VIDEOS_PER_SCENE,
    block: videoUploadBlock(ctx, scene),
  };
}

export interface NewLanVideo {
  tmpAbs: string;
  bytes: number;
  originalName: string;
  probe: UploadedVideoProbe;
}

/**
 * Lưu video đã tải xong (file tạm đã ghi đủ và ffprobe đã đạt) thành asset của cảnh và chọn nó. Trong MỘT transaction:
 * kiểm tra cảnh không bận, đủ chỗ (≤ 5 video), tính attempt, gắn file vào tên cuối bằng hard link (nguyên tử, KHÔNG BAO GIỜ ghi đè file có sẵn),
 * ghi asset + đặt `selected_video_id` + event + SSE. Lỗi giữa chừng thì xoá file đã gắn (file tạm do người gọi dọn).
 */
export function addLanVideo(ctx: AppContext, p: ProjectRow, sceneId: number, up: NewLanVideo): AssetRow {
  const scene = getScene(ctx, sceneId);
  if (scene.project_id !== p.id) throw notFound('cảnh');
  let finalAbs: string | null = null;
  try {
    return ctx.tx(() => {
      assertVideoUploadable(ctx, getScene(ctx, scene.id));
      const used = ctx.db.prepare("SELECT COALESCE(MAX(attempt), 0) AS m, COUNT(*) AS n FROM assets WHERE scene_id = ? AND kind = 'video'").get(scene.id) as { m: number; n: number };
      let attempt = Math.max(used.m, used.n) + 1;
      let rel = '';
      for (let tries = 0; ; tries++) {
        rel = cleanRelPath(`output/${p.slug}/video/${scene.code}_v${attempt}.mp4`, ['output']);
        const abs = path.join(ctx.config.rootDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        try {
          fs.linkSync(up.tmpAbs, abs); // hard link: nguyên tử và thất bại (EEXIST) thay vì ghi đè
          finalAbs = abs;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' && tries < 50) {
            attempt++;
            continue;
          }
          if (code === 'EEXIST') throw conflict('FILE_EXISTS', 'Không chọn được tên file cho video');
          // hệ thống file không hỗ trợ hard link: đổi tên (vẫn nguyên tử) sau khi kiểm tra không có file trùng
          if (fs.existsSync(abs)) {
            attempt++;
            continue;
          }
          fs.copyFileSync(up.tmpAbs, abs, fs.constants.COPYFILE_EXCL);
          finalAbs = abs;
          break;
        }
      }
      fs.rmSync(up.tmpAbs, { force: true });
      const meta = videoMeta(up);
      const info = ctx.db
        .prepare("INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, meta, created_at) VALUES (?, NULL, 'video', ?, ?, ?, ?)")
        .run(scene.id, rel, attempt, JSON.stringify(meta), ctx.now());
      const id = Number(info.lastInsertRowid);
      ctx.db.prepare('UPDATE scenes SET selected_video_id = ?, updated_at = ? WHERE id = ?').run(id, ctx.now(), scene.id);
      logEvent(ctx, { project_id: p.id, scene_id: scene.id, type: 'scene.video_uploaded', message: `${scene.code}: người dùng LAN tải lên video (lượt ${attempt}, ${meta.duration_s} giây) và chọn làm video của cảnh` });
      ctx.publish('asset.created', p.id, () => ({ asset: assetJson(getAsset(ctx, id)) }));
      emitScene(ctx, scene.id, p.id);
      emitBudget(ctx, p.id);
      emitProject(ctx, p.id);
      return getAsset(ctx, id);
    });
  } catch (err) {
    if (finalAbs) fs.rmSync(finalAbs, { force: true });
    throw err;
  }
}

/** Chọn lại một video đã tải lên của cảnh làm video chính (không đổi trạng thái cảnh, không tạo job). */
export function selectLanVideo(ctx: AppContext, p: ProjectRow, sceneId: number, assetId: number): LanVideoJson {
  return ctx.tx(() => {
    const scene = getScene(ctx, sceneId);
    if (scene.project_id !== p.id) throw notFound('cảnh');
    const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined;
    const ok = asset && asset.scene_id === scene.id && asset.kind === 'video' && parseJson<{ source?: string }>(asset.meta, {}).source === LAN_UPLOAD_SOURCE;
    if (!ok) throw notFound('video đã tải lên của cảnh này');
    if (scene.selected_video_id !== asset.id) {
      ctx.db.prepare('UPDATE scenes SET selected_video_id = ?, updated_at = ? WHERE id = ?').run(asset.id, ctx.now(), scene.id);
      logEvent(ctx, { project_id: p.id, scene_id: scene.id, type: 'scene.video_selected', message: `${scene.code}: người dùng LAN chọn video lượt ${asset.attempt} (asset #${asset.id})` });
      emitScene(ctx, scene.id, p.id);
      emitProject(ctx, p.id);
    }
    return videoJson(asset, asset.id);
  });
}

export { videoJson as lanVideoJson };
