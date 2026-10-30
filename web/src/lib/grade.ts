import type { FinalCut, Grade, GradeMatch } from '../api/types';

/**
 * Chỉnh màu của bản dựng hoàn chỉnh (khớp `server/src/services/grade.ts`; server vẫn kẹp giá trị và chuẩn hoá nên các hằng số ở đây chỉ để vẽ thanh trượt).
 * Chỉnh màu luôn chạy SAU bước xoá logo Veo, trên bản sạch chưa chỉnh màu, nên mỗi phiên bản mới luôn chỉnh lại từ bản gốc (không chỉnh chồng).
 */
export type GradeKey = 'brightness' | 'contrast' | 'saturation' | 'gamma' | 'temperature_k' | 'vibrance';

export interface GradeField {
  key: GradeKey;
  label: string;
  min: number;
  max: number;
  step: number;
  neutral: number;
  digits: number;
  /** Gợi ý ngắn dưới thanh trượt. */
  hint: string;
}

export const GRADE_FIELDS: GradeField[] = [
  { key: 'temperature_k', label: 'Nhiệt độ màu', min: 4000, max: 9000, step: 50, neutral: 6500, digits: 0, hint: 'Trái: lạnh hơn · phải: ấm hơn' },
  { key: 'contrast', label: 'Tương phản', min: 0.7, max: 1.5, step: 0.01, neutral: 1, digits: 2, hint: 'Cao hơn: sáng tối rõ hơn' },
  { key: 'brightness', label: 'Độ sáng', min: -0.25, max: 0.25, step: 0.01, neutral: 0, digits: 2, hint: 'Cộng/trừ độ sáng toàn khung' },
  { key: 'saturation', label: 'Bão hoà', min: 0.5, max: 1.8, step: 0.01, neutral: 1, digits: 2, hint: 'Thấp hơn: nhạt, cao hơn: đậm màu' },
  { key: 'vibrance', label: 'Sống động', min: -0.5, max: 1, step: 0.01, neutral: 0, digits: 2, hint: 'Làm tươi màu nhạt, ít đụng màu đã đậm' },
  { key: 'gamma', label: 'Gamma', min: 0.7, max: 1.4, step: 0.01, neutral: 1, digits: 2, hint: 'Cao hơn: sáng vùng giữa' },
];

export const neutralGrade = (): Grade => ({ brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature_k: 6500, vibrance: 0 });

const round = (key: GradeKey, v: number): number => {
  const f = GRADE_FIELDS.find((x) => x.key === key)!;
  const p = 10 ** f.digits;
  return Math.round(Math.min(f.max, Math.max(f.min, v)) * p) / p;
};

/** Grade đầy đủ từ dữ liệu của bản dựng (thiếu trường → trung tính). */
export function gradeOf(fc: Pick<FinalCut, 'grade'> | null | undefined): Grade {
  const g = fc?.grade;
  const out = neutralGrade();
  if (!g) return out;
  for (const f of GRADE_FIELDS) if (typeof g[f.key] === 'number') out[f.key] = round(f.key, g[f.key]);
  if (g.scenes?.length) out.scenes = g.scenes.map((s) => ({ ...s }));
  if (g.match) out.match = { ...g.match };
  return out;
}

export function isNeutralGrade(g: Grade): boolean {
  return !g.match && !g.scenes?.length && GRADE_FIELDS.every((f) => g[f.key] === f.neutral);
}

export const MATCH_DEFAULT_STRENGTH = 0.7;

/** Màu theo ảnh mẫu / LUT mới chọn: cường độ 0,7, chỉ lấy tông màu, không khớp riêng từng cảnh (khớp mặc định của server). */
export const newMatch = (kind: 'image' | 'lut', refId: number, prev?: GradeMatch): GradeMatch => ({
  kind,
  ref_id: refId,
  strength: prev?.strength ?? MATCH_DEFAULT_STRENGTH,
  mode: kind === 'image' ? (prev?.mode ?? 'color') : 'color',
  per_scene: kind === 'image' ? (prev?.per_scene ?? false) : false,
});

const matchKey = (m: GradeMatch | undefined): unknown => (m ? [m.kind, m.ref_id, Math.round(m.strength * 100) / 100, m.mode, m.per_scene] : null);

/** Hai grade giống nhau (so theo giá trị đã làm tròn, không phụ thuộc thứ tự khoá). */
export function gradesEqual(a: Grade, b: Grade): boolean {
  const norm = (g: Grade) => JSON.stringify([GRADE_FIELDS.map((f) => round(f.key, g[f.key])), (g.scenes ?? []).map((s) => [s.scene_id, s.brightness ?? null, s.contrast ?? null, s.saturation ?? null, s.gamma ?? null, s.temperature_k ?? null]), matchKey(g.match)]);
  return norm(a) === norm(b);
}

/** "6500K" / "1.15" / "+0.05" */
export function fmtGradeValue(key: GradeKey, v: number): string {
  if (key === 'temperature_k') return `${Math.round(v)}K`;
  const s = v.toFixed(2);
  return key === 'brightness' || key === 'vibrance' ? (v > 0 ? `+${s}` : s) : s;
}

/** Mô tả nhiệt độ: "Ấm", "Lạnh", "Trung tính". */
export const temperatureWord = (k: number): string => (k > 6500 ? 'Ấm' : k < 6500 ? 'Lạnh' : 'Trung tính');

/** Các thông số khác mặc định dạng chip ("Ấm 7200K", "Tương phản 1.15"). Ưu tiên chip do server trả (`grade_chips`). */
export function gradeChips(fc: Pick<FinalCut, 'grade' | 'grade_chips'>): string[] {
  if (fc.grade_chips) return fc.grade_chips;
  const g = fc.grade;
  if (!g) return [];
  const out: string[] = [];
  if (g.temperature_k !== 6500) out.push(`${temperatureWord(g.temperature_k)} ${g.temperature_k}K`);
  if (g.contrast !== 1) out.push(`Tương phản ${g.contrast.toFixed(2)}`);
  if (g.brightness !== 0) out.push(`Độ sáng ${fmtGradeValue('brightness', g.brightness)}`);
  if (g.saturation !== 1) out.push(`Bão hoà ${g.saturation.toFixed(2)}`);
  if (g.gamma !== 1) out.push(`Gamma ${g.gamma.toFixed(2)}`);
  if (g.vibrance !== 0) out.push(`Sống động ${fmtGradeValue('vibrance', g.vibrance)}`);
  if (g.scenes?.length) out.push(`Riêng ${g.scenes.length} cảnh`);
  if (g.match) {
    out.unshift(`${g.match.kind === 'lut' ? 'Màu theo file LUT' : 'Màu theo ảnh mẫu'} ${Math.round(g.match.strength * 100)}%`);
    if (g.match.kind === 'image' && g.match.mode === 'full') out.splice(1, 0, 'Giống cả độ sáng');
    if (g.match.kind === 'image' && g.match.per_scene) out.splice(g.match.mode === 'full' ? 2 : 1, 0, 'Khớp từng cảnh');
  }
  return out;
}

/** Chip nói về ảnh mẫu / LUT (để hiện kèm ảnh thu nhỏ trong lịch sử). */
export const isMatchChip = (chip: string): boolean => chip.startsWith('Màu theo ảnh mẫu') || chip.startsWith('Màu theo file LUT');

/** Gợi ý góp ý nhanh: bấm để chèn chữ vào ô góp ý. */
export const FEEDBACK_SUGGESTIONS = ['Màu ấm hơn', 'Tương phản cao hơn', 'Sáng hơn', 'Màu tươi hơn', 'Màu nhạt/điện ảnh hơn', 'Giữ nguyên điểm cắt'] as const;

/** Chèn gợi ý vào cuối nội dung hiện có (ngăn bằng dấu phẩy, không lặp). */
export function appendSuggestion(text: string, suggestion: string): string {
  const t = text.trimEnd();
  if (!t) return suggestion;
  if (t.toLowerCase().includes(suggestion.toLowerCase())) return text;
  return `${t.replace(/[,.;]$/, '')}, ${suggestion.charAt(0).toLowerCase()}${suggestion.slice(1)}`;
}

export const FEEDBACK_MAX_CHARS = 1000;
