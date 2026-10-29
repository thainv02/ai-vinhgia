/**
 * Xem thử MỘT khung hình của clip đúng như bản dựng: cùng ffmpeg, cùng ASS (cùng font, cùng layout) và cùng filtergraph, chỉ khác là chỉ ra 1 khung jpg.
 * Tối đa MỘT ffmpeg xem thử cùng lúc: yêu cầu mới huỷ yêu cầu đang chạy (kết quả cũ bị bỏ, trả 409 `PREVIEW_STALE`). Giữ lại vài ảnh gần nhất, xoá ảnh cũ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { conflict } from '../../lib/errors.js';
import { run } from '../final-render/ffmpeg-renderer.js';
import { RenderCancelled } from '../final-render/types.js';
import { ffmpegOf } from '../media.js';
import { fileUrl } from '../repo.js';
import { lanFileUrl } from '../lan-common.js';
import { buildAss, displayWords, parseCaptionStyle } from './captions.js';
import { captionStyleBody } from './clips.js';
import { abs, clipsDirRel, getClipProject, getClipRow, getSourceRow, latestCut, readTranscript } from './repo.js';
import { sourceFileOk } from './source.js';
import { CAPTION_FFMPEG_MISSING, buildFilterGraph, captionFonts, captionSupport, resolveReframe, targetSize } from './render.js';
import { captionWordsOf } from './view.js';
import { parseJson } from '../repo.js';
import type { ReframeMode } from '../../db/types.js';

export const FRAMES_KEEP = 6;
export const PREVIEW_TIMEOUT_MS = 30_000;
const f3 = (x: number): string => (Math.round(x * 1000) / 1000).toFixed(3);

export const previewBody = z.object({
  /** Giây tính từ đầu clip; vắng = 40% clip. */
  at: z.number().min(0).max(36_000).optional(),
  /** Kiểu/vị trí chưa lưu để thử; vắng từng trường = dùng kiểu đã lưu của clip. */
  captions: captionStyleBody.optional(),
});
export type PreviewBody = z.infer<typeof previewBody>;

export const framesDirRel = (slug: string): string => `${clipsDirRel(slug)}/frames`;

interface PreviewState {
  seq: number;
  ctrl: AbortController | null;
  tail: Promise<unknown>;
}
const states = new WeakMap<AppContext, PreviewState>();
const stateOf = (ctx: AppContext): PreviewState => {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { seq: 0, ctrl: null, tail: Promise.resolve() }));
  return s;
};

const stale = () => conflict('PREVIEW_STALE', 'Yêu cầu xem thử đã được thay bằng yêu cầu mới hơn');

/** Giữ `keep` ảnh mới nhất trong thư mục khung xem thử, xoá ảnh cũ và ASS tạm còn sót. */
export function pruneFrames(dir: string, keep: number = FRAMES_KEEP): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const jpgs = names
    .filter((n) => n.endsWith('.jpg'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const j of jpgs.slice(keep)) fs.rmSync(path.join(dir, j.n), { force: true });
  for (const n of names.filter((x) => x.endsWith('.ass'))) fs.rmSync(path.join(dir, n), { force: true });
}

/** `POST /api/clips/:id/preview-frame` → `{ url, at, width, height }`. */
export async function renderPreviewFrame(ctx: AppContext, clipId: number, body: PreviewBody, o: { lan: boolean }): Promise<{ url: string; at: number; width: number; height: number }> {
  const st = stateOf(ctx);
  const my = ++st.seq;
  st.ctrl?.abort();
  const ctrl = new AbortController();
  st.ctrl = ctrl;
  const prev = st.tail;
  let release!: () => void;
  st.tail = new Promise<void>((r) => (release = r));
  try {
    await prev.catch(() => undefined); // ffmpeg trước đã dừng hẳn rồi mới chạy cái mới (tối đa 1 tiến trình)
    if (st.seq !== my) throw stale();

    const clip = getClipRow(ctx, clipId);
    const project = getClipProject(ctx, clip.project_id);
    const source = getSourceRow(ctx, clip.source_id);
    if (!sourceFileOk(ctx, source)) throw conflict('SOURCE_DELETED', 'Video gốc đã bị xoá nên không xem thử được');
    const transcript = readTranscript(ctx, source);
    if (!transcript) throw conflict('NOT_TRANSCRIBED', 'Video chưa được nhận dạng lời nói xong');
    const stored = parseCaptionStyle(clip.captions);
    const style = { preset: body.captions?.preset ?? stored.preset, layout: body.captions?.layout === undefined ? stored.layout : body.captions.layout };
    let bin = ffmpegOf(ctx.config);
    if (style.preset !== 'none') {
      const sup = captionSupport(ctx);
      if (!sup.available || !sup.ffmpeg) throw conflict('CAPTIONS_UNAVAILABLE', CAPTION_FFMPEG_MISSING);
      bin = sup.ffmpeg;
    }
    if (!bin) throw conflict('NO_FFMPEG', 'Không tìm thấy ffmpeg trên máy chủ');

    const dur = clip.end_s - clip.start_s;
    const at = Math.min(Math.max(0, body.at ?? dur * 0.4), Math.max(0, dur - 0.05));
    const srcW = source.width ?? 1920;
    const srcH = source.height ?? 1080;
    const { w, h } = targetSize('9:16', srcW, srcH);
    const reframeMode = parseJson<{ mode?: ReframeMode }>(latestCut(ctx, clip.id)?.reframe ?? null, {}).mode;
    const resolved = resolveReframe(srcW, srcH, w, h, reframeMode, '9:16');

    const dirRel = framesDirRel(project.slug);
    const dir = abs(ctx, dirRel);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now().toString(36)}${my.toString(36)}`;
    const outRel = `${dirRel}/${clip.code}_${stamp}.jpg`;
    const out = abs(ctx, outRel);
    const assFile = path.join(dir, `.${clip.code}_${stamp}.ass`);
    let ass: { file: string; fontsDir: string | null } | null = null;
    try {
      if (style.preset !== 'none') {
        const words = displayWords(transcript, clip.start_word, clip.end_word, captionWordsOf(clip));
        const fonts = captionFonts(ctx);
        fs.writeFileSync(assFile, buildAss(words, { preset: style.preset, width: w, height: h, font: fonts.family, clipStart: clip.start_s, clipEnd: clip.end_s, layout: style.layout }));
        ass = { file: assFile, fontsDir: fonts.fontsDir };
      }
      const { graph } = buildFilterGraph({ srcW, srcH, aspect: '9:16', reframe: resolved, ass, ptsOffsetS: at });
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', f3(clip.start_s + at), '-i', abs(ctx, source.path!), '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-q:v', '3', '-update', '1', out];
      const timer = setTimeout(() => ctrl.abort(), PREVIEW_TIMEOUT_MS);
      try {
        await run(bin, args, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      if (st.seq !== my) throw stale();
    } catch (err) {
      fs.rmSync(out, { force: true });
      if (err instanceof RenderCancelled || ctrl.signal.aborted) throw st.seq !== my ? stale() : conflict('PREVIEW_TIMEOUT', 'Dựng khung xem thử quá lâu, hãy thử lại');
      throw err;
    } finally {
      fs.rmSync(assFile, { force: true });
    }
    pruneFrames(dir);
    return { url: o.lan ? lanFileUrl(outRel) : fileUrl(outRel), at, width: w, height: h };
  } finally {
    if (st.ctrl === ctrl) st.ctrl = null;
    release();
  }
}
