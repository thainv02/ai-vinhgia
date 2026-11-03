import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error module JS của tools/gwr, không có khai báo kiểu
import { browserCandidates, findBrowser } from '../../tools/gwr/browser.mjs';
// @ts-expect-error module JS của tools/gwr, không có khai báo kiểu
import { parseArgs } from '../../tools/gwr/gwr.mjs';
import { GWR_CLI } from './helpers-gwr.js';

describe('tools/gwr: tìm trình duyệt có sẵn', () => {
  it('Windows: GWR_BROWSER_PATH trước, rồi Edge (Program Files x86, Program Files, LocalAppData), rồi Chrome', () => {
    const env = { GWR_BROWSER_PATH: 'D:\\Browsers\\edge.exe', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    expect(browserCandidates('win32', env)).toEqual([
      'D:\\Browsers\\edge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('chỉ trả đường dẫn có thật; không có trình duyệt nào → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwr-browser-'));
    const fake = path.join(dir, 'browser');
    fs.writeFileSync(fake, '');
    expect(findBrowser('linux', { GWR_BROWSER_PATH: fake })).toBe(fake);
    expect(findBrowser('win32', { GWR_BROWSER_PATH: path.join(dir, 'khong-co'), ProgramFiles: path.join(dir, 'pf') })).toBeNull();
  });
});

describe('tools/gwr: dòng lệnh tương thích server', () => {
  it('đọc tham số remove; chặn file không phải video, số âm, tham số lạ', () => {
    expect(parseArgs(['in.mp4', '--output', 'out.mp4', '--json', '--video-bitrate-mbps', '12', '--video-timeout-ms', '60000'])).toEqual({
      input: 'in.mp4', output: 'out.mp4', json: true, overwrite: false, timeoutMs: 60000, bitrateMbps: 12,
    });
    expect(() => parseArgs(['in.png', '--output', 'o.png'])).toThrow(/Chỉ hỗ trợ video/);
    expect(() => parseArgs(['in.mp4', '--output', 'o.mp4', '--video-timeout-ms', '-1'])).toThrow(/số dương/);
    expect(() => parseArgs(['in.mp4', '--output', 'o.mp4', '--video-page', 'x'])).toThrow(/không hỗ trợ/);
    expect(() => parseArgs(['in.mp4'])).toThrow(/Usage/);
  });

  it('--help thoát 0 khi máy có Edge/Chrome; remove báo thiếu input (mã 3), file ra đã có (mã 2) mà không mở trình duyệt', () => {
    const run = (args: string[]) => spawnSync(process.execPath, [GWR_CLI, ...args], { encoding: 'utf8' });
    if (findBrowser()) expect(run(['--help']).status).toBe(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwr-cli-'));
    expect(run(['remove', path.join(dir, 'khong-co.mp4'), '--output', path.join(dir, 'o.mp4')]).status).toBe(3);
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    fs.writeFileSync(path.join(dir, 'o.mp4'), 'x');
    const r = run(['remove', path.join(dir, 'a.mp4'), '--output', path.join(dir, 'o.mp4')]);
    expect([r.status, r.stderr]).toEqual([2, expect.stringMatching(/already exists/)]);
  });
});
