// Dựng bản chạy Windows (giai đoạn 2 của PLAN-windows-exe.md) vào dist-win/:
//   node.exe, server/server.mjs, server/node_modules/better-sqlite3 (+bindings, file-uri-to-path), web/, bin/ffmpeg.exe, bin/ffprobe.exe, start.cmd
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
if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('Thiếu web/dist/index.html (build web lỗi?)');
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
  external: ['better-sqlite3'],
  define: { __EMBEDDED_MIGRATIONS__: JSON.stringify(migrations) },
  // Nhiều dependency CommonJS gọi require() động (kể cả module built-in): trong bundle ESM cần require thật
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// ---------------------------------------------------------------- 3. better-sqlite3 (+bindings, file-uri-to-path) lấy từ node_modules đã cài theo package-lock.json, cắt gọn
// Không còn `npm install` không khoá: chép đúng bản đã `npm ci`, đối chiếu phiên bản với package-lock.json.
// Lưu ý trung thực: bản thân addon better_sqlite3.node do `prebuild-install` tải từ GitHub Releases trong lúc `npm ci`
// (lockfile chỉ ghim hash của tarball npm, KHÔNG ghim hash của file nhị phân tải thêm). Build này ghi SHA256 của addon
// vào BUILD-INFO.json để phát hiện lệch giữa các lần build; đây chưa phải build tái lập hoàn toàn từ mã nguồn.
// Có thể ép bằng --expect-addon-sha256 <hex>.
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const KEEP = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
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
// bindings / file-uri-to-path: bỏ test, tài liệu, file khai báo kiểu
for (const [pkg, junk] of [
  ['bindings', ['README.md']],
  ['file-uri-to-path', ['test', '.travis.yml', '.npmignore', 'History.md', 'index.d.ts', 'README.md']],
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
  'rem Chạy AutoVideo: start.cmd [thư mục dữ liệu] [cổng]',
  'rem Mặc định dữ liệu ở %USERPROFILE%\\AutoVideo, cổng 8787. Server luôn chỉ lắng nghe 127.0.0.1.',
  'setlocal',
  'set "APP=%~dp0"',
  'if "%~1"=="" (set "DATA=%USERPROFILE%\\AutoVideo") else (set "DATA=%~1")',
  'set "PORTARG="',
  'if not "%~2"=="" set "PORTARG=--port %~2"',
  '"%APP%node.exe" --max-old-space-size=192 "%APP%server\\server.mjs" --app-dir "%APP%." --data-dir "%DATA%" %PORTARG%',
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
    },
    null,
    2,
  ) + '\n',
);

log(`Xong: ${rel(OUT)}`);
