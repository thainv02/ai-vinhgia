import { describe, expect, it } from 'vitest';
import { assertBrowserAction, isAllowedBrowserUrl } from '../../worker/src/browser-policy.js';

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
