import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Thư mục gốc repo (autovideo/) khi chạy từ mã nguồn (server/src → lên 2 cấp).
 * Khi đã gom bundle (<app>/server/server.mjs) thì lên 1 cấp; bản build luôn truyền --app-dir nên đây chỉ là mặc định.
 */
export const REPO_ROOT = path.resolve(HERE, path.basename(HERE) === 'src' ? path.join('..', '..') : '..');

/** Đọc `--name value` hoặc `--name=value` từ dòng lệnh. */
export function cliArg(name: string, argv: string[] = process.argv): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

const argAppDir = cliArg('app-dir') || process.env.APP_DIR;
const argDataDir = cliArg('data-dir') || process.env.DATA_DIR;

/** Thư mục cài đặt (chỉ đọc): web/, bin/, tools/gwr. Mặc định = thư mục repo (dev, test). */
export const APP_DIR = path.resolve(argAppDir || REPO_ROOT);
/** Thư mục dữ liệu (đọc/ghi): config.env, data/app.db, data/backup, output/, refs/, logs/. Mặc định = thư mục repo. */
export const DATA_DIR = path.resolve(argDataDir || REPO_ROOT);
/** File cấu hình: chỉ định --data-dir → <DATA_DIR>/config.env; không thì `.env` ở thư mục repo như trước. */
export const ENV_FILE = argDataDir ? path.join(DATA_DIR, 'config.env') : path.join(REPO_ROOT, '.env');

export interface Config {
  port: number;
  host: string;
  /** Thư mục gốc chứa output/ và refs/. Tuyệt đối. */
  rootDir: string;
  /** Đường dẫn file SQLite. Tuyệt đối. */
  dbPath: string;
  workerToken: string;
  maxConcurrentVideoJobs: number;
  requirePromptApproval: boolean;
  heartbeatStaleMinutes: number;
  workerOnlineSeconds: number;
  /** Origin bổ sung được phép gọi API ghi (ngoài origin mặc định và origin theo cổng đang chạy). */
  extraAllowedOrigins: string[];
  /** Thư mục web/dist để phục vụ khi chạy thật (null = không phục vụ). */
  webDistDir: string | null;
  maxUploadBytes: number;
  /** Đường dẫn ffmpeg/ffprobe tùy chọn (mặc định tìm trong PATH, rồi thư mục bin/ cạnh app). */
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** Xoá logo Veo trên bản dựng hoàn chỉnh: auto (bật nếu GWR_CLI chạy được) | off (bỏ qua bước này). */
  watermarkRemover: 'auto' | 'off';
  /** Đường dẫn tuyệt đối tới gemini-watermark-remover/bin/gwr.mjs. null = chưa cấu hình. */
  gwrCli: string | null;
  /** Bitrate video (Mbps) truyền cho tool; null = mặc định của tool. */
  gwrVideoBitrateMbps: number | null;
  gwrTimeoutMs: number;
}

/** Origin luôn được phép (dev Vite 5173 + cổng mặc định của server); thêm origin theo cổng thực tế bằng `allowedOriginsFor`. */
export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

/** Origin mặc định cộng với đúng cổng server đang dùng (cổng có thể do --port chọn). */
export function allowedOriginsFor(port: number, extra: string[] = []): string[] {
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...extra])];
}

export function defaultConfig(rootDir: string, dbPath: string): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    rootDir,
    dbPath,
    workerToken: '',
    maxConcurrentVideoJobs: 4,
    requirePromptApproval: true,
    heartbeatStaleMinutes: 5,
    workerOnlineSeconds: 90,
    extraAllowedOrigins: [],
    webDistDir: null,
    maxUploadBytes: 10 * 1024 * 1024,
    ffmpegPath: null,
    ffprobePath: null,
    watermarkRemover: 'auto',
    gwrCli: null,
    gwrVideoBitrateMbps: null,
    gwrTimeoutMs: 30 * 60_000,
  };
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean => {
  if (v === undefined || v === '') return d;
  return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
};

/** Vị trí web build: bản đóng gói đặt ở <APP_DIR>/web, repo dev ở <APP_DIR>/web/dist. */
function resolveWebDist(): string {
  const packed = path.join(APP_DIR, 'web');
  return fs.existsSync(path.join(packed, 'index.html')) ? packed : path.join(packed, 'dist');
}

/** Vị trí gwr: bản đóng gói <APP_DIR>/tools/gwr, repo dev <APP_DIR>/gemini-watermark-remover (thiếu file → `auto` tự tắt kèm lý do). */
function resolveGwrCli(): string {
  const packed = path.join(APP_DIR, 'tools', 'gwr', 'bin', 'gwr.mjs');
  return fs.existsSync(packed) ? packed : path.join(APP_DIR, 'gemini-watermark-remover', 'bin', 'gwr.mjs');
}

/** Đọc cấu hình từ biến môi trường (đã nạp .env) và tham số dòng lệnh (`--port`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rootDir = path.resolve(DATA_DIR, env.ROOT_DIR || '.');
  const dbPath = path.resolve(rootDir, env.DB_PATH || 'data/app.db');
  const base = defaultConfig(rootDir, dbPath);
  return {
    ...base,
    port: num(cliArg('port') ?? env.PORT, base.port),
    host: base.host, // luôn 127.0.0.1
    workerToken: env.WORKER_TOKEN || '',
    maxConcurrentVideoJobs: num(env.MAX_CONCURRENT_VIDEO_JOBS, base.maxConcurrentVideoJobs),
    requirePromptApproval: bool(env.REQUIRE_PROMPT_APPROVAL, base.requirePromptApproval),
    heartbeatStaleMinutes: num(env.HEARTBEAT_STALE_MINUTES, base.heartbeatStaleMinutes),
    workerOnlineSeconds: num(env.WORKER_ONLINE_SECONDS, base.workerOnlineSeconds),
    extraAllowedOrigins: (env.EXTRA_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webDistDir: env.NODE_ENV === 'production' ? resolveWebDist() : null,
    ffmpegPath: env.FFMPEG_PATH || null,
    ffprobePath: env.FFPROBE_PATH || null,
    watermarkRemover: (env.WATERMARK_REMOVER ?? '').toLowerCase() === 'off' ? 'off' : 'auto',
    // Mặc định trỏ tới tool nằm trong APP_DIR; thiếu file thì `auto` tự tắt kèm lý do (xem GET /api/meta)
    gwrCli: env.GWR_CLI || resolveGwrCli(),
    gwrVideoBitrateMbps: env.GWR_VIDEO_BITRATE_MBPS ? num(env.GWR_VIDEO_BITRATE_MBPS, 0) || null : null,
    gwrTimeoutMs: num(env.GWR_TIMEOUT_MS, base.gwrTimeoutMs),
  };
}
