import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { APP_DIR, type Config } from '../config.js';
import { ffmpegOf, ffprobeOf } from './media.js';

/**
 * Worker văn bản nhúng (bản desktop): server chạy `worker/src/text-main.ts` (dev, qua tsx) hoặc `<APP_DIR>/worker/worker.mjs` (bản build)
 * làm tiến trình con, trỏ về chính API của server. Worker chết thì chạy lại (chờ tăng dần 5 s → 60 s); server tắt thì dừng worker.
 */
export interface EmbeddedWorker {
  stop(): Promise<void>;
  readonly running: boolean;
}

export interface EmbeddedWorkerOptions {
  config: Pick<Config, 'port' | 'workerToken' | 'rootDir' | 'dbPath' | 'ffmpegPath' | 'ffprobePath'>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Ghi đè lệnh chạy (test); null = coi như không có worker. */
  command?: { bin: string; args: string[] } | null;
  /** Thời gian chờ trước lần chạy lại đầu tiên (mặc định 5 giây, tăng gấp đôi tới 60 giây). */
  restartDelayMs?: number;
}

/** Lệnh chạy worker: bản build có `worker/worker.mjs` cạnh app; repo dev chạy mã nguồn bằng tsx. null nếu không có cả hai. */
export function workerCommand(appDir = APP_DIR): { bin: string; args: string[] } | null {
  const bundled = path.join(appDir, 'worker', 'worker.mjs');
  if (fs.existsSync(bundled)) return { bin: process.execPath, args: ['--max-old-space-size=192', bundled] };
  const source = path.join(appDir, 'worker', 'src', 'text-main.ts');
  if (fs.existsSync(source)) return { bin: process.execPath, args: ['--import', 'tsx', source] };
  return null;
}

export async function startEmbeddedWorker(opts: EmbeddedWorkerOptions): Promise<EmbeddedWorker> {
  const { config, log } = opts;
  const command = opts.command === undefined ? workerCommand() : opts.command;
  const firstDelay = opts.restartDelayMs ?? 5_000;
  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let backoff = firstDelay;
  if (!command) {
    log('error', 'Không tìm thấy worker văn bản (worker/worker.mjs hoặc worker/src/text-main.ts); các việc AI sẽ nằm chờ');
    return { stop: async () => undefined, running: false };
  }
  const [ffmpeg, ffprobe] = await Promise.all([ffmpegOf(config), ffprobeOf(config)]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOVIDEO_API: `http://127.0.0.1:${config.port}`,
    AUTOVIDEO_WORKER_ID: 'desktop',
    AUTOVIDEO_ROOT: config.rootDir,
    AUTOVIDEO_LOCK_DIR: path.dirname(config.dbPath),
    AUTOVIDEO_EMBEDDED: '1',
    AUTOVIDEO_RULES_FILE: path.join(APP_DIR, 'video-production-rules.md'),
    WORKER_TOKEN: config.workerToken,
    ...(ffmpeg ? { FFMPEG_PATH: ffmpeg } : {}),
    ...(ffprobe ? { FFPROBE_PATH: ffprobe } : {}),
  };

  const pipeLines = (stream: NodeJS.ReadableStream | null, level: 'info' | 'error') => {
    let buf = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) log(level, `[worker] ${line}`);
      }
    });
  };

  const launch = () => {
    timer = null;
    if (stopped) return;
    const startedAt = Date.now();
    const c = spawn(command.bin, command.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = c;
    pipeLines(c.stdout, 'info');
    pipeLines(c.stderr, 'error');
    c.on('error', (err) => log('error', `Không chạy được worker văn bản: ${err.message}`));
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      if (stopped) return;
      // chạy được lâu (> 1 phút) rồi mới chết: coi như lỗi mới, đặt lại thời gian chờ
      if (Date.now() - startedAt > 60_000) backoff = firstDelay;
      log('warn', `Worker văn bản dừng (${signal ?? `mã ${code}`}); chạy lại sau ${Math.round(backoff / 1000)} giây`);
      timer = setTimeout(launch, backoff);
      timer.unref();
      backoff = Math.min(backoff * 2, 60_000);
    });
  };
  launch();

  return {
    get running() {
      return !!child && child.exitCode === null;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const c = child;
      if (!c || c.exitCode !== null) return;
      // đóng stdin = báo worker dừng sau job hiện tại; quá 3 giây thì kill
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => c.kill(), 3_000);
        c.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        c.stdin?.end();
      });
    },
  };
}
