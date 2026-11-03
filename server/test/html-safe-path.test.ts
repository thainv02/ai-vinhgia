import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANIFEST_LIMITS, validateManifest, verifyTree, writeStaging } from '../src/services/html/safe-path.js';
import { CAN_SYMLINK } from './helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-html-sp-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const f = (p: string, content = '<p>x</p>') => ({ path: p, content });
const idx = f('index.html', '<!doctype html><title>Xin chào</title>');
const bad = (files: unknown, re?: RegExp) => {
  try {
    validateManifest(files);
  } catch (e: any) {
    expect(e.code).toBe('INVALID_MANIFEST');
    expect(e.status).toBe(400);
    if (re) expect(e.message).toMatch(re);
    return;
  }
  throw new Error('đáng lẽ phải bị từ chối');
};

describe('validateManifest: đường dẫn', () => {
  it('nhận bộ file hợp lệ, chuẩn hoá NFC và tính kích thước UTF-8 + sha256', () => {
    const out = validateManifest([idx, f('compositions/cảnh-1.html'), f('compositions/Giới_thiệu.v2.html'), f('assets/css/style.css', 'a{b:c}'), f('assets/js/app.js', 'let a=1')]);
    expect(out.map((x) => x.path)).toEqual(['index.html', 'compositions/cảnh-1.html', 'compositions/Giới_thiệu.v2.html', 'assets/css/style.css', 'assets/js/app.js']);
    expect(out[0]!.bytes).toBe(Buffer.byteLength(idx.content));
    expect(out[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // NFD (a + dấu) được đưa về NFC
    const nfd = validateManifest([idx, f('compositions/cảnh.html'.normalize('NFD'))]);
    expect(nfd[1]!.path).toBe('compositions/cảnh.html'.normalize('NFC'));
  });

  it.each([
    ['tuyệt đối', '/etc/passwd', /tuyệt đối/],
    ['UNC', '//server/share/x.html', /tuyệt đối/],
    ['UNC backslash', '\\\\server\\share\\x.html', /gạch ngược/],
    ['ổ đĩa', 'C:/x.html', /":"/],
    ['ổ đĩa tương đối', 'C:foo.html', /":"/],
    ['..', 'compositions/../x.html', /"\.\."/],
    ['.. đầu', '../index.html', /"\.\."/],
    ['backslash', 'compositions\\x.html', /gạch ngược/],
    ['ADS', 'compositions/a.html:stream', /":"/],
    ['ADS index', 'index.html::$DATA', /":"/],
    ['thiết bị aux', 'compositions/aux.html', /Windows/],
    ['thiết bị CON hoa', 'compositions/CON.html', /Windows/],
    ['thiết bị com1', 'compositions/com1.html', /Windows/],
    ['thiết bị lpt9 có đuôi phụ', 'compositions/lpt9.x.html', /Windows/],
    ['thiết bị nul css', 'assets/css/NUL.css', /Windows/],
    ['dấu chấm cuối', 'compositions/a.html.', /chấm/],
    ['khoảng trắng cuối', 'compositions/a.html ', /khoảng trắng/],
    ['khoảng trắng trong tên', 'compositions/a b.html', /không cho phép/],
    ['điều khiển', 'compositions/a\u0001.html', /điều khiển/],
    ['NUL', 'compositions/a\u0000.html', /điều khiển/],
    ['RTL override', 'compositions/a\u202e.html', /điều khiển/],
    ['rỗng', '', /rỗng/],
    ['thành phần rỗng', 'compositions//a.html', /rỗng/],
    ['dấu chấm đầu', 'compositions/.hidden.html', /không cho phép/],
    ['quá sâu', 'compositions/a/b/c.html', /quá sâu/],
    ['thư mục lạ', 'vendor/x.js', /danh sách cho phép/],
    ['đuôi sai thư mục', 'compositions/x.js', /danh sách cho phép/],
    ['css sai chỗ', 'assets/js/x.css', /danh sách cho phép/],
    ['assets/u (của server)', 'assets/u/1.png', /danh sách cho phép/],
    ['file gốc lạ', 'main.js', /danh sách cho phép/],
    ['package.json', 'package.json', /danh sách cho phép/],
    ['tên chỉ có đuôi', 'compositions/.html', /không cho phép/],
    ['ký tự đặc biệt', 'compositions/a;b.html', /không cho phép/],
    ['quá dài', `compositions/${'a'.repeat(70)}.html`, /quá dài/],
  ])('từ chối %s', (_n, p, re) => bad([idx, f(p as string)], re as RegExp));

  it('từ chối trùng tên không phân biệt hoa thường (kể cả index.HTML và NFD/NFC)', () => {
    bad([f('index.HTML')], /danh sách cho phép/); // đuôi sai chữ hoa không được nhận
    bad([idx, f('index.HTML')], /Trùng tên/);
    bad([idx, f('compositions/A.html'), f('compositions/a.html')], /Trùng tên/);
    bad([idx, f('compositions/Cảnh.html'), f('compositions/CẢNH.html')], /Trùng tên/);
    bad([idx, f('compositions/cảnh.html'.normalize('NFD')), f('compositions/cảnh.html'.normalize('NFC'))], /Trùng tên/);
  });

  it('thiếu index.html, rỗng, sai kiểu', () => {
    bad([f('compositions/a.html')], /Thiếu index\.html/);
    bad([], /rỗng/);
    bad('x');
    bad([{ path: 'index.html' }], /content/);
    bad([{ path: 5, content: 'x' }], /chuỗi/);
    bad([{ path: 'index.html', content: 'a\u0000b' }], /NUL/);
  });
});

describe('validateManifest: giới hạn', () => {
  it('tối đa 40 file', () => {
    const many = Array.from({ length: MANIFEST_LIMITS.maxFiles - 1 }, (_, i) => f(`compositions/c${i}.html`));
    expect(validateManifest([idx, ...many])).toHaveLength(MANIFEST_LIMITS.maxFiles);
    bad([idx, ...many, f('compositions/thua.html')], /Quá nhiều file/);
  });
  it('tối đa 256 KB mỗi file (tính theo byte UTF-8) và 1,5 MB tổng', () => {
    expect(validateManifest([f('index.html', 'a'.repeat(MANIFEST_LIMITS.maxFileBytes))])).toHaveLength(1);
    bad([f('index.html', 'a'.repeat(MANIFEST_LIMITS.maxFileBytes + 1))], /quá lớn/);
    bad([f('index.html', 'ế'.repeat(100_000))], /quá lớn/); // 3 byte/ký tự = 300 KB
    const chunk = 'b'.repeat(MANIFEST_LIMITS.maxFileBytes);
    bad([idx, ...Array.from({ length: 7 }, (_, i) => f(`compositions/c${i}.html`, chunk))], /Tổng dung lượng/); // 7*256KB = 1.75MB
    expect(validateManifest([idx, ...Array.from({ length: 5 }, (_, i) => f(`compositions/c${i}.html`, chunk))])).toHaveLength(6);
  });
});

describe('writeStaging / verifyTree', () => {
  it('ghi đúng cây thư mục, trả manifest, và verifyTree khớp', () => {
    const dir = path.join(tmp, 'staging', '1-1');
    const files = validateManifest([idx, f('compositions/cảnh-1.html', '<p>Việt</p>'), f('assets/css/a.css', 'a{}')]);
    const manifest = writeStaging(dir, files);
    expect(manifest.map((m) => m.path)).toEqual(['index.html', 'compositions/cảnh-1.html', 'assets/css/a.css']);
    expect(fs.readFileSync(path.join(dir, 'compositions', 'cảnh-1.html'), 'utf8')).toBe('<p>Việt</p>');
    expect(() => verifyTree(dir, manifest)).not.toThrow();
  });

  it('không ghi đè staging có sẵn và dọn khi lỗi', () => {
    const dir = path.join(tmp, 'staging', '1-1');
    const files = validateManifest([idx]);
    writeStaging(dir, files);
    expect(() => writeStaging(dir, files)).toThrow(/EEXIST/);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true); // thư mục cũ không bị đụng tới
    const sub = path.join(tmp, 'staging', '1-2');
    expect(() => writeStaging(sub, [{ ...files[0]!, path: 'compositions/../../x.html' }])).toThrow(); // lỗi giữa chừng → staging của lần này bị dọn
    expect(fs.existsSync(sub)).toBe(false);
  });

  it('verifyTree phát hiện file lạ, sửa nội dung, thiếu file; cho phép assets/u do server chụp', () => {
    const dir = path.join(tmp, 'staging', '2-1');
    const manifest = writeStaging(dir, validateManifest([idx]));
    fs.mkdirSync(path.join(dir, 'assets', 'u'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'u', '1.png'), 'png');
    expect(() => verifyTree(dir, manifest)).not.toThrow();
    fs.writeFileSync(path.join(dir, 'extra.js'), 'x');
    expect(() => verifyTree(dir, manifest)).toThrow(/ngoài manifest/);
    fs.rmSync(path.join(dir, 'extra.js'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'khác');
    expect(() => verifyTree(dir, manifest)).toThrow(/không khớp/);
    fs.rmSync(path.join(dir, 'index.html'));
    expect(() => verifyTree(dir, manifest)).toThrow(/Thiếu file/);
  });

  it.skipIf(!CAN_SYMLINK)('verifyTree từ chối symlink/junction trong cây', () => {
    const dir = path.join(tmp, 'staging', '3-1');
    const manifest = writeStaging(dir, validateManifest([idx]));
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, 'assets'), 'junction');
    expect(() => verifyTree(dir, manifest)).toThrow(/liên kết tượng trưng/);
  });
});
