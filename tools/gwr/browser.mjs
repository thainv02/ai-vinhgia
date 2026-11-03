import fs from 'node:fs';
import path from 'node:path';

/**
 * Trình duyệt Chromium có sẵn trên máy để chạy trang xoá logo (WebCodecs + WASM) ở chế độ ẩn, không phải tải Chromium riêng:
 * `GWR_BROWSER_PATH` → Edge (luôn có trên Windows 10/11) → Chrome. Trả đường dẫn file chạy, hoặc null nếu không có.
 */
export function browserCandidates(platform = process.platform, env = process.env) {
  const list = [];
  if (env.GWR_BROWSER_PATH) list.push(env.GWR_BROWSER_PATH);
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) list.push(path.win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const r of roots) list.push(path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return list;
}

export function findBrowser(platform = process.platform, env = process.env) {
  return browserCandidates(platform, env).find((p) => fs.existsSync(p)) ?? null;
}

export const NO_BROWSER = 'Không tìm thấy trình duyệt Microsoft Edge hoặc Google Chrome để xoá logo (đặt GWR_BROWSER_PATH nếu cài ở chỗ khác)';
