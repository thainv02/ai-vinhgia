/**
 * Sao chép văn bản vào clipboard. Trang LAN chạy trên HTTP thuần (http://192.168.x.x), KHÔNG phải secure context nên
 * `navigator.clipboard` không tồn tại: dùng `document.execCommand('copy')` với textarea tạm làm phương án dự phòng.
 * Trả true nếu đã chép.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* bị từ chối quyền: thử phương án dự phòng */
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  // ngoài màn hình nhưng vẫn chọn được (iOS cần phần tử hiển thị); cỡ chữ 16px để iOS không phóng to
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    active?.focus?.({ preventScroll: true });
  }
}
