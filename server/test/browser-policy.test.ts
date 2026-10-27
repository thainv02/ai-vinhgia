import { describe, expect, it } from 'vitest';
import { RepeatGuard, assertBrowserAction, isAllowedBrowserUrl, isDownloadControl, isLoginPage, isSubmitControl, requiredSite } from '../../worker/src/browser-policy.js';

describe('download controls và lặp thao tác', () => {
  it('nhận nút tải theo nhãn thật của ChatGPT/Flow, không nhầm nút khác', () => {
    expect(isDownloadControl({ ariaLabel: 'Download' })).toBe(true);
    expect(isDownloadControl({ text: '', ariaLabel: 'Download this image' })).toBe(true);
    expect(isDownloadControl({ text: 'x', download: true } as never)).toBe(true);
    for (const label of ['Generated image 1', 'Share generated image 1', 'Copy image', 'Open in side panel', 'Close viewer']) {
      expect(isDownloadControl({ ariaLabel: label })).toBe(false);
    }
  });
  it('lần thứ 3 cùng tool + tham số bị chặn; snapshot/wait hoặc tham số khác đặt lại bộ đếm', () => {
    const g = new RepeatGuard();
    g.check('browser_click', { ref: 79 });
    g.check('browser_click', { ref: 79 });
    expect(() => g.check('browser_click', { ref: 79 })).toThrow(/REPEATED_ACTION/);
    g.check('browser_snapshot', {});
    g.check('browser_click', { ref: 79 });
    g.check('browser_click', { ref: 80 });
    g.check('browser_click', { ref: 79 });
    g.check('browser_wait', { seconds: 10 });
    g.check('browser_click', { ref: 79 });
    expect(() => g.check('browser_click', { ref: 79 })).not.toThrow();
  });
});

describe('browser site boundaries', () => {
  it('accepts the logged-in Flow project after redirect from the legacy entrypoint', () => {
    for (const url of ['https://chatgpt.com/', 'https://flow.google.com/project/example', 'https://labs.google/fx/tools/flow/project/example']) {
      expect(isAllowedBrowserUrl(url)).toBe(true);
    }
  });
  it('rejects other sites, deceptive URLs and malformed input', () => {
    for (const url of ['http://flow.google.com/', 'https://flow.google.com.evil.test/', 'https://flow.google.com@evil.test/', 'https://user@flow.google.com/', 'https://flow.google.com:8443/', 'https://labs.google/other', 'https://accounts.google.com/', 'javascript:alert(1)', 'invalid']) {
      expect(isAllowedBrowserUrl(url)).toBe(false);
    }
  });
});

describe('browser tools cannot bypass generation journal', () => {
  it('rejects generation through ordinary click, upload or download', () => {
    for (const label of ['Generate', 'Send prompt', 'Tạo video', 'Create', 'Gửi']) {
      for (const kind of ['click', 'upload', 'download'] as const) expect(() => assertBrowserAction(kind, label, 'button', true)).toThrow();
    }
  });
  it('rejects purchases and unnamed ordinary clicks', () => {
    expect(() => assertBrowserAction('click', 'Buy more credits', 'button')).toThrow();
    expect(() => assertBrowserAction('click', '', 'button')).toThrow();
  });
  it('accepts identifiable upload/download and project controls', () => {
    expect(() => assertBrowserAction('upload', 'Upload images', 'button')).not.toThrow();
    expect(() => assertBrowserAction('upload', '', 'file')).not.toThrow();
    expect(() => assertBrowserAction('download', 'Download', 'button')).not.toThrow();
    expect(() => assertBrowserAction('download', '', 'button', true)).not.toThrow();
    expect(() => assertBrowserAction('click', 'Create project', 'button')).not.toThrow();
    expect(() => assertBrowserAction('upload', 'Settings', 'button')).toThrow();
  });
});

describe('F1: chỉ động từ gửi/tạo đứng riêng mới là submit', () => {
  const real = ['Generated image 1', 'Share generated image 1', 'Edit generated image 1'];
  it('nhãn thật của ChatGPT không bị coi là gửi/tạo', () => {
    for (const label of real) {
      expect(isSubmitControl({ ariaLabel: label }), label).toBe(false);
      expect(() => assertBrowserAction('click', label, 'button')).not.toThrow();
      expect(() => assertBrowserAction('click', label, 'button', false, { control: { text: '', ariaLabel: label, type: 'button' } })).not.toThrow();
    }
    expect(isSubmitControl({ text: 'Generating will use 15 credits' })).toBe(false);
    expect(isSubmitControl({ text: 'Resend email' })).toBe(true); // resend là gửi lại: vẫn qua journal
  });
  it('vẫn chặn động từ đứng riêng, tiếng Việt, tạo lại/gửi lại và ký tự hoa/thường', () => {
    for (const label of ['Generate', 'GENERATE video', 'Send prompt', 'Submit', 'Create', 'create', 'Gửi', 'GỬI tin nhắn', 'Tạo video', 'Tạo', 'Regenerate', 'Try again', 'Tạo lại', 'Generate (1 credit)']) {
      expect(isSubmitControl({ text: label }), label).toBe(true);
      expect(() => assertBrowserAction('click', label, 'button'), label).toThrow(/browser_submit/);
    }
  });
  it('icon ligature gửi, type=submit và nút submit mặc định trong form prompt là nút gửi', () => {
    for (const icon of ['arrow_forward', 'arrow_upward', 'send', 'north']) {
      expect(isSubmitControl({ text: icon }), icon).toBe(true);
      expect(isSubmitControl({ text: `${icon}\nCreate` })).toBe(true);
    }
    expect(isSubmitControl({ text: '', type: 'submit' })).toBe(true);
    expect(isSubmitControl({ text: 'Tools', formSubmit: true })).toBe(true);
    expect(isSubmitControl({ text: 'Upload media arrow_upward' })).toBe(false); // nhãn upload loại trừ icon mơ hồ
    expect(isSubmitControl({ text: 'Settings', formSubmit: false })).toBe(false);
    expect(isSubmitControl({ text: 'New project' })).toBe(false);
    expect(isSubmitControl({ text: 'add_2 New project', ariaLabel: 'New project' })).toBe(false);
  });
  it('vẫn chặn mua/nâng cấp và các mục tải upscale/4K/1080p/GIF', () => {
    for (const label of ['Buy more credits', 'Upgrade plan', '4K (Upgrade)', 'Nâng cấp']) expect(() => assertBrowserAction('click', label, 'button'), label).toThrow(/mua|nâng cấp|upscale/i);
    for (const label of ['1080p Upscaled', '4K', '270p GIF']) {
      expect(() => assertBrowserAction('download', label, 'button', false, { jobType: 'video' }), label).toThrow();
      expect(() => assertBrowserAction('click', label, 'button'), label).toThrow();
    }
  });
  it('download: nút Download/Tải xuống và mục 720p Original (chỉ video) được phép; mục khác không', () => {
    expect(() => assertBrowserAction('click', 'Download', 'button')).not.toThrow();
    expect(() => assertBrowserAction('click', 'Tải xuống', 'button')).not.toThrow();
    expect(() => assertBrowserAction('download', '720p Original', 'menuitem', false, { jobType: 'video' })).not.toThrow();
    expect(() => assertBrowserAction('download', '720p Original', 'menuitem', false, { jobType: 'storyboard' })).toThrow(/download/);
    expect(() => assertBrowserAction('download', 'Settings', 'button', false, { jobType: 'video' })).toThrow(/download/);
  });
});

describe('F1: site theo loại job', () => {
  it('storyboard chỉ chatgpt.com; video chỉ Flow; không có loại job thì chấp nhận cả hai', () => {
    expect(requiredSite('storyboard')).toBe('chatgpt');
    expect(requiredSite('video')).toBe('flow');
    expect(requiredSite('analyze_brief')).toBeNull();
    const chat = 'https://chatgpt.com/c/1', flow = 'https://flow.google.com/project/x', labs = 'https://labs.google/fx/tools/flow/project/y';
    expect([chat, flow, labs].map((u) => isAllowedBrowserUrl(u, 'storyboard'))).toEqual([true, false, false]);
    expect([chat, flow, labs].map((u) => isAllowedBrowserUrl(u, 'video'))).toEqual([false, true, true]);
    expect([chat, flow, labs].map((u) => isAllowedBrowserUrl(u))).toEqual([true, true, true]);
    expect(isAllowedBrowserUrl(chat, 'analyze_brief')).toBe(false); // loại job không dùng browser → không site nào hợp lệ
  });
});

describe('trang đăng nhập khác trang ngoài site', () => {
  it('chỉ trang đăng nhập là LOGIN_REQUIRED', () => {
    for (const u of ['https://accounts.google.com/v3/signin', 'https://auth.openai.com/log-in', 'https://example.auth0.com/u/login', 'https://x.test/login']) expect(isLoginPage(u), u).toBe(true);
    for (const u of ['https://example.org/', 'about:blank', 'chrome://newtab/', 'not a url']) expect(isLoginPage(u), u).toBe(false);
  });
});
