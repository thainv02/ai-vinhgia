import { describe, expect, it } from 'vitest';
import {
  GRADE_RANGES,
  NEUTRAL_GRADE,
  buildGradeFilter,
  canonicalGrade,
  ffmpegTemperature,
  gradeChips,
  gradeHash,
  gradesEqual,
  isNeutralGrade,
  normalizeGrade,
  outRanges,
} from '../src/services/grade.js';

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e;
  }
  return null;
};

describe('Grade: schema, kẹp giá trị, chuẩn hoá', () => {
  it('null / {} → trung tính đầy đủ; thiếu trường → giá trị trung tính', () => {
    expect(normalizeGrade(null)).toEqual(NEUTRAL_GRADE);
    expect(normalizeGrade(undefined)).toEqual(NEUTRAL_GRADE);
    expect(normalizeGrade({})).toEqual(NEUTRAL_GRADE);
    expect(normalizeGrade({ temperature_k: 7000 })).toEqual({ ...NEUTRAL_GRADE, temperature_k: 7000 });
    expect(isNeutralGrade(normalizeGrade({}))).toBe(true);
    expect(isNeutralGrade(normalizeGrade({ contrast: 1.01 }))).toBe(false);
  });

  it('giá trị ngoài khoảng bị KẸP (không báo lỗi), làm tròn 2 chữ số, nhiệt độ làm tròn số nguyên', () => {
    const g = normalizeGrade({ brightness: 9, contrast: 0.1, saturation: 3, gamma: -4, temperature_k: 99999, vibrance: -9 });
    expect(g).toEqual({ brightness: 0.25, contrast: 0.7, saturation: 1.8, gamma: 0.7, temperature_k: 9000, vibrance: -0.5 });
    for (const [k, r] of Object.entries(GRADE_RANGES)) expect(normalizeGrade({ [k]: r.max + 100 })[k as keyof typeof NEUTRAL_GRADE]).toBe(r.max);
    expect(normalizeGrade({ contrast: 1.23456, brightness: 0.12345, temperature_k: 6543.7 })).toMatchObject({ contrast: 1.23, brightness: 0.12, temperature_k: 6544 });
    expect(normalizeGrade({ temperature_k: 1000 }).temperature_k).toBe(4000);
  });

  it('sai kiểu → INVALID_GRADE (400) nêu đúng trường; khoá lạ bị bỏ', () => {
    for (const bad of [{ contrast: 'cao' }, { brightness: null }, { saturation: Number.NaN }, 'x', 5, [], { scenes: 'a' }, { scenes: [{ scene_id: 1.5 }] }, { scenes: [{ contrast: 1.1 }] }]) {
      const e = err(() => normalizeGrade(bad));
      expect([JSON.stringify(bad), e?.code, e?.status]).toEqual([JSON.stringify(bad), 'INVALID_GRADE', 400]);
    }
    expect(err(() => normalizeGrade({ contrast: 'cao' }))?.message).toContain('contrast');
    expect(normalizeGrade({ contrast: 1.1, hack: '; rm -rf /' } as any)).toEqual({ ...NEUTRAL_GRADE, contrast: 1.1 });
  });

  it('chỉnh theo cảnh: giá trị trung tính bị bỏ, kẹp giá trị, scene_id phải thuộc danh sách, không lặp, sắp theo thứ tự cảnh', () => {
    const g = normalizeGrade({ scenes: [{ scene_id: 12, brightness: 0.9, contrast: 1 }, { scene_id: 11, saturation: 1, temperature_k: 6500 }, { scene_id: 10, gamma: 1.2, temperature_k: 7000 }] }, { sceneIds: [10, 11, 12] });
    expect(g.scenes).toEqual([{ scene_id: 10, gamma: 1.2, temperature_k: 7000 }, { scene_id: 12, brightness: 0.25 }]); // cảnh 11 toàn trung tính → bỏ
    expect(isNeutralGrade(g)).toBe(false);
    expect(normalizeGrade({ scenes: [{ scene_id: 5, contrast: 1 }] }).scenes).toBeUndefined(); // không còn mục nào → không có khoá scenes
    expect(err(() => normalizeGrade({ scenes: [{ scene_id: 99, gamma: 1.1 }] }, { sceneIds: [1, 2] }))?.code).toBe('INVALID_GRADE');
    expect(err(() => normalizeGrade({ scenes: [{ scene_id: 1, gamma: 1.1 }, { scene_id: 1, gamma: 1.2 }] }, { sceneIds: [1] }))?.message).toContain('lặp');
  });

  it('so sánh và băm theo nội dung chuẩn, không theo thứ tự khoá', () => {
    const a = normalizeGrade({ contrast: 1.1, temperature_k: 7000 });
    const b = normalizeGrade({ temperature_k: 7000, contrast: 1.1 });
    expect(gradesEqual(a, b)).toBe(true);
    expect(gradeHash(a)).toBe(gradeHash(b));
    expect(gradeHash(a)).not.toBe(gradeHash(normalizeGrade({ contrast: 1.2, temperature_k: 7000 })));
    expect(gradesEqual(null, NEUTRAL_GRADE)).toBe(true);
    expect(canonicalGrade(a)).toBe(canonicalGrade(b));
  });

  it('chip mô tả: Ấm/Lạnh theo nhiệt độ, chỉ các thông số khác mặc định', () => {
    expect(gradeChips(normalizeGrade({ temperature_k: 7200, contrast: 1.15 }))).toEqual(['Ấm 7200K', 'Tương phản 1.15']);
    expect(gradeChips(normalizeGrade({ temperature_k: 5800, brightness: -0.05, vibrance: 0.3 }))).toEqual(['Lạnh 5800K', 'Độ sáng -0.05', 'Sống động +0.30']);
    expect(gradeChips(NEUTRAL_GRADE)).toEqual([]);
    expect(gradeChips(normalizeGrade({ scenes: [{ scene_id: 1, gamma: 1.1 }] }))).toEqual(['Riêng 1 cảnh']);
  });
});

describe('Grade: dựng filter ffmpeg', () => {
  it('trung tính → null (không chạy bước chỉnh màu)', () => {
    expect(buildGradeFilter(NEUTRAL_GRADE)).toBeNull();
    expect(buildGradeFilter(normalizeGrade({ scenes: [{ scene_id: 1, gamma: 1.2 }] }), [])).toBeNull(); // chỉnh theo cảnh nhưng thiếu khoảng thời gian → không có gì để áp
  });

  it('chỉnh chung: eq → colortemperature → vibrance → format; chỉ ghi tham số khác mặc định; nhiệt độ đối xứng quanh 6500 (ấm hơn = K của ffmpeg thấp hơn)', () => {
    expect(buildGradeFilter(normalizeGrade({ brightness: 0.05, contrast: 1.15, saturation: 1.1, gamma: 0.9, temperature_k: 7200, vibrance: 0.3 }))).toBe(
      'eq=brightness=0.05:contrast=1.15:saturation=1.1:gamma=0.9,colortemperature=temperature=5800,vibrance=intensity=0.3,format=yuv420p',
    );
    expect(buildGradeFilter(normalizeGrade({ contrast: 1.2 }))).toBe('eq=contrast=1.2,format=yuv420p');
    expect(buildGradeFilter(normalizeGrade({ temperature_k: 5500 }))).toBe('colortemperature=temperature=7500,format=yuv420p');
    expect(ffmpegTemperature(6500)).toBe(6500);
    expect(ffmpegTemperature(9000)).toBe(4000);
    expect(ffmpegTemperature(4000)).toBe(9000);
  });

  it('khoảng thời gian của cảnh trên video đầu ra = cộng dồn các đoạn giữ lại theo thứ tự cảnh', () => {
    const edl = {
      scenes: [
        { scene_id: 1, segments: [{ in_s: 0.5, out_s: 9.5 }] }, // 9.0 → [0, 9]
        { scene_id: 2, segments: [{ in_s: 0, out_s: 2 }, { in_s: 4, out_s: 7.5 }] }, // 2 + 3.5 → [9, 14.5]
        { scene_id: 3, segments: [{ in_s: 1, out_s: 4.25 }] }, // 3.25 → [14.5, 17.75]
      ],
    };
    expect(outRanges(edl)).toEqual([
      { scene_id: 1, start: 0, end: 9 },
      { scene_id: 2, start: 9, end: 14.5 },
      { scene_id: 3, start: 14.5, end: 17.75 },
    ]);
  });

  it('chỉnh theo cảnh dùng enable=between(t,a,b) với khoảng của cảnh (b trừ 1ms để cảnh liền nhau không chồng), áp sau chỉnh chung', () => {
    const edl = { scenes: [{ scene_id: 1, segments: [{ in_s: 0, out_s: 9 }] }, { scene_id: 2, segments: [{ in_s: 0, out_s: 5.5 }] }] };
    const g = normalizeGrade({ contrast: 1.1, scenes: [{ scene_id: 2, brightness: 0.1, gamma: 0.9, temperature_k: 7000 }] }, { sceneIds: [1, 2] });
    expect(buildGradeFilter(g, outRanges(edl))).toBe(
      "eq=contrast=1.1,eq=brightness=0.1:gamma=0.9:enable='between(t,9,14.499)',colortemperature=temperature=6000:enable='between(t,9,14.499)',format=yuv420p",
    );
    const only = normalizeGrade({ scenes: [{ scene_id: 1, saturation: 1.4 }] }, { sceneIds: [1, 2] });
    expect(buildGradeFilter(only, outRanges(edl))).toBe("eq=saturation=1.4:enable='between(t,0,8.999)',format=yuv420p");
  });
});
