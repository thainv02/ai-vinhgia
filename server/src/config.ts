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

/** Loại job AI do worker nhúng xử lý (app không còn job điều khiển trình duyệt). */
export const TEXT_JOB_TYPES: JobType[] = ['analyze_brief', 'revise_prompt', 'edit_plan', 'clip_plan', 'html_compose'];

export interface Config {
  /** API AI gọi trực tiếp (chuẩn OpenAI, vd `http://ai.duocvinhgia.com/v1`). Rỗng = dùng account pool (gateway loopback). */
  aiApiUrl: string;
  /** Key của `aiApiUrl` (`AI_API_KEY`). Không bao giờ trả ra API/log. */
  aiApiKey: string;
  /** Model của `aiApiUrl` (`AI_MODEL`, mặc định `claude-sonnet-4-6`). */
  aiModel: string;
  /** Model nhẹ cho việc phụ (chuẩn hoá chính tả lời thoại): `AI_FAST_MODEL`; rỗng = tự chọn trong `/models` (haiku/lite/mini/flash…), không có thì `aiModel`. */
  aiFastModel: string;
  /** Chuẩn hoá chính tả/ngữ nghĩa kết quả nhận dạng lời nói bằng AI trước khi hiển thị (`STT_AI_FIX`, mặc định bật; test: tắt). */
  sttAiFix: boolean;
  /** File cấu hình đang dùng (`.env` hoặc `<DATA_DIR>/config.env`) để trang Cài đặt của bản desktop lưu key; null = không lưu được (test). */
  envFile: string | null;
  /**
   * App chạy thật luôn `managed` với `TEXT_JOB_TYPES` (worker nhúng). `legacy` chỉ còn là mặc định của test: job được claim
   * không kèm lease để test dựng trạng thái nhanh. Luôn dùng `managedJobTypes()` để đọc giá trị hiệu lực.
   */
  workerMode: 'legacy' | 'managed';
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
  maxUploadBytes: number;
  /** Đường dẫn ffmpeg/ffprobe tùy chọn (mặc định tìm trong PATH, rồi thư mục bin/ cạnh app). */
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** Xoá logo Veo trên bản dựng hoàn chỉnh: auto (bật nếu GWR_CLI chạy được) | off (bỏ qua bước này). */
  watermarkRemover: 'auto' | 'off';
  /** Đường dẫn tuyệt đối tới tool xoá logo (mặc định `<APP_DIR>/tools/gwr/gwr.mjs`). null = chưa cấu hình. */
  gwrCli: string | null;
  /** Bitrate video (Mbps) truyền cho tool; null = mặc định của tool. */
  gwrVideoBitrateMbps: number | null;
  gwrTimeoutMs: number;
  /** Listener giao diện (trang planner, tên lịch sử "LAN"): luôn 127.0.0.1. Chỉ đăng ký route planner, không có route của API chính. */
  lanHost: string;
  lanPort: number;
  /** Cổng listener preview Video HTML (127.0.0.1, chỉ bản desktop); 0 = ngẫu nhiên. Env HTML_PREVIEW_PORT. */
  previewPort: number;
  /** Thư mục chứa bản build trang planner (planner.html + assets). Mặc định web/dist. */
  lanDistDir: string;
  /** Dung lượng tối đa của một video LAN tải lên (video cảnh và công cụ xoá logo). Mặc định 200 MB; chỉ test đổi. */
  lanVideoMaxBytes: number;
  /**
   * Số việc render/xoá logo chạy CÙNG LÚC trong hàng đợi render (bản dựng của app + LAN và việc công cụ xoá logo LAN). Mặc định 2, kẹp 1–4.
   * Việc của dự án `app` vẫn được lấy trước việc LAN đang chờ; việc đang chạy không bị ngắt.
   */
  renderConcurrency: number | 'auto';
  htmlComposeParallel?:number;
  /** Số ngày dự án nằm trong thùng rác trước khi tự xoá vĩnh viễn (`TRASH_RETENTION_DAYS`, mặc định 30, tối thiểu 1). */
  trashRetentionDays: number;
  // ---- Cắt clip từ video dài ----
  /**
   * `local`: nhận dạng ngay trên máy bằng CPU (model gipformer chạy qua sherpa-onnx, mặc định của bản desktop);
   * `omnix`: dịch vụ nhận dạng lời nói nội bộ (chuẩn OpenAI); `none`: chưa cấu hình. Mặc định `omnix` nếu có STT_URL.
   */
  sttProvider: 'omnix' | 'local' | 'none';
  /** Thư mục chứa model nhận dạng tại máy (`--stt-models-dir` / `STT_MODELS_DIR`; mặc định `<ROOT_DIR>/models`). Model nằm ở thư mục con theo id. */
  sttModelsDir: string;
  /** Thư mục bộ dựng Video HTML (chrome-headless-shell tải riêng; `HTML_RENDERER_DIR`; mặc định cạnh thư mục model STT: `<cha của sttModelsDir>/html-renderer`). */
  htmlRendererDir: string;
  /** Số luồng CPU cho nhận dạng tại máy (`STT_THREADS`; mặc định số nhân − 1, tối đa 4). */
  sttThreads: number;
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

export const AI_MODEL_DEFAULT = 'claude-sonnet-4-6';
/** Máy chủ AI mặc định (dịch vụ nội bộ): chỉ cần nhập API key trong Cài đặt. `AI_API_URL`/`STT_URL` vẫn ghi đè được. */
// CLIProxyAPI tự host (IIS site `ai.duocvinhgia.vn` → 127.0.0.1:8317). Tạm dùng HTTP vì tên miền chưa có chứng chỉ HTTPS:
// có chứng chỉ thì đổi sang https.
export const DESKTOP_AI_API_URL = 'http://ai.duocvinhgia.com/v1';
/** Số luồng mặc định cho nhận dạng tại máy: chừa một nhân cho giao diện/server, tối đa 4 (thêm luồng gần như không nhanh hơn). */
export const defaultSttThreads = (): number => Math.max(1, Math.min(4, os.availableParallelism() - 1));
/** Chừa CPU/RAM cho giao diện và nhận dạng voice. */
export const autoRenderConcurrency = ({cores,freeMemBytes}:{cores:number;freeMemBytes:number}):number =>
  clampRenderConcurrency(Math.max(1,Math.min(Math.floor((cores-2)/3),Math.floor(freeMemBytes/(1.5*1024**3)))));

/** Origin luôn được phép (dev Vite 5173 + cổng mặc định của server); thêm origin theo cổng thực tế bằng `allowedOriginsFor`. */
export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

/** Origin mặc định cộng với đúng cổng server đang dùng (cổng có thể do --port chọn). */
export function allowedOriginsFor(port: number): string[] {
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, `http://localhost:${port}`, `http://127.0.0.1:${port}`])];
}

export function defaultConfig(rootDir: string, dbPath: string): Config {
  return {
    aiApiUrl: '',
    aiApiKey: '',
    aiModel: AI_MODEL_DEFAULT,
    aiFastModel: '',
    sttAiFix: false,
    envFile: null,
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
    maxUploadBytes: 10 * 1024 * 1024,
    ffmpegPath: null,
    ffprobePath: null,
    watermarkRemover: 'auto',
    gwrCli: null,
    gwrVideoBitrateMbps: null,
    gwrTimeoutMs: 30 * 60_000,
    lanHost: '127.0.0.1',
    lanPort: 8790,
    previewPort: 0,
    lanDistDir: path.join(APP_DIR, 'web', 'dist'),
    lanVideoMaxBytes: 200 * 1024 * 1024,
    renderConcurrency: 'auto',
    htmlComposeParallel:2,
    trashRetentionDays: TRASH_RETENTION_DAYS_DEFAULT,
    sttProvider: 'none',
    sttModelsDir: path.join(rootDir || '.', 'models'),
    htmlRendererDir: path.join(rootDir || '.', 'html-renderer'),
    sttThreads: defaultSttThreads(),
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
 * Vị trí web build (chỉ còn trang planner): repo dev ở <APP_DIR>/web/dist, bản đóng gói ở <APP_DIR>/web.
 * Xét web/dist trước: trong repo, web/planner.html là file nguồn của Vite chứ không phải bản build.
 */
function resolveWebDist(): string {
  const dev = path.join(APP_DIR, 'web', 'dist');
  return fs.existsSync(path.join(dev, 'planner.html')) ? dev : path.join(APP_DIR, 'web');
}

/**
 * Tool xoá logo Veo của app: `<APP_DIR>/tools/gwr/gwr.mjs` (workspace `tools/gwr` trong repo; bản đóng gói chép cùng đường dẫn).
 * `GWR_CLI` vẫn trỏ được sang bản clone đầy đủ của gemini-watermark-remover (`.../bin/gwr.mjs`).
 */
function resolveGwrCli(): string {
  return path.join(APP_DIR, 'tools', 'gwr', 'gwr.mjs');
}

/** `RENDER_CONCURRENCY`: số nguyên kẹp 1–4; thiếu/không phải số → 2. */
export function parseRenderConcurrency(value: string | undefined): number | 'auto' {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase()==='auto') return 'auto';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'auto';
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

/** Đọc cấu hình từ biến môi trường (đã nạp .env) và tham số dòng lệnh (`--port`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rootDir = path.resolve(DATA_DIR, env.ROOT_DIR || '.');
  const dbPath = path.resolve(rootDir, env.DB_PATH || 'data/app.db');
  const base = defaultConfig(rootDir, dbPath);
  const cfg: Config = {
    ...base,
    aiApiUrl: ((env.AI_API_URL ?? '').trim() || DESKTOP_AI_API_URL).replace(/\/+$/, ''),
    aiApiKey: (env.AI_API_KEY ?? '').trim(),
    aiModel: (env.AI_MODEL ?? '').trim() || AI_MODEL_DEFAULT,
    aiFastModel: (env.AI_FAST_MODEL ?? '').trim(),
    sttAiFix: bool(env.STT_AI_FIX, true),
    // mọi job AI do worker nhúng (managed) nhận
    workerMode: 'managed',
    managedJobTypes: TEXT_JOB_TYPES,
    aiHome: env.AI_HOME ? path.resolve(env.AI_HOME) : base.aiHome,
    port: num(cliArg('port') ?? env.PORT, base.port),
    host: base.host, // luôn 127.0.0.1
    workerToken: env.WORKER_TOKEN || '',
    maxConcurrentVideoJobs: num(env.MAX_CONCURRENT_VIDEO_JOBS, base.maxConcurrentVideoJobs),
    requirePromptApproval: bool(env.REQUIRE_PROMPT_APPROVAL, base.requirePromptApproval),
    heartbeatStaleMinutes: num(env.HEARTBEAT_STALE_MINUTES, base.heartbeatStaleMinutes),
    workerOnlineSeconds: num(env.WORKER_ONLINE_SECONDS, base.workerOnlineSeconds),
    ffmpegPath: env.FFMPEG_PATH || null,
    ffprobePath: env.FFPROBE_PATH || null,
    watermarkRemover: (env.WATERMARK_REMOVER ?? '').toLowerCase() === 'off' ? 'off' : 'auto',
    // Mặc định trỏ tới tool nằm trong APP_DIR; thiếu file thì `auto` tự tắt kèm lý do (xem GET /api/meta)
    gwrCli: env.GWR_CLI || resolveGwrCli(),
    gwrVideoBitrateMbps: env.GWR_VIDEO_BITRATE_MBPS ? num(env.GWR_VIDEO_BITRATE_MBPS, 0) || null : null,
    gwrTimeoutMs: num(env.GWR_TIMEOUT_MS, base.gwrTimeoutMs),
    lanPort: num(cliArg('lan-port') ?? env.LAN_PORT, base.lanPort),
    previewPort: Math.max(0, Math.min(65535, Math.trunc(num(env.HTML_PREVIEW_PORT, 0)))),
    lanDistDir: resolveWebDist(),
    renderConcurrency: parseRenderConcurrency(env.RENDER_CONCURRENCY),
    htmlComposeParallel:Math.max(1,Math.min(3,Math.floor(num(env.HTML_COMPOSE_PARALLEL,2)))),
    // không có trang thùng rác (xoá là xoá vĩnh viễn): thứ còn sót trong thùng rác (từ bản cũ) được dọn ở lần bảo trì kế tiếp
    trashRetentionDays: 0,
    // nhận dạng lời nói ngay trên máy (CPU) trừ khi cấu hình dịch vụ STT riêng
    ...parseClipConfig(!(env.STT_URL ?? '').trim() && !(env.STT_PROVIDER ?? '').trim() ? { ...env, STT_PROVIDER: 'local' } : env),
    sttModelsDir: path.resolve(cliArg('stt-models-dir') || env.STT_MODELS_DIR || path.join(rootDir, 'models')),
    htmlRendererDir: path.resolve(cliArg('html-renderer-dir') || env.HTML_RENDERER_DIR || path.join(path.dirname(path.resolve(cliArg('stt-models-dir') || env.STT_MODELS_DIR || path.join(rootDir, 'models'))), 'html-renderer')),
    sttThreads: Math.floor(num(env.STT_THREADS, base.sttThreads)),
  };
  // một người dùng trên chính máy mình → giới hạn video nguồn như dự án thường
  return { ...cfg, lanClipSourceMaxBytes: cfg.clipSourceMaxBytes, lanClipSourceMaxS: cfg.clipSourceMaxS };
}

/**
 * Cấu hình cắt clip (STT_*, CLIP_*, LAN_CLIP_*). `STT_PROVIDER`: `local` (nhận dạng trên máy), `omnix` (cần `STT_URL`); bỏ trống → `omnix` nếu có
 * `STT_URL`, ngược lại `none`; giá trị lạ → `none`.
 */
export function parseClipConfig(env: NodeJS.ProcessEnv): Pick<Config, 'sttProvider' | 'sttUrl' | 'sttTenantId' | 'sttTimeoutMs' | 'sttMaxRetries' | 'clipSourceMaxBytes' | 'clipSourceMaxS' | 'lanClipSourceMaxBytes' | 'lanClipSourceMaxS' | 'clipMinFreeGb' | 'lanClipSourceRetentionDays' | 'clipCaptionFont' | 'clipFontsDir' | 'clipFfmpegPath'> {
  const base = defaultConfig('', '');
  const sttUrl = (env.STT_URL ?? '').trim();
  const provider = (env.STT_PROVIDER ?? '').trim().toLowerCase();
  const sttProvider: Config['sttProvider'] =
    provider === 'local' ? 'local' : provider === '' ? (sttUrl ? 'omnix' : 'none') : provider === 'omnix' && sttUrl ? 'omnix' : 'none';
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

/** Kiểm tra cổng của listener giao diện lúc khởi động: sai thì không bật thay vì trùng cổng API chính. */
export function assertLanConfig(config: Pick<Config, 'lanPort' | 'port'>): void {
  if (!Number.isInteger(config.lanPort) || config.lanPort < 1 || config.lanPort > 65535) {
    throw new Error(`LAN_PORT không hợp lệ: ${config.lanPort}`);
  }
  if (config.lanPort === config.port) throw new Error('LAN_PORT phải khác PORT của app chính');
}
