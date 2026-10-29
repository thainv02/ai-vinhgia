/**
 * Dựng clip: MỘT lượt ffmpeg `-ss start -i src -t dur` (cắt chính xác, mã hoá lại) → reframe (`fit` nền mờ / `center` cắt giữa / tự nhận biết nguồn đã đúng tỉ lệ)
 * → `subtitles` (ASS, libass) → afade 0.06 s hai đầu → libx264 crf 18 preset medium + aac 160k + faststart.
 * Chạy trong hàng đợi render chung (`FinalRenderService.enqueueClipTask`), ưu tiên app hơn LAN, hủy được (kill ffmpeg, xoá file dở).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { CAPTION_PRESETS, CLIP_ASPECTS, REFRAME_MODES, type ClipAspect, type ClipCutRow, type ClipRow, type ProjectRow, type ReframeMode, type SourceVideoRow } from '../../db/types.js';
import { conflict } from '../../lib/errors.js';
import { run } from '../final-render/ffmpeg-renderer.js';
import { RenderCancelled } from '../final-render/types.js';
import { assertLanQueueRoom } from '../lan-queue.js';
import { ffmpegOf, probeMedia } from '../media.js';
import { emitProject } from '../project-view.js';
import { getProject, logEvent, parseJson } from '../repo.js';
import { buildAss, buildClipSrt, captionLayoutSchema, captionStyleJson, displayWords, parseCaptionStyle } from './captions.js';
import { abs, cutsDirRel, getClipProject, getClipRow, getCutRow, getSourceRow, readTranscript } from './repo.js';
import { assertDiskRoom, sourceFileOk } from './source.js';
import { captionWordsOf, emitClip, emitCut } from './view.js';

export const FADE_S = 0.06;
const f3 = (x: number): string => (Math.round(x * 1000) / 1000).toFixed(3);
export const CAPTION_FFMPEG_MISSING =
  'ffmpeg trên máy chủ chưa hỗ trợ phụ đề (thiếu libass/bộ lọc "subtitles"). Cài ffmpeg có libass (vd `brew install ffmpeg-full`) hoặc đặt CLIP_FFMPEG_PATH trong .env rồi khởi động lại; hoặc chọn "Không phụ đề".';

export const renderBody = z.object({
  aspect: z.enum(CLIP_ASPECTS).default('9:16'),
  reframe_mode: z.enum(REFRAME_MODES).optional(),
  /** Vắng: dùng kiểu đã lưu của clip (mặc định highlight). */
  captions_preset: z.enum(CAPTION_PRESETS).optional(),
  /** Vắng: dùng vị trí đã lưu của clip; null = vị trí mặc định. */
  captions_layout: captionLayoutSchema.nullable().optional(),
});
export type RenderBody = z.infer<typeof renderBody>;

// ---------------------------------------------------------------- ffmpeg có libass, font

const filterCache = new Map<string, boolean>();

/** Bộ lọc/bộ mã hoá mà bản dựng clip cần (ngoài `subtitles`): một số bản ffmpeg tối giản (vd conda-forge) thiếu `boxblur`. */
const NEEDED_FILTERS = ['subtitles', 'boxblur', 'overlay', 'scale', 'crop', 'eq', 'split', 'afade', 'format'];
const NEEDED_ENCODERS = ['libx264', 'aac'];

/**
 * ffmpeg này đủ để dựng clip CÓ phụ đề không: có bộ lọc `subtitles` (libass) và mọi bộ lọc/bộ mã hoá của filtergraph (có nhớ lại kết quả theo đường dẫn).
 * Tên giữ nguyên `hasSubtitlesFilter` vì libass là phần hiếm nhất.
 */
export function hasSubtitlesFilter(bin: string): boolean {
  const hit = filterCache.get(bin);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const run = (args: string[]): string => execFileSync(bin, ['-hide_banner', ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const filters = run(['-filters']);
    const encoders = run(['-encoders']);
    ok = NEEDED_FILTERS.every((f) => new RegExp(`\\s${f}\\s`).test(filters)) && NEEDED_ENCODERS.every((e) => new RegExp(`\\s${e}\\s`).test(encoders));
  } catch {
    ok = false;
  }
  filterCache.set(bin, ok);
  return ok;
}

const LIBASS_CANDIDATES = ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

export interface CaptionSupport {
  available: boolean;
  ffmpeg: string | null;
  reason: string | null;
}

/** ffmpeg dùng để cháy phụ đề: CLIP_FFMPEG_PATH, rồi ffmpeg mặc định, rồi ffmpeg-full của Homebrew; cái nào có libass thì dùng. */
export function captionSupport(ctx: AppContext): CaptionSupport {
  const cands: (string | null)[] = [ctx.config.clipFfmpegPath, ffmpegOf(ctx.config), ...LIBASS_CANDIDATES.map((c) => (fs.existsSync(c) ? c : null))];
  for (const c of cands) if (c && hasSubtitlesFilter(c)) return { available: true, ffmpeg: c, reason: null };
  return { available: false, ffmpeg: null, reason: CAPTION_FFMPEG_MISSING };
}

/** Font hệ thống macOS có đủ dấu tiếng Việt (đã kiểm chứng bằng render thật câu mẫu, xem docs/ai/OPERATIONS.md). Khoá: family (viết thường). */
const SYSTEM_FONT_FILES: Record<string, string[]> = {
  arial: ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf'],
  'helvetica neue': ['/System/Library/Fonts/HelveticaNeue.ttc'],
  verdana: ['/System/Library/Fonts/Supplemental/Verdana Bold.ttf'],
  tahoma: ['/System/Library/Fonts/Supplemental/Tahoma Bold.ttf'],
  'trebuchet ms': ['/System/Library/Fonts/Supplemental/Trebuchet MS Bold.ttf'],
};

/**
 * Thư mục font cho libass: CLIP_FONTS_DIR nếu đặt; không thì `<thư mục DB>/clip-fonts` chứa MỘT bản chép của font hệ thống tương ứng
 * (không quét cả thư mục font của máy: nhanh và không phụ thuộc fontconfig). Không có file font thì trả null (libass tự tìm theo tên family).
 */
export function captionFonts(ctx: AppContext): { family: string; fontsDir: string | null } {
  const family = ctx.config.clipCaptionFont;
  if (ctx.config.clipFontsDir) return { family, fontsDir: ctx.config.clipFontsDir };
  const dir = path.join(path.dirname(ctx.config.dbPath), 'clip-fonts');
  const src = (SYSTEM_FONT_FILES[family.toLowerCase()] ?? []).find((f) => fs.existsSync(f));
  if (!src) return { family, fontsDir: fs.existsSync(dir) ? dir : null };
  const dest = path.join(dir, path.basename(src));
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    return { family, fontsDir: dir };
  } catch {
    return { family, fontsDir: null };
  }
}

// ---------------------------------------------------------------- filtergraph (thuần)

export function targetSize(aspect: ClipAspect, srcW: number, srcH: number): { w: number; h: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  if (aspect === '9:16') return { w: 1080, h: 1920 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  if (aspect === '16:9') return { w: 1920, h: 1080 };
  return { w: even(srcW), h: even(srcH) };
}

export type ResolvedReframe = 'native' | ReframeMode;

/** Nguồn đã đúng tỉ lệ đích (sai lệch < 2%) → `native` (chỉ scale). Ngược lại dùng chế độ người dùng chọn (mặc định `fit`). */
export function resolveReframe(srcW: number, srcH: number, tw: number, th: number, requested: ReframeMode | undefined, aspect: ClipAspect): ResolvedReframe {
  if (aspect === 'source') return 'native';
  const sa = srcW / srcH;
  const ta = tw / th;
  if (Math.abs(sa - ta) / ta < 0.02) return 'native';
  return requested ?? 'fit';
}

/** Hai tầng escape của ffmpeg (giá trị tuỳ chọn rồi tới filtergraph), đủ cho đường dẫn có khoảng trắng, dấu `:` `'` `,` `[` `]` `;`. */
export function escapeFilterValue(s: string): string {
  const opt = s.replace(/[\\':]/g, (m) => `\\${m}`);
  return opt.replace(/[\\',[\];]/g, (m) => `\\${m}`);
}

/**
 * Đường dẫn file đưa vào bộ lọc, đặt TRONG dấu nháy đơn (`filename='...'`). Trên Windows: đổi dấu gạch chéo ngược thành `/` (nó là ký tự escape của ffmpeg nên
 * `C:\a\b.ass` hỏng) và chỉ escape dấu `:` của ổ đĩa MỘT lần (trong dấu nháy, tầng filtergraph không giải escape nên escape hai tầng như `escapeFilterValue`
 * sẽ để lại `\` và làm `:` tách tuỳ chọn). Hệ khác dùng `escapeFilterValue` như trước.
 */
export function escapeFilterPath(p: string, win: boolean = process.platform === 'win32'): string {
  return win ? p.replaceAll('\\', '/').replace(/'/g, "'\\''").replace(/:/g, '\\:') : escapeFilterValue(p);
}

export interface GraphInput {
  srcW: number;
  srcH: number;
  aspect: ClipAspect;
  reframe: ResolvedReframe;
  ass: { file: string; fontsDir: string | null } | null;
  /** Xem thử một khung: dịch mốc thời gian khung lên `ptsOffsetS` giây trước khi cháy phụ đề (vì `-ss` đầu vào đưa khung về 0). */
  ptsOffsetS?: number;
}

/** filter_complex một lượt: reframe → (phụ đề) → nhãn `[v]`. */
export function buildFilterGraph(g: GraphInput): { graph: string; width: number; height: number } {
  const { w, h } = targetSize(g.aspect, g.srcW, g.srcH);
  const parts: string[] = [];
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  if (g.reframe === 'native') {
    parts.push(`[0:v]scale=${w}:${h}:flags=lanczos,setsar=1[base]`);
  } else if (g.reframe === 'center') {
    // cắt giữa khung theo tỉ lệ đích (kích thước chẵn), rồi scale
    const ta = w / h;
    const cw = g.srcW / g.srcH > ta ? Math.max(2, Math.floor((g.srcH * ta) / 2) * 2) : g.srcW;
    const ch = g.srcW / g.srcH > ta ? g.srcH : Math.max(2, Math.floor(g.srcW / ta / 2) * 2);
    parts.push(`[0:v]crop=${cw}:${ch}:(iw-${cw})/2:(ih-${ch})/2,scale=${w}:${h}:flags=lanczos,setsar=1[base]`);
  } else {
    // nền: phóng to phủ khung, làm mờ ở độ phân giải 1/4 (nhanh, tương đương mờ rộng ở độ phân giải đầy đủ), giảm sáng nhẹ; lớp chính nằm giữa
    const bw = even(w / 4);
    const bh = even(h / 4);
    parts.push(
      `[0:v]split=2[bg0][fg0]`,
      `[bg0]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=6:2,scale=${w}:${h},eq=brightness=-0.10[bg]`,
      `[fg0]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`,
    );
  }
  if (g.ass) {
    const fonts = g.ass.fontsDir ? `:fontsdir='${escapeFilterPath(g.ass.fontsDir)}'` : '';
    const shift = g.ptsOffsetS ? `setpts=PTS+${f3(g.ptsOffsetS)}/TB,` : '';
    parts.push(`[base]${shift}subtitles=filename='${escapeFilterPath(g.ass.file)}'${fonts},format=yuv420p[v]`);
  } else {
    parts.push('[base]format=yuv420p[v]');
  }
  return { graph: parts.join(';'), width: w, height: h };
}

export interface ArgsInput {
  src: string;
  startS: number;
  durS: number;
  graph: string;
  hasAudio: boolean;
  out: string;
}

/** Tham số ffmpeg đầy đủ: `-ss` TRƯỚC `-i` (mã hoá lại nên cắt chính xác), `-t`, afade 0.06 s hai đầu, x264 crf 18, aac 160k, faststart. */
export function buildClipArgs(a: ArgsInput): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-ss', f3(a.startS), '-i', a.src, '-t', f3(a.durS), '-filter_complex', a.graph, '-map', '[v]'];
  if (a.hasAudio) {
    args.push('-map', '0:a:0', '-af', `afade=t=in:st=0:d=${FADE_S},afade=t=out:st=${f3(Math.max(0, a.durS - FADE_S))}:d=${FADE_S}`);
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (a.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-movflags', '+faststart', '-f', 'mp4', a.out);
  return args;
}

// ---------------------------------------------------------------- tạo bản dựng

const ACTIVE_STATUSES = ['rendering'];

/** Số version kế tiếp của clip: lớn hơn mọi version trong DB và mọi file `<code>_v<n>.*` trên đĩa (không bao giờ ghi đè). */
export function nextCutVersion(ctx: AppContext, clip: ClipRow, project: ProjectRow): number {
  const dbMax = (ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM clip_cuts WHERE clip_id = ?').get(clip.id) as { v: number }).v;
  let v = dbMax + 1;
  for (;;) {
    const base = `${cutsDirRel(project.slug)}/${clip.code}_v${v}`;
    if (!['.mp4', '.srt', '.ass'].some((ext) => fs.existsSync(abs(ctx, base + ext)))) return v;
    v++;
  }
}

/**
 * `POST /api/clips/:id/render`: tạo `clip_cuts` version mới (`rendering`) và xếp hàng chung (app trước LAN). 409 nếu clip đã bỏ, video gốc đã xoá,
 * đang dựng bản khác của clip này, hoặc ffmpeg thiếu libass mà chọn phụ đề; 507 nếu ổ đĩa không đủ chỗ; 429 nếu hàng đợi LAN đầy.
 */
export function startClipRender(ctx: AppContext, clipId: number, body: RenderBody, o: { lan: boolean }): ClipCutRow {
  return ctx.tx(() => {
    const clip = getClipRow(ctx, clipId);
    const project = getClipProject(ctx, clip.project_id);
    if (clip.status === 'rejected') throw conflict('INVALID_STATE', `Clip ${clip.code} đã bị bỏ; hãy duyệt lại trước khi dựng`);
    const source = getSourceRow(ctx, clip.source_id);
    if (!sourceFileOk(ctx, source)) throw conflict('SOURCE_DELETED', 'Video gốc đã bị xoá nên không dựng clip mới được (vẫn tải được các clip đã dựng)');
    if (!ffmpegOf(ctx.config)) throw conflict('NO_FFMPEG', 'Không tìm thấy ffmpeg trên máy chủ');
    const stored = parseCaptionStyle(clip.captions);
    const style = { preset: body.captions_preset ?? stored.preset, layout: body.captions_layout === undefined ? stored.layout : body.captions_layout };
    if (style.preset !== 'none' && !captionSupport(ctx).available) throw conflict('CAPTIONS_UNAVAILABLE', CAPTION_FFMPEG_MISSING);
    const busy = ctx.db.prepare("SELECT version FROM clip_cuts WHERE clip_id = ? AND status = 'rendering' LIMIT 1").get(clipId) as { version: number } | undefined;
    if (busy) throw conflict('CUT_ACTIVE', `Clip ${clip.code} đang dựng bản v${busy.version}; hãy đợi hoặc hủy trước`);
    assertDiskRoom(ctx, Math.round((clip.end_s - clip.start_s) * 2_000_000), 1);
    if (o.lan) assertLanQueueRoom(ctx);
    const sw = source.width ?? 1920;
    const sh = source.height ?? 1080;
    const { w, h } = targetSize(body.aspect, sw, sh);
    const resolved = resolveReframe(sw, sh, w, h, body.reframe_mode, body.aspect);
    const version = nextCutVersion(ctx, clip, project);
    const reframe = { mode: resolved === 'native' ? (body.reframe_mode ?? 'fit') : resolved, ...(resolved === 'native' ? { native: true } : {}) };
    const info = ctx.db
      .prepare(
        `INSERT INTO clip_cuts (clip_id, project_id, version, status, stage, progress, aspect, reframe, captions, start_s, end_s, created_at)
         VALUES (?, ?, ?, 'rendering', 'prepare', 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(clip.id, project.id, version, body.aspect, JSON.stringify(reframe), captionStyleJson(style), clip.start_s, clip.end_s, ctx.now());
    const id = Number(info.lastInsertRowid);
    // kiểu đã dùng để dựng thành kiểu đang lưu của clip (để "cần dựng lại" chỉ bật khi người dùng đổi sau đó)
    if (clip.captions !== captionStyleJson(style) && (body.captions_preset !== undefined || body.captions_layout !== undefined)) ctx.db.prepare('UPDATE clips SET captions = ? WHERE id = ?').run(captionStyleJson(style), clip.id);
    logEvent(ctx, { project_id: project.id, type: 'clip.render', message: `Clip ${clip.code}: dựng bản v${version} (${body.aspect}, ${resolved === 'native' ? 'đúng tỉ lệ nguồn' : resolved === 'fit' ? 'nền mờ' : 'cắt giữa'}, phụ đề ${style.preset}${style.layout ? ' có vị trí riêng' : ''})` });
    emitCut(ctx, id, project.id);
    emitClip(ctx, clip.id, project.id);
    emitProject(ctx, project.id);
    ctx.afterCommit(() => enqueueCut(ctx, id, o.lan));
    return getCutRow(ctx, id);
  });
}

/** Xếp một bản dựng `rendering` vào hàng đợi render chung. */
export function enqueueCut(ctx: AppContext, cutId: number, lan: boolean): void {
  ctx.finalRender?.enqueueClipTask('clip', cutId, lan, (abort) => runClipCut(ctx, cutId, abort));
}

// ---------------------------------------------------------------- chạy

type CutPatch = Partial<Pick<ClipCutRow, 'status' | 'stage' | 'progress' | 'error' | 'video_path' | 'srt_path' | 'ass_path' | 'duration_s' | 'finished_at'>>;

function patchCut(ctx: AppContext, id: number, patch: CutPatch): void {
  const keys = Object.keys(patch) as (keyof CutPatch)[];
  if (!keys.length) return;
  ctx.tx(() => {
    ctx.db.prepare(`UPDATE clip_cuts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
    const row = getCutRow(ctx, id);
    emitCut(ctx, id, row.project_id);
  });
}

const stillRendering = (ctx: AppContext, id: number): boolean => (ctx.db.prepare('SELECT status FROM clip_cuts WHERE id = ?').get(id) as { status: string } | undefined)?.status === 'rendering';

function failCut(ctx: AppContext, id: number, clip: ClipRow, error: string): void {
  if (!stillRendering(ctx, id)) return;
  ctx.tx(() => {
    patchCut(ctx, id, { status: 'failed', stage: null, error: error.slice(0, 500), finished_at: ctx.now() });
    const cut = getCutRow(ctx, id);
    logEvent(ctx, { project_id: clip.project_id, type: 'clip.render_failed', message: `Clip ${clip.code}: dựng v${cut.version} lỗi — ${error.slice(0, 300)}` });
    emitClip(ctx, clip.id, clip.project_id);
    emitProject(ctx, clip.project_id);
  });
}

/** Chạy một bản dựng (được gọi bởi hàng đợi render). Mọi kết cục đều được ghi DB; không ném lỗi ra ngoài. */
export async function runClipCut(ctx: AppContext, cutId: number, abort: AbortController): Promise<void> {
  const cut = ctx.db.prepare('SELECT * FROM clip_cuts WHERE id = ?').get(cutId) as ClipCutRow | undefined;
  if (!cut || cut.status !== 'rendering' || abort.signal.aborted) return;
  let clip: ClipRow;
  let source: SourceVideoRow;
  let project: ProjectRow;
  try {
    clip = getClipRow(ctx, cut.clip_id);
    source = getSourceRow(ctx, clip.source_id);
    project = getProject(ctx, clip.project_id);
  } catch {
    return; // dự án đã vào thùng rác
  }
  const base = `${cutsDirRel(project.slug)}/${clip.code}_v${cut.version}`;
  const rel = { video: `${base}.mp4`, srt: `${base}.srt`, ass: `${base}.ass` };
  const dir = path.dirname(abs(ctx, rel.video));
  const tmpVideo = path.join(dir, `.${clip.code}_v${cut.version}.tmp.mp4`);
  const { preset, layout } = parseCaptionStyle(cut.captions);
  const created: string[] = [];
  try {
    for (const r of [rel.video, rel.srt, rel.ass]) {
      if (fs.existsSync(abs(ctx, r))) throw new Error(`File ${path.basename(r)} đã tồn tại; không ghi đè. Hãy dựng lại để lấy số version mới`);
    }
    if (!sourceFileOk(ctx, source)) throw new Error('Video gốc đã bị xoá hoặc không còn trên máy chủ');
    const transcript = readTranscript(ctx, source);
    if (!transcript) throw new Error('Không đọc được transcript của video');
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tmpVideo, { force: true });
    const aspect = cut.aspect;
    const info = probeMedia(ctx.config, abs(ctx, source.path!));
    const srcW = info?.width ?? source.width ?? 1920;
    const srcH = info?.height ?? source.height ?? 1080;
    const { w, h } = targetSize(aspect, srcW, srcH);
    const reframeMode = parseJson<{ mode?: ReframeMode }>(cut.reframe, {}).mode;
    const resolved = resolveReframe(srcW, srcH, w, h, reframeMode, aspect);

    // --- chuẩn bị phụ đề (.ass cho ffmpeg, .srt cho người dùng) ---
    const words = displayWords(transcript, clip.start_word, clip.end_word, captionWordsOf(clip));
    fs.writeFileSync(abs(ctx, rel.srt), buildClipSrt(words, cut.start_s, cut.end_s), { flag: 'wx' });
    created.push(rel.srt);
    let ass: { file: string; fontsDir: string | null } | null = null;
    let bin = ffmpegOf(ctx.config);
    if (preset !== 'none') {
      const sup = captionSupport(ctx);
      if (!sup.available || !sup.ffmpeg) throw new Error(CAPTION_FFMPEG_MISSING);
      bin = sup.ffmpeg;
      const fonts = captionFonts(ctx);
      fs.writeFileSync(abs(ctx, rel.ass), buildAss(words, { preset, width: w, height: h, font: fonts.family, clipStart: cut.start_s, clipEnd: cut.end_s, layout }), { flag: 'wx' });
      created.push(rel.ass);
      ass = { file: abs(ctx, rel.ass), fontsDir: fonts.fontsDir };
    }
    if (!bin) throw new Error('Không tìm thấy ffmpeg');
    if (abort.signal.aborted) throw new RenderCancelled();

    // --- dựng một lượt ---
    const durS = cut.end_s - cut.start_s;
    const { graph } = buildFilterGraph({ srcW, srcH, aspect, reframe: resolved, ass });
    const args = buildClipArgs({ src: abs(ctx, source.path!), startS: cut.start_s, durS, graph, hasAudio: info?.has_audio ?? true, out: tmpVideo });
    patchCut(ctx, cutId, { stage: 'render', progress: 0 });
    const throttle = ctx.finalRender?.progressThrottleMs ?? 1000;
    let lastWrite = 0;
    let best = 0;
    await run(bin, args, abort.signal, (line) => {
      const m = /^out_time(?:_us|_ms)?=(\d+)/.exec(line);
      if (!m || abort.signal.aborted) return;
      best = Math.max(best, Math.min(99, Math.round((Number(m[1]) / 1e6 / durS) * 1000) / 10));
      const now = Date.now();
      if (now - lastWrite < throttle && best < 99) return;
      lastWrite = now;
      if (stillRendering(ctx, cutId)) patchCut(ctx, cutId, { progress: best });
    });
    if (abort.signal.aborted) throw new RenderCancelled();
    const out = probeMedia(ctx.config, tmpVideo);
    if (!out?.duration_s || Math.abs(out.duration_s - durS) > 0.5) throw new Error(`Video dựng ra dài ${out?.duration_s?.toFixed(2) ?? '?'} giây, lệch so với ${durS.toFixed(2)} giây dự kiến`);
    if (!stillRendering(ctx, cutId)) throw new RenderCancelled();
    fs.renameSync(tmpVideo, abs(ctx, rel.video)); // nguyên tử: bản dựng chỉ xuất hiện khi đã đầy đủ và hợp lệ
    created.push(rel.video);
    ctx.tx(() => {
      if (!stillRendering(ctx, cutId)) {
        for (const r of created) fs.rmSync(abs(ctx, r), { force: true });
        return;
      }
      patchCut(ctx, cutId, {
        status: 'ready',
        stage: null,
        progress: 100,
        error: null,
        video_path: rel.video,
        srt_path: rel.srt,
        ass_path: preset !== 'none' ? rel.ass : null,
        duration_s: Math.round(out.duration_s! * 1000) / 1000,
        finished_at: ctx.now(),
      });
      logEvent(ctx, { project_id: project.id, type: 'clip.render_ready', message: `Clip ${clip.code}: bản v${cut.version} sẵn sàng (${out.duration_s!.toFixed(1)} giây)` });
      emitClip(ctx, clip.id, project.id);
      emitProject(ctx, project.id);
    });
  } catch (err) {
    fs.rmSync(tmpVideo, { force: true });
    if (abort.signal.aborted || err instanceof RenderCancelled) {
      // đã hủy (trạng thái do cancelClipCut ghi): xoá file dở. Tắt server giữa chừng: bản `rendering` được đánh dấu failed ở lần khởi động sau.
      for (const r of created) fs.rmSync(abs(ctx, r), { force: true });
      return;
    }
    for (const r of created) fs.rmSync(abs(ctx, r), { force: true });
    failCut(ctx, cutId, clip, err instanceof Error ? err.message : String(err));
  }
}

/** `POST /api/clip-cuts/:id/cancel`: hủy bản đang dựng (kill ffmpeg, xoá file dở). Trạng thái khác `rendering` → 409. */
export function cancelClipCut(ctx: AppContext, cutId: number): ClipCutRow {
  return ctx.tx(() => {
    const cut = getCutRow(ctx, cutId);
    if (!ACTIVE_STATUSES.includes(cut.status)) throw conflict('INVALID_STATE', `Bản dựng v${cut.version} đang ở trạng thái ${cut.status}, không thể hủy`);
    const clip = getClipRow(ctx, cut.clip_id);
    patchCut(ctx, cutId, { status: 'cancelled', stage: null, progress: null, error: null, finished_at: ctx.now() });
    logEvent(ctx, { project_id: cut.project_id, type: 'clip.render_cancelled', message: `Clip ${clip.code}: bản dựng v${cut.version} đã bị hủy` });
    ctx.afterCommit(() => {
      ctx.finalRender?.cancelClipTask('clip', cutId);
      const slug = (ctx.db.prepare('SELECT slug FROM projects WHERE id = ?').get(cut.project_id) as { slug: string } | undefined)?.slug;
      if (slug) {
        const base = `${cutsDirRel(slug)}/${clip.code}_v${cut.version}`;
        fs.rmSync(path.join(path.dirname(abs(ctx, base)), `.${clip.code}_v${cut.version}.tmp.mp4`), { force: true });
        // file đã ghi trước khi ffmpeg bị dừng (srt/ass) chỉ xoá nếu bản này chưa `ready` (đã `cancelled` ở trên)
        for (const ext of ['.srt', '.ass']) fs.rmSync(abs(ctx, base + ext), { force: true });
      }
    });
    emitClip(ctx, clip.id, cut.project_id);
    emitProject(ctx, cut.project_id);
    return getCutRow(ctx, cutId);
  });
}

/** Khi server khởi động: bản đang `rendering` của tiến trình cũ (đã chết) → `failed`, dọn file tạm và file dở. */
export function recoverClipCuts(ctx: AppContext): number {
  return ctx.tx(() => {
    const rows = ctx.db.prepare("SELECT c.*, p.slug, k.code AS clip_code FROM clip_cuts c JOIN projects p ON p.id = c.project_id JOIN clips k ON k.id = c.clip_id WHERE c.status = 'rendering'").all() as (ClipCutRow & { slug: string; clip_code: string })[];
    for (const r of rows) {
      const base = `${cutsDirRel(r.slug)}/${r.clip_code}_v${r.version}`;
      ctx.afterCommit(() => {
        fs.rmSync(path.join(path.dirname(abs(ctx, base)), `.${r.clip_code}_v${r.version}.tmp.mp4`), { force: true });
        for (const ext of ['.srt', '.ass', '.mp4']) fs.rmSync(abs(ctx, base + ext), { force: true });
      });
      ctx.db.prepare("UPDATE clip_cuts SET status = 'failed', stage = NULL, progress = NULL, error = 'Server khởi động lại trong lúc dựng; bấm Dựng lại', finished_at = ? WHERE id = ?").run(ctx.now(), r.id);
      logEvent(ctx, { project_id: r.project_id, type: 'clip.render_failed', message: `Clip ${r.clip_code}: server khởi động lại trong lúc dựng v${r.version}` });
    }
    return rows.length;
  });
}

