/**
 * Asset (ảnh/video/nhạc) người dùng tải lên dự án Video HTML (plan mục 9). Nhận theo LUỒNG xuống file tạm (không giữ cả file trong RAM), nhận diện loại
 * bằng magic bytes (không tin tên/đuôi/Content-Type), đọc kích thước ảnh từ header, ffprobe video/nhạc, rồi đổi tên nguyên tử thành
 * `output/<slug>/html/assets/<sha256 8 ký tự>-<id>.<ext>`. Tên người dùng chỉ là nhãn. Trần: ảnh 20 MB, video/nhạc 200 MB, 1 GB mỗi dự án.
 * Phiên bản chụp asset bằng hard link (dự phòng copy) vào `<phiên bản>/assets/u/<id>.<ext>` nên xoá/sửa asset gốc không phá bản cũ.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { drainRequest } from '../../lib/video-upload.js';
import { ffprobeOf, probeMedia } from '../media.js';
import { logEvent } from '../repo.js';
import { assetsDirRel, incomingDirRel, mediaEnv } from './config.js';
import { getHtmlAsset, getHtmlProject, listVersionAssets, projectAssets, type HtmlAssetRow } from './repo.js';
import { assetView, extOf, type HtmlAssetView } from './view.js';

export const ASSET_LIMITS = {
  imageBytes: 20 * 1024 * 1024,
  mediaBytes: 200 * 1024 * 1024,
  projectBytes: 1024 * 1024 * 1024,
  /** Ảnh lớn hơn thế này (điểm ảnh) có thể làm trình duyệt dựng hết RAM. */
  maxPixels: 64_000_000,
  maxSide: 12_000,
} as const;

export interface Sniffed {
  kind: 'image' | 'video' | 'audio';
  ext: string;
  mime: string;
}

/** Nhận diện từ ~64 byte đầu. null = không thuộc loại hỗ trợ. */
export function sniffAsset(h: Buffer): Sniffed | null {
  const ascii = (a: number, b: number) => h.subarray(a, b).toString('latin1');
  if (h.length >= 8 && h[0] === 0x89 && ascii(1, 4) === 'PNG' && h[4] === 0x0d && h[5] === 0x0a && h[6] === 0x1a && h[7] === 0x0a) return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (h.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', ext: 'webp', mime: 'image/webp' };
  if (h.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { kind: 'image', ext: 'gif', mime: 'image/gif' };
  if (h.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'qt  ') return { kind: 'video', ext: 'mov', mime: 'video/quicktime' };
    if (brand === 'M4A ' || brand === 'M4B ') return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
    return { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
  }
  if (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return ascii(0, h.length).includes('webm') ? { kind: 'video', ext: 'webm', mime: 'video/webm' } : null; // mkv bị loại
  if (h.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { kind: 'audio', ext: 'wav', mime: 'audio/wav' };
  if (h.length >= 4 && ascii(0, 4) === 'OggS') return { kind: 'audio', ext: 'ogg', mime: 'audio/ogg' };
  if (h.length >= 3 && ascii(0, 3) === 'ID3') return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
  if (h.length >= 2 && h[0] === 0xff) {
    if ((h[1]! & 0xf6) === 0xf0) return { kind: 'audio', ext: 'aac', mime: 'audio/aac' };
    if ((h[1]! & 0xe0) === 0xe0 && ((h[1]! >> 1) & 3) !== 0) return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
  }
  return null;
}

/** Kích thước ảnh từ header (png/jpeg/webp/gif); `buf` là phần đầu file (≥ vài chục KB cho jpeg có EXIF lớn). null nếu không đọc được. */
export function imageSize(buf: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === 'png') return buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR' ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
    if (ext === 'gif') return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
    if (ext === 'webp') {
      const fmt = buf.toString('latin1', 12, 16);
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const m = buf[i + 1]!;
        if (m === 0xff) {
          i++;
          continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {
    /* header cụt */
  }
  return null;
}

/** Cổng kiểm tra giữa luồng multipart và file: đếm byte, nhận diện loại từ 64 byte đầu, áp trần theo loại và trần còn lại của dự án, tính sha256. */
class AssetGate extends Transform {
  bytes = 0;
  sniffed: Sniffed | null = null;
  sha256 = '';
  private head = Buffer.alloc(0);
  private limit = 0;
  private readonly hash = crypto.createHash('sha256');
  constructor(private readonly projectRemaining: number) {
    super();
  }

  private decide(): AppError | null {
    this.sniffed = sniffAsset(this.head);
    if (!this.sniffed) return new AppError('UNSUPPORTED_FILE_TYPE', 'File không phải ảnh (png, jpg, webp, gif), video (mp4, mov, webm) hoặc nhạc (mp3, wav, m4a, aac, ogg)', 415);
    this.limit = Math.min(this.sniffed.kind === 'image' ? ASSET_LIMITS.imageBytes : ASSET_LIMITS.mediaBytes, this.projectRemaining);
    return this.bytes > this.limit ? this.tooLarge() : null;
  }
  private tooLarge(): AppError {
    const k = this.sniffed!.kind;
    const cap = k === 'image' ? ASSET_LIMITS.imageBytes : ASSET_LIMITS.mediaBytes;
    return this.limit < cap
      ? new AppError('PROJECT_ASSET_QUOTA', 'Dự án đã đạt giới hạn 1 GB asset; hãy xoá bớt asset không dùng', 413)
      : new AppError('FILE_TOO_LARGE', `${k === 'image' ? 'Ảnh' : k === 'video' ? 'Video' : 'File âm thanh'} quá lớn (tối đa ${cap / 1024 / 1024} MB)`, 413);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (!this.sniffed) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, 64 - this.head.length)]);
      if (this.head.length >= 64) {
        const err = this.decide();
        if (err) return cb(err);
      } else if (this.bytes > ASSET_LIMITS.imageBytes) return cb(new AppError('UNSUPPORTED_FILE_TYPE', 'File không hợp lệ', 415));
    } else if (this.bytes > this.limit) return cb(this.tooLarge());
    this.hash.update(chunk);
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    if (!this.sniffed) {
      const err = this.head.length ? this.decide() : new AppError('UNSUPPORTED_FILE_TYPE', 'File rỗng', 415);
      if (err) return cb(err);
    }
    this.sha256 = this.hash.digest('hex');
    cb();
  }
}

const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/]+/g, '_').trim().slice(0, 120);

function probeAudio(ffprobe: string, abs: string): Promise<{ duration_s: number } | null> {
  return new Promise((resolve) => {
    execFile(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true, env: mediaEnv() }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; duration?: string }[] };
        if (!j.streams?.some((s) => s.codec_type === 'audio')) return resolve(null);
        const d = Number(j.format?.duration ?? j.streams.find((s) => s.codec_type === 'audio')?.duration);
        resolve(Number.isFinite(d) && d > 0 ? { duration_s: Math.round(d * 1000) / 1000 } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * `POST /lan/api/html-projects/:id/assets` (multipart, một file/lần, trường `file`). Ném 400/404/413/415. Trả asset đã lưu.
 * Giữ `ctx.beginProjectUpload` suốt lúc ghi để dự án không bị xoá giữa chừng.
 */
export async function uploadHtmlAsset(ctx: AppContext, req: FastifyRequest, projectId: number): Promise<HtmlAssetView> {
  const project = getHtmlProject(ctx, projectId);
  if (!req.isMultipart()) throw badRequest('BAD_REQUEST', 'Cần gửi multipart/form-data với trường "file"');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > ASSET_LIMITS.mediaBytes + 256 * 1024) throw new AppError('FILE_TOO_LARGE', 'File quá lớn (tối đa 200 MB)', 413);
  const used = (ctx.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM html_assets WHERE project_id = ?').get(projectId) as { b: number }).b;
  const remaining = ASSET_LIMITS.projectBytes - used;
  if (remaining <= 0) throw new AppError('PROJECT_ASSET_QUOTA', 'Dự án đã đạt giới hạn 1 GB asset; hãy xoá bớt asset không dùng', 413);
  const release = ctx.beginProjectUpload(projectId);
  const incoming = path.join(ctx.config.rootDir, incomingDirRel(project.slug));
  fs.mkdirSync(incoming, { recursive: true });
  const tmpAbs = path.join(incoming, `.up-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    let got: { gate: AssetGate; name: string } | null = null;
    try {
      const parts = req.parts({ limits: { fileSize: ASSET_LIMITS.mediaBytes, files: 1, fields: 4, fieldSize: 1024, parts: 6 } });
      for await (const part of parts) {
        if (part.type === 'field') continue;
        if (got) throw badRequest('VALIDATION_ERROR', 'Mỗi lần chỉ tải lên một file');
        const gate = new AssetGate(remaining);
        try {
          await pipeline(part.file, gate, fs.createWriteStream(tmpAbs, { flags: 'wx', mode: 0o600 }));
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError('FILE_TOO_LARGE', 'File quá lớn (tối đa 200 MB)', 413);
          throw err;
        }
        if (part.file.truncated) throw new AppError('FILE_TOO_LARGE', 'File quá lớn (tối đa 200 MB)', 413);
        got = { gate, name: cleanName(part.filename ?? '') || 'asset' };
      }
    } catch (err) {
      drainRequest(req);
      throw err;
    }
    if (!got) throw badRequest('NO_FILE', 'Không có file nào được gửi lên');
    const { gate, name } = got;
    const kind = gate.sniffed!;

    let width: number | null = null;
    let height: number | null = null;
    let duration: number | null = null;
    let hasAudio: boolean | null = null;
    if (kind.kind === 'image') {
      const fd = fs.openSync(tmpAbs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(gate.bytes, 4 * 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, 0);
        const sz = imageSize(buf, kind.ext);
        if (!sz || sz.width < 1 || sz.height < 1) throw new AppError('INVALID_IMAGE', 'Không đọc được kích thước ảnh (file hỏng?)', 415);
        if (sz.width > ASSET_LIMITS.maxSide || sz.height > ASSET_LIMITS.maxSide || sz.width * sz.height > ASSET_LIMITS.maxPixels) throw new AppError('IMAGE_TOO_LARGE', 'Ảnh có kích thước quá lớn (tối đa 12000 điểm mỗi cạnh, 64 megapixel)', 413);
        ({ width, height } = sz);
      } finally {
        fs.closeSync(fd);
      }
    } else if (kind.kind === 'video') {
      const info = await probeMedia(ctx.config, tmpAbs);
      if (!info || !info.width || !info.height || !info.duration_s) throw new AppError('INVALID_MEDIA', 'Không đọc được video (file hỏng hoặc thiếu ffprobe)', 415);
      width = info.width;
      height = info.height;
      duration = Math.round(info.duration_s * 1000) / 1000;
      hasAudio = info.has_audio;
    } else {
      const bin = await ffprobeOf(ctx.config);
      const info = bin ? await probeAudio(bin, tmpAbs) : null;
      if (!info) throw new AppError('INVALID_MEDIA', 'Không đọc được file âm thanh (file hỏng hoặc thiếu ffprobe)', 415);
      duration = info.duration_s;
      hasAudio = true;
    }

    const id = ctx.tx(() => {
      getHtmlProject(ctx, projectId); // dự án có thể đã bị xoá trong lúc tải
      const total = (ctx.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM html_assets WHERE project_id = ?').get(projectId) as { b: number }).b;
      if (total + gate.bytes > ASSET_LIMITS.projectBytes) throw new AppError('PROJECT_ASSET_QUOTA', 'Dự án đã đạt giới hạn 1 GB asset; hãy xoá bớt asset không dùng', 413);
      const info = ctx.db
        .prepare(
          `INSERT INTO html_assets (project_id, original_name, stored_path, content_hash, kind, media_type, bytes, width, height, duration_s, has_audio, created_at)
           VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, name, gate.sha256, kind.kind, kind.mime, gate.bytes, width, height, duration, hasAudio === null ? null : hasAudio ? 1 : 0, ctx.now());
      const newId = Number(info.lastInsertRowid);
      const rel = `${assetsDirRel(project.slug)}/${gate.sha256.slice(0, 8)}-${newId}.${kind.ext}`;
      fs.mkdirSync(path.dirname(path.join(ctx.config.rootDir, rel)), { recursive: true });
      fs.renameSync(tmpAbs, path.join(ctx.config.rootDir, rel)); // nguyên tử (cùng ổ đĩa); lỗi → rollback dòng DB
      ctx.db.prepare('UPDATE html_assets SET stored_path = ? WHERE id = ?').run(rel, newId);
      logEvent(ctx, { project_id: projectId, type: 'html.asset_added', message: `Thêm asset ${kind.kind} "${name}" (${gate.bytes} byte)` });
      return newId;
    });
    return assetView(getHtmlAsset(ctx, projectId, id));
  } finally {
    fs.rmSync(tmpAbs, { force: true });
    release();
  }
}

export function listHtmlAssets(ctx: AppContext, projectId: number): HtmlAssetView[] {
  getHtmlProject(ctx, projectId);
  return projectAssets(ctx, projectId).map(assetView);
}

/** Xoá asset gốc. Chặn khi một phiên bản đang composing/validating còn dùng nó (cần file lúc công bố). Bản đã công bố có bản chụp riêng nên không ảnh hưởng. */
export function deleteHtmlAsset(ctx: AppContext, projectId: number, assetId: number): void {
  let rel = '';
  ctx.tx(() => {
    getHtmlProject(ctx, projectId);
    const a = getHtmlAsset(ctx, projectId, assetId);
    if (ctx.db.prepare('SELECT project_id FROM html_voice WHERE project_id=? AND asset_id=?').get(projectId, assetId)) throw conflict('VOICE_IN_USE', 'Bỏ chọn lời đọc hoặc hủy nhận dạng trước khi xoá file này');
    const busy = ctx.db
      .prepare(
        `SELECT v.version FROM html_version_assets va JOIN html_versions v ON v.id = va.version_id
         WHERE va.asset_ref = ? AND v.project_id = ? AND v.status IN ('composing','validating') ORDER BY v.version LIMIT 1`,
      )
      .get(assetId, projectId) as { version: number } | undefined;
    if (busy) throw conflict('ASSET_IN_USE', `Asset đang được phiên bản v${busy.version} (đang tạo) sử dụng; hãy đợi xong hoặc hủy phiên bản đó trước khi xoá`);
    ctx.db.prepare('DELETE FROM html_assets WHERE id = ?').run(assetId);
    logEvent(ctx, { project_id: projectId, type: 'html.asset_deleted', message: `Xoá asset "${a.original_name}"` });
    rel = a.stored_path;
  });
  // file gốc: hard link của các bản đã công bố giữ nội dung sống
  try {
    fs.rmSync(path.join(ctx.config.rootDir, rel), { force: true });
  } catch {
    /* file đang mở: để dọn sau, không ảnh hưởng nghiệp vụ */
  }
}

/** Đường dẫn tuyệt đối của file asset gốc (để phục vụ xem/tải); null nếu file không còn. */
export function assetFileAbs(ctx: AppContext, a: HtmlAssetRow): string | null {
  const abs = path.join(ctx.config.rootDir, a.stored_path);
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Chụp asset của phiên bản vào `<dir>/assets/u/<asset_id>.<ext>` (hard link, dự phòng copy). `dir` là staging chưa công bố.
 * Trả danh sách `{asset_id, rel}` (rel tương đối từ gốc phiên bản) để điền `snapshot_path` sau khi rename.
 */
export function snapshotVersionAssets(ctx: AppContext, versionId: number, dir: string): { asset_id: number; rel: string; content_hash: string }[] {
  const out: { asset_id: number; rel: string; content_hash: string }[] = [];
  for (const a of listVersionAssets(ctx, versionId)) {
    const src = path.isAbsolute(a.stored_path) ? a.stored_path : path.join(ctx.config.rootDir, a.stored_path);
    const rel = `assets/u/${a.asset_id}${extOf(a.stored_path)}`;
    const dest = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(src)) throw new AppError('ASSET_MISSING', `File asset #${a.asset_id} không còn trên đĩa`, 409);
    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    }
    out.push({ asset_id: a.asset_id, rel, content_hash: a.content_hash });
  }
  return out;
}
