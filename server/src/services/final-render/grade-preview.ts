import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import { conflict } from '../../lib/errors.js';
import { cleanBaseOf } from '../final-revisions.js';
import { getFinalCutRow, type Edl, type SelectionItem } from '../final-cuts.js';
import { colorRefKinds } from '../color-refs.js';
import { MatchError, resolveMatchLuts } from '../color-match.js';
import { buildGradeFilter, gradeHash, normalizeGrade, outRanges, type Grade } from '../grade.js';
import { ffmpegOf, probeMedia } from '../media.js';
import { getProject, parseJson } from '../repo.js';
import { run } from './ffmpeg-renderer.js';

/** Ảnh xem trước trước/sau của chỉnh màu: 3 mốc thời gian, mỗi mốc một khung từ BẢN SẠCH (chưa chỉnh màu). */
export const PREVIEW_POINTS = [0.15, 0.5, 0.85] as const;
/** Chiều rộng ảnh xem trước (px); JPEG ~15–30 KB mỗi ảnh. */
export const PREVIEW_WIDTH = 360;
/** Số ảnh tối đa giữ trong thư mục cache của MỖI dự án; vượt thì xoá ảnh cũ nhất. */
export const PREVIEW_CACHE_MAX_FILES = 120;
/** Số lượt xem trước chạy ffmpeg cùng lúc (toàn server): mỗi lượt tạo ≤ 6 ảnh nên cần giới hạn để không chen việc render. */
const MAX_PREVIEW_CONCURRENCY = 2;

export interface GradePreviewResult {
  hash: string;
  items: { t: number; before: string; after: string }[];
}

let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PREVIEW_CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

const previewDir = (slug: string): string => `output/${slug}/final/preview`;

/** Các mốc thời gian (giây, làm tròn 0,1) trong video có thời lượng `dur`. */
export function previewTimes(dur: number): number[] {
  const last = Math.max(0, dur - 0.15);
  return PREVIEW_POINTS.map((p) => Math.round(Math.min(last, dur * p) * 10) / 10);
}

function prune(absDir: string, keep: Set<string>): void {
  try {
    const files = fs
      .readdirSync(absDir)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => ({ f, t: fs.statSync(path.join(absDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(PREVIEW_CACHE_MAX_FILES)) if (!keep.has(x.f)) fs.rmSync(path.join(absDir, x.f), { force: true });
  } catch {
    /* thư mục chưa có */
  }
}

async function frame(bin: string, baseAbs: string, t: number, filter: string | null, outAbs: string): Promise<void> {
  const tmp = `${outAbs}.tmp.jpg`;
  fs.rmSync(tmp, { force: true });
  // -copyts: `t` trong enable='between(t,a,b)' (chỉnh theo cảnh) là thời gian của video đầu ra, không bị đặt lại về 0 sau khi tua
  const vf = `${filter ? `${filter},` : ''}scale=${PREVIEW_WIDTH}:-2`;
  await run(bin, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-copyts', '-i', baseAbs, '-vf', vf, '-frames:v', '1', '-q:v', '4', '-f', 'image2', tmp], new AbortController().signal);
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('ffmpeg không xuất được khung hình');
  fs.renameSync(tmp, outAbs);
}

/**
 * `POST /api/final-cuts/:id/grade-preview`: ảnh trước/sau ở 3 mốc thời gian, render 1 khung bằng ffmpeg từ bản sạch (`base_path` hoặc `video_path` nếu bản
 * chưa chỉnh màu). Cache theo (bản dựng, mốc, hash grade) trong `output/<slug>/final/preview/`, tối đa `PREVIEW_CACHE_MAX_FILES` ảnh mỗi dự án.
 * Có `match` (ảnh mẫu / LUT) thì dùng đúng LUT như bước dựng thật. Trả đường dẫn tương đối từ ROOT; người gọi đổi sang URL (`/files/...` hoặc `/lan/files/...`).
 */
export async function gradePreview(ctx: AppContext, cutId: number, gradeInput: unknown): Promise<GradePreviewResult> {
  const cut = getFinalCutRow(ctx, cutId);
  const project = getProject(ctx, cut.project_id);
  const sceneIds = parseJson<SelectionItem[]>(cut.selection, []).map((s) => s.scene_id);
  const grade: Grade = normalizeGrade(gradeInput, { sceneIds, matchRefs: colorRefKinds(ctx, project.id) });
  if (cut.status !== 'ready') throw conflict('INVALID_STATE', `Bản hoàn chỉnh v${cut.version} đang ở trạng thái ${cut.status}; chỉ xem trước được bản đã sẵn sàng`);
  const baseRel = cleanBaseOf(cut);
  const baseAbs = baseRel ? path.join(ctx.config.rootDir, baseRel) : null;
  if (!baseRel || !baseAbs || !fs.existsSync(baseAbs)) throw conflict('FILE_MISSING', `Không thấy bản sạch của v${cut.version} để xem trước`);
  const bin = ffmpegOf(ctx.config);
  if (!bin) throw conflict('FFMPEG_UNAVAILABLE', 'Không tìm thấy ffmpeg để xem trước màu');
  const dur = probeMedia(ctx.config, baseAbs)?.duration_s ?? cut.duration_s;
  if (!dur) throw conflict('FILE_MISSING', `Không đọc được thời lượng của v${cut.version}`);
  const edl = parseJson<Edl | null>(cut.edl, null);
  const ranges = edl ? outRanges(edl) : [];
  const hash = gradeHash(grade);
  const dirRel = previewDir(project.slug);
  const dirAbs = path.join(ctx.config.rootDir, dirRel);
  fs.mkdirSync(dirAbs, { recursive: true });
  const times = previewTimes(dur);
  const names = times.map((_, k) => ({ before: `v${cut.id}_t${k}_before.jpg`, after: `v${cut.id}_t${k}_${hash}.jpg` }));
  const keep = new Set(names.flatMap((n) => [n.before, n.after]));
  await withSlot(async () => {
    // màu theo ảnh mẫu / LUT: cùng đường đi với bước dựng thật (lấy mẫu bản sạch → file .cube theo hash → lut3d đứng trước eq/...)
    let luts: Awaited<ReturnType<typeof resolveMatchLuts>> | null = null;
    if (grade.match) {
      try {
        luts = await resolveMatchLuts(ctx, project, grade, { baseAbs, ranges });
      } catch (err) {
        if (err instanceof MatchError) throw conflict('COLOR_MATCH_FAILED', `Không áp được màu theo ảnh mẫu: ${err.message}`);
        throw err;
      }
    }
    const filter = buildGradeFilter(grade, ranges, luts);
    for (let k = 0; k < times.length; k++) {
      const n = names[k]!;
      if (!fs.existsSync(path.join(dirAbs, n.before))) await frame(bin, baseAbs, times[k]!, null, path.join(dirAbs, n.before));
      if (!fs.existsSync(path.join(dirAbs, n.after))) {
        // grade trung tính: ảnh "sau" là chính ảnh "trước" (không chạy lại ffmpeg)
        if (!filter) fs.copyFileSync(path.join(dirAbs, n.before), path.join(dirAbs, n.after));
        else await frame(bin, baseAbs, times[k]!, filter, path.join(dirAbs, n.after));
      }
    }
  });
  prune(dirAbs, keep);
  return { hash, items: times.map((t, k) => ({ t, before: `${dirRel}/${names[k]!.before}`, after: `${dirRel}/${names[k]!.after}` })) };
}
