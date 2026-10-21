import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Thư mục gốc repo (autovideo/). config.ts nằm ở server/src nên đi lên 2 cấp. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Config {
  workerMode: 'legacy' | 'managed';
  aiHome: string;
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
  /** Origin bổ sung được phép gọi API ghi (ngoài 4 origin mặc định). */
  extraAllowedOrigins: string[];
  /** Thư mục web/dist để phục vụ khi chạy thật (null = không phục vụ). */
  webDistDir: string | null;
  maxUploadBytes: number;
  /** Trình dựng bản hoàn chỉnh: auto (shotcut nếu sẵn sàng, ngược lại ffmpeg) | shotcut | ffmpeg. */
  finalRenderer: 'auto' | 'shotcut' | 'ffmpeg';
  /** Python chạy Shotcut MCP và đường dẫn script server (tuyệt đối). null = chưa cấu hình. */
  shotcutMcpPython: string | null;
  shotcutMcpServerScript: string | null;
  /** Đường dẫn ffmpeg/ffprobe tùy chọn (mặc định tìm trong PATH, rồi /Applications/Shotcut.app/Contents/MacOS/). */
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

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

export function defaultConfig(rootDir: string, dbPath: string): Config {
  return {
    workerMode: 'legacy',
    aiHome: path.join(os.homedir(), '.local/share/autovideo/accounts', crypto.createHash('sha256').update(dbPath).digest('hex').slice(0, 12)),
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
    finalRenderer: 'auto',
    shotcutMcpPython: null,
    shotcutMcpServerScript: null,
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

/** Đọc cấu hình từ biến môi trường (đã nạp .env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rootDir = path.resolve(REPO_ROOT, env.ROOT_DIR || '.');
  const dbPath = path.resolve(rootDir, env.DB_PATH || 'data/app.db');
  const base = defaultConfig(rootDir, dbPath);
  return {
    ...base,
    workerMode: env.WORKER_MODE === 'managed' ? 'managed' : 'legacy',
    aiHome: env.AI_HOME ? path.resolve(env.AI_HOME) : base.aiHome,
    port: num(env.PORT, base.port),
    host: env.HOST || base.host,
    workerToken: env.WORKER_TOKEN || '',
    maxConcurrentVideoJobs: num(env.MAX_CONCURRENT_VIDEO_JOBS, base.maxConcurrentVideoJobs),
    requirePromptApproval: bool(env.REQUIRE_PROMPT_APPROVAL, base.requirePromptApproval),
    heartbeatStaleMinutes: num(env.HEARTBEAT_STALE_MINUTES, base.heartbeatStaleMinutes),
    workerOnlineSeconds: num(env.WORKER_ONLINE_SECONDS, base.workerOnlineSeconds),
    extraAllowedOrigins: (env.EXTRA_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webDistDir: env.NODE_ENV === 'production' ? path.join(REPO_ROOT, 'web', 'dist') : null,
    finalRenderer: (['auto', 'shotcut', 'ffmpeg'] as const).find((m) => m === (env.FINAL_RENDERER ?? '').toLowerCase()) ?? base.finalRenderer,
    shotcutMcpPython: env.SHOTCUT_MCP_PYTHON || null,
    shotcutMcpServerScript: env.SHOTCUT_MCP_SERVER_SCRIPT || null,
    ffmpegPath: env.FFMPEG_PATH || null,
    ffprobePath: env.FFPROBE_PATH || null,
    watermarkRemover: (env.WATERMARK_REMOVER ?? '').toLowerCase() === 'off' ? 'off' : 'auto',
    // Mặc định trỏ tới tool nằm cạnh repo; thiếu file thì `auto` tự tắt kèm lý do (xem GET /api/meta)
    gwrCli: env.GWR_CLI || path.join(REPO_ROOT, 'gemini-watermark-remover', 'bin', 'gwr.mjs'),
    gwrVideoBitrateMbps: env.GWR_VIDEO_BITRATE_MBPS ? num(env.GWR_VIDEO_BITRATE_MBPS, 0) || null : null,
    gwrTimeoutMs: num(env.GWR_TIMEOUT_MS, base.gwrTimeoutMs),
  };
}
