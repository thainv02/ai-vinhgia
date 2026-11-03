import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardenArgs, installHardening, launchLog, NETWORK_LOCKDOWN_ARGS } from '../src/services/html/engine-runner.js';
import {
  BROWSER_PIN,
  HTML_CSP,
  HTML_FONT_FILES,
  badUrl,
  browserPath,
  cancelRendererDownload,
  downloadBrowser,
  injectHead,
  installedBrowser,
  lintComposition,
  materialize,
  outputResolutionOf,
  rendererStatus,
  runnerEnv,
  securityLint,
  startRendererDownload,
  type BrowserPin,
} from '../src/services/html/engine/index.js';
import { buildZip } from '../src/services/zip.js';
import { CAN_SYMLINK, PNG_BYTES } from './helpers.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';
import { FIXTURE_INDEX, writeFixture } from './helpers-html-engine.js';

const tmps: string[] = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-eng-unit-'));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const codes = (files: { path: string; content: string }[]) => securityLint(files).map((i) => i.code);
const html = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe('canvas / outputResolution', () => {
  it('preset đúng theo tỉ lệ và chất lượng', () => {
    expect(outputResolutionOf('9:16', '720p')).toBe('portrait-720p');
    expect(outputResolutionOf('9:16', '1080p')).toBe('portrait');
    expect(outputResolutionOf('16:9', '720p')).toBe('landscape-720p');
    expect(outputResolutionOf('1:1', '1080p')).toBe('square');
  });
});

describe('injectHead', () => {
  const src = '<!doctype html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n<title>Ưu đãi</title>\n</head>\n<body><h1>Giảm giá ặệếữ</h1></body>\n</html>';
  it('CSP đứng ngay sau doctype (trước mọi nội dung AI), có @font-face inline, giữ nguyên chữ Việt và số dòng', () => {
    const out = injectHead(src, { mode: 'render' });
    expect(out.startsWith('<!doctype html><meta data-hf-engine http-equiv="Content-Security-Policy"')).toBe(true);
    expect(HTML_CSP).toContain("worker-src 'none'");
    expect(out).toContain(HTML_CSP);
    expect(out).toContain("@font-face{font-family:'Be Vietnam Pro'");
    expect(out).toContain('unicode-range:U+0102-0103');
    expect(out).toContain('Giảm giá ặệếữ');
    expect(out).not.toContain('__hf/runtime.js');
    expect(out.split('\n').length).toBe(src.split('\n').length); // lint dòng không lệch
    expect(HTML_FONT_FILES).toHaveLength(12);
  });
  it('preview/capture thêm runtime; compositions chỉ CSP; luôn chèn (dấu giả của AI không tắt được CSP)', () => {
    const p = injectHead(src, { mode: 'preview', runtimeSrc: '__hf/runtime.js' });
    expect(p).toContain('<script data-hf-engine src="__hf/runtime.js"></script>');
    expect(injectHead('<!-- data-hf-engine --><html><body>x</body></html>', { mode: 'render' })).toMatch(/^<meta data-hf-engine http-equiv="Content-Security-Policy"/);
    const sub = injectHead('<template><div>x</div></template>', { mode: 'preview', base: '../', fonts: false });
    expect(sub).toContain(HTML_CSP);
    expect(sub).not.toContain('@font-face');
    expect(sub).not.toContain('runtime.js');
    expect(injectHead(src, { mode: 'capture', base: '../' })).toContain('src="../__hf/runtime.js"');
  });
  it('không dò <head> của AI: <head> giả trong title/thuộc tính/chú thích, <script> trước <head> đều không đẩy CSP ra sau', () => {
    for (const evil of [
      '<html><body>x</body></html>',
      '<!doctype html><div>x</div>',
      '<!doctype html><html><head><title><head></title></head><body>x</body></html>',
      '<!doctype html><html data-x="<head>"><head></head><body>x</body></html>',
      '<!doctype html><html><script>new WebSocket("ws://x")</script><head></head></html>',
      '<!doctype html><!-- x --!><head></head><body>x</body></html>',
      '﻿<!DOCTYPE html><body><head></head></body>',
    ]) {
      const out = injectHead(evil, { mode: 'render' });
      const at = out.indexOf('<meta data-hf-engine');
      const dt = /^﻿?\s*<!doctype[^>]*>/i.exec(evil)?.[0].length ?? 0;
      expect(at).toBe(dt); // ngay sau doctype, trước MỌI thẻ của AI
    }
  });
});

describe('lint bảo mật', () => {
  const idx = (script: string, body = '') => [{ path: 'index.html', content: html(`${body}<script>${script}</script>`) }];
  it('mã bị cấm', () => {
    const cases: [string, string][] = [
      ["fetch('/lan/api/settings/ai')", 'sec_fetch'],
      ['window.fetch(x)', 'sec_fetch'],
      ["new WebSocket('ws://127.0.0.1:1')", 'sec_websocket'],
      ['var x = new XMLHttpRequest()', 'sec_xhr'],
      ["new EventSource('a')", 'sec_eventsource'],
      ["navigator.sendBeacon('a', 'b')", 'sec_beacon'],
      ["import('./x.js')", 'sec_import'],
      ["import x from './a.js'", 'sec_import'],
      ["eval('1')", 'sec_eval'],
      ["new Function('return 1')", 'sec_eval'],
      ["setTimeout('alert(1)', 5)", 'sec_eval'],
      ["new Worker('a.js')", 'sec_worker'],
      ["navigator.serviceWorker.register('a')", 'sec_worker'],
      ["window.open('http://a')", 'sec_navigation'],
      ["open('https:/'+'/evil')", 'sec_navigation'],
      ["self['open']('x')", 'sec_navigation'],
      ["var s = 'data-hf-engine'", 'sec_engine_mark'],
      ["location.href = 'x'", 'sec_navigation'],
      ["parent.postMessage('x','*')", 'sec_parent'],
      ["localStorage.setItem('a','b')", 'sec_storage'],
      ["var u = 'https://evil.example/x'", 'sec_remote_url_js'],
      ['var r = Math.random()', 'nondeterministic'],
      ['var t = Date.now()', 'nondeterministic'],
    ];
    for (const [js, code] of cases) expect(codes(idx(js)), js).toContain(code);
  });
  it('thuộc tính HTML: URL từ xa, script/link/thẻ cấm', () => {
    const bad: [string, string][] = [
      ['<img src="https://a.com/x.png">', 'sec_remote_url'],
      ['<img src="//a.com/x.png">', 'sec_remote_url'],
      ['<img src="/lan/api/x">', 'sec_remote_url'],
      ['<img src="javascript:alert(1)">', 'sec_remote_url'],
      ['<img src=" Java\tScript:alert(1)">', 'sec_remote_url'],
      ['<a href="http://a.com">x</a>', 'sec_remote_url'],
      ['<video src="blob:abc"></video>', 'sec_remote_url'],
      ['<img srcset="assets/u/1.png 1x, https://a.com/b.png 2x">', 'sec_srcset'],
      ['<img src="assets/u/1.png" onerror="fetch(1)">', 'sec_fetch'],
      ['<iframe src="assets/u/1.png"></iframe>', 'sec_tag'],
      ['<!-- x --!><iframe src="assets/u/1.png"></iframe>', 'sec_tag'],
      ['<!--><iframe src="assets/u/1.png"></iframe>-->', 'sec_tag'],
      ['<form action="a"></form>', 'sec_tag'],
      ['<object data="a"></object>', 'sec_tag'],
      ['<base href="//a.com/">', 'sec_tag'],
      ['<script src="https://cdn.jsdelivr.net/npm/gsap"></script>', 'sec_script_src'],
      ['<script src="vendor/gsap.min.js"></script>', 'sec_script_src'],
      ['<script type="module">1</script>', 'sec_script_type'],
      ['<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">', 'sec_link'],
      ['<link rel="preload" href="assets/css/a.css">', 'sec_link'],
      ['<meta http-equiv="refresh" content="0;url=http://a">', 'sec_meta_http_equiv'],
      ['<div style="background:url(https://a.com/x.png)"></div>', 'sec_css_url'],
    ];
    for (const [b, code] of bad) expect(codes([{ path: 'index.html', content: html(b) }]), b).toContain(code);
    // hợp lệ
    const ok = html('<script src="__hf/gsap.min.js"></script><script src="assets/js/main.js"></script><link rel="stylesheet" href="assets/css/style.css"><img src="assets/u/1.png" srcset="assets/u/1.png 1x"><img src="data:image/png;base64,AAAA"><a href="#x">x</a><div style="background:url(assets/u/1.png)"></div>');
    expect(codes([{ path: 'index.html', content: ok }])).toEqual([]);
  });
  it('CSS: @import, @font-face của AI, url() từ xa, font-family lạ', () => {
    const css = (c: string) => codes([{ path: 'assets/css/a.css', content: c }]);
    expect(css("@import url('https://a.com/a.css');")).toEqual(expect.arrayContaining(['sec_css_import', 'sec_css_url']));
    expect(css('@font-face{font-family:X;src:url(assets/u/1.woff2)}')).toContain('sec_font_face');
    expect(css('.a{background:url("https://a.com/x.png")}')).toContain('sec_css_url');
    expect(css('.a{background:url(//a.com/x.png)}')).toContain('sec_css_url');
    expect(css('.a{background:image-set("https://a.com/x.png" 1x)}')).toContain('sec_css_url');
    expect(css('.a{font-family:"Roboto", sans-serif}')).toContain('font_family_unsupported');
    expect(css('.a{font-family:"Be Vietnam Pro", sans-serif; background:url(assets/u/2.png)}')).toEqual([]);
    expect(codes([{ path: 'index.html', content: html('<p>x</p>', '<style>@import "a.css"; .a{background:url(http://a.com/b.png)}</style>') }])).toEqual(expect.arrayContaining(['sec_css_import', 'sec_css_url']));
  });
  it('chữ tiếng Việt và từ thường không gây dương tính giả', () => {
    const files = [
      { path: 'index.html', content: html('<h1>Ưu đãi – lấy ngay (fetch? không)! Ăn ngon, ngủ khỏe</h1><p>Evaluate eval Worker import</p>', '<style>.t{font-family:"Be Vietnam Pro",sans-serif}</style>') },
      { path: 'assets/js/a.js', content: 'const tl = gsap.timeline({paused:true}); tl.to(".a",{x:10,duration:1}); window.__timelines={main:tl};' },
    ];
    expect(codes(files)).toEqual([]);
  });
  it('badUrl', () => {
    expect(badUrl('assets/u/1.png')).toBeNull();
    expect(badUrl('../__hf/fonts/a.woff2')).toBeNull();
    expect(badUrl('data:image/png;base64,AA')).toBeNull();
    expect(badUrl('data:x', { allowData: false })).not.toBeNull();
    expect(badUrl('&#104;ttp://a.com')).not.toBeNull(); // thực thể HTML
    expect(badUrl('\\\\host\\share')).not.toBeNull();
  });
});

describe('lintComposition (HyperFrames + bảo mật + canvas)', () => {
  it('fixture hợp lệ đạt; canvas/thời lượng sai và mã cấm bị báo', async () => {
    const dir = mk();
    writeFixture(dir);
    const ok = await lintComposition(dir, { aspect: '9:16', durationS: 2 });
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([]);
    expect(ok.checks).toEqual(expect.arrayContaining(['security', 'canvas', 'lint']));

    const bad = await lintComposition(dir, { aspect: '16:9', durationS: 5 });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['canvas_size_mismatch', 'duration_mismatch']));

    fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE_INDEX.replace('window.__timelines["main"] = tl;', 'window.__timelines["main"] = tl; fetch("/lan/api/status");'));
    const evil = await lintComposition(dir, { aspect: '9:16', durationS: 2 });
    expect(evil.ok).toBe(false);
    expect(evil.errors.map((e) => e.code)).toContain('sec_fetch');
  }, 60_000);
});

describe('materialize', () => {
  it('chèn head đúng chỗ, chép __hf, không đụng thư mục phiên bản', async () => {
    const ver = mk();
    fs.mkdirSync(path.join(ver, 'compositions'));
    fs.mkdirSync(path.join(ver, 'assets', 'u'), { recursive: true });
    fs.mkdirSync(path.join(ver, '__hf'));
    fs.writeFileSync(path.join(ver, '__hf', 'gsap.min.js'), 'EVIL');
    fs.writeFileSync(path.join(ver, 'index.html'), FIXTURE_INDEX);
    fs.writeFileSync(path.join(ver, 'compositions', 'cảnh-1.html'), '<template id="a"><div>Cảnh 1</div></template>');
    fs.writeFileSync(path.join(ver, 'assets', 'u', '1.png'), PNG_BYTES);
    const before = fs.readFileSync(path.join(ver, 'index.html'), 'utf8');
    const work = path.join(mk(), 'w');
    await materialize(ver, work, { mode: 'capture' });
    const idx = fs.readFileSync(path.join(work, 'index.html'), 'utf8');
    expect(idx).toContain('data-hf-engine');
    expect(idx).toContain('<script data-hf-engine src="__hf/runtime.js">');
    const sub = fs.readFileSync(path.join(work, 'compositions', 'cảnh-1.html'), 'utf8');
    expect(sub).toContain(HTML_CSP);
    expect(sub).not.toContain('@font-face');
    expect(fs.readFileSync(path.join(work, '__hf', 'gsap.min.js'), 'utf8')).not.toBe('EVIL'); // server cấp, không lấy từ phiên bản
    for (const f of HTML_FONT_FILES) expect(fs.existsSync(path.join(work, '__hf', 'fonts', f))).toBe(true);
    expect(fs.existsSync(path.join(work, '__hf', 'runtime.js'))).toBe(true);
    expect(fs.readFileSync(path.join(work, 'assets', 'u', '1.png')).equals(PNG_BYTES)).toBe(true);
    expect(fs.readFileSync(path.join(ver, 'index.html'), 'utf8')).toBe(before);
    const r = path.join(mk(), 'w2');
    await materialize(ver, r, { mode: 'render' });
    expect(fs.readFileSync(path.join(r, 'index.html'), 'utf8')).not.toContain('runtime.js');
  });
  it.skipIf(!CAN_SYMLINK)('từ chối symlink; thiếu index.html → 409', async () => {
    const ver = mk();
    fs.writeFileSync(path.join(ver, 'index.html'), '<html></html>');
    const target = mk();
    fs.symlinkSync(target, path.join(ver, 'assets'), 'junction');
    await expect(materialize(ver, path.join(mk(), 'w'), { mode: 'render' })).rejects.toMatchObject({ code: 'HTML_UNSAFE_TREE' });
    await expect(materialize(mk(), path.join(mk(), 'w'), { mode: 'render' })).rejects.toMatchObject({ code: 'HTML_VERSION_MISSING' });
  });
});

// ---------------------------------------------------------------- tải trình duyệt (fetch giả + zip giả nhỏ)
describe('tải trình duyệt dựng', () => {
  const zip = buildZip([
    { name: 'chrome-headless-shell-win64/chrome-headless-shell.exe', read: () => Buffer.alloc(4096, 7) },
    { name: 'chrome-headless-shell-win64/LICENSE.headless_shell', read: () => Buffer.from('license') },
  ]);
  const pin: BrowserPin = { ...BROWSER_PIN, version: '0.0.1-test', url: 'https://example.invalid/x.zip', sha256: crypto.createHash('sha256').update(zip).digest('hex'), bytes: zip.length, diskBytes: 5000 };
  const extract = async (_z: string, dest: string) => {
    fs.mkdirSync(path.join(dest, 'chrome-headless-shell-win64'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), 'exe');
  };
  /** fetch giả: phục vụ `data`, hỗ trợ Range; `stallAt` = dừng giữa chừng tới khi abort. */
  const fakeFetch = (data: Buffer, o: { stallAt?: number; ignoreRange?: boolean } = {}) => {
    const calls: { range: string | null }[] = [];
    const fn = (async (_u: unknown, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      calls.push({ range });
      const start = range && !o.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const body = data.subarray(start);
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          const half = o.stallAt && start === 0 ? o.stallAt : body.length;
          c.enqueue(body.subarray(0, half));
          if (half < body.length) {
            await new Promise<void>((_r, rej) => signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
          }
          c.close();
        },
      });
      return new Response(stream, { status: start > 0 ? 206 : 200 });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('thành công: kiểm sha, giải nén, manifest cuối cùng; idempotent', async () => {
    const dir = mk();
    const f = fakeFetch(zip);
    const progress: number[] = [];
    const exe = await downloadBrowser(dir, { pin, fetchImpl: f.fn, extract, onProgress: (r) => progress.push(r) });
    expect(fs.existsSync(exe)).toBe(true);
    expect(installedBrowser(dir, pin)).toBe(exe);
    expect(progress.at(-1)).toBe(zip.length);
    expect(fs.existsSync(path.join(dir, 'downloads', `${pin.version}.zip.part`))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.extract'))).toEqual([]);
    await downloadBrowser(dir, { pin, fetchImpl: f.fn, extract });
    expect(f.calls).toHaveLength(1);
  });
  it('sai sha256: lỗi, xoá .part, không cài', async () => {
    const dir = mk();
    const bad = Buffer.from(zip);
    bad[10] ^= 0xff;
    await expect(downloadBrowser(dir, { pin, fetchImpl: fakeFetch(bad).fn, extract })).rejects.toThrow(/không đúng|SHA256/);
    expect(installedBrowser(dir, pin)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'downloads', `${pin.version}.zip.part`))).toBe(false);
    expect(fs.existsSync(path.join(dir, pin.version))).toBe(false);
  });
  it('hủy giữa chừng giữ .part; tải tiếp bằng Range hoàn tất đúng sha', async () => {
    const dir = mk();
    const ac = new AbortController();
    const f1 = fakeFetch(zip, { stallAt: 1000 });
    const p = downloadBrowser(dir, { pin, fetchImpl: f1.fn, extract, signal: ac.signal, onProgress: (r) => r >= 1000 && ac.abort() });
    await expect(p).rejects.toThrow();
    const part = path.join(dir, 'downloads', `${pin.version}.zip.part`);
    expect(fs.statSync(part).size).toBe(1000);
    expect(installedBrowser(dir, pin)).toBeNull();
    const f2 = fakeFetch(zip);
    const exe = await downloadBrowser(dir, { pin, fetchImpl: f2.fn, extract });
    expect(f2.calls[0]!.range).toBe('bytes=1000-');
    expect(fs.existsSync(exe)).toBe(true);
    // server bỏ qua Range (200): vẫn hoàn tất
    const dir2 = mk();
    fs.mkdirSync(path.join(dir2, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'downloads', `${pin.version}.zip.part`), zip.subarray(0, 500));
    await downloadBrowser(dir2, { pin, fetchImpl: fakeFetch(zip, { ignoreRange: true }).fn, extract });
    expect(installedBrowser(dir2, pin)).toBeTruthy();
  });
  it('giải nén lỗi (thiếu exe) không để lại bản dở', async () => {
    const dir = mk();
    await expect(downloadBrowser(dir, { pin, fetchImpl: fakeFetch(zip).fn, extract: async (_z, d) => void fs.mkdirSync(d, { recursive: true }) })).rejects.toThrow(/chrome-headless-shell/);
    expect(installedBrowser(dir, pin)).toBeNull();
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.extract'))).toEqual([]);
  });
  it.skipIf(process.platform !== 'win32')('giải nén thật bằng tar.exe của Windows', async () => {
    const dir = mk();
    const exe = await downloadBrowser(dir, { pin, fetchImpl: fakeFetch(zip).fn });
    expect(fs.statSync(exe).size).toBe(4096);
  });
});

describe('trạng thái / điều khiển tải / routes (desktop)', () => {
  let L: LanEnv;
  const saved = process.env.HTML_RENDERER_BROWSER;
  beforeAll(async () => {
    delete process.env.HTML_RENDERER_BROWSER;
    L = await makeLanEnv({ config: { htmlRendererDir: path.join(mk(), 'html-renderer') } });
  });
  afterAll(async () => {
    if (saved !== undefined) process.env.HTML_RENDERER_BROWSER = saved;
    await L.close();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('chưa cài: status, browserPath 409 HTML_RENDERER_MISSING', async () => {
    const s = rendererStatus(L.env.ctx);
    expect(s).toMatchObject({ installed: false, version: '152.0.7977.30', download_bytes: 119_527_247, disk_bytes: 281_669_281, download: { state: 'idle' } });
    expect(() => browserPath(L.env.ctx)).toThrowError(expect.objectContaining({ code: 'HTML_RENDERER_MISSING', status: 409, message: expect.stringContaining('Cài đặt') }));
    const r = await L.client().get('/lan/api/settings/html-renderer');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ installed: false, download: { state: 'idle' } });
  });
  it('HTML_RENDERER_BROWSER ghi đè (dev/test)', () => {
    const exe = path.join(mk(), 'chrome.exe');
    fs.writeFileSync(exe, 'x');
    process.env.HTML_RENDERER_BROWSER = exe;
    try {
      expect(browserPath(L.env.ctx)).toBe(path.resolve(exe));
      expect(rendererStatus(L.env.ctx)).toMatchObject({ installed: true, source: 'env' });
    } finally {
      delete process.env.HTML_RENDERER_BROWSER;
    }
  });
  it('POST download chạy nền (không tự tải), cancel → cancelled; có thể thử lại', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', ((_u: unknown, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(1000));
              init?.signal?.addEventListener('abort', () => {
                aborted = true;
                c.error(new DOMException('x', 'AbortError'));
              });
            },
          }),
          { status: 200 },
        ),
      )) as typeof fetch);
    const c = L.client();
    expect((await c.get('/lan/api/settings/html-renderer')).body.download.state).toBe('idle'); // không tự tải
    const r = await c.post('/lan/api/settings/html-renderer/download', {});
    expect(r.status).toBe(200);
    expect(r.body.download.state).toBe('downloading');
    await vi.waitFor(() => expect(rendererStatus(L.env.ctx).download.received).toBe(1000));
    const cancel = await c.post('/lan/api/settings/html-renderer/download/cancel', {});
    expect(cancel.status).toBe(200);
    await vi.waitFor(() => expect(rendererStatus(L.env.ctx).download.state).toBe('cancelled'));
    expect(aborted).toBe(true);
  });
  it('startRendererDownload là no-op khi đã cài', async () => {
    const dir = mk();
    const exe = path.join(dir, BROWSER_PIN.version, ...BROWSER_PIN.exe.split('/'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'x');
    fs.writeFileSync(path.join(dir, BROWSER_PIN.version, 'manifest.json'), JSON.stringify({ version: BROWSER_PIN.version, sha256: BROWSER_PIN.sha256 }));
    const fake = { ...L.env.ctx, config: { ...L.env.ctx.config, htmlRendererDir: dir } } as unknown as typeof L.env.ctx;
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await startRendererDownload(fake);
    cancelRendererDownload(fake);
    expect(f).not.toHaveBeenCalled();
    expect(rendererStatus(fake).installed).toBe(true);
  });
});

describe('runner: env tối thiểu và hardening', () => {
  beforeEach(() => {
    process.env.AI_API_KEY = 'sk-secret-should-not-leak';
    process.env.WORKER_TOKEN = 'tok-secret-should-not-leak';
    process.env.LAN_ACCESS_CODE = 'code-secret';
  });
  afterEach(() => {
    delete process.env.AI_API_KEY;
    delete process.env.WORKER_TOKEN;
    delete process.env.LAN_ACCESS_CODE;
  });
  it('env của tiến trình con không chứa AI_API_KEY/WORKER_TOKEN và trỏ ghi vào thư mục tạm', () => {
    const t = path.join(os.tmpdir(), 'hfr-x');
    const env = runnerEnv({ tempDir: t, chromePath: 'C:/chrome.exe', ffmpeg: 'C:/f.exe', ffprobe: 'C:/p.exe' });
    const dump = JSON.stringify(env);
    for (const bad of ['AI_API_KEY', 'WORKER_TOKEN', 'LAN_ACCESS_CODE', 'secret-should-not-leak', 'code-secret']) expect(dump).not.toContain(bad);
    expect(env.TEMP).toBe(t);
    expect(env.TMP).toBe(t);
    expect(env.USERPROFILE).toBe(t);
    expect(env.HYPERFRAMES_FFMPEG_PATH).toBe('C:/f.exe');
    expect(env.PRODUCER_HEADLESS_SHELL_PATH).toBe('C:/chrome.exe');
    expect(env.HYPERFRAMES_EXTRACT_CACHE_DIR!.startsWith(t)).toBe(true);
    expect(Object.keys(env).length).toBeLessThan(30);
  });
  it('hardenArgs: giữ site isolation, chặn mạng ngoài loopback/DNS/WebRTC, bỏ cờ tắt popup blocker', () => {
    const a = hardenArgs(['--disable-features=Translate,IsolateOrigins,site-per-process,AudioServiceOutOfProcess', '--disable-features=IsolateOrigins', '--disable-popup-blocking', '--mute-audio']);
    expect(a).toEqual(['--disable-features=Translate,AudioServiceOutOfProcess', '--mute-audio', ...NETWORK_LOCKDOWN_ARGS]);
    expect(NETWORK_LOCKDOWN_ARGS.some((x) => x.startsWith('--proxy-server='))).toBe(true);
    expect(NETWORK_LOCKDOWN_ARGS.some((x) => x.startsWith('--host-resolver-rules='))).toBe(true);
  });
  it('puppeteer.launch bị vá: bỏ --no-sandbox, userDataDir riêng, allowlist request', async () => {
    const original = puppeteer.launch;
    const seen: Record<string, unknown>[] = [];
    const handlers: ((r: unknown) => void)[] = [];
    const page = { setRequestInterception: async () => undefined, on: (_e: string, h: (r: unknown) => void) => void handlers.push(h) };
    (puppeteer as unknown as { launch: unknown }).launch = async (o: Record<string, unknown>) => {
      seen.push(o);
      return { newPage: async () => page, on: () => undefined };
    };
    try {
      const temp = mk();
      installHardening(temp);
      const b = (await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=C:/evil', '--disable-popup-blocking', '--proxy-server=evil', '--hide-scrollbars'] } as never)) as unknown as { newPage(): Promise<unknown> };
      expect(seen[0]!.args).toEqual(['--hide-scrollbars', ...NETWORK_LOCKDOWN_ARGS]);
      expect(String(seen[0]!.userDataDir).startsWith(temp)).toBe(true);
      expect(launchLog.args.flat()).not.toContain('--no-sandbox');
      await b.newPage();
      const decide = (url: string, nav = false) => {
        const res = { action: '' };
        handlers[0]!({ isInterceptResolutionHandled: () => false, url: () => url, method: () => 'GET', isNavigationRequest: () => nav, continue: () => (res.action = 'continue'), abort: () => (res.action = 'abort') });
        return res.action;
      };
      expect(decide('http://127.0.0.1:5555/index.html', true)).toBe('continue'); // học cổng
      expect(decide('http://localhost:5555/a.png')).toBe('continue');
      expect(decide('http://127.0.0.1:8790/lan/api/status')).toBe('abort'); // cổng khác (API app)
      expect(decide('http://127.0.0.1:8790/', true)).toBe('abort'); // điều hướng sang cổng khác sau khi đã học
      expect(decide('https://evil.example/x.js')).toBe('abort');
      expect(decide('ws://127.0.0.1:5555/')).toBe('abort');
      expect(decide('data:image/png;base64,AA')).toBe('continue');
      expect(decide('blob:null/abc')).toBe('continue');
    } finally {
      (puppeteer as unknown as { launch: unknown }).launch = original;
    }
  });
});
