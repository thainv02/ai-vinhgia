/**
 * Toán học THUẦN của chức năng "màu theo ảnh mẫu" (không đụng DB, đĩa hay ffmpeg; mọi hàm tất định, không dùng AI):
 * - chuyển sRGB ⇄ CIELAB (D65) và ⇄ lαβ của Reinhard (sRGB → tuyến tính → LMS → log10 → trực giao hoá), thống kê (trung bình, độ lệch chuẩn) của ảnh/nhiều khung hình;
 * - chuyển màu kiểu Reinhard từng kênh: `out = (in − μ_src) · clamp(σ_ref / σ_src) + μ_ref`. KHÔNG GIAN MẶC ĐỊNH là lαβ: vết ám màu nhân theo kênh trong ánh sáng tuyến tính
 *   (sai cân bằng trắng) thành độ lệch HẰNG của α, β nên chuyển trung bình đưa vùng gần trung tính về đúng trung tính; ở CIELAB cùng vết ám thành độ lệch phụ thuộc độ sáng
 *   nên bao bì trắng ngả hồng/vàng (xem số đo trong BACKLOG). Tỉ lệ σ kênh sắc kẹp 0,8–1,25 ở lαβ (0,6–1,6 ở CIELAB), kênh sáng 0,6–1,6.
 *   Chế độ `color` chỉ chuyển 2 kênh sắc và GIỮ ĐỘ CHÓI Y của điểm gốc (⇔ L* của CIELAB; ở lαβ bằng cách nhân đều RGB tuyến tính sau khi chuyển), `full` chuyển cả kênh sáng;
 *   `strength` nội suy (trong không gian chuyển) giữa màu gốc và màu đã chuyển; ngoài gam sRGB thì giảm độ đậm, giữ độ sáng và hướng sắc;
 * - sinh LUT 3D 33³ và đọc/ghi file `.cube` (đọc chặt).
 *
 * Quy ước `.cube` (Adobe/Resolve): chỉ số đỏ chạy nhanh nhất, rồi xanh lá, rồi xanh dương; mỗi dòng "r g b" trong 0..1. ffmpeg `lut3d` đọc đúng quy ước này.
 */

import { AppError } from '../lib/errors.js';

export const LUT_SIZE = 33;
export const SIGMA_RATIO_MIN = 0.6;
export const SIGMA_RATIO_MAX = 1.6;
/** Pixel có L* ngoài khoảng này (gần đen / gần trắng tuyệt đối: viền đen, vùng cháy) không tính vào thống kê. */
export const STATS_L_MIN = 3;
export const STATS_L_MAX = 97;

export type Vec3 = [number, number, number];

// ------------------------------------------------------------------ sRGB ⇄ Lab (D65)

const XN = 0.95047;
const YN = 1;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

/** sRGB 0..1 (đã mã hoá gamma) → tuyến tính. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Tuyến tính → sRGB 0..1. */
const fromLinear = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const LIN8 = new Float64Array(256).map((_, i) => toLinear(i / 255));

const fLab = (t: number): number => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const fLabInv = (t: number): number => {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
};

function linearToLab(r: number, g: number, b: number): Vec3 {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fx = fLab(x);
  const fy = fLab(y / YN);
  const fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** sRGB 0..1 (gamma) → Lab. */
export const srgbToLab = (r: number, g: number, b: number): Vec3 => linearToLab(toLinear(r), toLinear(g), toLinear(b));

/** Lab → RGB TUYẾN TÍNH (có thể ngoài 0..1 khi ngoài gam màu sRGB). */
function labToLinear(L: number, a: number, b: number): Vec3 {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fLabInv(fx) * XN;
  const y = L > KAPPA * EPS ? fy * fy * fy : L / KAPPA;
  const z = fLabInv(fz) * ZN;
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
}

const inGamut = (v: Vec3): boolean => v[0] >= -1e-6 && v[0] <= 1 + 1e-6 && v[1] >= -1e-6 && v[1] <= 1 + 1e-6 && v[2] >= -1e-6 && v[2] <= 1 + 1e-6;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Lab → sRGB 0..1 (gamma). Ngoài gam màu: giữ NGUYÊN L và hướng sắc (a:b), giảm độ đậm (chroma) bằng chia đôi tới khi vừa gam
 * (không kẹp từng kênh RGB để khỏi lệch sắc và đổi độ sáng). L ngoài 0..100 bị kẹp.
 */
export function labToSrgb(L: number, a: number, b: number): Vec3 {
  const l = Math.min(100, Math.max(0, L));
  let lin = labToLinear(l, a, b);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(labToLinear(l, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
    lin = labToLinear(l, a * lo, b * lo);
  }
  return [fromLinear(clamp01(lin[0])), fromLinear(clamp01(lin[1])), fromLinear(clamp01(lin[2]))];
}

// ------------------------------------------------------------------ không gian chuyển màu

/**
 * Không gian để chuyển thống kê. Kênh 0 luôn là độ sáng (giữ nguyên ở chế độ `color`), kênh 1–2 là sắc.
 * - `cielab`: CIELAB (L*, a*, b*).
 * - `lalphabeta`: lαβ của Reinhard (sRGB → tuyến tính → LMS → log10 → trực giao hoá). Ở đây vết ám màu nhân theo kênh (cân bằng trắng) thành độ lệch HẰNG
 *   của α, β nên chuyển trung bình đưa xám về đúng xám; điểm xám (R=G=B) luôn có α=β=0.
 */
export type MatchSpace = 'cielab' | 'lalphabeta';

const M_LMS: number[][] = [
  [0.3811, 0.5783, 0.0402],
  [0.1967, 0.7244, 0.0782],
  [0.0241, 0.1288, 0.8444],
];
// nghịch đảo của M_LMS (tính sẵn bằng định thức)
const M_LMS_INV: number[][] = (() => {
  const m = M_LMS;
  const det = m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const c = (r: number, k: number) => {
    const rows = [0, 1, 2].filter((x) => x !== r);
    const cols = [0, 1, 2].filter((x) => x !== k);
    const minor = m[rows[0]!]![cols[0]!]! * m[rows[1]!]![cols[1]!]! - m[rows[0]!]![cols[1]!]! * m[rows[1]!]![cols[0]!]!;
    return ((r + k) % 2 === 0 ? 1 : -1) * minor;
  };
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => c(j, i) / det));
})();
const LAB_A = [1 / Math.sqrt(3), 1 / Math.sqrt(6), 1 / Math.sqrt(2)];
const LOG_FLOOR = 1e-5;

function linearToLab2(r: number, g: number, b: number): Vec3 {
  const L = M_LMS[0]![0]! * r + M_LMS[0]![1]! * g + M_LMS[0]![2]! * b;
  const M = M_LMS[1]![0]! * r + M_LMS[1]![1]! * g + M_LMS[1]![2]! * b;
  const S = M_LMS[2]![0]! * r + M_LMS[2]![1]! * g + M_LMS[2]![2]! * b;
  const x = Math.log10(Math.max(LOG_FLOOR, L));
  const y = Math.log10(Math.max(LOG_FLOOR, M));
  const z = Math.log10(Math.max(LOG_FLOOR, S));
  return [LAB_A[0]! * (x + y + z), LAB_A[1]! * (x + y - 2 * z), LAB_A[2]! * (x - y)];
}

function lab2ToLinear(l: number, a: number, b: number): Vec3 {
  const x = l / LAB_A[0]! / 3 + a / LAB_A[1]! / 6 + b / LAB_A[2]! / 2;
  const y = l / LAB_A[0]! / 3 + a / LAB_A[1]! / 6 - b / LAB_A[2]! / 2;
  const z = l / LAB_A[0]! / 3 - (2 * a) / LAB_A[1]! / 6;
  const L = 10 ** x;
  const M = 10 ** y;
  const S = 10 ** z;
  return [M_LMS_INV[0]![0]! * L + M_LMS_INV[0]![1]! * M + M_LMS_INV[0]![2]! * S, M_LMS_INV[1]![0]! * L + M_LMS_INV[1]![1]! * M + M_LMS_INV[1]![2]! * S, M_LMS_INV[2]![0]! * L + M_LMS_INV[2]![1]! * M + M_LMS_INV[2]![2]! * S];
}

export interface Space {
  id: MatchSpace;
  /** RGB tuyến tính 0..1 → không gian chuyển. */
  fromLinear(r: number, g: number, b: number): Vec3;
  /** Không gian chuyển → RGB tuyến tính (có thể ngoài 0..1). */
  toLinear(a: number, b: number, c: number): Vec3;
  /** Kẹp kênh sáng (kênh 0) về miền hợp lệ. */
  clampLight(l: number): number;
}

const SPACES: Record<MatchSpace, Space> = {
  cielab: { id: 'cielab', fromLinear: linearToLab, toLinear: labToLinear, clampLight: (l) => Math.min(100, Math.max(0, l)) },
  lalphabeta: { id: 'lalphabeta', fromLinear: linearToLab2, toLinear: lab2ToLinear, clampLight: (l) => l },
};
export const spaceOf = (id: MatchSpace): Space => SPACES[id];

/**
 * Không gian mặc định: lαβ (log-LMS). Đo trên ảnh thật với vết ám màu nhân trong ánh sáng tuyến tính (cool/warm/green/magenta), CIELAB làm vùng sáng gần trung tính
 * (bao bì trắng, nền xám) ngả hồng/vàng (a*, b* lệch tới 4–16 đơn vị) vì vết ám nhân theo kênh không phải độ lệch đều của a*, b*; lαβ đưa chúng về trung tính (lệch ≤ 0,7 trên ảnh nền xám).
 */
export const DEFAULT_SPACE: MatchSpace = 'lalphabeta';

const lumY = (v: Vec3): number => 0.2126729 * v[0] + 0.7151522 * v[1] + 0.072175 * v[2];
const scaled = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

/**
 * Biến đổi ngược về sRGB 0..1 (gamma) trong một không gian bất kỳ; ngoài gam thì giảm độ đậm kênh 1–2 (giữ kênh sáng và hướng sắc) bằng chia đôi.
 * `targetY` (độ chói tuyến tính của điểm gốc): đưa kết quả về ĐÚNG độ chói đó bằng cách nhân đều RGB tuyến tính (giữ nguyên sắc độ, giữ L* của CIELAB),
 * và phép kiểm tra gam tính SAU khi nhân. Dùng cho chế độ `color` ở lαβ (giữ `l` của lαβ chỉ giữ trung bình hình học LMS chứ không giữ độ chói).
 */
export function spaceToSrgb(space: Space, v: Vec3, targetY?: number): Vec3 {
  const l = space.clampLight(v[0]);
  const make = (c: number): Vec3 => {
    const lin = space.toLinear(l, v[1] * c, v[2] * c);
    if (targetY === undefined) return lin;
    const y = lumY(lin);
    return y > 1e-9 ? scaled(lin, targetY / y) : [targetY, targetY, targetY];
  };
  let lin = make(1);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(make(mid))) lo = mid;
      else hi = mid;
    }
    lin = make(lo);
  }
  return [fromLinear(clamp01(lin[0])), fromLinear(clamp01(lin[1])), fromLinear(clamp01(lin[2]))];
}

// ------------------------------------------------------------------ thống kê Lab

export interface LabStats {
  mean: Vec3;
  std: Vec3;
  /** Số pixel đã tính (sau khi bỏ pixel quá tối/quá sáng). */
  n: number;
}

/** Cộng dồn thống kê Lab qua nhiều ảnh/khung hình (gộp mọi pixel như một tập). */
export class LabAccumulator {
  constructor(private readonly space: Space = SPACES.cielab) {}
  private n = 0;
  private s: Vec3 = [0, 0, 0];
  private s2: Vec3 = [0, 0, 0];
  /** Số pixel đã thấy (kể cả bị loại vì quá tối/quá sáng). */
  seen = 0;

  /** `rgb`: RGB24 thô (w·h·3 byte). `crop`: vùng tính (mặc định cả ảnh). */
  addRgb24(rgb: Uint8Array, width: number, height: number, crop?: { x0: number; y0: number; x1: number; y1: number }): void {
    const c = crop ?? { x0: 0, y0: 0, x1: width, y1: height };
    for (let y = c.y0; y < c.y1; y++) {
      for (let x = c.x0; x < c.x1; x++) {
        const i = (y * width + x) * 3;
        this.seen++;
        const lr = LIN8[rgb[i]!]!;
        const lg = LIN8[rgb[i + 1]!]!;
        const lb = LIN8[rgb[i + 2]!]!;
        const L = linearToLab(lr, lg, lb)[0]; // pixel quá tối/quá sáng loại theo L* ở MỌI không gian
        if (L < STATS_L_MIN || L > STATS_L_MAX) continue;
        const lab = this.space === SPACES.cielab ? linearToLab(lr, lg, lb) : this.space.fromLinear(lr, lg, lb);
        this.n++;
        for (let k = 0; k < 3; k++) {
          this.s[k]! += lab[k]!;
          this.s2[k]! += lab[k]! * lab[k]!;
        }
      }
    }
  }

  stats(): LabStats | null {
    if (this.n < 16) return null;
    const mean: Vec3 = [this.s[0]! / this.n, this.s[1]! / this.n, this.s[2]! / this.n];
    const std = mean.map((m, k) => Math.sqrt(Math.max(0, this.s2[k]! / this.n - m * m))) as Vec3;
    return { mean, std, n: this.n };
  }
}

/** Vùng không phải viền đen của một khung RGB24: bỏ các hàng/cột ngoài cùng gần như đen hoàn toàn (letterbox/pillarbox). Không có nội dung → cả khung. */
export function contentBox(rgb: Uint8Array, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } {
  const dark = (idx: number): boolean => rgb[idx]! < 20 && rgb[idx + 1]! < 20 && rgb[idx + 2]! < 20;
  const rowDark = (y: number): boolean => {
    for (let x = 0; x < width; x++) if (!dark((y * width + x) * 3)) return false;
    return true;
  };
  const colDark = (x: number, y0: number, y1: number): boolean => {
    for (let y = y0; y < y1; y++) if (!dark((y * width + x) * 3)) return false;
    return true;
  };
  let y0 = 0;
  let y1 = height;
  while (y0 < y1 && rowDark(y0)) y0++;
  while (y1 > y0 && rowDark(y1 - 1)) y1--;
  if (y1 - y0 < 2) return { x0: 0, y0: 0, x1: width, y1: height };
  let x0 = 0;
  let x1 = width;
  while (x0 < x1 && colDark(x0, y0, y1)) x0++;
  while (x1 > x0 && colDark(x1 - 1, y0, y1)) x1--;
  if (x1 - x0 < 2) return { x0: 0, y0: 0, x1: width, y1: height };
  return { x0, y0, x1, y1 };
}

// ------------------------------------------------------------------ chuyển màu Reinhard → LUT

export type MatchMode = 'color' | 'full';

export const CHROMA_CLAMP_DEFAULT: [number, number] = [SIGMA_RATIO_MIN, SIGMA_RATIO_MAX];
/** Ở lαβ hai kênh sắc chỉ co giãn nhẹ (tỉ lệ σ kẹp 0,8–1,25): chủ yếu là chuyển TRUNG BÌNH, không để ảnh mẫu ít màu làm video xám đi hoặc ảnh mẫu rực làm video loè. */
export const CHROMA_CLAMP_LAB: [number, number] = [0.8, 1.25];
export const defaultChromaClamp = (space: MatchSpace): [number, number] => (space === 'lalphabeta' ? CHROMA_CLAMP_LAB : CHROMA_CLAMP_DEFAULT);

export const clampSigmaRatio = (ref: number, src: number, range: [number, number] = CHROMA_CLAMP_DEFAULT): number => (src < 1e-6 ? 1 : Math.min(range[1], Math.max(range[0], ref / src)));

export interface Transfer {
  mode: MatchMode;
  strength: number;
  src: LabStats;
  ref: LabStats;
  /** Không gian chuyển (mặc định `DEFAULT_SPACE`); thống kê `src`/`ref` phải tính trong cùng không gian. */
  space?: MatchSpace;
  /** Khoảng kẹp tỉ lệ σ của hai kênh sắc (mặc định theo không gian: lαβ 0,8–1,25, CIELAB 0,6–1,6). Kênh sáng luôn 0,6–1,6. */
  chromaClamp?: [number, number];
  /** Chế độ `color` ở lαβ: `'Y'` (mặc định) giữ độ chói Y (⇔ L*); `'channel'` chỉ giữ kênh `l` của lαβ (dùng để so sánh). CIELAB luôn giữ L*. */
  keepLuma?: 'Y' | 'channel';
}

/** Biến đổi Reinhard của một điểm trong không gian chuyển (chưa nội suy cường độ). Chế độ `color` giữ nguyên kênh sáng. */
export function reinhard(lab: Vec3, ref: LabStats, src: LabStats, mode: MatchMode, chromaClamp: [number, number] = CHROMA_CLAMP_DEFAULT): Vec3 {
  const out: Vec3 = [lab[0], lab[1], lab[2]];
  for (let k = mode === 'color' ? 1 : 0; k < 3; k++) {
    out[k] = (lab[k]! - src.mean[k]!) * clampSigmaRatio(ref.std[k]!, src.std[k]!, k === 0 ? CHROMA_CLAMP_DEFAULT : chromaClamp) + ref.mean[k]!;
  }
  return out;
}

/** Điểm sRGB (0..1) sau khi chuyển màu và nội suy cường độ (trong không gian chuyển). Cường độ 0 trả đúng điểm vào. */
export function transferRgb(rgb: Vec3, t: Transfer): Vec3 {
  if (t.strength <= 0) return rgb;
  const space = spaceOf(t.space ?? DEFAULT_SPACE);
  const lin: Vec3 = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const lab = space.fromLinear(lin[0], lin[1], lin[2]);
  const tr = reinhard(lab, t.ref, t.src, t.mode, t.chromaClamp ?? defaultChromaClamp(space.id));
  const s = Math.min(1, t.strength);
  // chế độ color: giữ ĐỘ CHÓI (Y tuyến tính ⇔ L*) của điểm gốc ở mọi không gian (kênh sáng của CIELAB đã là L*)
  const keepY = t.mode === 'color' && space.id !== 'cielab' && (t.keepLuma ?? 'Y') === 'Y' ? lumY(lin) : undefined;
  return spaceToSrgb(space, [lab[0] + s * (tr[0] - lab[0]), lab[1] + s * (tr[1] - lab[1]), lab[2] + s * (tr[2] - lab[2])], keepY);
}

/** LUT 3D: `data[(b·N² + g·N + r)·3 + c]` (đỏ chạy nhanh nhất, như file .cube). */
export interface Lut3D {
  size: number;
  data: Float32Array;
}

export function identityLut(size = LUT_SIZE): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    data[i++] = r / (size - 1);
    data[i++] = g / (size - 1);
    data[i++] = b / (size - 1);
  }
  return { size, data };
}

/** Sinh LUT 33³ cho một phép chuyển màu. */
export function buildTransferLut(t: Transfer, size = LUT_SIZE): Lut3D {
  const lut = identityLut(size);
  if (t.strength <= 0) return lut;
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) {
    const o = transferRgb([d[i]!, d[i + 1]!, d[i + 2]!], t);
    d[i] = o[0];
    d[i + 1] = o[1];
    d[i + 2] = o[2];
  }
  return lut;
}

/** Trộn một LUT với đồng nhất theo `strength` (0 = đồng nhất, 1 = nguyên LUT). Trả LUT mới. */
export function blendWithIdentity(lut: Lut3D, strength: number): Lut3D {
  const s = Math.min(1, Math.max(0, strength));
  const id = identityLut(lut.size);
  const data = new Float32Array(lut.data.length);
  for (let i = 0; i < data.length; i++) data[i] = id.data[i]! + s * (lut.data[i]! - id.data[i]!);
  return { size: lut.size, data };
}

// ------------------------------------------------------------------ .cube

/** Ghi file .cube chuẩn hoá: LUT_3D_SIZE, DOMAIN 0..1, 6 chữ số thập phân, giá trị kẹp 0..1. */
export function writeCube(lut: Lut3D, title: string): string {
  const lines: string[] = [`# autovideo color match`, `TITLE "${title.replace(/[^\x20-\x7e]/g, '?').replace(/"/g, "'").slice(0, 80)}"`, `LUT_3D_SIZE ${lut.size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) lines.push(`${clamp01(d[i]!).toFixed(6)} ${clamp01(d[i + 1]!).toFixed(6)} ${clamp01(d[i + 2]!).toFixed(6)}`);
  return `${lines.join('\n')}\n`;
}

export const CUBE_MAX_BYTES = 5 * 1024 * 1024;
export const CUBE_MIN_SIZE = 2;
export const CUBE_MAX_SIZE = 65;
/** Giá trị trong file cho phép lệch khỏi 0..1 chút ít (một số công cụ ghi -0.0001); xa hơn thì từ chối. */
const CUBE_VALUE_SLACK = 0.05;

const cubeError = (message: string): AppError => new AppError('INVALID_LUT', `File LUT không hợp lệ: ${message}`, 400);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Đọc CHẶT file .cube 3D: chỉ nhận `TITLE`, `LUT_3D_SIZE` (2–65, đúng một lần, đứng trước dữ liệu), `DOMAIN_MIN/MAX` (mặc định 0 và 1; chỉ hỗ trợ 0–1),
 * chú thích `#`, dòng trống và đúng N³ dòng dữ liệu "r g b" (số hữu hạn, trong 0..1 ± 0,05; ngoài ra kẹp 0..1). Từ chối `LUT_1D_SIZE`, từ khoá lạ, thiếu/thừa dòng,
 * ký tự điều khiển. Trả LUT đã chuẩn hoá (đưa vào `writeCube`); KHÔNG bao giờ phục vụ lại file gốc.
 */
export function parseCube(text: string): Lut3D {
  if (text.length > CUBE_MAX_BYTES) throw cubeError('file lớn hơn 5 MB');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw cubeError('chứa ký tự không phải văn bản');
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let size = 0;
  let dmin: Vec3 = [0, 0, 0];
  let dmax: Vec3 = [1, 1, 1];
  let data: Float32Array | null = null;
  let filled = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    const parts = raw.split(/\s+/);
    const head = parts[0]!;
    if (/^[A-Za-z_]/.test(head)) {
      const kw = head.toUpperCase();
      if (data && filled > 0) throw cubeError(`dòng ${ln + 1}: từ khoá "${head.slice(0, 30)}" nằm sau dữ liệu`);
      if (kw === 'TITLE') continue;
      if (kw === 'LUT_1D_SIZE' || kw === 'LUT_1D_INPUT_RANGE') throw cubeError('LUT 1D chưa được hỗ trợ, hãy dùng LUT 3D (LUT_3D_SIZE)');
      if (kw === 'LUT_3D_SIZE') {
        if (size) throw cubeError(`dòng ${ln + 1}: LUT_3D_SIZE khai báo hai lần`);
        if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) throw cubeError(`dòng ${ln + 1}: LUT_3D_SIZE cần một số nguyên`);
        size = Number(parts[1]);
        if (size < CUBE_MIN_SIZE || size > CUBE_MAX_SIZE) throw cubeError(`LUT_3D_SIZE ${size} ngoài khoảng ${CUBE_MIN_SIZE}–${CUBE_MAX_SIZE}`);
        data = new Float32Array(size * size * size * 3);
        continue;
      }
      if (kw === 'DOMAIN_MIN' || kw === 'DOMAIN_MAX') {
        if (parts.length !== 4 || !parts.slice(1).every((p) => NUMBER.test(p))) throw cubeError(`dòng ${ln + 1}: ${kw} cần ba số`);
        const v = parts.slice(1).map(Number) as Vec3;
        if (kw === 'DOMAIN_MIN') dmin = v;
        else dmax = v;
        continue;
      }
      throw cubeError(`dòng ${ln + 1}: từ khoá "${head.slice(0, 30)}" không được hỗ trợ`);
    }
    if (!data) throw cubeError(`dòng ${ln + 1}: dữ liệu xuất hiện trước LUT_3D_SIZE`);
    if (parts.length !== 3 || !parts.every((p) => NUMBER.test(p))) throw cubeError(`dòng ${ln + 1}: cần đúng ba số "r g b"`);
    if (filled >= data.length) throw cubeError(`thừa dòng dữ liệu (cần đúng ${size ** 3} dòng)`);
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isFinite(v) || v < -CUBE_VALUE_SLACK || v > 1 + CUBE_VALUE_SLACK) throw cubeError(`dòng ${ln + 1}: giá trị ${p.slice(0, 20)} ngoài khoảng 0–1`);
      data[filled++] = clamp01(v);
    }
  }
  if (!size || !data) throw cubeError('thiếu LUT_3D_SIZE');
  if (filled !== data.length) throw cubeError(`thiếu dòng dữ liệu (có ${filled / 3}, cần ${size ** 3})`);
  if (dmin.some((v) => v !== 0) || dmax.some((v) => v !== 1)) throw cubeError('chỉ hỗ trợ DOMAIN_MIN 0 0 0 và DOMAIN_MAX 1 1 1');
  return { size, data };
}
