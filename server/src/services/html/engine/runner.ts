/**
 * Phía server của tiến trình dựng/chụp: tạo thư mục tạm riêng cho job, env TỐI THIỂU (không AI_API_KEY/WORKER_TOKEN), spawn `engine-runner`,
 * đọc tiến độ `@@HF {json}`, timeout, hủy = killTree + CHỜ tiến trình thoát, luôn xoá thư mục tạm. Mọi hàm chạy 1 tiến trình con cho 1 việc.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../../../context.js';
import { APP_DIR } from '../../../config.js';
import { AppError } from '../../../lib/errors.js';
import { killTree } from '../../final-render/watermark.js';
import { ffmpegOf, ffprobeOf } from '../../media.js';
import type { RunnerCommand } from '../engine-runner.js';
import type { HtmlAspect, HtmlQuality } from '../view.js';
import { browserPath } from './browser.js';
import { outputResolutionOf } from './constants.js';

/** Tên lệnh trần (vd "ffmpeg" tìm thấy qua PATH) → đường dẫn tuyệt đối: env tối thiểu của tiến trình con không có PATH của người dùng. */
export function absoluteBinary(bin: string, sys: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(bin)) return bin;
  const exts = process.platform === 'win32' ? (sys.PATHEXT ?? '.EXE;.CMD').split(';').concat('') : [''];
  for (const dir of (sys.PATH ?? sys.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const f = path.join(dir, bin + e);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        /* thử tiếp */
      }
    }
  }
  return bin;
}

/** Lệnh chạy runner: bản build `server/html-runner.mjs`; repo dev chạy mã nguồn bằng tsx. */
export function runnerCommand(appDir = APP_DIR): { bin: string; args: string[]; cwd: string } {
  const bundled = path.join(appDir, 'server', 'html-runner.mjs');
  if (fs.existsSync(bundled)) return { bin: process.execPath, args: [bundled], cwd: path.dirname(bundled) };
  const source = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'engine-runner.ts');
  return { bin: process.execPath, args: ['--import', 'tsx', source], cwd: path.dirname(source) };
}

export interface RunnerEnvInput {
  tempDir: string;
  chromePath: string;
  ffmpeg: string;
  ffprobe: string;
}

/** Env tối thiểu cho tiến trình con. KHÔNG kế thừa process.env (trừ SystemRoot/windir); mọi thư mục ghi được trỏ vào thư mục tạm của job. */
export function runnerEnv(i: RunnerEnvInput, sys: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = sys.SystemRoot ?? sys.SYSTEMROOT ?? 'C:\\Windows';
  const t = i.tempDir;
  const env: NodeJS.ProcessEnv = {
    PATH: process.platform === 'win32' ? `${root}\\System32;${root}` : '/usr/bin:/bin',
    TEMP: t,
    TMP: t,
    TMPDIR: t,
    HOME: t,
    USERPROFILE: t,
    APPDATA: path.join(t, 'appdata'),
    LOCALAPPDATA: path.join(t, 'localappdata'),
    XDG_CACHE_HOME: path.join(t, 'cache'),
    HYPERFRAMES_FFMPEG_PATH: i.ffmpeg,
    HYPERFRAMES_FFPROBE_PATH: i.ffprobe,
    PRODUCER_HEADLESS_SHELL_PATH: i.chromePath,
    HYPERFRAMES_EXTRACT_CACHE_DIR: path.join(t, 'extract-cache'),
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PUPPETEER_CACHE_DIR: path.join(t, 'puppeteer'),
    HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    DO_NOT_TRACK: '1',
    NODE_ENV: 'production',
  };
  if (process.platform === 'win32') {
    env.SystemRoot = root;
    env.windir = root;
    env.ComSpec = `${root}\\System32\\cmd.exe`;
  }
  return env;
}

interface RunOpts {
  cmd: (tempDir: string) => Omit<RunnerCommand, 'tempDir' | 'chromePath'>;
  signal: AbortSignal;
  onProgress?: (pct: number, stage: string) => void;
  /** Tổng thời gian tối đa (ms). */
  totalMs: number;
  /** Không có tiến độ mới trong ngần này (ms) → coi là treo. */
  stallMs: number;
  /** Chạy trong thư mục tạm đã tạo (đọc kết quả) trước khi xoá. */
  withTemp?: (tempDir: string) => Promise<unknown> | unknown;
  command?: { bin: string; args: string[]; cwd: string };
}

interface RunResult {
  warnings: string[];
  denied: string[];
  extra: unknown;
}

async function runChild(ctx: AppContext, o: RunOpts): Promise<RunResult> {
  if (o.signal.aborted) throw new AppError('CANCELLED', 'Đã hủy', 409);
  const chrome = browserPath(ctx); // ném 409 HTML_RENDERER_MISSING
  const [ffmpeg, ffprobe] = await Promise.all([ffmpegOf(ctx.config), ffprobeOf(ctx.config)]);
  if (!ffmpeg || !ffprobe) throw new AppError('FFMPEG_MISSING', 'Không tìm thấy ffmpeg/ffprobe để dựng video HTML', 500);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfr-'));
  try {
    const cmd: RunnerCommand = { ...o.cmd(tempDir), tempDir, chromePath: chrome };
    const command = o.command ?? runnerCommand();
    const child = spawn(command.bin, command.args, { cwd: command.cwd, env: runnerEnv({ tempDir, chromePath: chrome, ffmpeg: absoluteBinary(ffmpeg), ffprobe: absoluteBinary(ffprobe) }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let buf = '';
    let outcome: { type: string; [k: string]: unknown } | null = null;
    let reason: 'abort' | 'timeout' | 'stall' | null = null;
    let lastProgress = Date.now();
    const exited = new Promise<number | null>((resolve) => {
      let settled = false;
      const done = (c: number | null) => {
        if (!settled) {
          settled = true;
          resolve(c);
        }
      };
      child.once('close', (c) => done(c));
      child.once('error', () => done(null));
    });
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.startsWith('@@HF ')) continue;
        try {
          const m = JSON.parse(l.slice(5)) as { type: string; pct?: number; stage?: string };
          lastProgress = Date.now();
          if (m.type === 'progress') o.onProgress?.(m.pct ?? 0, m.stage ?? '');
          else outcome = m;
        } catch {
          /* dòng hỏng */
        }
      }
    });
    const kill = (r: 'abort' | 'timeout' | 'stall') => {
      reason ??= r;
      if (child.pid) killTree(child.pid);
    };
    const onAbort = () => kill('abort');
    o.signal.addEventListener('abort', onAbort, { once: true });
    const total = setTimeout(() => kill('timeout'), o.totalMs);
    const stall = setInterval(() => Date.now() - lastProgress > o.stallMs && kill('stall'), 5000);
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(cmd));
    let code: number | null;
    try {
      code = await exited;
      if (reason && child.pid) {
        // đã kill: chờ cả cây chết hẳn (tối đa 10 giây) trước khi giải phóng slot/xoá thư mục tạm
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      clearTimeout(total);
      clearInterval(stall);
      o.signal.removeEventListener('abort', onAbort);
    }
    if (reason === 'abort' || o.signal.aborted) throw new AppError('CANCELLED', 'Đã hủy', 409);
    if (reason === 'timeout') throw new AppError('HTML_RENDER_TIMEOUT', `Dựng video quá thời gian cho phép (${Math.round(o.totalMs / 1000)} giây)`, 500);
    if (reason === 'stall') throw new AppError('HTML_RENDER_TIMEOUT', `Bộ dựng không phản hồi quá ${Math.round(o.stallMs / 1000)} giây`, 500);
    const out = outcome as { type: string; message?: string; warnings?: string[]; denied?: string[] } | null;
    if (code !== 0 || !out || out.type !== 'done') {
      const msg = out?.type === 'error' ? out.message : stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      throw new AppError('HTML_RENDER_FAILED', `Bộ dựng lỗi${code === null ? '' : ` (mã ${code})`}: ${(msg ?? 'không rõ').slice(0, 400)}`, 500, { stderr: stderr.slice(-2000) });
    }
    const extra = o.withTemp ? await o.withTemp(tempDir) : undefined;
    return { warnings: out.warnings ?? [], denied: out.denied ?? [], extra };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      /* dọn sau (TEMP) */
    }
  }
}

export interface RenderOptions {
  workDir: string;
  outPath: string;
  aspect: HtmlAspect;
  quality: HtmlQuality;
  durationS: number;
  workers?: number;
  signal: AbortSignal;
  onProgress: (pct: number, stage: string) => void;
}

/** Dựng mp4 (h264/aac, 30 fps) từ thư mục đã `materialize(mode render)`. Hủy → kill cả cây và chờ thoát. */
export async function runRender(ctx: AppContext, o: RenderOptions): Promise<{ warnings: string[] }> {
  fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
  const r = await runChild(ctx, {
    cmd: () => ({ cmd: 'render', workDir: o.workDir, outPath: o.outPath, outputResolution: outputResolutionOf(o.aspect, o.quality), durationS: o.durationS, workers: o.workers ?? 1, fps: 30 }),
    signal: o.signal,
    onProgress: o.onProgress,
    totalMs: 30_000 + 8_000 * o.durationS,
    stallMs: 5 * 60_000,
  });
  return { warnings: r.warnings };
}

export interface CaptureOptions {
  workDir: string;
  aspect: HtmlAspect;
  times: number[];
  signal: AbortSignal;
  /** Hệ số điểm ảnh (mặc định 1 = canvas gốc, vd 360x640). */
  scale?: number;
}

/** Chụp PNG tại các thời điểm (giây) từ thư mục đã `materialize(mode capture)`. Trả buffer theo đúng thứ tự `times`. */
export async function captureFrames(ctx: AppContext, o: CaptureOptions): Promise<Buffer[]> {
  if (!o.times.length) return [];
  const r = await runChild(ctx, {
    cmd: (t) => ({ cmd: 'capture', workDir: o.workDir, outDir: path.join(t, 'frames'), durationS: 0, times: o.times, scale: o.scale ?? 1 }),
    signal: o.signal,
    totalMs: 60_000 + 6_000 * o.times.length,
    stallMs: 90_000,
    withTemp: (t) => o.times.map((_, i) => fs.readFileSync(path.join(t, 'frames', `frame-${i}.png`))),
  });
  return r.extra as Buffer[];
}
