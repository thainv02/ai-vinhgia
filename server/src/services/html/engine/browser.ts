/**
 * Thành phần trình duyệt dựng video: chrome-headless-shell 152.0.7977.30 (win64) ghim URL + SHA256 + kích thước (spike §3).
 * KHÔNG tự tải: chỉ khi người dùng bấm trong Cài đặt. Tải vào `.part` (tiếp tục được bằng Range), kiểm SHA256, giải nén bằng tar.exe của Windows
 * vào thư mục tạm rồi đổi tên, ghi manifest CUỐI CÙNG. Trạng thái = manifest + exe tồn tại. Env `HTML_RENDERER_BROWSER` (đường dẫn exe) dùng cho dev/test.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../../context.js';
import { AppError } from '../../../lib/errors.js';

export interface BrowserPin {
  version: string;
  url: string;
  sha256: string;
  /** Kích thước file zip (byte). */
  bytes: number;
  /** Dung lượng sau giải nén (byte). */
  diskBytes: number;
  /** Đường dẫn exe trong thư mục giải nén (posix). */
  exe: string;
}

export const BROWSER_PIN: BrowserPin = {
  version: '152.0.7977.30',
  url: 'https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.30/win64/chrome-headless-shell-win64.zip',
  sha256: '5d7df999a6e4a65a1b16b25b61064f7337b8aa8ee2ed1b4e07bfdd24f6e4275e',
  bytes: 119_527_247,
  diskBytes: 281_669_281,
  exe: 'chrome-headless-shell-win64/chrome-headless-shell.exe',
};

export interface HtmlRendererStatus {
  installed: boolean;
  version: string;
  path?: string;
  /** 'env' = HTML_RENDERER_BROWSER (dev/test), 'managed' = bản app tải. */
  source?: 'env' | 'managed';
  download_bytes: number;
  disk_bytes: number;
  download: { state: 'idle' | 'downloading' | 'done' | 'failed' | 'cancelled'; received: number; total: number; error?: string };
}

export const RENDERER_MISSING_MSG = 'Chưa có bộ dựng Video HTML trên máy này. Vào Cài đặt > Bộ dựng Video HTML để tải (khoảng 120 MB).';
const MANIFEST = 'manifest.json';

export const rendererVersionDir = (baseDir: string, pin: BrowserPin = BROWSER_PIN): string => path.join(baseDir, pin.version);
const exeOf = (baseDir: string, pin: BrowserPin = BROWSER_PIN): string => path.join(rendererVersionDir(baseDir, pin), ...pin.exe.split('/'));

/** Đường dẫn exe nếu đã cài đủ (manifest + exe tồn tại), ngược lại null. Không xét env. */
export function installedBrowser(baseDir: string, pin: BrowserPin = BROWSER_PIN): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(rendererVersionDir(baseDir, pin), MANIFEST), 'utf8')) as { version?: string; sha256?: string };
    if (m.version !== pin.version || m.sha256 !== pin.sha256) return null;
    const exe = exeOf(baseDir, pin);
    return fs.statSync(exe).isFile() ? exe : null;
  } catch {
    return null;
  }
}

function envBrowser(): string | null {
  const p = process.env.HTML_RENDERER_BROWSER?.trim();
  return p && fs.existsSync(p) ? path.resolve(p) : null;
}

// ---------------------------------------------------------------- tải

export class RendererDownloadError extends Error {}

export interface DownloadOpts {
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  fetchImpl?: typeof fetch;
  pin?: BrowserPin;
  /** Ghi đè lệnh giải nén (test). Mặc định tar.exe của Windows. */
  extract?: (zip: string, destDir: string) => Promise<void>;
}

export function extractZip(zip: string, dest: string): Promise<void> {
  // bsdtar của Windows (tar của Git Bash hiểu `E:` là tên máy)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 5 * 60_000, maxBuffer: 1 << 20 }, (err, _o, stderr) => {
      if (err) reject(new RendererDownloadError(`Giải nén thất bại: ${(stderr || err.message).toString().slice(0, 300)}`));
      else resolve();
    });
  });
}

/** Tải + kiểm + giải nén + ghi manifest. Hủy bằng `signal` giữ lại `.part` để tải tiếp lần sau. Idempotent nếu đã cài đủ. */
export async function downloadBrowser(baseDir: string, opts: DownloadOpts = {}): Promise<string> {
  const pin = opts.pin ?? BROWSER_PIN;
  const done = installedBrowser(baseDir, pin);
  if (done) return done;
  const doFetch = opts.fetchImpl ?? fetch;
  const dlDir = path.join(baseDir, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  try {
    const st = fs.statfsSync(dlDir);
    const need = pin.bytes + pin.diskBytes;
    if (Number(st.bavail) * Number(st.bsize) < need) throw new RendererDownloadError(`Không đủ chỗ trống trên ổ đĩa (cần khoảng ${Math.ceil(need / 1e6)} MB)`);
  } catch (e) {
    if (e instanceof RendererDownloadError) throw e; // statfs lỗi: bỏ qua kiểm tra
  }
  const part = path.join(dlDir, `${pin.version}.zip.part`);
  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch {
    /* chưa có */
  }
  if (have > pin.bytes) {
    fs.rmSync(part, { force: true });
    have = 0;
  }
  let hash = crypto.createHash('sha256');
  if (have > 0) hash.update(fs.readFileSync(part)); // tiếp tục: băm phần đã có (tối đa ~120 MB)
  let res: Response;
  try {
    res = await doFetch(pin.url, { signal: opts.signal, redirect: 'follow', headers: have > 0 ? { Range: `bytes=${have}-` } : undefined });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new RendererDownloadError(`Không kết nối được để tải bộ dựng (${e instanceof Error ? e.message : String(e)})`);
  }
  if (have > 0 && res.status === 200) {
    // server bỏ qua Range: dùng luôn phản hồi đầy đủ, ghi lại từ đầu
    have = 0;
    hash = crypto.createHash('sha256');
  }
  if (!(res.ok || res.status === 206) || !res.body) throw new RendererDownloadError(`Tải bộ dựng thất bại: HTTP ${res.status}`);
  return finish(res, have, hash);

  async function finish(r: Response, from: number, h: crypto.Hash): Promise<string> {
    const out = fs.createWriteStream(part, { flags: from > 0 ? 'a' : 'w' });
    let got = from;
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        h.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((ok) => out.once('drain', () => ok()));
        opts.onProgress?.(got, pin.bytes);
      }
      await new Promise<void>((ok, bad) => out.end((err?: Error | null) => (err ? bad(err) : ok())));
    } catch (e) {
      await new Promise<void>((ok) => out.end(() => ok())); // ghi nốt phần đã nhận để tải tiếp được
      if (opts.signal?.aborted) throw e; // giữ .part để tải tiếp
      throw new RendererDownloadError(`Mất kết nối khi tải bộ dựng (${e instanceof Error ? e.message : String(e)})`);
    }
    const digest = h.digest('hex');
    if (got !== pin.bytes || digest !== pin.sha256) {
      fs.rmSync(part, { force: true });
      throw new RendererDownloadError(`File bộ dựng tải về không đúng (kích thước ${got}/${pin.bytes} byte hoặc sai SHA256); đã xoá, hãy thử tải lại`);
    }
    if (opts.signal?.aborted) throw new DOMException('Đã huỷ', 'AbortError');
    // giải nén vào thư mục tạm cạnh đích rồi đổi tên
    const tmp = path.join(baseDir, `.extract-${pin.version}-${process.pid}-${Date.now()}`);
    const dest = rendererVersionDir(baseDir, pin);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await (opts.extract ?? extractZip)(part, tmp);
      if (!fs.existsSync(path.join(tmp, ...pin.exe.split('/')))) throw new RendererDownloadError('Gói giải nén không có chrome-headless-shell.exe');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify({ version: pin.version, sha256: pin.sha256, bytes: pin.bytes, installed_at: new Date().toISOString() }, null, 2));
    fs.rmSync(part, { force: true });
    return exeOf(baseDir, pin);
  }
}

// ---------------------------------------------------------------- lớp điều khiển (giống STT: trạng thái trong bộ nhớ + abort)

interface Dl {
  state: 'downloading' | 'done' | 'failed' | 'cancelled';
  received: number;
  total: number;
  error: string | null;
  abort: AbortController;
}
const downloads = new Map<string, Dl>();

export function rendererStatus(ctx: AppContext): HtmlRendererStatus {
  const dir = ctx.config.htmlRendererDir;
  const env = envBrowser();
  const managed = installedBrowser(dir);
  const d = downloads.get(dir);
  const p = env ?? managed;
  return {
    installed: !!p,
    version: BROWSER_PIN.version,
    ...(p ? { path: p, source: env ? ('env' as const) : ('managed' as const) } : {}),
    download_bytes: BROWSER_PIN.bytes,
    disk_bytes: BROWSER_PIN.diskBytes,
    download: d ? { state: d.state, received: d.received, total: d.total, ...(d.error ? { error: d.error } : {}) } : { state: 'idle', received: 0, total: BROWSER_PIN.bytes },
  };
}

/** Đường dẫn exe trình duyệt; ném 409 HTML_RENDERER_MISSING nếu chưa cài. */
export function browserPath(ctx: AppContext): string {
  const p = envBrowser() ?? installedBrowser(ctx.config.htmlRendererDir);
  if (!p) throw new AppError('HTML_RENDERER_MISSING', RENDERER_MISSING_MSG, 409);
  return p;
}

/** Bắt đầu tải nền (không làm gì nếu đã cài hoặc đang tải). Không bao giờ gọi tự động. */
export function startRendererDownload(ctx: AppContext, over: Partial<DownloadOpts> = {}): Promise<void> {
  const dir = ctx.config.htmlRendererDir;
  if (downloads.get(dir)?.state === 'downloading' || installedBrowser(dir, over.pin)) return Promise.resolve();
  const d: Dl = { state: 'downloading', received: 0, total: (over.pin ?? BROWSER_PIN).bytes, error: null, abort: new AbortController() };
  downloads.set(dir, d);
  return downloadBrowser(dir, { ...over, signal: d.abort.signal, onProgress: (r, t) => ((d.received = r), (d.total = t)) }).then(
    () => void (d.state = 'done'),
    (e: unknown) => {
      if (d.abort.signal.aborted) d.state = 'cancelled';
      else {
        d.state = 'failed';
        d.error = e instanceof RendererDownloadError ? e.message : `Tải bộ dựng thất bại: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  );
}

export function cancelRendererDownload(ctx: AppContext): void {
  downloads.get(ctx.config.htmlRendererDir)?.abort.abort();
}
