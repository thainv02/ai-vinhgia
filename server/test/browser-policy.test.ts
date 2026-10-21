import { describe, expect, it } from 'vitest';
import { assertBrowserAction } from '../../worker/src/browser-policy.js';

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
