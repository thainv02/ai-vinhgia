/**
 * Kiểm tra cứng trước khi bấm tạo (browser_submit). Toàn bộ là hàm thuần: executor đọc trang (page-scripts.ts)
 * rồi các hàm này quyết định. Không xác minh được mục nào → Issue → từ chối `PRECHECK_FAILED: <mục>`.
 */
export interface Issue { item: string; detail: string }

export interface VideoSettings { aspect: string; duration_s: number; count: number; resolution: string }
export const DEFAULT_VIDEO_SETTINGS: VideoSettings = { aspect: '9:16', duration_s: 10, count: 1, resolution: '720p' };

export type Category = 'aspect' | 'duration' | 'count' | 'resolution';
export interface OptionState { category: Category; value: string | number; text: string; selected: boolean | null }
export interface ComposerSnapshot {
  chips: string[];
  options: OptionState[];
  prompt: { found: boolean; ambiguous: boolean; text: string; candidates: number };
  /** Toàn bộ innerText trang đã chuẩn hóa khoảng trắng. */
  text: string;
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
/** Chuẩn hóa so sánh prompt: NFC, bỏ ký tự rộng 0, NBSP → cách, dấu nháy/gạch kiểu typographic → ASCII, gộp mọi khoảng trắng. */
export function normalizePrompt(value: string): string {
  return value.normalize('NFC').replace(ZERO_WIDTH, '').replace(/ /g, ' ')
    .replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...')
    .replace(/\s+/g, ' ').trim();
}

export function comparePrompt(actual: string, expected: string): Issue | null {
  const a = normalizePrompt(actual), e = normalizePrompt(expected);
  if (!e) return { item: 'prompt', detail: 'payload không có prompt để đối chiếu' };
  if (a === e) return null;
  if (!a) return { item: 'prompt', detail: 'ô prompt đang trống' };
  let i = 0;
  while (i < a.length && i < e.length && a[i] === e[i]) i++;
  return { item: 'prompt', detail: `nội dung ô prompt (${a.length} ký tự) khác prompt của job (${e.length} ký tự), bắt đầu lệch ở vị trí ${i}; dùng browser_fill điền lại nguyên văn` };
}

const CREDIT_PATTERNS = [
  /(?:will\s+use|uses?|costs?|requires?|spends?|sẽ\s+(?:dùng|tốn|sử\s+dụng|mất)|(?:dùng|tốn|sử\s+dụng|mất))\s+(\d{1,5})\s+(?:ai\s+)?(?:credits?|tín\s+dụng)/giu,
  /(\d{1,5})\s+(?:ai\s+)?credits?\s+(?:will\s+be\s+(?:used|spent|deducted|charged)|sẽ\s+được)/giu,
];
/** Mọi số credit được nêu trong text (đã loại trùng). */
export function parseCredits(text: string): number[] {
  const found = new Set<number>();
  for (const re of CREDIT_PATTERNS) for (const m of text.matchAll(re)) found.add(Number(m[1]));
  return [...found];
}

export interface ChipValue { raw: string; resolution: number; duration: number; count: number; aspect?: string }
/** `Video · 720p · 8s · x1` → {resolution:720,duration:8,count:1}. Cần đủ độ phân giải, thời lượng và số lượng. */
export function parseChip(raw: string): ChipValue | null {
  const t = raw.normalize('NFC');
  const res = /(\d{3,4})\s?p\b/i.exec(t), dur = /(?<![\d:])(\d{1,2})\s*(?:s|secs?|giây)\b/i.exec(t), cnt = /(?<![\p{L}\d])x\s?(\d)(?![\p{L}\d])/iu.exec(t);
  if (!res || !dur || !cnt) return null;
  const asp = /(\d{1,2})\s*:\s*(\d{1,2})/.exec(t);
  return { raw, resolution: Number(res[1]), duration: Number(dur[1]), count: Number(cnt[1]), ...(asp ? { aspect: `${asp[1]}:${asp[2]}` } : {}) };
}

/** Đối chiếu thiết lập Flow đang chọn với payload. Ưu tiên chip tổng hợp, rồi trạng thái chọn của nút; không rõ → Issue. */
export function evaluateVideoSettings(snap: ComposerSnapshot, want: VideoSettings, credits: number | undefined): Issue[] {
  const issues: Issue[] = [];
  const chips = snap.chips.map(parseChip).filter((c): c is ChipValue => !!c);
  const distinct = new Set(chips.map((c) => `${c.resolution}|${c.duration}|${c.count}|${c.aspect ?? ''}`));
  if (distinct.size > 1) issues.push({ item: 'settings', detail: `nhiều chip cài đặt khác nhau: ${chips.map((c) => c.raw).join(' / ')}` });
  const chip = distinct.size === 1 ? chips[0] : undefined;
  const wantResolution = Number(String(want.resolution).replace(/p$/i, ''));
  const expected: Record<Category, [string, string | number]> = {
    aspect: ['aspect_ratio', want.aspect], duration: ['duration', want.duration_s], count: ['count', want.count], resolution: ['resolution', wantResolution],
  };
  const label: Record<Category, string> = { aspect: 'tỉ lệ', duration: 'thời lượng', count: 'số lượng', resolution: 'độ phân giải' };
  const shown = (c: Category, v: string | number) => (c === 'duration' ? `${v}s` : c === 'count' ? `x${v}` : c === 'resolution' ? `${v}p` : String(v));
  for (const cat of ['aspect', 'duration', 'count', 'resolution'] as Category[]) {
    const [item, want1] = expected[cat];
    const fromChip = chip ? (cat === 'aspect' ? chip.aspect : cat === 'duration' ? chip.duration : cat === 'count' ? chip.count : chip.resolution) : undefined;
    const selected = snap.options.filter((o) => o.category === cat && o.selected === true);
    const all = snap.options.filter((o) => o.category === cat);
    const selectedValues = new Set(selected.map((o) => String(o.value)));
    if (fromChip !== undefined) {
      if (String(fromChip) !== String(want1)) issues.push({ item, detail: `${label[cat]} đang là ${shown(cat, fromChip)}, cần ${shown(cat, want1)}` });
      else if (selectedValues.size > 0 && !selectedValues.has(String(want1))) issues.push({ item, detail: `${label[cat]}: chip và nút đang chọn mâu thuẫn` });
    } else if (selectedValues.size === 1) {
      if (!selectedValues.has(String(want1))) issues.push({ item, detail: `${label[cat]} đang chọn ${[...selectedValues][0]}, cần ${shown(cat, want1)}` });
    } else if (selectedValues.size > 1) {
      issues.push({ item, detail: `${label[cat]}: nhiều lựa chọn cùng được đánh dấu chọn` });
    } else if (!(all.length === 1 && String(all[0]!.value) === String(want1))) {
      issues.push({ item, detail: `không xác minh được ${label[cat]} đang chọn (mở popover cài đặt và chọn ${shown(cat, want1)})` });
    }
  }
  const nums = parseCredits(snap.text);
  if (credits === undefined || !Number.isFinite(credits)) issues.push({ item: 'credits', detail: 'payload không có credits_expected' });
  else if (nums.length === 0) issues.push({ item: 'credits', detail: 'không thấy dòng "Generating will use N credits" trên trang (mở popover cài đặt)' });
  else if (nums.length > 1) issues.push({ item: 'credits', detail: `trang nêu nhiều mức credit khác nhau: ${nums.join(', ')}` });
  else if (nums[0] !== credits) issues.push({ item: 'credits', detail: `trang báo ${nums[0]} credit, job được duyệt ${credits}` });
  return issues;
}

const key = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Upload đã thực hiện phải đủ và đúng thứ tự `upload_files` của payload. `done` là các file đã upload thành công (đã nối theo thứ tự). */
export function evaluateUploads(done: string[], expected: string[], ownOutputs: string[]): Issue[] {
  const issues: Issue[] = [];
  const own = new Set(ownOutputs.map(key));
  if (expected.some((f) => own.has(key(f)))) issues.push({ item: 'uploads', detail: 'upload_files chứa file output của chính job; từ chối' });
  if (done.some((f) => own.has(key(f)))) issues.push({ item: 'uploads', detail: 'đã upload file output của chính job' });
  const d = done.map(key), e = expected.map(key);
  if (d.length < e.length) issues.push({ item: 'uploads', detail: `mới upload ${d.length}/${e.length} file; còn thiếu: ${e.slice(d.length).join(', ')}` });
  else if (d.length > e.length || d.some((f, i) => f !== e[i])) issues.push({ item: 'uploads', detail: `file đã upload (${d.join(', ') || 'không có'}) không khớp thứ tự yêu cầu (${e.join(', ') || 'không có'})` });
  return issues;
}

export function precheckError(issues: Issue[]): Error {
  const items = [...new Set(issues.map((i) => i.item))];
  return new Error(`PRECHECK_FAILED: ${items.join(', ')}. ${issues.map((i) => `${i.item}: ${i.detail}`).join('; ')}. Chưa ghi intent và chưa bấm; sửa rồi gọi lại browser_submit.`);
}
