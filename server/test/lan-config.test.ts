import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEXT_JOB_TYPES, assertLanConfig, loadConfig } from '../src/config.js';
import { setEnvValue } from '../src/lib/env.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-lanenv-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('file cấu hình', () => {
  it('setEnvValue: giá trị có ký tự $ không bị hiểu là mẫu thay thế', () => {
    const file = path.join(tmp, 'x.env');
    fs.writeFileSync(file, 'A=1\nB=old\n');
    setEnvValue(file, 'B', 'a$&b');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nB=a$&b\n');
  });
});

describe('cấu hình listener giao diện', () => {
  it('luôn 127.0.0.1:8790; biến của bản web cũ (LAN_HOST, LAN_ENABLED, LAN_REQUIRE_CODE, WORKER_MODE, MANAGED_JOB_TYPES) bị bỏ qua', () => {
    const c = loadConfig({ LAN_ENABLED: 'false', LAN_HOST: '0.0.0.0', LAN_REQUIRE_CODE: 'true', LAN_ACCESS_CODE: 'ABCD2345', WORKER_MODE: 'legacy', MANAGED_JOB_TYPES: 'khong-hop-le' });
    expect(c).toMatchObject({ lanHost: '127.0.0.1', lanPort: 8790, workerMode: 'managed' });
    expect(c.managedJobTypes).toEqual(TEXT_JOB_TYPES);
    expect(loadConfig({ LAN_PORT: '9001' }).lanPort).toBe(9001);
    expect(loadConfig({ LAN_PORT: 'abc' }).lanPort).toBe(8790);
  });

  it('assertLanConfig: cổng hợp lệ và khác PORT', () => {
    const ok = { lanPort: 8790, port: 8787 };
    expect(() => assertLanConfig(ok)).not.toThrow();
    expect(() => assertLanConfig({ ...ok, lanPort: 0 })).toThrow(/LAN_PORT/);
    expect(() => assertLanConfig({ ...ok, lanPort: 70000 })).toThrow(/LAN_PORT/);
    expect(() => assertLanConfig({ ...ok, lanPort: 8787 })).toThrow(/khác PORT/);
  });
});
