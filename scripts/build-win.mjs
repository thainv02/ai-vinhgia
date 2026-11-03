// Dựng bản chạy Windows (giai đoạn 2 của PLAN-windows-exe.md) vào dist-win/:
//   node.exe, server/server.mjs, server/node_modules/better-sqlite3 (+bindings, file-uri-to-path), worker/worker.mjs, web/,
//   server/stt-runner.mjs + server/stt-model-cli.mjs + server/node_modules/sherpa-onnx-node (+sherpa-onnx-win-x64): nhận dạng lời nói trên máy
//   (model ~73 MB không nằm trong dist-win: build-installer.mjs tải vào .build-cache/stt-models và bộ cài chép vào %LOCALAPPDATA%),
//   server/html-runner.mjs + server/node_modules/@hyperframes/* (+ phụ thuộc, ~100MB, chép theo package-lock.json) + server/assets (html-runtime: gsap, runtime, font; mẫu): tab Video HTML
//   (trình duyệt dựng chrome-headless-shell 152 KHÔNG đóng gói: người dùng tải trong Cài đặt),
//   video-production-rules.md, tools/gwr (xoá logo Veo, dùng Edge/Chrome của máy), bin/ffmpeg.exe, bin/ffprobe.exe, start.cmd (chạy chế độ desktop)
//
//   npm run build:win [-- --ffmpeg-zip <đường dẫn zip đã tải sẵn>] [-- --node-exe <node.exe>] [-- --skip-web]
//
// ffmpeg được ghim cứng URL + SHA256; zip tải về cache ở .build-cache/ (gitignored), sai hash thì dừng.
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packGwr } from './pack-gwr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-win');
const CACHE = path.join(ROOT, '.build-cache');

// ---- ffmpeg ghim cứng (gyan.dev essentials 8.0: GPL, có libx264) ----
const FFMPEG = {
  version: '8.0-essentials_build-www.gyan.dev',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip',
  sha256: '647e467caf82b9fa200a562769b5ff4d736aaf725804ed2c64ea9752106fa569',
  inner: 'ffmpeg-8.0-essentials_build',
};

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);

const log = (msg) => console.log(`[build-win] ${msg}`);
const rel = (p) => path.relative(ROOT, p) || '.';

if (process.platform !== 'win32') throw new Error('build:win chỉ chạy trên Windows (cần addon better-sqlite3 và node.exe win-x64)');
if (process.arch !== 'x64') throw new Error(`Cần Node win-x64 (đang là ${process.arch})`);

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

/** Lấy zip ffmpeg: --ffmpeg-zip, hoặc cache, hoặc tải về; luôn kiểm tra SHA256 ghim cứng. */
async function getFfmpegZip() {
  const given = opt('ffmpeg-zip');
  const zip = given ? path.resolve(given) : path.join(CACHE, path.basename(FFMPEG.url));
  if (!fs.existsSync(zip)) {
    if (given) throw new Error(`Không thấy file --ffmpeg-zip: ${zip}`);
    fs.mkdirSync(CACHE, { recursive: true });
    log(`Tải ffmpeg ${FFMPEG.version} (~100MB): ${FFMPEG.url}`);
    const res = await fetch(FFMPEG.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Tải ffmpeg thất bại: HTTP ${res.status}`);
    const tmp = `${zip}.part`;
    await fs.promises.writeFile(tmp, res.body);
    fs.renameSync(tmp, zip);
  }
  const got = await sha256File(zip);
  if (got !== FFMPEG.sha256) {
    if (!given) fs.rmSync(zip, { force: true }); // không giữ file cache sai hash
    throw new Error(`SHA256 ffmpeg không khớp.\n  cần:  ${FFMPEG.sha256}\n  được: ${got}\n  file:  ${zip}`);
  }
  log(`ffmpeg zip khớp SHA256 (${rel(zip)})`);
  return zip;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Chép thư mục đệ quy. Không dùng fs.cpSync: trên Windows Node 22.20 nó làm hỏng tên có ký tự ngoài ASCII (vd `Dữ liệu` thành `Dá»¯ liá»‡u`). */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

// ---------------------------------------------------------------- 0. dọn
log(`Dọn ${rel(OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- 1. web
if (!flag('skip-web')) {
  log('Build web (tsc + vite)');
  execSync('npm run build -w web', { cwd: ROOT, stdio: 'inherit' });
}
const webDist = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'planner.html'))) throw new Error('Thiếu web/dist/planner.html (build web lỗi?)');
copyDir(webDist, path.join(OUT, 'web'));

// ---------------------------------------------------------------- 2. server.mjs (esbuild)
log('Gom server bằng esbuild -> server/server.mjs');
const migDir = path.join(ROOT, 'server', 'migrations');
const migrations = fs
  .readdirSync(migDir)
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort()
  .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(migDir, f), 'utf8').replace(/\r\n/g, '\n') })); // chuẩn hoá LF để build giống nhau dù checkout CRLF
await build({
  entryPoints: [path.join(ROOT, 'server', 'src', 'start.ts')],
  outfile: path.join(OUT, 'server', 'server.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  external: ['better-sqlite3', '@hyperframes/lint'], // lint nạp động từ server/node_modules (bước 4a)
  define: { __EMBEDDED_MIGRATIONS__: JSON.stringify(migrations) },
  // Nhiều dependency CommonJS gọi require() động (kể cả module built-in): trong bundle ESM cần require thật
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// Nhận dạng lời nói trên máy: runner (tiến trình con của server) và lệnh tải model cho installer. sherpa-onnx-node để external (chép ở bước 3b).
for (const [entry, out] of [
  [path.join(ROOT, 'server', 'src', 'services', 'clips', 'stt-runner.ts'), 'stt-runner.mjs'],
  [path.join(ROOT, 'server', 'src', 'scripts', 'stt-model-cli.ts'), 'stt-model-cli.mjs'],
]) {
  log(`Gom ${path.basename(entry)} -> server/${out}`);
  await build({
    entryPoints: [entry],
    outfile: path.join(OUT, 'server', out),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    external: ['sherpa-onnx-node'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
}

// Video HTML: runner dựng/chụp (tiến trình con của server). puppeteer + @hyperframes/* để external: producer đọc file trong dist của chính nó
// và engine `import("puppeteer")` phải cùng instance với runner (đã vá launch) → chép node_modules ở bước 4a.
log('Gom engine-runner -> server/html-runner.mjs');
await build({
  entryPoints: [path.join(ROOT, 'server', 'src', 'services', 'html', 'engine-runner.ts')],
  outfile: path.join(OUT, 'server', 'html-runner.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  external: ['puppeteer', 'puppeteer-core', '@hyperframes/*'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// Worker văn bản nhúng (server chạy làm tiến trình con ở chế độ desktop): không có trình duyệt, không cần playwright-core
log('Gom worker văn bản bằng esbuild -> worker/worker.mjs');
const workerBuild = await build({
  entryPoints: [path.join(ROOT, 'worker', 'src', 'text-main.ts')],
  outfile: path.join(OUT, 'worker', 'worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
if (Object.keys(workerBuild.metafile.inputs).some((f) => f.includes('playwright'))) throw new Error('worker.mjs kéo theo playwright-core (worker văn bản không được nạp phần trình duyệt)');
// Quy tắc sản xuất video: worker đọc từ thư mục cài đặt (AUTOVIDEO_RULES_FILE)
copyFile(path.join(ROOT, 'video-production-rules.md'), path.join(OUT, 'video-production-rules.md'));

// ---------------------------------------------------------------- 3. better-sqlite3 (+bindings, file-uri-to-path) lấy từ node_modules đã cài theo package-lock.json, cắt gọn
// Không còn `npm install` không khoá: chép đúng bản đã `npm ci`, đối chiếu phiên bản với package-lock.json.
// Lưu ý trung thực: bản thân addon better_sqlite3.node do `prebuild-install` tải từ GitHub Releases trong lúc `npm ci`
// (lockfile chỉ ghim hash của tarball npm, KHÔNG ghim hash của file nhị phân tải thêm). Build này ghi SHA256 của addon
// vào BUILD-INFO.json để phát hiện lệch giữa các lần build; đây chưa phải build tái lập hoàn toàn từ mã nguồn.
// Có thể ép bằng --expect-addon-sha256 <hex>.
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
// sherpa-onnx-node + bản dựng sẵn win-x64 (sherpa-onnx.node, onnxruntime.dll…): nhận dạng lời nói trên máy (stt-runner.mjs)
const KEEP = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'sherpa-onnx-node', 'sherpa-onnx-win-x64'];
/** npm workspaces hoist: better-sqlite3 nằm ở server/node_modules, hai gói còn lại ở node_modules gốc (theo lockfile). */
const sources = {};
const pkgVersions = {};
for (const name of KEEP) {
  const lockKey = ['server/node_modules/' + name, 'node_modules/' + name].find((k) => lock.packages?.[k]);
  if (!lockKey) throw new Error(`package-lock.json không có ${name}`);
  const dir = path.join(ROOT, lockKey);
  const lockVer = lock.packages[lockKey].version;
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj)) throw new Error(`Chưa cài ${rel(dir)} (chạy npm ci trước)`);
  const got = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
  if (got !== lockVer) throw new Error(`${name}: đã cài ${got} nhưng package-lock.json ghi ${lockVer} (chạy npm ci)`);
  sources[name] = dir;
  pkgVersions[name] = got;
}
const sqliteVersion = pkgVersions['better-sqlite3'];
log(`Chép better-sqlite3@${sqliteVersion}, bindings@${pkgVersions.bindings}, file-uri-to-path@${pkgVersions['file-uri-to-path']} từ node_modules (khớp package-lock.json)`);
const nm = path.join(OUT, 'server', 'node_modules');
for (const name of KEEP) copyDir(sources[name], path.join(nm, name));
// bindings / file-uri-to-path / sherpa-onnx: bỏ test, tài liệu, file khai báo kiểu
for (const [pkg, junk] of [
  ['bindings', ['README.md']],
  ['file-uri-to-path', ['test', '.travis.yml', '.npmignore', 'History.md', 'index.d.ts', 'README.md']],
  ['sherpa-onnx-node', ['README.md']],
  ['sherpa-onnx-win-x64', ['README.md']],
]) {
  for (const j of junk) fs.rmSync(path.join(nm, pkg, j), { recursive: true, force: true });
}
const bs = path.join(nm, 'better-sqlite3');
for (const name of fs.readdirSync(bs)) {
  if (!['lib', 'build', 'package.json', 'LICENSE'].includes(name)) fs.rmSync(path.join(bs, name), { recursive: true, force: true });
}
if (!fs.existsSync(path.join(bs, 'build', 'Release'))) throw new Error('Thiếu build/Release của better-sqlite3 (npm ci chưa tải/biên dịch addon?)');
for (const name of fs.readdirSync(path.join(bs, 'build'))) {
  if (name !== 'Release') fs.rmSync(path.join(bs, 'build', name), { recursive: true, force: true });
}
for (const name of fs.readdirSync(path.join(bs, 'build', 'Release'))) {
  if (name !== 'better_sqlite3.node') fs.rmSync(path.join(bs, 'build', 'Release', name), { recursive: true, force: true });
}
const addonPath = path.join(bs, 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(addonPath)) throw new Error('Thiếu better_sqlite3.node sau khi chép');
// package.json tối thiểu để Node coi server.mjs là ESM (server/ nằm ngoài mọi package.json khác)
fs.writeFileSync(path.join(OUT, 'server', 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
const addonSha256 = await sha256File(addonPath);
const expectAddon = opt('expect-addon-sha256');
if (expectAddon && expectAddon.toLowerCase() !== addonSha256) {
  throw new Error(`SHA256 better_sqlite3.node không khớp.\n  cần:  ${expectAddon}\n  được: ${addonSha256}`);
}
log(`better_sqlite3.node SHA256 ${addonSha256}`);

// ---------------------------------------------------------------- 4. node.exe
const nodeExe = path.resolve(opt('node-exe') ?? process.execPath);
log(`Chép node.exe (${nodeExe}), phiên bản ${execFileSync(nodeExe, ['-p', 'process.version + " abi " + process.versions.modules']).toString().trim()}`);
const nodeAbi = execFileSync(nodeExe, ['-p', 'process.versions.modules']).toString().trim();
if (nodeAbi !== process.versions.modules) throw new Error(`ABI của node.exe (${nodeAbi}) khác ABI node đang build addon (${process.versions.modules})`);
const nodeVersion = execFileSync(nodeExe, ['-p', 'process.version']).toString().trim();
copyFile(nodeExe, path.join(OUT, 'node.exe'));
const nodeSha256 = await sha256File(path.join(OUT, 'node.exe'));

// Kiểm tra addon bằng chính node.exe đóng gói: nạp better-sqlite3 từ bản đã chép, mở DB :memory:, đối chiếu ABI
log('Kiểm tra addon bằng node.exe đóng gói');
const smoke = execFileSync(
  path.join(OUT, 'node.exe'),
  ['-e', "const D = require('better-sqlite3'); const db = new D(':memory:'); const v = db.prepare('select sqlite_version() v').get().v; db.close(); console.log(JSON.stringify({ abi: process.versions.modules, sqlite: v }))"],
  { cwd: path.join(OUT, 'server'), encoding: 'utf8' },
);
const smokeInfo = JSON.parse(smoke.trim().split(/\r?\n/).pop());
if (smokeInfo.abi !== nodeAbi) throw new Error(`ABI khi chạy thử (${smokeInfo.abi}) khác ABI node.exe (${nodeAbi})`);
log(`Addon chạy được trên node.exe (ABI ${smokeInfo.abi}, SQLite ${smokeInfo.sqlite})`);
// sherpa-onnx (N-API, nạp onnxruntime.dll cạnh addon): nạp thử bằng node.exe đóng gói
const sherpaSmoke = execFileSync(path.join(OUT, 'node.exe'), ['-e', "const s = require('sherpa-onnx-node'); console.log(JSON.stringify({ sherpa: s.version, ort: s.onnxruntimeVersion }))"], {
  cwd: path.join(OUT, 'server'),
  encoding: 'utf8',
});
log(`sherpa-onnx chạy được trên node.exe (${sherpaSmoke.trim().split(/\r?\n/).pop()})`);

// ---------------------------------------------------------------- 4a. Video HTML: @hyperframes/{producer,lint} + toàn bộ phụ thuộc (theo package-lock.json), asset runtime
// Producer đọc dist của chính nó (runtime, healthWorkerThread...) và engine nạp động `puppeteer` → chép cây node_modules thay vì gom một file (spike §4).
// Bỏ qua optionalDependencies (sharp... không cần cho mp4). Đối chiếu phiên bản đã cài với lockfile; thiếu → dừng.
log('Chép @hyperframes/producer + lint và phụ thuộc vào server/node_modules');
const hfRoots = ['node_modules/@hyperframes/producer', 'node_modules/@hyperframes/lint'];
const resolveDep = (from, dep) => {
  let base = from;
  for (;;) {
    const cand = `${base ? base + '/' : ''}node_modules/${dep}`;
    if (lock.packages[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i >= 0 ? base.slice(0, i) : '';
  }
};
const hfClosure = new Map();
const hfStack = [...hfRoots];
while (hfStack.length) {
  const key = hfStack.pop();
  if (hfClosure.has(key)) continue;
  const entry = lock.packages[key];
  if (!entry) throw new Error(`package-lock.json không có ${key}`);
  hfClosure.set(key, entry.version);
  for (const dep of Object.keys(entry.dependencies ?? {})) {
    const r = resolveDep(key, dep);
    if (!r) throw new Error(`Không phân giải được ${dep} (phụ thuộc của ${key}) trong package-lock.json`);
    hfStack.push(r);
  }
}
const hfVersions = {};
for (const [key, lockVer] of hfClosure) {
  const dir = path.join(ROOT, key);
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj)) throw new Error(`Chưa cài ${key} (chạy npm ci trước)`);
  const got = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
  if (got !== lockVer) throw new Error(`${key}: đã cài ${got} nhưng package-lock.json ghi ${lockVer} (chạy npm ci)`);
  copyDir(dir, path.join(nm, key.replace(/^(?:server\/)?node_modules\//, '')));
  hfVersions[key.replace(/^.*node_modules\//, '')] = got;
}
// gọn: bỏ file khai báo kiểu, sourcemap, tài liệu (giữ LICENSE/NOTICE)
const prune = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) prune(f);
    else if (/\.(?:d\.[cm]?ts|map)$/i.test(e.name) || /^(?:README|CHANGELOG|HISTORY)(?:\.[a-z]+)?$/i.test(e.name)) fs.rmSync(f, { force: true });
  }
};
prune(nm);
// asset do server cung cấp: html-runtime (gsap, runtime, font Be Vietnam Pro, NOTICE.md) + mẫu html-templates (nếu có)
copyDir(path.join(ROOT, 'server', 'assets'), path.join(OUT, 'server', 'assets'));
for (const f of ['gsap.min.js', 'runtime.js', 'NOTICE.md', 'fonts/OFL.txt', 'fonts/be-vietnam-pro-vietnamese-700-normal.woff2']) {
  if (!fs.existsSync(path.join(OUT, 'server', 'assets', 'html-runtime', f))) throw new Error(`Thiếu server/assets/html-runtime/${f}`);
}
// nạp thử bằng node.exe đóng gói: producer + puppeteer (cùng instance engine) + lint + runner bundle
const hfSmoke = execFileSync(
  path.join(OUT, 'node.exe'),
  ['-e', "Promise.all([import('@hyperframes/producer'), import('@hyperframes/lint'), import('puppeteer')]).then(([p, l, pp]) => console.log(JSON.stringify({ producer: typeof p.executeRenderJob, lint: typeof l.lintProject, launch: typeof pp.default.launch })))"],
  { cwd: path.join(OUT, 'server'), encoding: 'utf8', timeout: 180_000 },
);
const hfInfo = JSON.parse(hfSmoke.trim().split(/\r?\n/).pop());
if (hfInfo.producer !== 'function' || hfInfo.lint !== 'function' || hfInfo.launch !== 'function') throw new Error(`Nạp thử @hyperframes/puppeteer thất bại: ${hfSmoke}`);
log(`Video HTML: ${hfClosure.size} gói npm, producer/lint/puppeteer nạp được trên node.exe đóng gói`);

// ---------------------------------------------------------------- 4b. tool xoá logo Veo (tools/gwr): phần video của gói npm + playwright-core,
// chạy trong Edge/Chrome có sẵn trên máy (không kèm Chromium). Kiểm tra nạp module bằng chính node.exe đóng gói.
log('Đóng gói tool xoá logo Veo -> tools/gwr');
const gwr = packGwr(OUT, { node: path.join(OUT, 'node.exe'), log });

// ---------------------------------------------------------------- 5. ffmpeg + ffprobe
const zip = await getFfmpegZip();
const x = path.join(CACHE, 'ffmpeg-extract');
fs.rmSync(x, { recursive: true, force: true });
fs.mkdirSync(x, { recursive: true });
log('Giải nén ffmpeg.exe, ffprobe.exe, LICENSE');
// bsdtar của Windows (không dùng tar của Git Bash: nó hiểu `E:` là tên máy)
execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', x, `${FFMPEG.inner}/bin/ffmpeg.exe`, `${FFMPEG.inner}/bin/ffprobe.exe`, `${FFMPEG.inner}/LICENSE`], { stdio: 'inherit' });
copyFile(path.join(x, FFMPEG.inner, 'bin', 'ffmpeg.exe'), path.join(OUT, 'bin', 'ffmpeg.exe'));
copyFile(path.join(x, FFMPEG.inner, 'bin', 'ffprobe.exe'), path.join(OUT, 'bin', 'ffprobe.exe'));
copyFile(path.join(x, FFMPEG.inner, 'LICENSE'), path.join(OUT, 'bin', 'ffmpeg-LICENSE.txt'));
fs.rmSync(x, { recursive: true, force: true });

// ---------------------------------------------------------------- 6. start.cmd + thông tin build
const startCmd = [
  '@echo off',
  'rem Chạy AI Vinh Gia (bản desktop): start.cmd [thư mục dữ liệu] [cổng giao diện]',
  'rem Mặc định dữ liệu ở %USERPROFILE%\\AutoVideo, giao diện ở http://127.0.0.1:8790 (API nội bộ 8787). Server chỉ lắng nghe 127.0.0.1.',
  'rem API key của máy chủ AI nhập trong Cài đặt của app (lưu vào config.env trong thư mục dữ liệu).',
  'setlocal',
  'set "APP=%~dp0"',
  'if "%~1"=="" (set "DATA=%USERPROFILE%\\AutoVideo") else (set "DATA=%~1")',
  'if "%~2"=="" (set "UIPORT=8790") else (set "UIPORT=%~2")',
  'echo AI Vinh Gia: mo http://127.0.0.1:%UIPORT%/ trong trinh duyet. Dong cua so nay de tat app.',
  // mở trình duyệt sau 3 giây (server cần chút thời gian để mở cổng); chạy nền để không chặn server
  'start "" /b cmd /d /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:%UIPORT%/"',
  '"%APP%node.exe" --max-old-space-size=192 "%APP%server\\server.mjs" --desktop --app-dir "%APP%." --data-dir "%DATA%" --lan-port %UIPORT%',
  '',
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'start.cmd'), startCmd);
fs.writeFileSync(
  path.join(OUT, 'BUILD-INFO.json'),
  JSON.stringify(
    {
      node: nodeVersion,
      abi: nodeAbi,
      'better-sqlite3': sqliteVersion,
      packages: pkgVersions,
      sha256: { 'node.exe': nodeSha256, 'better_sqlite3.node': addonSha256 },
      ffmpeg: { version: FFMPEG.version, url: FFMPEG.url, sha256: FFMPEG.sha256 },
      'html-video': { packages: hfVersions, browser: 'chrome-headless-shell 152.0.7977.30 (tải riêng trong Cài đặt)' },
      gwr: { '@pilio/gemini-watermark-remover': gwr.gwr, 'playwright-core': gwr.playwrightCore },
    },
    null,
    2,
  ) + '\n',
);

log(`Xong: ${rel(OUT)}`);
