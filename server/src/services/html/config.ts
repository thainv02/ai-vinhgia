/** Hằng số và hàm thuần của Video HTML (kích thước theo tỉ lệ/chất lượng, đường dẫn thư mục trong output/). */
import os from 'node:os';
import type { HtmlAspect, HtmlQuality } from './view.js';

/** Env tối thiểu cho ffmpeg/ffprobe chạy trên media người dùng/AI đưa vào: không mang AI_API_KEY/WORKER_TOKEN/mã truy cập của server. */
export const mediaEnv = (): NodeJS.ProcessEnv => ({ SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', TEMP: os.tmpdir(), TMP: os.tmpdir() });

export const HTML_ASPECTS = ['9:16', '1:1', '16:9'] as const;
export const HTML_QUALITIES = ['720p', '1080p'] as const;
export const HTML_FPS = 30;
export const HTML_MAX_DURATION_S = 60;
export const HTML_MAX_TOTAL_S = 420;

/** Kích thước chính xác theo tỉ lệ: cạnh ngắn = 720 hoặc 1080. */
export function aspectSize(aspect: HtmlAspect, quality: HtmlQuality): { width: number; height: number } {
  const s = quality === '1080p' ? 1080 : 720;
  const l = Math.round((s * 16) / 9);
  if (aspect === '9:16') return { width: s, height: l };
  if (aspect === '16:9') return { width: l, height: s };
  return { width: s, height: s };
}

/** Thư mục gốc của dự án Video HTML (tương đối từ ROOT). Slug đã qua `slugify` nên an toàn. */
export const htmlDirRel = (slug: string): string => `output/${slug}/html`;
export const versionDirRel = (slug: string, n: number): string => `${htmlDirRel(slug)}/versions/v${n}`;
export const stagingDirRel = (slug: string, versionId: number, attempt: number): string => `${htmlDirRel(slug)}/staging/${versionId}-${attempt}`;
export const assetsDirRel = (slug: string): string => `${htmlDirRel(slug)}/assets`;
export const incomingDirRel = (slug: string): string => `${htmlDirRel(slug)}/.incoming`;
