/** Dựng các đoạn trong cùng slot hàng đợi của MP4 tổng; không enqueue con để tránh khóa chờ. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { parseJson } from '../repo.js';
import { ffmpegOf, ffprobeOf } from '../media.js';
import { getVersionById, type HtmlVersionRow } from './repo.js';
import { listSegments } from './segments.js';
import { assembleSegments } from './segment-media.js';
import type { HtmlEngine } from './render.js';
import type { HtmlAspect, HtmlQuality } from './view.js';
import type { VoiceSnapshot } from './voice.js';

async function hashFile(file: string) {
  const h = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest('hex');
}
export async function renderSegments(
  ctx: AppContext,
  owner: HtmlVersionRow,
  eng: HtmlEngine,
  o: {
    workDir: string;
    outPath: string;
    aspect: HtmlAspect;
    quality: HtmlQuality;
    width: number;
    height: number;
    signal: AbortSignal;
    onProgress: (pct: number) => void;
  },
) {
  const rows = listSegments(ctx, owner.id),
    warnings: string[] = [],
    parts: { path: string; start_s: number; end_s: number }[] = [];
  if (!rows.length || rows.some((s) => s.status !== 'ready' || !s.segment_version_id))
    throw new AppError('HTML_SEGMENT_NOT_READY', 'Các đoạn chưa hoàn tất', 409);
  const ffmpeg = await ffmpegOf(ctx.config),
    ffprobe = await ffprobeOf(ctx.config);
  if (!ffmpeg || !ffprobe) throw new AppError('HTML_RENDER_FAILED', 'Thiếu FFmpeg/ffprobe', 500);
  for (const [i, row] of rows.entries()) {
    o.signal.throwIfAborted();
    const child = getVersionById(ctx, row.segment_version_id!);
    const source = crypto
      .createHash('sha256')
      .update(JSON.stringify([child.content_hash, o.aspect, o.quality, row.end_s - row.start_s, 30]))
      .digest('hex');
    const cache = ctx.db.prepare('SELECT * FROM html_segment_renders WHERE segment_version_id=? AND quality=?').get(child.id, o.quality) as
      | { source_hash: string; video_path: string; video_hash: string }
      | undefined;
    let video = cache ? path.join(ctx.config.rootDir, cache.video_path) : '';
    const valid = cache?.source_hash === source && fs.existsSync(video) && (await hashFile(video)) === cache.video_hash;
    if (!valid) {
      const work = path.join(o.workDir, `segment-${row.idx}`);
      fs.mkdirSync(work, { recursive: true });
      await eng.materialize(path.join(ctx.config.rootDir, child.files_dir!), work, { mode: 'render' });
      const tmp = path.join(o.workDir, `segment-${row.idx}.mp4`);
      const result = await eng.runRender(ctx, {
        workDir: work,
        outPath: tmp,
        aspect: o.aspect,
        quality: o.quality,
        durationS: row.end_s - row.start_s,
        workers: 1,
        signal: o.signal,
        onProgress: (p) => o.onProgress(((i + p / 100) / rows.length) * 90),
      });
      warnings.push(...result.warnings);
      o.signal.throwIfAborted();
      // Hai version có thể cùng dùng một đoạn. Cache mới có tên riêng để không ghi đè file đang được concat.
      const rel = `${owner.files_dir}/../../segment-cache/${child.id}-${source}-${o.quality}-${crypto.randomUUID()}.mp4`;
      video = path.resolve(ctx.config.rootDir, rel);
      fs.mkdirSync(path.dirname(video), { recursive: true });
      const hash = await hashFile(tmp);
      fs.copyFileSync(tmp, video);
      ctx.db
        .prepare(
          `INSERT INTO html_segment_renders(segment_version_id,quality,source_hash,video_path,video_hash,duration_s,settings_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(segment_version_id,quality) DO UPDATE SET source_hash=excluded.source_hash,video_path=excluded.video_path,video_hash=excluded.video_hash,duration_s=excluded.duration_s,settings_json=excluded.settings_json,updated_at=excluded.updated_at`,
        )
        .run(
          child.id,
          o.quality,
          source,
          path.relative(ctx.config.rootDir, video).split(path.sep).join('/'),
          hash,
          row.end_s - row.start_s,
          JSON.stringify({ aspect: o.aspect, width: o.width, height: o.height, fps: 30 }),
          ctx.now(),
        );
    }
    parts.push({ path: video, start_s: row.start_s, end_s: row.end_s });
    o.onProgress(((i + 1) / rows.length) * 90);
  }
  const voice = parseJson<VoiceSnapshot | null>(owner.voice_json ?? null, null);
  await assembleSegments({
    ffmpeg,
    ffprobe,
    parts,
    totalS: rows.at(-1)!.end_s,
    width: o.width,
    height: o.height,
    voice: voice ? path.join(ctx.config.rootDir, owner.files_dir!, voice.path) : undefined,
    out: o.outPath,
    tempDir: path.join(o.workDir, 'concat'),
    signal: o.signal,
  });
  o.onProgress(99);
  return { warnings };
}
