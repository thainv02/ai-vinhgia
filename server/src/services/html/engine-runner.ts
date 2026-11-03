/**
 * Tiến trình con dựng/chụp Video HTML (điểm vào; bản build: `server/html-runner.mjs`, dev: chạy mã nguồn qua tsx).
 * stdin: JSON một lần (lệnh); stdout: các dòng `@@HF {json}` (progress/done/error), phần còn lại (log của producer) bị bỏ qua; stderr: log.
 * Cứng hoá (spike §6): puppeteer.launch bị vá — bỏ --no-sandbox/--disable-setuid-sandbox, userDataDir riêng trong TEMP, allowlist request
 * (data:/blob:/about: + http 127.0.0.1|localhost đúng cổng file-server của trang đó). Chống mạng thật là CSP meta do server chèn (allowlist không chặn WebSocket).
 * Tiến trình này KHÔNG import code app (không DB, không config): chỉ nhận lệnh + env tối thiểu từ server.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { HTML_CSP } from './engine/constants.js';

export interface RunnerCommand {
  cmd: 'render' | 'capture';
  workDir: string;
  /** render: file mp4 đích (đã tồn tại thư mục cha). */
  outPath?: string;
  /** capture: thư mục ghi `frame-<i>.png`. */
  outDir?: string;
  outputResolution?: string;
  durationS: number;
  workers?: number;
  fps?: number;
  times?: number[];
  scale?: number;
  /** Thư mục tạm riêng của job (profile trình duyệt nằm trong đây). */
  tempDir: string;
  chromePath: string;
  browserTimeoutMs?: number;
  protocolTimeoutMs?: number;
}

const send = (o: unknown): void => void process.stdout.write(`@@HF ${JSON.stringify(o)}\n`);
const ALLOWED_PROTOCOLS = new Set(['data:', 'blob:', 'about:']);
let launchSeq = 0;
export const launchLog: { args: string[][]; denied: string[] } = { args: [], denied: [] };

/**
 * Cờ mạng thêm vào mọi lần mở trình duyệt: mọi kết nối không phải loopback (HTTP, WebSocket, cửa sổ popup — popup là target riêng, không có
 * interception lẫn CSP của trang) đi qua proxy chết 127.0.0.1:9 (Chrome mặc định bỏ qua proxy cho loopback nên file-server vẫn chạy);
 * không phân giải DNS (chặn rò dữ liệu qua tên miền); WebRTC không được dùng UDP ngoài proxy.
 */
export const NETWORK_LOCKDOWN_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', // MAP * áp cả IP literal: phải chừa 127.0.0.1
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-background-networking',
  // Không cho tạo cửa sổ mới (window.open, <a target=_blank>): popup tới cổng loopback khác đi thẳng (proxy bỏ qua loopback) và không có
  // interception/CSP; đóng nó ở `targetcreated` là quá muộn (request đầu đã đi — test honeypot đã bắt được).
  '--block-new-web-contents',
];
const STRIPPED_ARGS = new Set(['--no-sandbox', '--disable-setuid-sandbox', '--disable-popup-blocking', '--single-process', '--no-zygote']);

/** Bỏ `IsolateOrigins`/`site-per-process` khỏi `--disable-features=` (producer tắt site isolation). */
function keepSiteIsolation(a: string): string | null {
  if (!a.startsWith('--disable-features=')) return a;
  const rest = a.slice('--disable-features='.length).split(',').filter((f) => f && f !== 'IsolateOrigins' && f !== 'site-per-process');
  return rest.length ? `--disable-features=${rest.join(',')}` : null;
}

/** Args sau khi cứng hoá (thuần, test được). */
export function hardenArgs(input: string[]): string[] {
  const args = input
    .filter((a) => !STRIPPED_ARGS.has(a) && !a.startsWith('--user-data-dir') && !a.startsWith('--proxy-') && !a.startsWith('--host-resolver-rules') && !a.startsWith('--remote-debugging-address'))
    .map(keepSiteIsolation)
    .filter((a): a is string => a !== null);
  return [...args, ...NETWORK_LOCKDOWN_ARGS];
}

/** Vá puppeteer.launch (cùng instance engine `import("puppeteer")`). Xuất ra để test kiểm tra args. */
export function installHardening(tempDir: string): void {
  const orig = puppeteer.launch.bind(puppeteer);
  puppeteer.launch = (async (opts: Record<string, unknown> = {}) => {
    const args = hardenArgs((opts.args as string[] | undefined) ?? []);
    launchLog.args.push(args);
    const userDataDir = path.join(tempDir, `profile-${++launchSeq}`);
    fs.mkdirSync(userDataDir, { recursive: true });
    const browser = await orig({ ...opts, args, userDataDir } as never);
    // Popup (window.open, <a target=_blank>...) = target có opener, không qua newPage nên không có interception: đóng ngay.
    browser.on('targetcreated', (t) => {
      if (t.type() !== 'page' || !t.opener()) return;
      launchLog.denied.push(`popup ${t.url()}`);
      void t.page().then((p) => p?.close()).catch(() => undefined);
    });
    const newPage = browser.newPage.bind(browser);
    browser.newPage = (async (...a: []) => {
      const page = await newPage(...a);
      let port: string | null = null; // cổng file-server của trang này (học từ lần điều hướng đầu tiên)
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.isInterceptResolutionHandled()) return;
        let u: URL;
        try {
          u = new URL(req.url());
        } catch {
          launchLog.denied.push(req.url());
          return void req.abort('blockedbyclient');
        }
        if (ALLOWED_PROTOCOLS.has(u.protocol)) return void req.continue();
        if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
          if (port === null && req.isNavigationRequest()) port = u.port;
          if (u.port === port) return void req.continue();
        }
        launchLog.denied.push(`${req.method()} ${req.url()}`);
        void req.abort('blockedbyclient');
      });
      return page;
    }) as never;
    return browser;
  }) as never;
}

/** Node-level: producer không được gọi mạng ngoài (tải font/media từ xa...). Chỉ loopback. */
function blockOutboundFetch(): void {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* chặn */
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return Promise.reject(new Error(`Chặn kết nối mạng ra ngoài: ${host || url}`));
    return orig(input, init);
  }) as typeof fetch;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.json': 'application/json' };

/** File-server tĩnh 127.0.0.1 cho chụp khung (CSP header, Range, chặn thoát thư mục/dotfile). */
function staticServer(root: string, csp: string): Promise<{ port: number; close: () => Promise<void> }> {
  const base = path.resolve(root);
  const srv = http.createServer((q, r) => {
    r.setHeader('Content-Security-Policy', csp);
    r.setHeader('Cache-Control', 'no-store');
    let rel = '';
    try {
      rel = decodeURIComponent(new URL(q.url ?? '/', 'http://x').pathname);
    } catch {
      r.statusCode = 400;
      return void r.end();
    }
    if (rel === '/') rel = '/index.html';
    const f = path.resolve(base, `.${rel}`);
    if (!f.startsWith(base + path.sep) || rel.split('/').some((s) => s.startsWith('.')) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      r.statusCode = 404;
      return void r.end('Not found');
    }
    const size = fs.statSync(f).size;
    r.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream');
    r.setHeader('Accept-Ranges', 'bytes');
    const m = q.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(q.headers.range) : null;
    if (m && (m[1] || m[2])) {
      const s = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const e = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (s > e || s >= size) {
        r.statusCode = 416;
        r.setHeader('Content-Range', `bytes */${size}`);
        return void r.end();
      }
      r.statusCode = 206;
      r.setHeader('Content-Range', `bytes ${s}-${e}/${size}`);
      r.setHeader('Content-Length', e - s + 1);
      return void fs.createReadStream(f, { start: s, end: e }).pipe(r);
    }
    r.setHeader('Content-Length', size);
    if (q.method === 'HEAD') return void r.end();
    fs.createReadStream(f).pipe(r);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => new Promise((res) => srv.close(() => res())) }));
  });
}

async function runCapture(c: RunnerCommand): Promise<void> {
  const times = c.times ?? [];
  fs.mkdirSync(c.outDir!, { recursive: true });
  const srv = await staticServer(c.workDir, HTML_CSP);
  const browser = await puppeteer.launch({ executablePath: c.chromePath, headless: true, args: ['--hide-scrollbars', '--mute-audio'], protocolTimeout: c.protocolTimeoutMs ?? 60_000, timeout: c.browserTimeoutMs ?? 60_000 } as never);
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.port}/index.html`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => {
      const p = (window as unknown as { __player?: { seek?: unknown; getDuration(): number } }).__player;
      return !!p && typeof p.seek === 'function' && p.getDuration() > 0;
    }, { timeout: 20_000 });
    const meta = await page.evaluate(() => {
      const r = document.querySelector('[data-composition-id]') as HTMLElement;
      return { w: Number(r.dataset.width), h: Number(r.dataset.height) };
    });
    await page.setViewport({ width: meta.w, height: meta.h, deviceScaleFactor: c.scale ?? 1 });
    await page.evaluate(() => document.fonts.ready);
    for (let i = 0; i < times.length; i++) {
      await page.evaluate((t) => (window as unknown as { __player: { seek(t: number): void } }).__player.seek(t), times[i]!);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: path.join(c.outDir!, `frame-${i}.png`) as `${string}.png` });
      send({ type: 'progress', pct: Math.round(((i + 1) / times.length) * 100), stage: 'capture' });
    }
  } finally {
    await browser.close().catch(() => undefined);
    await srv.close();
  }
}

async function runRender(c: RunnerCommand): Promise<string[]> {
  const { createRenderJob, executeRenderJob } = await import('@hyperframes/producer');
  const job = createRenderJob({
    fps: c.fps ?? 30,
    quality: 'standard',
    format: 'mp4',
    ...(c.workers ? { workers: c.workers } : {}),
    entryFile: 'index.html',
    outputResolution: c.outputResolution as never,
    producerConfig: { browserTimeout: c.browserTimeoutMs ?? 60_000, protocolTimeout: c.protocolTimeoutMs ?? 120_000 } as never,
  });
  let last = -1;
  let lastAt = 0;
  const sink = (j: { progress: number; currentStage?: string }): void => {
    const pct = Math.max(0, Math.min(99, Math.round(j.progress)));
    const now = Date.now();
    if (pct === last || (now - lastAt < 400 && pct < 99)) return;
    last = pct;
    lastAt = now;
    send({ type: 'progress', pct, stage: j.currentStage ?? 'render' });
  };
  const ac = new AbortController();
  process.once('SIGTERM', () => ac.abort());
  await executeRenderJob(job, c.workDir, c.outPath!, sink as never, ac.signal);
  return (job.warnings as unknown[] | undefined)?.map((w) => String(w)) ?? [];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const c = JSON.parse(await readStdin()) as RunnerCommand;
  process.env.PRODUCER_HEADLESS_SHELL_PATH = c.chromePath;
  blockOutboundFetch();
  installHardening(c.tempDir);
  if (c.cmd === 'capture') {
    await runCapture(c);
    send({ type: 'done', denied: launchLog.denied.slice(0, 20) });
  } else {
    const warnings = await runRender(c);
    send({ type: 'done', warnings, denied: launchLog.denied.slice(0, 20) });
  }
}

// Chỉ chạy khi là điểm vào (test import module này để kiểm tra installHardening)
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry && /(engine-runner|html-runner)\.(ts|mjs|js)$/.test(entry)) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : 'Error' });
      process.exit(1);
    },
  );
}
