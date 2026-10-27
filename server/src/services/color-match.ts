/**
 * "Màu theo ảnh mẫu": biến `Grade.match` thành file LUT 3D (`.cube`) áp bằng ffmpeg `lut3d` (xem `buildGradeFilter`). TẤT ĐỊNH, không dùng AI:
 * 1. thống kê Lab của ảnh mẫu (1 khung ~256px) và của BẢN SẠCH chưa chỉnh màu (12 khung rải đều; hoặc 4 khung mỗi cảnh khi khớp riêng từng cảnh);
 * 2. chuyển màu kiểu Reinhard trong lαβ (log-LMS; vết ám nhân thành độ lệch hằng nên vùng trung tính ở lại trung tính; tỉ lệ σ kênh sắc kẹp 0,8–1,25, kênh sáng 0,6–1,6; bỏ pixel L*<3 hoặc >97), chế độ `color` (giữ nguyên độ chói Y ⇔ L*) hoặc `full`, nội suy theo `strength` (`color-lut.ts`);
 * 3. ghi LUT 33³ vào `output/<slug>/final/luts/<hash>.cube`; hash theo (thống kê ảnh mẫu, thống kê video, chế độ, cường độ, cỡ LUT) → dùng lại nếu đã có, KHÔNG ghi đè.
 *
 * Lựa chọn thiết kế (đặc tả cho phép hai cách): grade của phiên bản CHỈ lưu thông số (`kind, ref_id, strength, mode, per_scene`), KHÔNG lưu đường dẫn LUT.
 * LUT được TÍNH LẠI theo hash mỗi lần dựng/xem trước (thống kê video và ảnh mẫu được nhớ trong bộ nhớ nên rất nhanh). Kết quả tái lập được vì ảnh mẫu bất biến
 * (đặt tên theo nội dung, chỉ xoá được khi chưa bản nào dùng) và bản sạch của một phiên bản bất biến. File trong `luts/` chỉ là bộ nhớ đệm: cũ quá thì dọn (`pruneLuts`).
 * Với file LUT người dùng (`kind='lut'`): đọc lại file đã chuẩn hoá của server, trộn với đồng nhất theo `strength`, ghi vào `luts/`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import type { ColorRefRow, ProjectRow } from '../db/types.js';
import { cleanRelPath, resolveInside } from '../lib/paths.js';
import { blendWithIdentity, buildTransferLut, DEFAULT_SPACE, defaultChromaClamp, LUT_SIZE, parseCube, writeCube, type LabStats } from './color-lut.js';
import { cachedStats, fileKey, GLOBAL_FRAMES, imageStats, SampleError, SCENE_FRAMES, videoRangeStats } from './color-sample.js';
import type { OutRange, ResolvedLuts } from './grade.js';

export class MatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchError';
  }
}

/** Số LUT tối đa giữ trong `luts/` của mỗi dự án (bộ nhớ đệm; chỉ xoá file cũ hơn `LUT_MIN_AGE_MS`). */
export const LUT_CACHE_MAX_FILES = 80;
const LUT_MIN_AGE_MS = 60 * 60_000;

export const lutsDir = (slug: string): string => `output/${slug}/final/luts`;

const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const statsKey = (s: LabStats): number[] => [...s.mean.map(r4), ...s.std.map(r4)];

function hashOf(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** Ghi file mới (không ghi đè): có sẵn thì thôi. Ghi tạm rồi link nguyên tử để hai tiến trình cùng hash không giẫm nhau. */
function writeLutOnce(abs: string, text: string): void {
  if (fs.existsSync(abs)) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.linkSync(tmp, abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Dọn bộ nhớ đệm LUT: giữ `LUT_CACHE_MAX_FILES` file mới nhất; không xoá file mới hơn 1 giờ (có thể đang được ffmpeg dùng). */
export function pruneLuts(absDir: string, now = Date.now()): void {
  try {
    const files = fs
      .readdirSync(absDir)
      .filter((f) => f.endsWith('.cube'))
      .map((f) => ({ f, t: fs.statSync(path.join(absDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(LUT_CACHE_MAX_FILES)) if (now - x.t > LUT_MIN_AGE_MS) fs.rmSync(path.join(absDir, x.f), { force: true });
  } catch {
    /* thư mục chưa có */
  }
}

function refFileAbs(ctx: AppContext, row: ColorRefRow): string {
  let abs: string | null = null;
  try {
    abs = resolveInside(ctx.config.rootDir, cleanRelPath(row.file_path, ['output']), ['output']);
  } catch {
    abs = null;
  }
  if (!abs) throw new MatchError(`không thấy file của ${row.kind === 'lut' ? 'file LUT' : 'ảnh mẫu'} «${(row.original_name ?? `#${row.id}`).slice(0, 60)}»`);
  return abs;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Sinh (hoặc dùng lại) LUT cho `grade.match`. `baseAbs`: BẢN SẠCH chưa chỉnh màu (đã xoá logo). `ranges`: khoảng thời gian từng cảnh trên video đầu ra
 * (bắt buộc cho `per_scene`; cảnh lỗi lấy mẫu / quá ngắn dùng thống kê chung). Trả đường dẫn TUYỆT ĐỐI của các file `.cube`.
 */
export async function resolveMatchLuts(
  ctx: AppContext,
  project: Pick<ProjectRow, 'id' | 'slug'>,
  grade: { match?: { kind: 'image' | 'lut'; ref_id: number; strength: number; mode: 'color' | 'full'; per_scene: boolean } },
  o: { baseAbs: string; ranges: OutRange[]; signal?: AbortSignal },
): Promise<ResolvedLuts> {
  const m = grade.match;
  if (!m) return { global: null, scenes: [] };
  const row = ctx.db.prepare('SELECT * FROM color_refs WHERE id = ? AND project_id = ?').get(m.ref_id, project.id) as ColorRefRow | undefined;
  if (!row) throw new MatchError(`ảnh mẫu / file LUT #${m.ref_id} không còn trong dự án`);
  if (row.kind !== m.kind) throw new MatchError(`#${m.ref_id} không phải ${m.kind === 'lut' ? 'file LUT' : 'ảnh mẫu'}`);
  const refAbs = refFileAbs(ctx, row);
  const dirAbs = path.join(ctx.config.rootDir, lutsDir(project.slug));

  if (m.kind === 'lut') {
    const name = `${hashOf({ v: 1, kind: 'lut', ref: row.content_hash, strength: m.strength })}.cube`;
    const abs = path.join(dirAbs, name);
    if (!fs.existsSync(abs)) {
      const lut = blendWithIdentity(parseCube(fs.readFileSync(refAbs, 'utf8')), m.strength);
      writeLutOnce(abs, writeCube(lut, `${(row.original_name ?? 'LUT').replace(/\.cube$/i, '')} ${Math.round(m.strength * 100)}%`));
    }
    pruneLuts(dirAbs);
    return { global: abs, scenes: [] };
  }

  try {
    const refStats = await cachedStats(`ref|${DEFAULT_SPACE}|${row.content_hash}`, () => imageStats(ctx.config, refAbs, o.signal));
    const baseKey = fileKey(o.baseAbs);
    const globalStats = (): Promise<LabStats> => cachedStats(`vid|${DEFAULT_SPACE}|${baseKey}|all`, () => videoRangeStats(ctx.config, o.baseAbs, 0, Number.MAX_SAFE_INTEGER, GLOBAL_FRAMES, o.signal));
    const make = (src: LabStats): string => {
      const name = `${hashOf({ v: 2, kind: 'image', space: DEFAULT_SPACE, clamp: defaultChromaClamp(DEFAULT_SPACE), ref: statsKey(refStats), src: statsKey(src), mode: m.mode, strength: m.strength, size: LUT_SIZE })}.cube`;
      const abs = path.join(dirAbs, name);
      if (!fs.existsSync(abs)) {
        const lut = buildTransferLut({ mode: m.mode, strength: m.strength, src, ref: refStats, space: DEFAULT_SPACE }, LUT_SIZE);
        writeLutOnce(abs, writeCube(lut, `${(row.original_name ?? 'Anh mau').replace(/\.[A-Za-z0-9]{1,5}$/, '')} ${m.mode} ${Math.round(m.strength * 100)}%`));
      }
      return abs;
    };
    if (!m.per_scene) {
      const g = make(await globalStats());
      pruneLuts(dirAbs);
      return { global: g, scenes: [] };
    }
    const scenes: ResolvedLuts['scenes'] = [];
    for (const r of o.ranges) {
      if (r.end <= r.start) continue;
      let src: LabStats;
      try {
        src = await cachedStats(`vid|${DEFAULT_SPACE}|${baseKey}|${r.start}-${r.end}`, () => videoRangeStats(ctx.config, o.baseAbs, r.start, r.end, SCENE_FRAMES, o.signal));
      } catch (err) {
        if (o.signal?.aborted || !(err instanceof SampleError)) throw err;
        src = await globalStats(); // cảnh quá tối/lỗi lấy mẫu: dùng thống kê chung
      }
      scenes.push({ scene_id: r.scene_id, path: make(src) });
      await tick(); // nhường vòng lặp sự kiện giữa các cảnh (mỗi LUT tính vài trăm ms)
    }
    pruneLuts(dirAbs);
    return { global: null, scenes };
  } catch (err) {
    if (err instanceof SampleError) throw new MatchError(err.message);
    throw err;
  }
}
