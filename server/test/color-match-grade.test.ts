import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_GRADE,
  buildGradeFilter,
  canonicalGrade,
  ffmpegFilterPath,
  gradeChips,
  gradeHash,
  gradesEqual,
  isNeutralGrade,
  normalizeGrade,
  outRanges,
  parseStoredGrade,
} from '../src/services/grade.js';
import { reconcileAiMatch } from '../src/services/final-revisions.js';
import { normalizeRevisionResult } from '../../worker/src/revision.js';

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e;
  }
  return null;
};
const refs = new Map<number, 'image' | 'lut'>([[5, 'image'], [6, 'lut']]);
const img = (extra: Record<string, unknown> = {}) => ({ kind: 'image', ref_id: 5, ...extra });

describe('Grade.match: chuẩn hoá', () => {
  it('mặc định strength 0,7, mode color, per_scene false; kẹp strength 0–1 và làm tròn 2 chữ số', () => {
    expect(normalizeGrade({ match: img() }).match).toEqual({ kind: 'image', ref_id: 5, strength: 0.7, mode: 'color', per_scene: false });
    expect(normalizeGrade({ match: img({ strength: 9 }) }).match!.strength).toBe(1);
    expect(normalizeGrade({ match: img({ strength: -3 }) }).match!.strength).toBe(0);
    expect(normalizeGrade({ match: img({ strength: 0.456, mode: 'full', per_scene: true }) }).match).toEqual({ kind: 'image', ref_id: 5, strength: 0.46, mode: 'full', per_scene: true });
  });

  it('LUT: mode luôn color, per_scene luôn false dù đầu vào nói gì', () => {
    expect(normalizeGrade({ match: { kind: 'lut', ref_id: 6, strength: 0.5, mode: 'full', per_scene: true } }).match).toEqual({ kind: 'lut', ref_id: 6, strength: 0.5, mode: 'color', per_scene: false });
  });

  it('match null / thiếu → không có khoá match; sai kiểu → INVALID_GRADE nêu đúng trường', () => {
    expect('match' in normalizeGrade({ match: null })).toBe(false);
    expect('match' in normalizeGrade({})).toBe(false);
    for (const bad of [{ match: 'x' }, { match: {} }, { match: { kind: 'video', ref_id: 1 } }, { match: img({ ref_id: 0 }) }, { match: img({ ref_id: 1.5 }) }, { match: img({ ref_id: '5' }) }, { match: img({ mode: 'weird' }) }, { match: img({ per_scene: 'yes' }) }, { match: img({ strength: 'cao' }) }]) {
      const e = err(() => normalizeGrade(bad));
      expect([JSON.stringify(bad), e?.code, e?.status]).toEqual([JSON.stringify(bad), 'INVALID_GRADE', 400]);
    }
    expect(err(() => normalizeGrade({ match: img({ mode: 'weird' }) }))?.message).toContain('match.mode');
  });

  it('matchRefs: ref_id phải thuộc dự án và đúng loại; không truyền matchRefs thì không kiểm tra (đọc grade đã lưu)', () => {
    expect(normalizeGrade({ match: img() }, { matchRefs: refs }).match!.ref_id).toBe(5);
    expect(err(() => normalizeGrade({ match: img({ ref_id: 99 }) }, { matchRefs: refs }))).toMatchObject({ code: 'INVALID_GRADE', status: 400 });
    expect(err(() => normalizeGrade({ match: img({ ref_id: 99 }) }, { matchRefs: refs }))?.message).toContain('không thuộc dự án');
    expect(err(() => normalizeGrade({ match: img({ ref_id: 6 }) }, { matchRefs: refs }))?.message).toContain('file LUT');
    expect(err(() => normalizeGrade({ match: { kind: 'lut', ref_id: 5 } }, { matchRefs: refs }))?.message).toContain('ảnh mẫu');
    expect(normalizeGrade({ match: img({ ref_id: 99 }) }).match!.ref_id).toBe(99);
    expect(err(() => normalizeGrade({ match: img() }, { matchRefs: new Map() }))?.code).toBe('INVALID_GRADE'); // dự án chưa có ảnh mẫu nào
  });

  it('isNeutralGrade = false khi có match (kể cả strength 0); parseStoredGrade giữ match', () => {
    expect(isNeutralGrade(normalizeGrade({ match: img({ strength: 0 }) }))).toBe(false);
    const stored = JSON.stringify(normalizeGrade({ match: img({ strength: 0.55 }), temperature_k: 7000 }));
    expect(parseStoredGrade(stored)).toMatchObject({ temperature_k: 7000, match: { kind: 'image', ref_id: 5, strength: 0.55 } });
  });
});

describe('Grade.match: chuỗi chuẩn, hash, so sánh', () => {
  it('grade KHÔNG có match giữ NGUYÊN chuỗi chuẩn và hash như trước (cache ảnh xem trước cũ không đổi)', () => {
    expect(canonicalGrade(NEUTRAL_GRADE)).toBe('[[0,1,1,1,6500,0],[]]');
    expect(gradeHash(NEUTRAL_GRADE)).toBe(crypto.createHash('sha256').update('[[0,1,1,1,6500,0],[]]').digest('hex').slice(0, 16));
    const g = normalizeGrade({ temperature_k: 7000, scenes: [{ scene_id: 2, brightness: 0.1 }] });
    expect(canonicalGrade(g)).toBe('[[0,1,1,1,7000,0],[[2,0.1,null,null,null,null]]]');
  });

  it('match được tính vào chuỗi chuẩn: đổi ảnh/cường độ/chế độ/từng cảnh → hash khác; giống nhau → hash giống', () => {
    const base = normalizeGrade({ match: img() });
    const hs = new Set([
      gradeHash(base),
      gradeHash(normalizeGrade({ match: img({ ref_id: 6 }) })),
      gradeHash(normalizeGrade({ match: img({ strength: 0.71 }) })),
      gradeHash(normalizeGrade({ match: img({ mode: 'full' }) })),
      gradeHash(normalizeGrade({ match: img({ per_scene: true }) })),
      gradeHash(normalizeGrade({ match: { kind: 'lut', ref_id: 5 } })),
      gradeHash(NEUTRAL_GRADE),
    ]);
    expect(hs.size).toBe(7);
    expect(gradeHash(normalizeGrade({ match: img() }))).toBe(gradeHash(base));
    expect(gradesEqual(base, normalizeGrade({ match: img() }))).toBe(true);
    expect(gradesEqual(base, NEUTRAL_GRADE)).toBe(false);
    expect(gradesEqual(base, normalizeGrade({ match: img({ strength: 0.8 }) }))).toBe(false);
  });

  it('chip "Màu theo ảnh mẫu 70%" đứng đầu; LUT có chip riêng; full/per_scene thêm chip ngắn', () => {
    expect(gradeChips(normalizeGrade({ match: img() }))).toEqual(['Màu theo ảnh mẫu 70%']);
    expect(gradeChips(normalizeGrade({ match: img({ strength: 1, mode: 'full', per_scene: true }), temperature_k: 7200 }))).toEqual(['Màu theo ảnh mẫu 100%', 'Giống cả độ sáng', 'Khớp từng cảnh', 'Ấm 7200K']);
    expect(gradeChips(normalizeGrade({ match: img({ per_scene: true }) }))).toEqual(['Màu theo ảnh mẫu 70%', 'Khớp từng cảnh']);
    expect(gradeChips(normalizeGrade({ match: { kind: 'lut', ref_id: 6, strength: 0.4 } }))).toEqual(['Màu theo file LUT 40%']);
  });
});

describe('buildGradeFilter với match', () => {
  const edl = { scenes: [{ scene_id: 1, segments: [{ in_s: 0, out_s: 2 }] }, { scene_id: 2, segments: [{ in_s: 0, out_s: 3 }] }] };
  const luts = { global: '/r/o/o/t/a.cube', scenes: [{ scene_id: 1, path: '/r/s1.cube' }, { scene_id: 2, path: '/r/s2.cube' }] };

  it('THỨ TỰ: lut3d → eq → colortemperature → vibrance → (theo cảnh) → format=yuv420p', () => {
    const g = normalizeGrade({ match: img(), contrast: 1.2, temperature_k: 7000, vibrance: 0.3, scenes: [{ scene_id: 2, brightness: 0.1 }] });
    const f = buildGradeFilter(g, outRanges(edl), luts)!;
    const parts = f.split(/,(?=[a-z0-9]+=)/); // không tách dấu phẩy trong between(t,a,b)
    expect(parts[0]).toBe("lut3d=file='/r/o/o/t/a.cube':interp=tetrahedral");
    expect(parts.slice(1).map((p) => p.split('=')[0])).toEqual(['eq', 'colortemperature', 'vibrance', 'eq', 'format']);
    expect(f.endsWith(',format=yuv420p')).toBe(true);
    expect(f.indexOf('lut3d')).toBeLessThan(f.indexOf('eq='));
  });

  it('chỉ có match (không chỉnh khác): lut3d + format=yuv420p; strength 0 vẫn cho filter (LUT đồng nhất)', () => {
    expect(buildGradeFilter(normalizeGrade({ match: img({ strength: 0 }) }), [], luts)).toBe("lut3d=file='/r/o/o/t/a.cube':interp=tetrahedral,format=yuv420p");
  });

  it('per_scene: mỗi cảnh một lut3d với enable=between(t,a,b) theo outRanges (end trừ 1 ms), KHÔNG dùng LUT chung', () => {
    const f = buildGradeFilter(normalizeGrade({ match: img({ per_scene: true }) }), outRanges(edl), luts)!;
    expect(f).toBe("lut3d=file='/r/s1.cube':interp=tetrahedral:enable='between(t,0,1.999)',lut3d=file='/r/s2.cube':interp=tetrahedral:enable='between(t,2,4.999)',format=yuv420p");
    expect(f).not.toContain('a.cube');
    // cảnh không có khoảng thời gian → bỏ qua
    expect(buildGradeFilter(normalizeGrade({ match: img({ per_scene: true }) }), outRanges({ scenes: [edl.scenes[0]!] }), luts)).toBe("lut3d=file='/r/s1.cube':interp=tetrahedral:enable='between(t,0,1.999)',format=yuv420p");
  });

  it('có match mà thiếu luts → ném lỗi (không lặng lẽ bỏ qua ảnh mẫu); không match thì luts bị bỏ qua', () => {
    expect(() => buildGradeFilter(normalizeGrade({ match: img() }), [], null)).toThrowError(/resolveMatchLuts/);
    expect(buildGradeFilter(normalizeGrade({ contrast: 1.2 }), [], luts)).toBe('eq=contrast=1.2,format=yuv420p');
  });

  it('ffmpegFilterPath: nháy đơn, thoát \\ : \' (và nháy trong nháy)', () => {
    expect(ffmpegFilterPath('/a/b.cube')).toBe("'/a/b.cube'");
    expect(ffmpegFilterPath('/a b/c:d.cube')).toBe("'/a b/c\\:d.cube'");
    expect(ffmpegFilterPath("/it's/x.cube")).toBe("'/it\\'\\''s/x.cube'");
    expect(ffmpegFilterPath('C:\\x\\y')).toBe("'C\\:\\\\x\\\\y'");
  });
});

describe('AI giữ match (reconcileAiMatch ở server + normalizeRevisionResult ở worker)', () => {
  const parent = { kind: 'image' as const, ref_id: 5, strength: 0.7, mode: 'color' as const, per_scene: false };

  it('server: thiếu khoá match → giữ nguyên của bản cha', () => {
    expect(reconcileAiMatch(parent, undefined)).toEqual(parent);
  });
  it('server: match null/false → bỏ ảnh mẫu', () => {
    expect(reconcileAiMatch(parent, null)).toBeUndefined();
    expect(reconcileAiMatch(parent, false)).toBeUndefined();
  });
  it('server: chỉ nhận strength/mode/per_scene; kind và ref_id luôn lấy từ bản cha (AI không tự chọn ảnh mới)', () => {
    expect(reconcileAiMatch(parent, { kind: 'lut', ref_id: 99, strength: 0.85, mode: 'full', per_scene: true })).toEqual({ kind: 'image', ref_id: 5, strength: 0.85, mode: 'full', per_scene: true });
    expect(reconcileAiMatch(parent, { strength: 'cao', mode: 'x', per_scene: 1 })).toEqual(parent); // sai kiểu → bỏ qua từng trường
    expect(reconcileAiMatch(parent, 'bỏ')).toEqual(parent);
    // LUT: mode/per_scene không đổi được
    const lut = { kind: 'lut' as const, ref_id: 6, strength: 0.5, mode: 'color' as const, per_scene: false };
    expect(reconcileAiMatch(lut, { strength: 0.3, mode: 'full', per_scene: true })).toEqual({ ...lut, strength: 0.3 });
  });
  it('server: bản cha không có match thì AI không thêm được', () => {
    expect(reconcileAiMatch(undefined, { kind: 'image', ref_id: 5, strength: 1 })).toBeUndefined();
    expect(reconcileAiMatch(undefined, undefined)).toBeUndefined();
  });

  it('worker: giữ match của bản cha khi AI không nhắc; AI trả match null → bỏ; strength AI đổi được (kẹp 0–1); không đổi ref_id; không thêm khi bản cha không có', () => {
    const pg = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature_k: 6500, vibrance: 0, match: { ...parent, original_name: 'mau-am.jpg' } };
    const keep = normalizeRevisionResult({ summary: 'ok', grade: { temperature_k: 7000 } }, pg);
    expect(keep.grade).toMatchObject({ temperature_k: 7000, match: { kind: 'image', ref_id: 5, strength: 0.7 } });
    expect(normalizeRevisionResult({ summary: 'ok' }, pg).grade.match).toMatchObject({ ref_id: 5 }); // không có grade → bản cha
    expect('match' in normalizeRevisionResult({ summary: 'ok', grade: { match: null } }, pg).grade).toBe(true);
    expect(normalizeRevisionResult({ summary: 'ok', grade: { match: null } }, pg).grade.match).toBeNull();
    const up = normalizeRevisionResult({ summary: 'ok', grade: { match: { ref_id: 77, kind: 'lut', strength: 2 } } }, pg).grade.match as any;
    expect(up).toMatchObject({ kind: 'image', ref_id: 5, strength: 1 });
    const none = normalizeRevisionResult({ summary: 'ok', grade: { match: { kind: 'image', ref_id: 5, strength: 1 } } }, { brightness: 0 });
    expect('match' in none.grade).toBe(false);
  });
});
