import { chromium as base } from 'playwright-core';
import { NO_BROWSER, findBrowser } from './browser.mjs';

/**
 * Thay cho module `playwright` mà @pilio/gemini-watermark-remover nạp (`import('playwright')` rồi `chromium.launch({ headless: true })`):
 * dùng playwright-core với trình duyệt có sẵn trên máy (Edge/Chrome) thay vì Chromium tải riêng của Playwright.
 */
export const chromium = {
  launch(options = {}) {
    const executablePath = findBrowser();
    if (!executablePath) throw new Error(NO_BROWSER);
    return base.launch({ ...options, executablePath });
  },
};

export default { chromium };
