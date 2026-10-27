import { describe, expect, it } from 'vitest';
import {
  CUBE_MAX_BYTES,
  LabAccumulator,
  LUT_SIZE,
  SIGMA_RATIO_MAX,
  SIGMA_RATIO_MIN,
  blendWithIdentity,
  buildTransferLut,
  CHROMA_CLAMP_LAB,
  DEFAULT_SPACE,
  clampSigmaRatio,
  spaceOf,
  spaceToSrgb,
  contentBox,
  identityLut,
  labToSrgb,
  parseCube,
  reinhard,
  srgbToLab,
  transferRgb,
  writeCube,
  type LabStats,
  type Lut3D,
  type Vec3,
} from '../src/services/color-lut.js';

/** RGB24 thô từ danh sách pixel. */
const rgb24 = (px: Vec3[]): Uint8Array => Uint8Array.from(px.flat());

/** Lấy mẫu LUT bằng nội suy ba tuyến tính (để kiểm tra LUT trực tiếp). */
function sample(lut: Lut3D, r: number, g: number, b: number): Vec3 {
  const N = lut.size;
  const f = (v: number) => Math.min(N - 1 - 1e-9, Math.max(0, v * (N - 1)));
  const [x, y, z] = [f(r), f(g), f(b)];
  const [x0, y0, z0] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [dx, dy, dz] = [x - x0, y - y0, z - z0];
  const at = (i: number, j: number, k: number, c: number) => lut.data[((k * N + j) * N + i) * 3 + c]!;
  const out: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (const [i, wx] of [[x0, 1 - dx], [x0 + 1, dx]] as const)
      for (const [j, wy] of [[y0, 1 - dy], [y0 + 1, dy]] as const)
        for (const [k, wz] of [[z0, 1 - dz], [z0 + 1, dz]] as const) v += at(i, j, k, c) * wx * wy * wz;
    out[c] = v;
  }
  return out;
}

describe('sRGB ⇄ CIELAB (D65)', () => {
  it('giá trị tham chiếu: trắng L=100, đen L=0, đỏ sRGB ≈ (53.24, 80.09, 67.20), xám 50% ≈ L 53.4', () => {
    const w = srgbToLab(1, 1, 1);
    expect(w[0]).toBeCloseTo(100, 2);
    expect(Math.abs(w[1])).toBeLessThan(0.01);
    expect(Math.abs(w[2])).toBeLessThan(0.01);
    expect(srgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 6);
    const red = srgbToLab(1, 0, 0);
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 1);
    expect(red[2]).toBeCloseTo(67.2, 1);
    expect(srgbToLab(0.5, 0.5, 0.5)[0]).toBeCloseTo(53.39, 1);
  });

  it('khứ hồi sRGB → Lab → sRGB sai lệch < 1e-4 trên toàn lưới 9³', () => {
    let worst = 0;
    for (let r = 0; r <= 8; r++) for (let g = 0; g <= 8; g++) for (let b = 0; b <= 8; b++) {
      const rgb: Vec3 = [r / 8, g / 8, b / 8];
      const lab = srgbToLab(...rgb);
      const back = labToSrgb(...lab);
      worst = Math.max(worst, Math.abs(back[0] - rgb[0]), Math.abs(back[1] - rgb[1]), Math.abs(back[2] - rgb[2]));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('ngoài gam sRGB: giữ L, giảm độ đậm (không kẹp từng kênh làm lệch sắc); kết quả luôn trong 0..1', () => {
    const L = 60;
    const out = labToSrgb(L, 120, 100); // đậm quá gam
    for (const c of out) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThanOrEqual(1);
    const back = srgbToLab(...out);
    expect(back[0]).toBeCloseTo(L, 0);
    // hướng sắc giữ nguyên (a:b)
    expect(back[1] / back[2]).toBeCloseTo(120 / 100, 1);
  });
});

describe('thống kê Lab', () => {
  it('bỏ pixel L<3 (đen) và L>97 (cháy); ảnh toàn đen → không đủ pixel (null)', () => {
    const acc = new LabAccumulator();
    const px: Vec3[] = [];
    for (let i = 0; i < 100; i++) px.push([0, 0, 0], [255, 255, 255], [128, 128, 128]);
    acc.addRgb24(rgb24(px), 300, 1);
    const s = acc.stats()!;
    expect(s.n).toBe(100); // chỉ các pixel xám giữa
    expect(s.mean[0]).toBeCloseTo(53.59, 0);
    expect(s.std[0]).toBeLessThan(1e-3);
    expect(acc.seen).toBe(300);
    const black = new LabAccumulator();
    black.addRgb24(rgb24(Array.from({ length: 64 }, () => [0, 0, 0] as Vec3)), 8, 8);
    expect(black.stats()).toBeNull();
  });

  it('gộp nhiều khung: trung bình và độ lệch chuẩn của TẬP pixel gộp', () => {
    const a = new LabAccumulator();
    a.addRgb24(rgb24(Array.from({ length: 32 }, () => [200, 60, 40] as Vec3)), 32, 1);
    a.addRgb24(rgb24(Array.from({ length: 32 }, () => [40, 60, 200] as Vec3)), 32, 1);
    const s = a.stats()!;
    const l1 = srgbToLab(200 / 255, 60 / 255, 40 / 255);
    const l2 = srgbToLab(40 / 255, 60 / 255, 200 / 255);
    expect(s.mean[1]).toBeCloseTo((l1[1] + l2[1]) / 2, 3);
    expect(s.std[1]).toBeCloseTo(Math.abs(l1[1] - l2[1]) / 2, 3);
  });

  it('contentBox bỏ viền đen (letterbox/pillarbox), ảnh không có viền trả cả khung', () => {
    const w = 20;
    const h = 20;
    const px: Vec3[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push(y < 3 || y >= 16 || x < 2 || x >= 18 ? [0, 0, 0] : [180, 120, 90]);
    expect(contentBox(rgb24(px), w, h)).toEqual({ x0: 2, y0: 3, x1: 18, y1: 16 });
    expect(contentBox(rgb24(Array.from({ length: 16 }, () => [90, 90, 90] as Vec3)), 4, 4)).toEqual({ x0: 0, y0: 0, x1: 4, y1: 4 });
    expect(contentBox(rgb24(Array.from({ length: 16 }, () => [0, 0, 0] as Vec3)), 4, 4)).toEqual({ x0: 0, y0: 0, x1: 4, y1: 4 }); // toàn đen: không cắt
  });
});

describe('chuyển màu Reinhard', () => {
  const ref: LabStats = { mean: [60, 25, 40], std: [20, 12, 15], n: 1000 };
  const src: LabStats = { mean: [50, -10, -25], std: [20, 10, 12], n: 1000 };

  it('kẹp tỉ lệ σ trong [0,6; 1,6]; σ nguồn ≈ 0 → tỉ lệ 1', () => {
    expect(clampSigmaRatio(100, 1)).toBe(SIGMA_RATIO_MAX);
    expect(clampSigmaRatio(1, 100)).toBe(SIGMA_RATIO_MIN);
    expect(clampSigmaRatio(12, 10)).toBeCloseTo(1.2, 10);
    expect(clampSigmaRatio(5, 0)).toBe(1);
    expect(clampSigmaRatio(5, 1e-9)).toBe(1);
  });

  it('công thức: out = (in − μ_src)·tỉ lệ + μ_ref; mean nguồn → mean ảnh mẫu; chế độ color giữ L, full chuyển cả L', () => {
    const at = reinhard([50, -10, -25], ref, src, 'full');
    expect(at[0]).toBeCloseTo(60, 6);
    expect(at[1]).toBeCloseTo(25, 6);
    expect(at[2]).toBeCloseTo(40, 6);
    const lab: Vec3 = [70, 0, 0];
    const c = reinhard(lab, ref, src, 'color');
    expect(c[0]).toBe(70); // L giữ nguyên
    expect(c[1]).toBeCloseTo((0 + 10) * 1.2 + 25, 6);
    expect(c[2]).toBeCloseTo((0 + 25) * 1.25 + 40, 6);
    const f = reinhard(lab, ref, src, 'full');
    expect(f[0]).toBeCloseTo((70 - 50) * 1 + 60, 6);
    // tỉ lệ bị kẹp: ảnh mẫu σ_b = 100 vs nguồn 12 → kẹp 1,6 (không phải 8,3)
    const wide = reinhard([50, 0, -13], { ...ref, std: [20, 12, 100] }, src, 'color');
    expect(wide[2]).toBeCloseTo((-13 + 25) * SIGMA_RATIO_MAX + 40, 6);
  });

  it('strength 0 giữ nguyên điểm vào; strength 1 = chuyển hoàn toàn; 0,5 nằm giữa (trong Lab)', () => {
    const rgb: Vec3 = [0.3, 0.45, 0.7];
    expect(transferRgb(rgb, { mode: 'color', strength: 0, src, ref, space: 'cielab' })).toEqual(rgb);
    const lab = srgbToLab(...rgb);
    const full = srgbToLab(...transferRgb(rgb, { mode: 'color', strength: 1, src, ref, space: 'cielab' }));
    const half = srgbToLab(...transferRgb(rgb, { mode: 'color', strength: 0.5, src, ref, space: 'cielab' }));
    expect(half[1]).toBeCloseTo((lab[1] + full[1]) / 2, 1);
    expect(half[2]).toBeCloseTo((lab[2] + full[2]) / 2, 1);
    expect(full[1]).toBeGreaterThan(lab[1] + 10); // ảnh mẫu ấm hơn nhiều (a, b dương) → kéo về phía cam
  });
});

describe('LUT 3D 33³', () => {
  const ref: LabStats = { mean: [58, 22, 38], std: [18, 11, 14], n: 1 };
  const src: LabStats = { mean: [50, -8, -22], std: [18, 9, 12], n: 1 };

  it('đồng nhất: kích thước 33, thứ tự đỏ chạy nhanh nhất', () => {
    const id = identityLut();
    expect(id.size).toBe(LUT_SIZE);
    expect(id.data.length).toBe(33 ** 3 * 3);
    expect([id.data[0], id.data[1], id.data[2]]).toEqual([0, 0, 0]);
    expect(id.data[3]).toBeCloseTo(1 / 32, 6); // phần tử kế tiếp: r tăng
    expect(id.data[4]).toBe(0);
    expect(id.data[33 * 3 + 1]).toBeCloseTo(1 / 32, 6); // sau 33 phần tử: g tăng
    expect(id.data[33 * 33 * 3 + 2]).toBeCloseTo(1 / 32, 6); // sau 33² phần tử: b tăng
    const last = id.data.length - 3;
    expect([id.data[last], id.data[last + 1], id.data[last + 2]]).toEqual([1, 1, 1]);
  });

  it('strength=0 → LUT đồng nhất (sai lệch tối đa 0)', () => {
    const lut = buildTransferLut({ mode: 'color', strength: 0, src, ref, space: 'cielab' });
    const id = identityLut();
    let worst = 0;
    for (let i = 0; i < lut.data.length; i++) worst = Math.max(worst, Math.abs(lut.data[i]! - id.data[i]!));
    expect(worst).toBe(0);
  });

  it('chế độ color: L* của mọi điểm lưới giữ nguyên (sai lệch < 0,6 do lượng tử hoá gam màu); full: L đổi', () => {
    const lut = buildTransferLut({ mode: 'color', strength: 1, src, ref, space: 'cielab' });
    const id = identityLut();
    let worst = 0;
    for (let i = 0; i < lut.data.length; i += 3) {
      const l0 = srgbToLab(id.data[i]!, id.data[i + 1]!, id.data[i + 2]!)[0];
      const l1 = srgbToLab(lut.data[i]!, lut.data[i + 1]!, lut.data[i + 2]!)[0];
      worst = Math.max(worst, Math.abs(l1 - l0));
    }
    expect(worst).toBeLessThan(0.6);
    const full = buildTransferLut({ mode: 'full', strength: 1, src, ref, space: 'cielab' });
    const mid = sample(full, 0.5, 0.5, 0.5);
    expect(srgbToLab(...mid)[0]).toBeGreaterThan(srgbToLab(0.5, 0.5, 0.5)[0] + 4); // ảnh mẫu sáng hơn 8 đơn vị L ở mean
  });

  it('LUT đưa màu xanh lạnh (mean nguồn) về màu cam ấm (mean ảnh mẫu) trong chế độ color: R tăng, B giảm', () => {
    const lut = buildTransferLut({ mode: 'color', strength: 1, src, ref, space: 'cielab' });
    const cold = labToSrgb(50, -8, -22);
    const out = sample(lut, ...cold);
    expect(out[0] / out[2]).toBeGreaterThan((cold[0] / cold[2]) * 3);
  });

  it('blendWithIdentity: 0 = đồng nhất, 1 = nguyên LUT, 0,5 = trung bình', () => {
    const lut = buildTransferLut({ mode: 'color', strength: 1, src, ref, space: 'cielab' });
    const id = identityLut();
    expect(Array.from(blendWithIdentity(lut, 0).data)).toEqual(Array.from(id.data));
    expect(Array.from(blendWithIdentity(lut, 1).data)).toEqual(Array.from(lut.data));
    const h = blendWithIdentity(lut, 0.5);
    for (const i of [100, 5000, 40000]) expect(h.data[i]).toBeCloseTo((lut.data[i]! + id.data[i]!) / 2, 5);
  });
});

// ---------------------------------------------------------------------------------------------------------------- lαβ

/** Tập pixel giả "cảnh thật" (kiểu ảnh sản phẩm): 25% xám/trắng (L* 70–99), còn lại gỗ/da ấm, xanh lá dịu, nâu sẫm với độ bão hoà vừa phải (tất định). */
function scenePixels(n = 4000): Vec3[] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) {
      const v = 0.45 + rnd() * 0.55; // xám/trắng sáng (gamma 0,45–1)
      out.push([v, v, v]);
    } else {
      // màu ấm kiểu gỗ/da là chính, thêm xanh lá và nâu sẫm
      const k = rnd();
      out.push(k < 0.6 ? [0.6 + rnd() * 0.3, 0.45 + rnd() * 0.3, 0.28 + rnd() * 0.3] : k < 0.8 ? [0.25 + rnd() * 0.25, 0.4 + rnd() * 0.25, 0.22 + rnd() * 0.2] : [0.2 + rnd() * 0.2, 0.14 + rnd() * 0.15, 0.1 + rnd() * 0.12]);
    }
  }
  return out;
}
const toLin01 = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam01 = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** Vết ám màu = nhân từng kênh trong ÁNH SÁNG TUYẾN TÍNH (như sai cân bằng trắng; hệ số ≤ 1 để không cắt xén). */
const castLinear = (px: Vec3[], m: Vec3): Vec3[] => px.map((p) => p.map((c, k) => toGam01(toLin01(c) * m[k]!)) as Vec3);
const packRgb = (px: Vec3[]): Uint8Array => Uint8Array.from(px.flatMap((p) => p.map((c) => Math.round(c * 255))));
const statsIn = (px: Vec3[], space: 'cielab' | 'lalphabeta') => {
  const acc = new LabAccumulator(spaceOf(space));
  acc.addRgb24(packRgb(px), px.length, 1);
  return acc.stats()!;
};

describe('không gian lαβ (mặc định)', () => {
  it('mặc định là lαβ; xám (R=G=B) có α=β=0 ở mọi độ sáng; khứ hồi RGB → lαβ → RGB sai < 1e-4 (kể cả ngoài gam được kéo về gam)', () => {
    expect(DEFAULT_SPACE).toBe('lalphabeta');
    const sp = spaceOf('lalphabeta');
    for (const v of [0.02, 0.2, 0.5, 0.8, 1]) {
      const lin = toLin01(v);
      const lab = sp.fromLinear(lin, lin, lin);
      expect(Math.abs(lab[1])).toBeLessThan(2e-3);
      expect(Math.abs(lab[2])).toBeLessThan(2e-3);
    }
    let worst = 0;
    for (let r = 0; r <= 6; r++) for (let g = 0; g <= 6; g++) for (let b = 0; b <= 6; b++) {
      const rgb: Vec3 = [r / 6, g / 6, b / 6];
      const back = spaceToSrgb(sp, sp.fromLinear(toLin01(rgb[0]), toLin01(rgb[1]), toLin01(rgb[2])));
      worst = Math.max(worst, Math.abs(back[0] - rgb[0]), Math.abs(back[1] - rgb[1]), Math.abs(back[2] - rgb[2]));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('vết ám nhân trong ánh sáng tuyến tính → vùng gần trung tính (C* < 6, L* > 70 của ảnh gốc) về trung tính (|a*|,|b*| nhỏ) và sắc trung bình khớp ảnh gốc; CIELAB làm kém hơn rõ', () => {
    const ref = scenePixels();
    const result = (space: 'cielab' | 'lalphabeta', m: Vec3) => {
      const src = castLinear(ref, m);
      const t = { mode: 'color' as const, strength: 1, src: statsIn(src, space), ref: statsIn(ref, space), space };
      const out = src.map((p) => transferRgb(p, t));
      let nn = 0, na = 0, nb = 0, dab = 0, dL = 0;
      src.forEach((p, i) => {
        const l0 = srgbToLab(...ref[i]!);
        const lo = srgbToLab(...out[i]!);
        dab += Math.hypot(l0[1] - lo[1], l0[2] - lo[2]);
        dL += Math.abs(srgbToLab(...p)[0] - lo[0]);
        if (Math.hypot(l0[1], l0[2]) < 6 && l0[0] > 70) {
          nn++;
          na += Math.abs(lo[1]);
          nb += Math.abs(lo[2]);
        }
      });
      return { neutralA: na / nn, neutralB: nb / nn, dab: dab / src.length, dL: dL / src.length, nn };
    };
    for (const m of [[0.4, 0.6, 1], [1, 0.69, 0.41], [0.65, 1, 0.65], [1, 0.64, 1]] as Vec3[]) {
      const lab = result('lalphabeta', m);
      const cie = result('cielab', m);
      expect(lab.nn).toBeGreaterThan(300);
      expect([m, lab.neutralA < 4, lab.neutralB < 4]).toEqual([m, true, true]); // gần trung tính vẫn gần trung tính (trước khi sửa vết ám: 20–30)
      expect(lab.dab).toBeLessThan(cie.dab * 1.02); // sắc tổng thể không kém CIELAB (tập giả có σ sắc biến thiên mạnh nên kẹp 0,8–1,25 chặt hơn)
      expect(lab.neutralA + lab.neutralB).toBeLessThan(cie.neutralA + cie.neutralB); // vùng trung tính tốt hơn CIELAB
      expect(lab.dL).toBeLessThan(0.6); // chế độ color giữ độ chói (L*) của nguồn
    }
  });

  it('giữ độ chói: chế độ color ở lαβ giữ L* từng điểm (sai < 0,6 trên lưới 33³); full đổi L; kẹp σ sắc 0,8–1,25 ở lαβ, 0,6–1,6 ở CIELAB', () => {
    const ref = scenePixels();
    const src = castLinear(ref, [0.5, 0.7, 1]);
    const t = { strength: 1, src: statsIn(src, 'lalphabeta'), ref: statsIn(ref, 'lalphabeta'), space: 'lalphabeta' as const };
    const lut = buildTransferLut({ ...t, mode: 'color' });
    const id = identityLut();
    let worst = 0;
    for (let i = 0; i < lut.data.length; i += 3) worst = Math.max(worst, Math.abs(srgbToLab(lut.data[i]!, lut.data[i + 1]!, lut.data[i + 2]!)[0] - srgbToLab(id.data[i]!, id.data[i + 1]!, id.data[i + 2]!)[0]));
    expect(worst).toBeLessThan(0.6);
    expect(CHROMA_CLAMP_LAB).toEqual([0.8, 1.25]);
    const wide = { mean: [0, 0, 0] as Vec3, std: [1, 5, 5] as Vec3, n: 1 };
    const narrow = { mean: [0, 0, 0] as Vec3, std: [1, 1, 1] as Vec3, n: 1 };
    // σ ref gấp 5 lần: kênh sắc chỉ nhân tối đa 1,25 ở lαβ; ở CIELAB nhân tối đa 1,6
    expect(transferRgb([0.6, 0.5, 0.4], { mode: 'color', strength: 1, src: narrow, ref: wide, space: 'lalphabeta' })).toEqual(transferRgb([0.6, 0.5, 0.4], { mode: 'color', strength: 1, src: narrow, ref: wide, space: 'lalphabeta', chromaClamp: [0.8, 1.25] }));
  });
});

describe('file .cube', () => {
  const small = (n: number, edit?: (rows: string[]) => string[], head: string[] = [`LUT_3D_SIZE ${n}`], digits = 6): string => {
    const rows: string[] = [];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${(r / (n - 1)).toFixed(digits)} ${(g / (n - 1)).toFixed(digits)} ${(b / (n - 1)).toFixed(digits)}`);
    return [...head, ...(edit ? edit(rows) : rows)].join('\n') + '\n';
  };

  it('ghi → đọc khứ hồi: kích thước, dữ liệu (6 chữ số), header chuẩn', () => {
    const lut = buildTransferLut({ mode: 'color', strength: 0.8, space: 'cielab', src: { mean: [50, -8, -22], std: [18, 9, 12], n: 1 }, ref: { mean: [58, 22, 38], std: [18, 11, 14], n: 1 } });
    const text = writeCube(lut, 'Tên "thử" có dấu — ế');
    const lines = text.split('\n');
    expect(lines[0]).toBe('# autovideo color match');
    expect(lines[1]).toBe(`TITLE "T?n 'th?' c? d?u ? ?"`);
    expect(lines).toContain('LUT_3D_SIZE 33');
    expect(lines).toContain('DOMAIN_MIN 0 0 0');
    expect(lines).toContain('DOMAIN_MAX 1 1 1');
    expect(lines.length).toBe(5 + 33 ** 3 + 1);
    const back = parseCube(text);
    expect(back.size).toBe(33);
    let worst = 0;
    for (let i = 0; i < lut.data.length; i++) worst = Math.max(worst, Math.abs(back.data[i]! - lut.data[i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it('chấp nhận: chú thích, dòng trống, TITLE, CRLF, DOMAIN mặc định/khai rõ, size 2 và 65; thiếu DOMAIN = 0..1', () => {
    expect(parseCube(small(2)).size).toBe(2);
    expect(parseCube(small(2, undefined, ['# note', '', 'TITLE "x"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1.0 1.0 1.0'])).size).toBe(2);
    expect(parseCube(small(3).replace(/\n/g, '\r\n')).size).toBe(3);
    // 65³ dòng với 6 chữ số ≈ 7,4 MB > 5 MB nên bị từ chối vì dung lượng; ghi gọn (2 chữ số) thì ≈ 3,3 MB và đọc được
    expect(() => parseCube(small(65))).toThrowError(/5 MB/);
    expect(parseCube(small(65, undefined, undefined, 2)).size).toBe(65);
  });

  it('từ chối chặt: LUT_1D, size ngoài 2–65, thiếu/thừa dòng, từ khoá lạ, DOMAIN lạ, dữ liệu trước SIZE, SIZE hai lần, số hỏng, ngoài 0..1, ký tự điều khiển', () => {
    const bad = (text: string, re: RegExp) => expect(() => parseCube(text), re.source).toThrowError(re);
    bad('LUT_1D_SIZE 16\n0 0 0\n', /1D/);
    bad('LUT_3D_SIZE 1\n0 0 0\n', /ngoài khoảng 2–65/);
    bad('LUT_3D_SIZE 66\n', /ngoài khoảng 2–65/);
    bad('LUT_3D_SIZE abc\n', /số nguyên/);
    bad(small(2, (r) => r.slice(0, -1)), /thiếu dòng dữ liệu/);
    bad(small(2, (r) => [...r, '0 0 0']), /thừa dòng/);
    bad(small(2, (r) => ['0 0 0 0', ...r.slice(1)]), /đúng ba số/);
    bad(small(2, (r) => ['0 0', ...r.slice(1)]), /đúng ba số/);
    bad(small(2, (r) => ['0 0 NaN', ...r.slice(1)]), /đúng ba số/);
    bad(small(2, (r) => ['0 0 1e999', ...r.slice(1)]), /ngoài khoảng 0–1/);
    bad(small(2, (r) => ['0 0 1.5', ...r.slice(1)]), /ngoài khoảng 0–1/);
    bad(small(2, (r) => ['-0.5 0 0', ...r.slice(1)]), /ngoài khoảng 0–1/);
    bad(small(2, undefined, ['LUT_3D_SIZE 2', 'FOO 1']), /không được hỗ trợ/);
    bad(small(2, undefined, ['LUT_3D_SIZE 2', 'LUT_3D_SIZE 2']), /hai lần/);
    bad(small(2, undefined, ['LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0']), /DOMAIN_MIN cần ba số/);
    bad(small(2, undefined, ['LUT_3D_SIZE 2', 'DOMAIN_MAX 2 2 2']), /DOMAIN_MIN 0 0 0 và DOMAIN_MAX 1 1 1/);
    bad(small(2, undefined, ['LUT_3D_SIZE 2', 'DOMAIN_MIN -1 -1 -1']), /DOMAIN_MIN 0 0 0/);
    bad('0 0 0\nLUT_3D_SIZE 2\n', /trước LUT_3D_SIZE/);
    bad(small(2, (r) => [r[0]!, 'TITLE "muộn"', ...r.slice(1)]), /nằm sau dữ liệu/);
    bad('', /thiếu LUT_3D_SIZE/);
    bad(small(2).replace('0.000000', '0.000\u0001000'), /ký tự không phải văn bản/);
    bad('x'.repeat(CUBE_MAX_BYTES + 1), /5 MB/);
  });

  it('giá trị lệch nhẹ ngoài 0..1 (≤ 0,05) được kẹp, không từ chối', () => {
    const l = parseCube(small(2, (r) => ['-0.01 0 1.02', ...r.slice(1)]));
    expect(l.data[0]).toBe(0);
    expect(l.data[2]).toBe(1);
  });
});
