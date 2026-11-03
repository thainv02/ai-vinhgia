// Chuyển logo gốc thành asset giao diện và icon desktop; không cắt hoặc vẽ lại logo.
// Chạy: node scripts/prepare-brand-assets.mjs [logo.jpg]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, process.argv[2] ?? 'docs/ai/logo-VINH-GIA (1).jpg');
const original = await fs.readFile(source);
const icons = path.join(root, 'src-tauri', 'icons');
const web = path.join(root, 'web', 'src', 'assets');
await fs.mkdir(icons, { recursive: true });
await fs.mkdir(web, { recursive: true });
await fs.writeFile(path.join(web, 'vinh-gia-logo.jpg'), original);
await fs.writeFile(path.join(root, 'src-tauri', 'splash', 'logo-vinh-gia.jpg'), original);

const png = (size) => sharp(original).rotate().resize(size, size, {
  fit: 'contain', background: '#ffffff',
}).ensureAlpha().png().toBuffer();
for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
  await fs.writeFile(path.join(icons, name), await png(size));
}

// ICO: nhiều kích thước PNG RGBA để Windows chọn đúng theo DPI.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const directory = Buffer.alloc(6 + 16 * sizes.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
images.forEach((bytes, i) => {
  const at = 6 + 16 * i;
  directory[at] = sizes[i] === 256 ? 0 : sizes[i];
  directory[at + 1] = directory[at];
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(bytes.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += bytes.length;
});
await fs.writeFile(path.join(icons, 'icon.ico'), Buffer.concat([directory, ...images]));

// ICNS giữ cùng thương hiệu cho asset có sẵn trong repo.
const chunks = await Promise.all([['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(async ([type, size]) => {
  const bytes = await png(size);
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(bytes.length + 8, 4);
  return Buffer.concat([header, bytes]);
}));
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
await fs.writeFile(path.join(icons, 'icon.icns'), Buffer.concat([header, ...chunks]));
await fs.writeFile(path.join(root, 'src-tauri', 'app-icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="white"/><image href="data:image/jpeg;base64,${original.toString('base64')}" width="1024" height="1024" preserveAspectRatio="xMidYMid meet"/></svg>\n`);
console.log('Đã tạo logo giao diện, splash và icon AI Vinh Gia từ logo gốc.');
