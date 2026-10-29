import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRotatingLog } from '../src/lib/log-file.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-log-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('log file xoay vòng', () => {
  it('ghi vào file, quá dung lượng thì xoay vòng và chỉ giữ tối đa `files` file', () => {
    const file = path.join(tmp, 'logs', 'server.log');
    const log = createRotatingLog(file, 100, 3);
    for (let i = 0; i < 20; i++) log.stream.write(JSON.stringify({ i, pad: 'x'.repeat(30) }) + '\n');
    log.close();
    const names = fs.readdirSync(path.join(tmp, 'logs')).sort();
    expect(names).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    // dòng mới nhất nằm ở file hiện tại, không file nào vượt giới hạn quá một dòng
    expect(fs.readFileSync(file, 'utf8')).toContain('"i":19');
    for (const n of names) expect(fs.statSync(path.join(tmp, 'logs', n)).size).toBeLessThanOrEqual(100);
  });

  it('mở lại file có sẵn thì ghi tiếp (không ghi đè)', () => {
    const file = path.join(tmp, 'server.log');
    fs.writeFileSync(file, 'dòng cũ\n');
    const log = createRotatingLog(file);
    log.stream.write('dòng mới\n');
    log.close();
    expect(fs.readFileSync(file, 'utf8')).toBe('dòng cũ\ndòng mới\n');
  });
});
