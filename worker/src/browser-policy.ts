/** Exact HTTPS origins used by ChatGPT and both current/legacy Flow entrypoints. */
export function isAllowedBrowserUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    return u.hostname === 'chatgpt.com' || u.hostname === 'flow.google.com' ||
      (u.hostname === 'labs.google' && u.pathname.startsWith('/fx/'));
  } catch { return false; }
}

/** Shared guard: upload/download tools must not become alternative ways to click Generate. */
export function assertBrowserAction(kind: 'click' | 'upload' | 'download', label: string, type: string | null, hasDownload = false) {
  if (/purchase|buy|upgrade|mua thêm|nâng cấp|thanh toán/i.test(label)) throw new Error('Không tự mua thêm credit hoặc nâng cấp');
  const newProject = /^\s*(?:create|new|tạo)\s+(?:project|dự án)\s*$/i.test(label);
  const submit = !newProject && (/generate|send|gửi|tạo|submit|create/i.test(label) || type === 'submit');
  if (submit) throw new Error('Thao tác gửi/tạo phải dùng browser_submit và action journal');
  if (kind === 'click' && !label.trim()) throw new Error('Điều khiển không có nhãn; cần kiểm tra thủ công');
  if (kind === 'upload' && type !== 'file' && !/upload|tải lên|attach|đính kèm|thêm ảnh|add (?:image|file)|choose (?:file|image)/i.test(label)) throw new Error('Điều khiển không được xác nhận là upload');
  if (kind === 'download' && !hasDownload && !/download|tải xuống|tải về|lưu ảnh|lưu video|save (?:image|video)/i.test(label)) throw new Error('Điều khiển không được xác nhận là download');
}
