import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAN_MIN_ACCESS_CODE_LENGTH, assertLanConfig, defaultConfig, loadConfig, parseRequireCode } from '../src/config.js';
import { LAN_CODE_ALPHABET, ensureLanAccessCode, ensureWorkerToken, generateLanAccessCode, setEnvValue } from '../src/lib/env.js';
import { lanAddresses } from '../src/routes/lan-info.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-lanenv-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('mã truy cập LAN', () => {
  it('sinh 8 ký tự dễ đọc (không I/O/0/1), ngẫu nhiên', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const code = generateLanAccessCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(300);
    expect(LAN_CODE_ALPHABET).toHaveLength(32);
    expect(generateLanAccessCode(12)).toHaveLength(12);
  });

  it('ensureLanAccessCode: ghi vào .env (0600) khi thiếu, giữ nguyên các dòng khác; có sẵn thì không đổi', () => {
    const file = path.join(tmp, '.env');
    fs.writeFileSync(file, 'PORT=8787\nWORKER_TOKEN=abc\nLAN_ENABLED=true\nLAN_ACCESS_CODE=\n# ghi chú\n');
    const env: NodeJS.ProcessEnv = {};
    const code = ensureLanAccessCode(file, env);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(env.LAN_ACCESS_CODE).toBe(code);
    expect(fs.readFileSync(file, 'utf8')).toBe(`PORT=8787\nWORKER_TOKEN=abc\nLAN_ENABLED=true\nLAN_ACCESS_CODE=${code}\n# ghi chú\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // gọi lại: trả mã có sẵn, không ghi lại
    const before = fs.readFileSync(file, 'utf8');
    expect(ensureLanAccessCode(file, env)).toBe(code);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('ensureLanAccessCode: file chưa có → tạo; thiếu xuống dòng cuối → thêm đúng; không làm hỏng WORKER_TOKEN', () => {
    const file = path.join(tmp, 'moi.env');
    const code = ensureLanAccessCode(file, {});
    expect(fs.readFileSync(file, 'utf8')).toContain(`LAN_ACCESS_CODE=${code}\n`);
    const file2 = path.join(tmp, 'khong-newline.env');
    fs.writeFileSync(file2, 'PORT=1');
    const env: NodeJS.ProcessEnv = {};
    ensureWorkerToken(file2, env);
    const c2 = ensureLanAccessCode(file2, env);
    const text = fs.readFileSync(file2, 'utf8');
    expect(text).toMatch(/^PORT=1\nWORKER_TOKEN=[0-9a-f]{48}\nLAN_ACCESS_CODE=[A-Z2-9]{8}\n$/);
    expect(text).toContain(c2);
  });

  it('setEnvValue: giá trị có ký tự $ không bị hiểu là mẫu thay thế', () => {
    const file = path.join(tmp, 'x.env');
    fs.writeFileSync(file, 'A=1\nB=old\n');
    setEnvValue(file, 'B', 'a$&b');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nB=a$&b\n');
  });
});

describe('cấu hình LAN', () => {
  it('mặc định TẮT, 0.0.0.0:8790, không có mã', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ lanEnabled: false, lanHost: '0.0.0.0', lanPort: 8790, lanAccessCode: '', lanAllowedHosts: [] });
    expect(defaultConfig('/r', '/r/db').lanEnabled).toBe(false);
  });

  it('chỉ bật khi giá trị truthy rõ ràng; gõ sai thì vẫn tắt', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) expect(loadConfig({ LAN_ENABLED: v }).lanEnabled, v).toBe(true);
    for (const v of ['', 'false', '0', 'no', 'off', 'ture', 'enabled', 'y']) expect(loadConfig({ LAN_ENABLED: v }).lanEnabled, v).toBe(false);
  });

  it('đọc LAN_HOST, LAN_PORT, LAN_ACCESS_CODE (cắt khoảng trắng), LAN_ALLOWED_HOSTS (chữ thường)', () => {
    const c = loadConfig({ LAN_ENABLED: 'true', LAN_HOST: '192.168.1.5', LAN_PORT: '9001', LAN_ACCESS_CODE: '  ABCD2345 ', LAN_ALLOWED_HOSTS: 'Video.Cty.vn, may-chu.lan ,' });
    expect(c).toMatchObject({ lanEnabled: true, lanHost: '192.168.1.5', lanPort: 9001, lanAccessCode: 'ABCD2345', lanAllowedHosts: ['video.cty.vn', 'may-chu.lan'] });
    expect(loadConfig({ LAN_PORT: 'abc' }).lanPort).toBe(8790);
  });

  it('assertLanConfig: tắt thì bỏ qua; bật phải có mã đủ dài, cổng hợp lệ và khác PORT', () => {
    const ok = { lanEnabled: true, lanRequireCode: true, lanPort: 8790, lanAccessCode: 'ABCD2345', port: 8787 };
    expect(() => assertLanConfig(ok)).not.toThrow();
    expect(() => assertLanConfig({ ...ok, lanEnabled: false, lanAccessCode: '', lanPort: 0 })).not.toThrow();
    expect(() => assertLanConfig({ ...ok, lanAccessCode: 'x'.repeat(LAN_MIN_ACCESS_CODE_LENGTH - 1) })).toThrow(/ít nhất/);
    expect(() => assertLanConfig({ ...ok, lanAccessCode: '' })).toThrow(/LAN_ACCESS_CODE/);
    expect(() => assertLanConfig({ ...ok, lanPort: 0 })).toThrow(/LAN_PORT/);
    expect(() => assertLanConfig({ ...ok, lanPort: 70000 })).toThrow(/LAN_PORT/);
    expect(() => assertLanConfig({ ...ok, lanPort: 8787 })).toThrow(/khác PORT/);
  });

  it('LAN_REQUIRE_CODE: mặc định KHÔNG đòi mã; chỉ false/0/no/off (và trống) là không đòi; giá trị lạ/gõ sai ĐÒI mã (không âm thầm mở trang ra mạng)', () => {
    expect(defaultConfig('/r', '/r/db').lanRequireCode).toBe(false);
    expect(loadConfig({}).lanRequireCode).toBe(false);
    for (const v of [undefined, '', '  ', 'false', 'FALSE', '0', 'no', 'off', ' off ']) expect(parseRequireCode(v), String(v)).toBe(false);
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', 'treu', 'flase', 'enabled', 'y']) expect(parseRequireCode(v), v).toBe(true);
    expect(loadConfig({ LAN_REQUIRE_CODE: 'true', LAN_ACCESS_CODE: 'ABCD2345' })).toMatchObject({ lanRequireCode: true, lanAccessCode: 'ABCD2345' });
  });

  it('assertLanConfig: không đòi mã thì KHÔNG cần LAN_ACCESS_CODE (kể cả trống/yếu); đòi mã thì mã phải đủ dài; cổng vẫn được kiểm tra', () => {
    const open = { lanEnabled: true, lanRequireCode: false, lanPort: 8790, lanAccessCode: '', port: 8787 };
    expect(() => assertLanConfig(open)).not.toThrow();
    expect(() => assertLanConfig({ ...open, lanAccessCode: 'x' })).not.toThrow();
    expect(() => assertLanConfig({ ...open, lanRequireCode: true })).toThrow(/LAN_REQUIRE_CODE=true.*LAN_ACCESS_CODE/);
    expect(() => assertLanConfig({ ...open, lanRequireCode: true, lanAccessCode: 'x'.repeat(LAN_MIN_ACCESS_CODE_LENGTH - 1) })).toThrow(/ít nhất/);
    expect(() => assertLanConfig({ ...open, lanPort: 8787 })).toThrow(/khác PORT/);
    expect(() => assertLanConfig({ ...open, lanPort: 0 })).toThrow(/LAN_PORT/);
  });

  it('lanAddresses chỉ trả IPv4 không loopback, không link-local', () => {
    for (const a of lanAddresses()) {
      expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(a.startsWith('127.')).toBe(false);
      expect(a.startsWith('169.254.')).toBe(false);
    }
  });
});
