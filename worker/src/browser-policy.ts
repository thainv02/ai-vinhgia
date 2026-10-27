export type Site = 'chatgpt' | 'flow';

/** Site của một URL (chỉ HTTPS, đúng hostname, không credential/cổng). null nếu không phải ChatGPT/Flow. */
export function siteOf(value: string): Site | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (u.hostname === 'chatgpt.com') return 'chatgpt';
    if (u.hostname === 'flow.google.com' || (u.hostname === 'labs.google' && u.pathname.startsWith('/fx/'))) return 'flow';
    return null;
  } catch { return null; }
}

/** Trang đăng nhập (chuyển hướng khi hết phiên). Các trang ngoài site khác không phải lỗi đăng nhập. */
export function isLoginPage(value: string): boolean {
  try {
    const u = new URL(value);
    return /(^|\.)(accounts\.google\.com|auth\.openai\.com|auth0\.com)$/i.test(u.hostname) || /\/(log-?in|sign-?in|signin|auth)(\/|$)/i.test(u.pathname);
  } catch { return false; }
}

/** Site duy nhất mà loại job được dùng: storyboard → ChatGPT, video → Flow. Loại khác không dùng browser. */
export function requiredSite(jobType: string): Site | null {
  return jobType === 'storyboard' ? 'chatgpt' : jobType === 'video' ? 'flow' : null;
}
const SITE_NAME: Record<Site, string> = { chatgpt: 'chatgpt.com', flow: 'flow.google.com (hoặc labs.google/fx/)' };

/**
 * Exact HTTPS origins used by ChatGPT and both current/legacy Flow entrypoints.
 * Có `jobType`: chỉ trả true khi URL đúng site của loại job đó (storyboard chỉ ChatGPT, video chỉ Flow).
 */
export function isAllowedBrowserUrl(value: string, jobType?: string): boolean {
  const site = siteOf(value);
  if (!site) return false;
  return jobType === undefined || requiredSite(jobType) === site;
}

/** Thông báo trả cho model khi trang thuộc site hợp lệ nhưng sai site của job. Không chứa từ khóa LOGIN_REQUIRED/CAPTCHA. */
export function wrongSiteMessage(jobType: string, url: string): string {
  const need = requiredSite(jobType);
  const have = siteOf(url);
  return need
    ? `WRONG_SITE: job ${jobType} chỉ được dùng ${SITE_NAME[need]}; trang ${have ? SITE_NAME[have] : 'hiện tại'} không dùng cho loại job này. Dùng browser_open/browser_select tới đúng site.`
    : `WRONG_SITE: job ${jobType} không dùng browser.`;
}

export interface ControlInfo {
  text?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
  value?: string | null;
  /** Thuộc tính type (không phải thuộc tính DOM mặc định). */
  type?: string | null;
  /** Nút mặc định-submit nằm trong form có ô nhập prompt (bấm sẽ gửi form). */
  formSubmit?: boolean;
}

const WORD = '\\p{L}\\p{N}';
// Động từ đứng riêng (không dính chữ/số hai bên): khớp "Generate", "Send prompt", "Gửi", "Regenerate" (dính chữ nên có mục riêng),
// KHÔNG khớp "Generated image 1", "Share generated image 1", "Edit generated image 1", "Generating".
const SUBMIT_VERB = new RegExp(`(?<![${WORD}])(?:generate|send|submit|create|gửi|tạo)(?![${WORD}])`, 'iu');
// Các nút tạo lại/gửi lại cũng sinh generation mới nên cũng phải đi qua browser_submit (và bị journal chặn).
const RESUBMIT = new RegExp(`(?<![${WORD}])(?:regenerate|re-generate|resend|re-send|retry|try again|redo|remix|extend|tạo lại|gửi lại|thử lại)(?![${WORD}])`, 'iu');
const SEND_ICONS = new Set(['arrow_forward', 'arrow_upward', 'arrow_circle_up', 'send', 'north']);
const NEW_PROJECT = /^\s*(?:create|new|tạo)\s+(?:project|dự án)\s*$/iu;
const UPLOAD_DOWNLOAD_WORDS = /upload|tải lên|attach|đính kèm|download|tải xuống|tải về/iu;
const PURCHASE = /purchase|buy|upgrade|mua thêm|nâng cấp|thanh toán|top[- ]?up|add (?:more )?credits/iu;
// Mục menu không bao giờ được bấm: bản upscale/4K/1080p, GIF 270p, mọi thứ cần nâng cấp.
const FORBIDDEN_MENU = new RegExp(`(?<![${WORD}])(?:4k|2160p|1080p|upscal(?:e|ed|ing)|gif)(?![${WORD}])`, 'iu');

const parts = (c: ControlInfo): string[] => [c.text, c.ariaLabel, c.title, c.value].filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.normalize('NFC'));

export const controlLabel = (c: ControlInfo): string => parts(c).join(' ').trim();

/** Nút gửi/tạo (spend credit hoặc gửi prompt) — chỉ được bấm bằng browser_submit. */
export function isSubmitControl(c: ControlInfo): boolean {
  const p = parts(c);
  if (p.some((x) => NEW_PROJECT.test(x))) return false;
  if (p.some((x) => SUBMIT_VERB.test(x) || RESUBMIT.test(x))) return true;
  if ((c.type ?? '').toLowerCase() === 'submit') return true;
  // Icon ligature (Material Symbols) hoặc nút hành động chính của form prompt; nhãn upload/download loại trừ để không chặn nhầm.
  if (p.some((x) => UPLOAD_DOWNLOAD_WORDS.test(x))) return false;
  const tokens = p.flatMap((x) => x.toLowerCase().split(/\s+/));
  return tokens.some((t) => SEND_ICONS.has(t)) || c.formSubmit === true;
}

const DOWNLOAD_WORDS = /download|tải xuống|tải về|lưu ảnh|lưu video|save (?:image|video)/iu;

/** Nút tải (hoặc mở menu tải). Bấm bằng browser_click vẫn được, nhưng file tải về phải được executor bắt và lưu đúng output của job. */
export function isDownloadControl(c: ControlInfo & { download?: boolean }): boolean {
  return c.download === true || parts(c).some((x) => DOWNLOAD_WORDS.test(x));
}

/**
 * Chặn model lặp cùng một thao tác (cùng tool, cùng tham số) liên tục mà không chụp lại trang: lần thứ `limit` báo lỗi.
 * Snapshot và chờ đặt lại bộ đếm vì chúng cho model trạng thái mới.
 */
export class RepeatGuard {
  private last = '';
  private count = 0;
  constructor(private limit = 3) {}
  check(name: string, args: Record<string, unknown>) {
    if (name === 'browser_snapshot' || name === 'browser_wait') { this.last = ''; this.count = 0; return; }
    const sig = `${name}:${JSON.stringify(args)}`;
    this.count = sig === this.last ? this.count + 1 : 1;
    this.last = sig;
    if (this.count >= this.limit) {
      throw new Error(`REPEATED_ACTION: đã gọi ${name} với cùng tham số ${this.count} lần liên tiếp mà không chụp lại trang. Chụp browser_snapshot để xem kết quả rồi đổi cách làm.`);
    }
  }
}

export interface ActionOptions { control?: ControlInfo; jobType?: string }

/**
 * Shared guard: upload/download/click tools must not become alternative ways to click Generate.
 * `label` là nhãn gộp (cũ); truyền `opts.control` để phân tích từng phần (icon ligature, form).
 */
export function assertBrowserAction(kind: 'click' | 'upload' | 'download', label: string, type: string | null, hasDownload = false, opts: ActionOptions = {}) {
  const control: ControlInfo = { ...(opts.control ?? { text: label }), type: opts.control?.type ?? type };
  const whole = [label, controlLabel(control)].join(' ').normalize('NFC');
  if (PURCHASE.test(whole)) throw new Error('Không tự mua thêm credit hoặc nâng cấp');
  if (FORBIDDEN_MENU.test(whole)) throw new Error('Mục này là bản upscale/4K/1080p/GIF, không phải bản 720p gốc; không được chọn');
  if (isSubmitControl(control)) throw new Error('Thao tác gửi/tạo phải dùng browser_submit và action journal');
  if (kind === 'click' && !whole.trim()) throw new Error('Điều khiển không có nhãn; cần kiểm tra thủ công');
  if (kind === 'upload' && type !== 'file' && !/upload|tải lên|attach|đính kèm|thêm ảnh|add (?:image|file)|choose (?:file|image)/iu.test(whole)) throw new Error('Điều khiển không được xác nhận là upload');
  if (kind === 'download' && !hasDownload && !/download|tải xuống|tải về|lưu ảnh|lưu video|save (?:image|video)/iu.test(whole)
    && !(opts.jobType === 'video' && /^\s*720p\b/iu.test(label.trim() || whole.trim()))) {
    throw new Error('Điều khiển không được xác nhận là download (video chỉ nhận mục 720p Original hoặc nút Download)');
  }
}
