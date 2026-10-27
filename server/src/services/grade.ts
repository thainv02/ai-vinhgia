import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Chỉnh màu (grade) của bản dựng hoàn chỉnh. Thực hiện bằng ffmpeg (`eq`, `colortemperature`, `vibrance`) trên BẢN SẠCH đã xoá logo Veo:
 * thứ tự BẮT BUỘC là xoá logo TRƯỚC, chỉnh màu SAU (tool gwr tính ngược alpha từ màu gốc của logo; đổi màu trước sẽ để lại vết).
 *
 * Quy ước thông số (khớp giao diện và prompt của worker):
 * - `temperature_k`: nhiệt độ màu theo nghĩa người dùng (như thanh "Temp" của phần mềm chỉnh ảnh): CAO HƠN = ẤM HƠN, 6500 = trung tính.
 *   Bộ lọc `colortemperature` của ffmpeg ngược lại (nhiệt độ nguồn sáng cần bù: cao hơn = lạnh hơn) nên khi dựng filter ta lấy đối xứng quanh 6500:
 *   `ffmpeg_K = 13000 − temperature_k` (7200K → 5800 = ấm hơn; 5800K → 7200 = lạnh hơn).
 * - `scenes[]`: chỉnh THÊM cho riêng một cảnh, áp chồng lên chỉnh chung (cùng ý nghĩa và cùng giá trị trung tính; riêng `temperature_k` trung tính 6500).
 *   Khoảng thời gian của cảnh trên video đầu ra tính từ EDL (cộng độ dài các đoạn giữ lại theo thứ tự cảnh), xem `outRanges`.
 */

export interface SceneGrade {
  scene_id: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  temperature_k?: number;
}

/**
 * Màu theo ảnh mẫu / file LUT (xem `color-match.ts`). Chạy NGAY SAU xoá logo và TRƯỚC mọi chỉnh khác (`lut3d` rồi `eq`/`colortemperature`/`vibrance`).
 * `ref_id` là id trong bảng `color_refs` của CHÍNH dự án. Với `kind='lut'` chỉ có `strength` ý nghĩa (`mode` luôn 'color', `per_scene` luôn false).
 * Grade chỉ lưu thông số này (không lưu đường dẫn LUT): file LUT sinh ra được TÍNH LẠI theo hash (ảnh mẫu, thống kê bản sạch, chế độ, cường độ) khi dựng/xem trước.
 */
export interface ColorMatch {
  kind: 'image' | 'lut';
  ref_id: number;
  /** 0–1 (mặc định 0.7). */
  strength: number;
  mode: 'color' | 'full';
  per_scene: boolean;
}

export const MATCH_DEFAULT_STRENGTH = 0.7;

export interface Grade {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  temperature_k: number;
  vibrance: number;
  scenes?: SceneGrade[];
  /** Màu theo ảnh mẫu / LUT; thiếu = không dùng. */
  match?: ColorMatch;
}

export type GradeKey = 'brightness' | 'contrast' | 'saturation' | 'gamma' | 'temperature_k' | 'vibrance';

/** Khoảng cho phép, giá trị trung tính và số chữ số thập phân khi chuẩn hoá. */
export const GRADE_RANGES: Record<GradeKey, { min: number; max: number; neutral: number; digits: number }> = {
  brightness: { min: -0.25, max: 0.25, neutral: 0, digits: 2 },
  contrast: { min: 0.7, max: 1.5, neutral: 1, digits: 2 },
  saturation: { min: 0.5, max: 1.8, neutral: 1, digits: 2 },
  gamma: { min: 0.7, max: 1.4, neutral: 1, digits: 2 },
  temperature_k: { min: 4000, max: 9000, neutral: 6500, digits: 0 },
  vibrance: { min: -0.5, max: 1, neutral: 0, digits: 2 },
};

const KEYS = Object.keys(GRADE_RANGES) as GradeKey[];
const SCENE_KEYS: GradeKey[] = ['brightness', 'contrast', 'saturation', 'gamma', 'temperature_k'];
const MAX_SCENE_GRADES = 40;

export const NEUTRAL_GRADE: Grade = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature_k: 6500, vibrance: 0 };
export const neutralGrade = (): Grade => ({ ...NEUTRAL_GRADE });

const num = z.number({ error: 'phải là số' });
const matchShape = z.object({
  kind: z.enum(['image', 'lut'], { error: 'phải là "image" hoặc "lut"' }),
  ref_id: z.number({ error: 'phải là số' }).int('phải là số nguyên').positive('phải là số dương'),
  strength: num.optional(),
  mode: z.enum(['color', 'full'], { error: 'phải là "color" hoặc "full"' }).optional(),
  per_scene: z.boolean({ error: 'phải là true/false' }).optional(),
});
const gradeShape = z.object({
  match: matchShape.nullable().optional(),
  brightness: num.optional(),
  contrast: num.optional(),
  saturation: num.optional(),
  gamma: num.optional(),
  temperature_k: num.optional(),
  vibrance: num.optional(),
  scenes: z
    .array(
      z.object({
        scene_id: z.number({ error: 'phải là số' }).int('phải là số nguyên'),
        brightness: num.optional(),
        contrast: num.optional(),
        saturation: num.optional(),
        gamma: num.optional(),
        temperature_k: num.optional(),
      }),
    )
    .max(MAX_SCENE_GRADES, `tối đa ${MAX_SCENE_GRADES} cảnh`)
    .optional(),
});

const invalidGrade = (message: string, details?: Record<string, unknown>): AppError => new AppError('INVALID_GRADE', `Thông số màu không hợp lệ — ${message}`, 400, details);

function clampRound(key: GradeKey, v: number): number {
  const r = GRADE_RANGES[key];
  const c = Math.min(r.max, Math.max(r.min, v));
  const f = 10 ** r.digits;
  return Math.round(c * f) / f;
}

/**
 * Kiểm tra và chuẩn hoá Grade: thiếu trường → giá trị trung tính; giá trị ngoài khoảng bị KẸP (không báo lỗi), làm tròn 2 chữ số (nhiệt độ: số nguyên);
 * sai kiểu (chữ, null...) → 400 `INVALID_GRADE`. `null`/`undefined` → trung tính. `sceneIds` (nếu có): chỉnh theo cảnh phải thuộc danh sách này.
 * Mục chỉnh theo cảnh toàn giá trị trung tính bị bỏ; không còn mục nào thì không có khoá `scenes`.
 * `match` (màu theo ảnh mẫu): thiếu/null → bỏ; `strength` kẹp 0–1 (2 chữ số, mặc định 0,7), `mode` mặc định 'color', `per_scene` mặc định false (LUT: luôn 'color'/false).
 * `matchRefs` (id → loại của các ảnh mẫu/LUT của dự án) có truyền thì `ref_id` phải nằm trong đó và đúng loại, không thì 400 `INVALID_GRADE`.
 */
export function normalizeGrade(input: unknown, opts: { sceneIds?: number[]; matchRefs?: ReadonlyMap<number, 'image' | 'lut'> } = {}): Grade {
  if (input === null || input === undefined) return neutralGrade();
  const parsed = gradeShape.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    const where = i.path.length ? i.path.map((p) => (typeof p === 'number' ? `#${p + 1}` : String(p))).join('.') : 'grade';
    throw invalidGrade(`${where}: ${i.message}`, { path: i.path });
  }
  const p = parsed.data;
  const out: Grade = { ...NEUTRAL_GRADE };
  for (const k of KEYS) if (p[k] !== undefined) out[k] = clampRound(k, p[k]!);
  if (p.scenes?.length) {
    const seen = new Set<number>();
    const scenes: SceneGrade[] = [];
    for (const sc of p.scenes) {
      if (opts.sceneIds && !opts.sceneIds.includes(sc.scene_id)) throw invalidGrade(`scene_id ${sc.scene_id} không thuộc bản dựng này`, { scene_id: sc.scene_id });
      if (seen.has(sc.scene_id)) throw invalidGrade(`scene_id ${sc.scene_id} bị lặp trong "scenes"`, { scene_id: sc.scene_id });
      seen.add(sc.scene_id);
      const o: SceneGrade = { scene_id: sc.scene_id };
      for (const k of SCENE_KEYS) {
        const v = sc[k as keyof typeof sc] as number | undefined;
        if (v === undefined) continue;
        const n = clampRound(k, v);
        if (n !== GRADE_RANGES[k].neutral) (o as unknown as Record<string, number>)[k] = n;
      }
      if (Object.keys(o).length > 1) scenes.push(o);
    }
    if (opts.sceneIds) scenes.sort((a, b) => opts.sceneIds!.indexOf(a.scene_id) - opts.sceneIds!.indexOf(b.scene_id));
    if (scenes.length) out.scenes = scenes;
  }
  if (p.match) {
    const m = p.match;
    if (opts.matchRefs) {
      const kind = opts.matchRefs.get(m.ref_id);
      if (!kind) throw invalidGrade(`match.ref_id ${m.ref_id} không thuộc dự án này`, { ref_id: m.ref_id });
      if (kind !== m.kind) throw invalidGrade(`match.ref_id ${m.ref_id} là ${kind === 'image' ? 'ảnh mẫu' : 'file LUT'}, không phải "${m.kind}"`, { ref_id: m.ref_id });
    }
    const image = m.kind === 'image';
    const strength = Math.round(Math.min(1, Math.max(0, m.strength ?? MATCH_DEFAULT_STRENGTH)) * 100) / 100;
    out.match = { kind: m.kind, ref_id: m.ref_id, strength, mode: image ? (m.mode ?? 'color') : 'color', per_scene: image ? (m.per_scene ?? false) : false };
  }
  return out;
}

/** Trung tính = không chạy bước chỉnh màu. */
export function isNeutralGrade(g: Grade | null | undefined): boolean {
  if (!g) return true;
  if (g.match) return false;
  if (g.scenes?.length) return false;
  return KEYS.every((k) => g[k] === GRADE_RANGES[k].neutral);
}

/** Chuỗi chuẩn (khoá theo thứ tự cố định) để so sánh và băm. */
export function canonicalGrade(g: Grade): string {
  const base = KEYS.map((k) => g[k]);
  const scenes = (g.scenes ?? []).map((s) => [s.scene_id, ...SCENE_KEYS.map((k) => (s as unknown as Record<string, number | undefined>)[k] ?? null)]);
  // `match` chỉ thêm khi có: grade cũ (không match) giữ nguyên chuỗi chuẩn nên hash/cache ảnh xem trước cũ không đổi
  return JSON.stringify(g.match ? [base, scenes, [g.match.kind, g.match.ref_id, g.match.strength, g.match.mode, g.match.per_scene]] : [base, scenes]);
}

export const gradesEqual = (a: Grade | null | undefined, b: Grade | null | undefined): boolean => canonicalGrade(a ?? NEUTRAL_GRADE) === canonicalGrade(b ?? NEUTRAL_GRADE);

/** Băm ngắn của grade (khoá cache ảnh xem trước). */
export const gradeHash = (g: Grade): string => crypto.createHash('sha256').update(canonicalGrade(g)).digest('hex').slice(0, 16);

/** Đọc grade lưu trong DB (JSON); sai/hỏng → trung tính. Trả `null` khi cột rỗng. */
export function parseStoredGrade(raw: string | null): Grade | null {
  if (!raw) return null;
  try {
    return normalizeGrade(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ khoảng thời gian của cảnh trên video đầu ra

export interface OutRange {
  scene_id: number;
  /** Giây trên video đầu ra (đã chỉnh màu). */
  start: number;
  end: number;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Khoảng [start, end) của từng cảnh trên video đầu ra: cộng dồn độ dài các đoạn giữ lại (`out_s − in_s`) theo thứ tự cảnh của EDL. */
export function outRanges(edl: { scenes: { scene_id: number; segments: { in_s: number; out_s: number }[] }[] }): OutRange[] {
  let acc = 0;
  return edl.scenes.map((sc) => {
    const start = acc;
    for (const s of sc.segments) acc += s.out_s - s.in_s;
    return { scene_id: sc.scene_id, start: r3(start), end: r3(acc) };
  });
}

// ------------------------------------------------------------------ filter ffmpeg

const n3 = (x: number): string => String(Math.round(x * 1000) / 1000);

/** Nhiệt độ cho `colortemperature` của ffmpeg: đối xứng quanh 6500 (xem chú thích đầu file). */
export const ffmpegTemperature = (k: number): number => Math.min(40000, Math.max(1000, 13000 - k));

function eqPart(v: { brightness?: number; contrast?: number; saturation?: number; gamma?: number }, enable: string): string | null {
  const parts: string[] = [];
  if (v.brightness !== undefined && v.brightness !== 0) parts.push(`brightness=${n3(v.brightness)}`);
  if (v.contrast !== undefined && v.contrast !== 1) parts.push(`contrast=${n3(v.contrast)}`);
  if (v.saturation !== undefined && v.saturation !== 1) parts.push(`saturation=${n3(v.saturation)}`);
  if (v.gamma !== undefined && v.gamma !== 1) parts.push(`gamma=${n3(v.gamma)}`);
  if (!parts.length) return null;
  return `eq=${parts.join(':')}${enable}`;
}

/** Biểu thức `enable` theo khoảng thời gian (end trừ 1 ms để hai cảnh liền nhau không cùng áp lên một khung hình ở ranh giới). */
const enableFor = (r: OutRange): string => `:enable='between(t,${n3(r.start)},${n3(Math.max(r.start, r.end - 0.001))})'`;

/** LUT 3D đã sinh cho một grade có `match` (đường dẫn TUYỆT ĐỐI tới file `.cube`). `scenes` chỉ có khi `match.per_scene`. */
export interface ResolvedLuts {
  global: string | null;
  scenes: { scene_id: number; path: string }[];
}

/**
 * Đường dẫn cho tuỳ chọn `file=` của ffmpeg: thoát ký tự đặc biệt của tuỳ chọn (`\`, `:`, `'`) rồi bọc nháy đơn của filtergraph (`'` → `'\''`),
 * nên đường dẫn có dấu cách, dấu hai chấm, dấu phẩy, nháy... vẫn đúng (test chạy ffmpeg thật với đường dẫn như vậy).
 */
export function ffmpegFilterPath(p: string): string {
  const opt = p.replace(/[\\:']/g, (c) => `\\${c}`);
  return `'${opt.replace(/'/g, `'\\''`)}'`;
}

const lutPart = (file: string, enable: string): string => `lut3d=file=${ffmpegFilterPath(file)}:interp=tetrahedral${enable}`;

/**
 * Dãy bộ lọc ffmpeg (`-vf`) cho một grade; `null` nếu trung tính. Thứ tự: (1) `lut3d` theo ảnh mẫu / file LUT (chung, hoặc riêng từng cảnh với `enable`),
 * (2) `eq` → `colortemperature` → `vibrance` cho chỉnh chung, rồi `eq` + `colortemperature` cho từng cảnh (`enable='between(t,a,b)'`), (3) `format=yuv420p`
 * (các bộ lọc màu chạy trên RGB phẳng). Xoá logo đã xong từ trước (ở bản sạch). Nhờ LUT đứng trước nên sau khi khớp ảnh mẫu vẫn góp ý "ấm hơn" được.
 * `ranges` bắt buộc khi grade có `scenes` hoặc `match.per_scene` (thiếu khoảng của một cảnh thì bỏ qua cảnh đó).
 * `luts` bắt buộc khi grade có `match` (do `resolveMatchLuts` sinh); thiếu → ném lỗi thay vì lặng lẽ bỏ qua ảnh mẫu.
 */
export function buildGradeFilter(g: Grade, ranges: OutRange[] = [], luts?: ResolvedLuts | null): string | null {
  if (isNeutralGrade(g)) return null;
  const f: string[] = [];
  if (g.match) {
    if (!luts) throw new Error('Grade có "match" nhưng chưa có file LUT (gọi resolveMatchLuts trước)');
    if (g.match.per_scene) {
      for (const sc of luts.scenes) {
        const r = ranges.find((x) => x.scene_id === sc.scene_id);
        if (r && r.end > r.start) f.push(lutPart(sc.path, enableFor(r)));
      }
    } else if (luts.global) f.push(lutPart(luts.global, ''));
  }
  const eq = eqPart(g, '');
  if (eq) f.push(eq);
  if (g.temperature_k !== GRADE_RANGES.temperature_k.neutral) f.push(`colortemperature=temperature=${n3(ffmpegTemperature(g.temperature_k))}`);
  if (g.vibrance !== 0) f.push(`vibrance=intensity=${n3(g.vibrance)}`);
  for (const sc of g.scenes ?? []) {
    const r = ranges.find((x) => x.scene_id === sc.scene_id);
    if (!r || r.end <= r.start) continue;
    const en = enableFor(r);
    const e = eqPart(sc, en);
    if (e) f.push(e);
    if (sc.temperature_k !== undefined && sc.temperature_k !== GRADE_RANGES.temperature_k.neutral) {
      f.push(`colortemperature=temperature=${n3(ffmpegTemperature(sc.temperature_k))}${en}`);
    }
  }
  if (!f.length) return null;
  f.push('format=yuv420p');
  return f.join(',');
}

/** Tham số encode của bước chỉnh màu: cùng chất lượng bước render (libx264 crf 18 preset medium yuv420p), giữ nguyên âm thanh, faststart. */
export function buildGradeArgs(opts: { inAbs: string; outAbs: string; filter: string; progress?: boolean }): string[] {
  return [
    '-n',
    '-hide_banner',
    '-loglevel',
    'error',
    ...(opts.progress === false ? [] : ['-progress', 'pipe:1', '-nostats']),
    '-i',
    opts.inAbs,
    '-vf',
    opts.filter,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    opts.outAbs,
  ];
}

// ------------------------------------------------------------------ mô tả ngắn (log, tóm tắt)

const f2 = (x: number): string => x.toFixed(2);

/** Các thông số khác mặc định dạng chữ ngắn, vd ["Ấm 7200K", "Tương phản 1.15"]. */
export function gradeChips(g: Grade | null | undefined): string[] {
  if (!g) return [];
  const out: string[] = [];
  if (g.temperature_k !== 6500) out.push(`${g.temperature_k > 6500 ? 'Ấm' : 'Lạnh'} ${g.temperature_k}K`);
  if (g.contrast !== 1) out.push(`Tương phản ${f2(g.contrast)}`);
  if (g.brightness !== 0) out.push(`Độ sáng ${g.brightness > 0 ? '+' : ''}${f2(g.brightness)}`);
  if (g.saturation !== 1) out.push(`Bão hoà ${f2(g.saturation)}`);
  if (g.gamma !== 1) out.push(`Gamma ${f2(g.gamma)}`);
  if (g.vibrance !== 0) out.push(`Sống động ${g.vibrance > 0 ? '+' : ''}${f2(g.vibrance)}`);
  if (g.scenes?.length) out.push(`Riêng ${g.scenes.length} cảnh`);
  if (g.match) {
    const pct = Math.round(g.match.strength * 100);
    out.unshift(g.match.kind === 'lut' ? `Màu theo file LUT ${pct}%` : `Màu theo ảnh mẫu ${pct}%`);
    if (g.match.kind === 'image') {
      if (g.match.mode === 'full') out.splice(1, 0, 'Giống cả độ sáng');
      if (g.match.per_scene) out.splice(g.match.mode === 'full' ? 2 : 1, 0, 'Khớp từng cảnh');
    }
  }
  return out;
}
