// Đóng gói tool xoá logo Veo (tools/gwr) cho bản chạy: chỉ giữ phần video của @pilio/gemini-watermark-remover và playwright-core,
// không có Chromium (dùng Edge/Chrome có sẵn trên máy). Dùng trong scripts/build-win.mjs; chạy riêng để kiểm tra:
//   node scripts/pack-gwr.mjs <thư mục đích>      → <đích>/tools/gwr/...
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'node_modules/@pilio/gemini-watermark-remover';

/** File của gói xoá logo mà luồng video cần (API `/video`, trang xử lý, model, onnxruntime WASM). Thiếu file nào → dừng build. */
export const GWR_KEEP = [
  'package.json',
  'LICENSE',
  'src/sdk/video.js',
  'src/sdk/videoProgress.js',
  'dist/video-preview.html',
  'dist/video-app.js',
  'dist/models/allenk-fdncnn',
  'dist/onnxruntime',
];
/** File của app trong tools/gwr. */
export const APP_FILES = ['package.json', 'gwr.mjs', 'hooks.mjs', 'playwright-shim.mjs', 'browser.mjs'];

/** Chép thư mục/file đệ quy bằng copyFileSync (không dùng fs.cpSync: Node 22.20 trên Windows làm hỏng tên có dấu). */
function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

const dirSize = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((a, n) => a + dirSize(path.join(p, n)), 0) : fs.statSync(p).size);

/** Phiên bản đã cài phải khớp package-lock.json (chạy `npm ci` trước). */
function lockedPackage(lock, name) {
  const key = [`tools/gwr/node_modules/${name}`, `node_modules/${name}`].find((k) => lock.packages?.[k]);
  if (!key) throw new Error(`package-lock.json không có ${name}`);
  const dir = path.join(ROOT, key);
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj)) throw new Error(`Chưa cài ${key} (chạy npm ci trước)`);
  const got = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
  const want = lock.packages[key].version;
  if (got !== want) throw new Error(`${name}: đã cài ${got} nhưng package-lock.json ghi ${want} (chạy npm ci)`);
  return { dir, version: got };
}

/** Đóng gói vào `<out>/tools/gwr`. `node` = node dùng để kiểm tra bản đóng gói nạp được module. Trả phiên bản và dung lượng. */
export function packGwr(out, { node = process.execPath, log = console.log } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const dest = path.join(out, 'tools', 'gwr');
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of APP_FILES) copy(path.join(ROOT, 'tools', 'gwr', f), path.join(dest, f));

  const tool = lockedPackage(lock, '@pilio/gemini-watermark-remover');
  for (const f of GWR_KEEP) {
    const from = path.join(tool.dir, f);
    if (!fs.existsSync(from)) throw new Error(`Gói xoá logo thiếu ${f} (phiên bản ${tool.version} đổi cấu trúc?)`);
    copy(from, path.join(dest, TOOL, f));
  }
  const pw = lockedPackage(lock, 'playwright-core');
  copy(pw.dir, path.join(dest, 'node_modules', 'playwright-core'));

  // Bản đóng gói phải tự nạp được API video và playwright-core (không dựa vào node_modules của repo)
  execFileSync(node, ['--input-type=module', '-e', "await import('@pilio/gemini-watermark-remover/video'); await import('playwright-core');"], { cwd: dest, stdio: 'inherit' });
  const bytes = dirSize(dest);
  log(`tools/gwr: @pilio/gemini-watermark-remover@${tool.version} (chỉ phần video), playwright-core@${pw.version}, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return { gwr: tool.version, playwrightCore: pw.version, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error('Cách dùng: node scripts/pack-gwr.mjs <thư mục đích>');
  packGwr(path.resolve(out));
}
