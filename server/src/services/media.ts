import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_DIR, type Config } from '../config.js';

/** Ứng viên đường dẫn ffmpeg/ffprobe theo hệ điều hành, theo thứ tự ưu tiên. */
export function binaryCandidates(name: 'ffmpeg' | 'ffprobe', configured: string | null | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const list: (string | null | undefined)[] = [configured];
  if (platform === 'win32') {
    list.push(path.join(APP_DIR, 'bin', `${name}.exe`), name);
  } else if (platform === 'darwin') {
    list.push(name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  } else {
    list.push(name, `/usr/local/bin/${name}`);
  }
  return list.filter((c): c is string => !!c);
}

const abortError = (): Error => {
  const e = new Error('Đã huỷ');
  e.name = 'AbortError';
  return e;
};

/** Chạy `bin args` không qua shell; true nếu thoát mã 0. Quá `timeoutMs` thì kill và coi là lỗi. Không chặn event loop. */
function runOk(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

const binCache = new Map<string, Promise<string | null>>();

/**
 * Tìm ffmpeg/ffprobe: đường dẫn cấu hình → (Windows) bin/ cạnh app → PATH → (macOS) Homebrew.
 * Bất đồng bộ; kết quả được nhớ lại (kể cả "không có"), nhiều nơi gọi cùng lúc dùng chung một lần dò.
 */
export function resolveBinary(name: 'ffmpeg' | 'ffprobe', configured: string | null | undefined): Promise<string | null> {
  const key = `${name}|${configured ?? ''}`;
  let p = binCache.get(key);
  if (!p) {
    p = (async () => {
      for (const c of binaryCandidates(name, configured)) {
        if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
        if (await runOk(c, ['-version'], 8000)) return c;
      }
      return null;
    })();
    binCache.set(key, p);
  }
  return p;
}

export const ffmpegOf = (config: Pick<Config, 'ffmpegPath'>): Promise<string | null> => resolveBinary('ffmpeg', config.ffmpegPath);
export const ffprobeOf = (config: Pick<Config, 'ffprobePath'>): Promise<string | null> => resolveBinary('ffprobe', config.ffprobePath);

/** Dò sẵn cả hai binary (gọi sau khi server đã listen) để request đầu tiên không phải chờ. */
export async function warmMediaBinaries(config: Pick<Config, 'ffmpegPath' | 'ffprobePath'>): Promise<void> {
  await Promise.all([ffmpegOf(config), ffprobeOf(config)]);
}

export interface MediaInfo {
  duration_s: number | null;
  width: number | null;
  height: number | null;
  /** fps dạng số thực và phân số (vd 24/1, 30000/1001). */
  fps: number | null;
  fps_num: number | null;
  fps_den: number | null;
  has_audio: boolean;
}

const probeCache = new Map<string, MediaInfo | null>();

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** CHỈ DÙNG TRONG TEST: thay lệnh ffprobe (vd node.exe + script giả) và thời hạn; mặc định không đặt. */
export const __testOverrides: { probe?: { bin: string; prefixArgs: string[] } | null; timeoutMs?: number } = {};

const MAX_PROBES = 2;
let activeProbes = 0;
const probeQueue: (() => void)[] = [];

/** Xin một suất chạy ffprobe (tối đa MAX_PROBES cùng lúc); bỏ khỏi hàng đợi nếu bị huỷ. */
function acquireProbeSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  const release = () => {
    activeProbes--;
    probeQueue.shift()?.();
  };
  if (activeProbes < MAX_PROBES) {
    activeProbes++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener('abort', onAbort);
      activeProbes++;
      resolve(release);
    };
    const onAbort = () => {
      const i = probeQueue.indexOf(start);
      if (i >= 0) probeQueue.splice(i, 1);
      reject(abortError());
    };
    probeQueue.push(start);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Chạy ffprobe, trả stdout hoặc null (lỗi/hết giờ/không chạy được). Bị huỷ → kill con và ném AbortError. */
function runProbe(bin: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let out = '';
    let tooBig = false;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, __testOverrides.timeoutMs ?? 20_000);
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      out += d;
      if (out.length > 8 * 1024 * 1024) {
        tooBig = true;
        child.kill();
      }
    });
    child.on('error', () => settle(() => resolve(null)));
    // Chờ 'close' để chắc chắn tiến trình con đã thoát trước khi báo kết quả
    child.on('close', (code) =>
      settle(() => {
        if (aborted || signal?.aborted) return reject(abortError());
        resolve(code === 0 && !timedOut && !tooBig ? out : null);
      }),
    );
    if (signal?.aborted) onAbort();
  });
}

/**
 * Đọc thông tin media bằng ffprobe (có cache theo đường dẫn + size + mtime). null nếu không đọc được.
 * Bất đồng bộ, tối đa 2 ffprobe chạy cùng lúc; `opts.signal` huỷ → ném Error có name === 'AbortError'.
 */
export async function probeMedia(config: Pick<Config, 'ffprobePath'>, abs: string, opts: { signal?: AbortSignal } = {}): Promise<MediaInfo | null> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  let key: string;
  try {
    const st = await fs.promises.stat(abs);
    key = `${abs}|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }
  if (probeCache.has(key)) return probeCache.get(key) ?? null;
  const ov = __testOverrides.probe;
  const bin = ov ? ov.bin : await ffprobeOf(config);
  if (signal?.aborted) throw abortError();
  let info: MediaInfo | null = null;
  if (bin) {
    const release = await acquireProbeSlot(signal);
    let stdout: string | null;
    try {
      stdout = await runProbe(bin, [...(ov?.prefixArgs ?? []), '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], signal);
    } finally {
      release();
    }
    if (stdout !== null) {
      try {
        const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Record<string, unknown>[] };
        const v = j.streams?.find((s) => s.codec_type === 'video');
        if (v) {
          const [n, d] = String(v.r_frame_rate ?? '').split('/').map(Number);
          const fpsNum = n && Number.isFinite(n) ? n : null;
          const fpsDen = d && Number.isFinite(d) ? d : 1;
          info = {
            duration_s: num(j.format?.duration) ?? num(v.duration),
            width: num(v.width),
            height: num(v.height),
            fps: fpsNum ? fpsNum / fpsDen : null,
            fps_num: fpsNum,
            fps_den: fpsNum ? fpsDen : null,
            has_audio: !!j.streams?.some((s) => s.codec_type === 'audio'),
          };
        }
      } catch {
        info = null;
      }
    }
  }
  // Chỉ nhớ kết quả đọc được: null có thể do hết giờ khi máy đang bận (vd đang render), lần sau phải probe lại
  if (info) {
    if (probeCache.size > 500) probeCache.clear();
    probeCache.set(key, info);
  }
  return info;
}
