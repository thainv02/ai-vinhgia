import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JOB_TYPES, type JobType } from './db/types.js';

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
  workerMode: 'legacy' | 'managed';
  /**
   * Loại job do managed worker xử lý khi `workerMode='managed'`. null/rỗng = mọi loại.
   * Loại còn lại do worker legacy (WORKER.md, curl) nhận. Luôn dùng `managedJobTypes()` để đọc giá trị hiệu lực.
   */
  managedJobTypes: JobType[] | null;
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
  /** Listener LAN riêng cho trang prompt planner (mặc định TẮT). Chỉ đăng ký route planner, không mở API chính ra LAN. */
  lanEnabled: boolean;
  lanHost: string;
  lanPort: number;
  /**
   * Trang planner có đòi mã truy cập không. Mặc định `false`: mở ngay, không có màn đăng nhập/phiên (mọi bảo vệ khác vẫn giữ:
   * Host, Origin, cross-site, CSP, rate limit theo IP, trần hàng đợi, danh sách file được phép). `true`: đăng nhập bằng `lanAccessCode` như trước.
   */
  lanRequireCode: boolean;
  /** Mã truy cập chung của trang planner. Chỉ dùng khi `lanRequireCode`; rỗng + lanEnabled + lanRequireCode: server tự sinh và ghi vào .env khi khởi động. */
  lanAccessCode: string;
  /** Hostname bổ sung được chấp nhận trong header Host của listener LAN (ngoài IP, localhost, *.local, tên một nhãn). */
  lanAllowedHosts: string[];
  /** Thư mục chứa bản build trang planner (planner.html + assets). Mặc định web/dist. */
  lanDistDir: string;
  /** Dung lượng tối đa của một video LAN tải lên (video cảnh và công cụ xoá logo). Mặc định 200 MB; chỉ test đổi. */
  lanVideoMaxBytes: number;
  /**
   * Số việc render/xoá logo chạy CÙNG LÚC trong hàng đợi render (bản dựng của app + LAN và việc công cụ xoá logo LAN). Mặc định 2, kẹp 1–4.
   * Việc của dự án `app` vẫn được lấy trước việc LAN đang chờ; việc đang chạy không bị ngắt.
   */
  renderConcurrency: number;
  /** Số ngày dự án nằm trong thùng rác trước khi tự xoá vĩnh viễn (`TRASH_RETENTION_DAYS`, mặc định 30, tối thiểu 1). */
  trashRetentionDays: number;
  // ---- Cắt clip từ video dài ----
  /** `omnix`: dịch vụ nhận dạng lời nói nội bộ (chuẩn OpenAI); `none`: chưa cấu hình (báo "chưa cấu hình nhận dạng lời nói"). Mặc định `omnix` nếu có STT_URL. */
  sttProvider: 'omnix' | 'none';
  /** URL đầy đủ của `POST .../v1/audio/transcriptions` (vd http://10.0.3.214:18085/v1/audio/transcriptions). Rỗng = chưa cấu hình. */
  sttUrl: string;
  sttTenantId: string;
  sttTimeoutMs: number;
  /** Số lần thử lại khi dịch vụ báo lỗi tạm (backoff `sttRetryDelaysMs`). */
  sttMaxRetries: number;
  /** Backoff giữa các lần thử lại (mặc định 10 s / 30 s / 90 s); chỉ test đổi. */
  sttRetryDelaysMs: number[];
  /** Giãn cách hỏi lại kết quả theo job id (mặc định 3 s); chỉ test đổi. */
  sttPollMs: number;
  clipSourceMaxBytes: number;
  clipSourceMaxS: number;
  lanClipSourceMaxBytes: number;
  lanClipSourceMaxS: number;
  /** Dung lượng trống tối thiểu (GB) giữ lại sau khi tải video nguồn / dựng clip. Tải lên cần thêm 3 × kích thước file. */
  clipMinFreeGb: number;
  /** Số ngày giữ video nguồn của dự án LAN (giữ transcript, bản xem thử 480p và clip). */
  lanClipSourceRetentionDays: number;
  /** Tên font (family) của phụ đề ASS; luôn dùng kiểu đậm. */
  clipCaptionFont: string;
  /** Thư mục font cho libass (`fontsdir`). null = tự tạo `<thư mục DB>/clip-fonts` từ font hệ thống tương ứng. */
  clipFontsDir: string | null;
  /** ffmpeg có libass (bộ lọc `subtitles`) để cháy phụ đề. null = tự dò (ffmpeg mặc định, rồi ffmpeg-full của Homebrew). */
  clipFfmpegPath: string | null;
}

export const TRASH_RETENTION_DAYS_DEFAULT = 30;
export const RENDER_CONCURRENCY_DEFAULT = 2;
export const RENDER_CONCURRENCY_MAX = 4;

export const STT_DEFAULT_TENANT = 's-omnix-studio';
export const STT_RETRY_DELAYS_MS = [10_000, 30_000, 90_000];
export const GIB = 1024 * 1024 * 1024;

export const LAN_MIN_ACCESS_CODE_LENGTH = 6;

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
    workerMode: 'legacy',
    managedJobTypes: null,
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
    ffmpegPath: null,
    ffprobePath: null,
    watermarkRemover: 'auto',
    gwrCli: null,
    gwrVideoBitrateMbps: null,
    gwrTimeoutMs: 30 * 60_000,
    lanEnabled: false,
    lanHost: '0.0.0.0',
    lanPort: 8790,
    lanRequireCode: false,
    lanAccessCode: '',
    lanAllowedHosts: [],
    lanDistDir: path.join(APP_DIR, 'web', 'dist'),
    lanVideoMaxBytes: 200 * 1024 * 1024,
    renderConcurrency: RENDER_CONCURRENCY_DEFAULT,
    trashRetentionDays: TRASH_RETENTION_DAYS_DEFAULT,
    sttProvider: 'none',
    sttUrl: '',
    sttTenantId: STT_DEFAULT_TENANT,
    sttTimeoutMs: 3_600_000,
    sttMaxRetries: 3,
    sttRetryDelaysMs: STT_RETRY_DELAYS_MS,
    sttPollMs: 3000,
    clipSourceMaxBytes: 4 * GIB,
    clipSourceMaxS: 10_800,
    lanClipSourceMaxBytes: 2 * GIB,
    lanClipSourceMaxS: 10_800,
    clipMinFreeGb: 10,
    lanClipSourceRetentionDays: 7,
    clipCaptionFont: 'Arial',
    clipFontsDir: null,
    clipFfmpegPath: null,
  };
}

/** Loại job hiệu lực của managed worker: legacy → rỗng; managed không cấu hình danh sách → mọi loại. */
export function managedJobTypes(config: Pick<Config, 'workerMode' | 'managedJobTypes'>): readonly JobType[] {
  if (config.workerMode !== 'managed') return [];
  return config.managedJobTypes?.length ? config.managedJobTypes : JOB_TYPES;
}
export const isManagedJobType = (config: Pick<Config, 'workerMode' | 'managedJobTypes'>, type: string): boolean =>
  (managedJobTypes(config) as readonly string[]).includes(type);

/** MANAGED_JOB_TYPES=a,b,c. Giá trị lạ làm server không khởi động: sai chính tả không được âm thầm đổi worker nhận việc. */
export function parseManagedJobTypes(value: string | undefined): JobType[] | null {
  const parts = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const bad = parts.find((p) => !(JOB_TYPES as readonly string[]).includes(p));
  if (bad) throw new Error(`MANAGED_JOB_TYPES có loại job không hợp lệ: "${bad}" (hợp lệ: ${JOB_TYPES.join(', ')})`);
  return [...new Set(parts)] as JobType[];
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

/**
 * Vị trí web build: repo dev ở <APP_DIR>/web/dist, bản đóng gói ở <APP_DIR>/web.
 * Xét web/dist trước: trong repo, web/index.html là file nguồn của Vite chứ không phải bản build.
 */
function resolveWebDist(): string {
  const dev = path.join(APP_DIR, 'web', 'dist');
  return fs.existsSync(path.join(dev, 'index.html')) ? dev : path.join(APP_DIR, 'web');
}

/** Vị trí gwr: bản đóng gói <APP_DIR>/tools/gwr, repo dev <APP_DIR>/gemini-watermark-remover (thiếu file → `auto` tự tắt kèm lý do). */
function resolveGwrCli(): string {
  const packed = path.join(APP_DIR, 'tools', 'gwr', 'bin', 'gwr.mjs');
  return fs.existsSync(packed) ? packed : path.join(APP_DIR, 'gemini-watermark-remover', 'bin', 'gwr.mjs');
}

/** `RENDER_CONCURRENCY`: số nguyên kẹp 1–4; thiếu/không phải số → 2. */
export function parseRenderConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return RENDER_CONCURRENCY_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return RENDER_CONCURRENCY_DEFAULT;
  return clampRenderConcurrency(n);
}

/** Số việc render chạy cùng lúc hiệu lực (luôn nguyên, 1–4), kể cả khi cấu hình do test đặt tay. */
export function clampRenderConcurrency(n: number): number {
  if (!Number.isFinite(n)) return RENDER_CONCURRENCY_DEFAULT;
  return Math.max(1, Math.min(RENDER_CONCURRENCY_MAX, Math.floor(n)));
}

/** `TRASH_RETENTION_DAYS`: số nguyên ≥ 1; thiếu/rỗng/không phải số/< 1 → 30 (không bao giờ xoá ngay vì cấu hình sai). */
export function parseTrashRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return TRASH_RETENTION_DAYS_DEFAULT;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : TRASH_RETENTION_DAYS_DEFAULT;
}

/**
 * `LAN_REQUIRE_CODE`: mặc định (thiếu/rỗng) = `false`. `false/0/no/off` = không đòi mã. Mọi giá trị khác (kể cả gõ sai như `treu`)
 * = ĐÒI mã: lỗi chính tả không được âm thầm mở trang ra mạng.
 */
export function parseRequireCode(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return false;
  return !['false', '0', 'no', 'off'].includes(v);
}

/** Đọc cấu hình từ biến môi trường (đã nạp .env) và tham số dòng lệnh (`--port`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rootDir = path.resolve(DATA_DIR, env.ROOT_DIR || '.');
  const dbPath = path.resolve(rootDir, env.DB_PATH || 'data/app.db');
  const base = defaultConfig(rootDir, dbPath);
  return {
    ...base,
    workerMode: env.WORKER_MODE === 'managed' ? 'managed' : 'legacy',
    managedJobTypes: parseManagedJobTypes(env.MANAGED_JOB_TYPES),
    aiHome: env.AI_HOME ? path.resolve(env.AI_HOME) : base.aiHome,
    port: num(cliArg('port') ?? env.PORT, base.port),
    host: base.host, // luôn 127.0.0.1 (truy cập từ máy khác chỉ qua listener LAN riêng)
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
    // Bật LAN chỉ khi giá trị là truthy rõ ràng (gõ sai chính tả thì vẫn tắt, tránh mở cổng ngoài ý muốn).
    lanEnabled: ['true', '1', 'yes', 'on'].includes((env.LAN_ENABLED ?? '').trim().toLowerCase()),
    lanHost: env.LAN_HOST || base.lanHost,
    lanPort: num(env.LAN_PORT, base.lanPort),
    lanRequireCode: parseRequireCode(env.LAN_REQUIRE_CODE),
    lanAccessCode: (env.LAN_ACCESS_CODE ?? '').trim(),
    lanAllowedHosts: (env.LAN_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    lanDistDir: resolveWebDist(),
    renderConcurrency: parseRenderConcurrency(env.RENDER_CONCURRENCY),
    trashRetentionDays: parseTrashRetentionDays(env.TRASH_RETENTION_DAYS),
    ...parseClipConfig(env),
  };
}

/** Cấu hình cắt clip (STT_*, CLIP_*, LAN_CLIP_*). `STT_PROVIDER` mặc định `omnix` nếu có `STT_URL`, ngược lại `none`; giá trị lạ → `none`. */
export function parseClipConfig(env: NodeJS.ProcessEnv): Pick<Config, 'sttProvider' | 'sttUrl' | 'sttTenantId' | 'sttTimeoutMs' | 'sttMaxRetries' | 'clipSourceMaxBytes' | 'clipSourceMaxS' | 'lanClipSourceMaxBytes' | 'lanClipSourceMaxS' | 'clipMinFreeGb' | 'lanClipSourceRetentionDays' | 'clipCaptionFont' | 'clipFontsDir' | 'clipFfmpegPath'> {
  const base = defaultConfig('', '');
  const sttUrl = (env.STT_URL ?? '').trim();
  const provider = (env.STT_PROVIDER ?? '').trim().toLowerCase();
  const sttProvider: 'omnix' | 'none' = provider === '' ? (sttUrl ? 'omnix' : 'none') : provider === 'omnix' && sttUrl ? 'omnix' : 'none';
  const nonNeg = (v: string | undefined, d: number): number => {
    if (v === undefined || v.trim() === '') return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    sttProvider,
    sttUrl,
    sttTenantId: (env.STT_TENANT_ID ?? '').trim() || STT_DEFAULT_TENANT,
    sttTimeoutMs: num(env.STT_TIMEOUT_MS, base.sttTimeoutMs),
    sttMaxRetries: Math.floor(nonNeg(env.STT_MAX_RETRIES, base.sttMaxRetries)),
    clipSourceMaxBytes: num(env.CLIP_SOURCE_MAX_BYTES, base.clipSourceMaxBytes),
    clipSourceMaxS: num(env.CLIP_SOURCE_MAX_S, base.clipSourceMaxS),
    lanClipSourceMaxBytes: num(env.LAN_CLIP_SOURCE_MAX_BYTES, base.lanClipSourceMaxBytes),
    lanClipSourceMaxS: num(env.LAN_CLIP_SOURCE_MAX_S, base.lanClipSourceMaxS),
    clipMinFreeGb: nonNeg(env.CLIP_MIN_FREE_GB, base.clipMinFreeGb),
    lanClipSourceRetentionDays: Math.max(1, Math.floor(num(env.LAN_CLIP_SOURCE_RETENTION_DAYS, base.lanClipSourceRetentionDays))),
    clipCaptionFont: (env.CLIP_CAPTION_FONT ?? '').trim() || base.clipCaptionFont,
    clipFontsDir: env.CLIP_FONTS_DIR ? path.resolve(env.CLIP_FONTS_DIR) : null,
    clipFfmpegPath: env.CLIP_FFMPEG_PATH || null,
  };
}

/**
 * Kiểm tra cấu hình listener LAN lúc khởi động (chỉ khi LAN_ENABLED). Cấu hình sai làm server không bật LAN
 * thay vì bật với mã yếu hoặc cổng trùng app chính.
 */
export function assertLanConfig(config: Pick<Config, 'lanEnabled' | 'lanPort' | 'lanRequireCode' | 'lanAccessCode' | 'port'>): void {
  if (!config.lanEnabled) return;
  if (!Number.isInteger(config.lanPort) || config.lanPort < 1 || config.lanPort > 65535) {
    throw new Error(`LAN_PORT không hợp lệ: ${config.lanPort}`);
  }
  if (config.lanPort === config.port) throw new Error('LAN_PORT phải khác PORT của app chính');
  // Mã chỉ bắt buộc khi LAN_REQUIRE_CODE=true; không đòi mã thì không kiểm tra (không tự sinh, không bắt nhập).
  if (config.lanRequireCode && config.lanAccessCode.length < LAN_MIN_ACCESS_CODE_LENGTH) {
    throw new Error(`LAN_REQUIRE_CODE=true cần LAN_ACCESS_CODE dài ít nhất ${LAN_MIN_ACCESS_CODE_LENGTH} ký tự (để trống để server tự sinh mã)`);
  }
}
