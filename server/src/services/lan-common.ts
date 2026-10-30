/** Hằng số và hàm nhỏ dùng chung của các dịch vụ LAN (tách ra để lan-plans / lan-video / lan-final / lan-tools không import vòng tròn). */
import type { AppContext } from '../context.js';
import type { SceneRow } from '../db/types.js';
import { activeJobOf } from './rules.js';

/** Giá trị `assets.meta.source` của storyboard/video do người dùng LAN tải lên; chỉ các asset này được phục vụ qua listener LAN. */
export const LAN_UPLOAD_SOURCE = 'lan_upload';

/** URL tệp trên listener LAN (khác `/files/...` của app chính). */
export const lanFileUrl = (filePath: string): string => '/lan/files/' + filePath.split('/').map(encodeURIComponent).join('/');

const BUSY_STATUSES = new Set(['storyboard_queued', 'storyboard_running', 'video_queued', 'video_running']);

/** Lý do chưa thể tải storyboard/video lên cho cảnh (null = được). Chủ máy đang sản xuất cảnh này thì LAN không chen vào. */
export function storyboardUploadBlock(ctx: AppContext, scene: SceneRow): string | null {
  if (activeJobOf(ctx, scene.id) || BUSY_STATUSES.has(scene.status)) {
    return 'Chủ máy đang sản xuất cảnh này trên app chính, chưa thể tải storyboard lên lúc này.';
  }
  return null;
}

/** Bỏ đường dẫn tuyệt đối khỏi thông báo lỗi trước khi gửi cho người dùng LAN (stderr của tool có thể chứa đường dẫn trên máy chủ). */
export function scrubForLan(message: string | null, fallback: string): string | null {
  if (!message) return null;
  if (/(^|[\s'"(=])(\/[\w.@~+-]+){2,}/.test(message) || /[A-Za-z]:\\/.test(message)) return fallback;
  return message.length > 300 ? message.slice(0, 297) + '…' : message;
}
