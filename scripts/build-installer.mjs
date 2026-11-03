// Dựng bộ cài Inno Setup (installer/autovideo.iss) từ src-tauri/target/release/autovideo.exe + dist-win/ + model nhận dạng lời nói
// → src-tauri/target/release/bundle/inno/AI Vinh Gia_<version>_x64-setup.exe
//
//   npm run build:installer          (chỉ đóng gói; cần chạy `npm run build:win` và `tauri build --no-bundle` trước)
//   npm run build:app                (cả ba bước)
//
// ISCC.exe: biến môi trường ISCC, PATH, hoặc chỗ cài mặc định của Inno Setup 6.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg) => console.log(`[build-installer] ${msg}`);

if (process.platform !== 'win32') throw new Error('build:installer chỉ chạy trên Windows');

function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  try {
    return execFileSync('where.exe', ['ISCC.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    throw new Error('Không tìm thấy ISCC.exe: cài Inno Setup 6.5+ (https://jrsoftware.org/isdl.php) hoặc đặt biến ISCC');
  }
}

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const productName = conf.productName;
// VersionInfoVersion của Inno chỉ nhận số (a.b.c.d).
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`version "${version}" trong tauri.conf.json phải dạng số a.b.c`);

const exe = path.join(ROOT, 'src-tauri', 'target', 'release', 'autovideo.exe');
const runtime = path.join(ROOT, 'dist-win');
if (!fs.existsSync(exe)) throw new Error(`Chưa có ${path.relative(ROOT, exe)}: chạy \`npx tauri build --no-bundle\``);
if (!fs.existsSync(path.join(runtime, 'node.exe')) || !fs.existsSync(path.join(runtime, 'server', 'server.mjs'))) {
  throw new Error('Chưa có dist-win/: chạy `npm run build:win`');
}
// Exe cũ hơn runtime thường là quên build lại vỏ Tauri sau khi sửa src-tauri.
const srcNewest = Math.max(
  ...fs.readdirSync(path.join(ROOT, 'src-tauri', 'src')).map((f) => fs.statSync(path.join(ROOT, 'src-tauri', 'src', f)).mtimeMs),
);
if (fs.statSync(exe).mtimeMs < srcNewest) log('CẢNH BÁO: autovideo.exe cũ hơn mã nguồn src-tauri — nên chạy lại `npx tauri build --no-bundle`');

// Model nhận dạng lời nói (~73 MB) đóng thẳng vào bộ cài: máy nhân viên không phải tải từ HuggingFace (hay bị HTTP 429).
// Tải một lần vào .build-cache/stt-models (kiểm SHA256 từng file), các lần build sau dùng lại.
const sttModels = path.join(ROOT, '.build-cache', 'stt-models');
log('Chuẩn bị model nhận dạng lời nói...');
execFileSync(path.join(runtime, 'node.exe'), [path.join(runtime, 'server', 'stt-model-cli.mjs'), '--dir', sttModels], {
  cwd: runtime,
  stdio: 'inherit',
});
// Chỉ giữ model hiện dùng (model.json đánh dấu đã tải đủ + đúng hash); thư mục của model cũ bị bỏ để không lọt vào bộ cài.
const sttIds = fs.readdirSync(sttModels).filter((d) => fs.existsSync(path.join(sttModels, d, 'model.json')));
for (const d of fs.readdirSync(sttModels)) if (!sttIds.includes(d)) fs.rmSync(path.join(sttModels, d), { recursive: true, force: true });
if (sttIds.length !== 1) throw new Error(`.build-cache/stt-models phải có đúng một model, đang có: ${sttIds.join(', ') || '(trống)'} — xoá thư mục đó rồi build lại`);

const iscc = findIscc();
log(`ISCC: ${iscc}`);
log(`Đóng gói ${productName} ${version}...`);
execFileSync(iscc, ['/Qp', `/DAppVersion=${version}`, path.join(ROOT, 'installer', 'autovideo.iss')], { stdio: 'inherit' });

const out = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'inno', `${productName}_${version}_x64-setup.exe`);
log(`Xong: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
