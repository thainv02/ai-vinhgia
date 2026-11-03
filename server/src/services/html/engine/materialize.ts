/** Chép phiên bản bất biến → thư mục làm việc: chèn head vào HTML, chép file runtime `__hf/`. Không bao giờ ghi vào thư mục phiên bản. */
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../lib/errors.js';
import { htmlRuntimeDir, injectHead, runtimeFileMap } from './head.js';

export interface MaterializeOptions {
  mode: 'render' | 'capture' | 'preview';
  /** Bỏ qua asset người dùng `assets/u/` (lint không cần nội dung). */
  skipUserAssets?: boolean;
}

function copyTree(src: string, dst: string, mode: MaterializeOptions['mode'], rel: string, o: MaterializeOptions): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new AppError('HTML_UNSAFE_TREE', `Thư mục phiên bản chứa liên kết tượng trưng: ${r}`, 409);
    if (e.isDirectory()) {
      if (r === '__hf') continue; // do server cấp, không lấy từ phiên bản
      if (r === 'assets/u' && o.skipUserAssets) continue;
      copyTree(a, b, mode, r, o);
    } else if (e.isFile()) {
      const isHtml = e.name.toLowerCase().endsWith('.html') && (r === 'index.html' || r.startsWith('compositions/'));
      if (isHtml) {
        const entry = r === 'index.html';
        fs.writeFileSync(b, injectHead(fs.readFileSync(a, 'utf8'), { mode, base: entry ? '' : '../', fonts: entry }));
      } else if (r.startsWith('assets/u/')) {
        try {
          fs.linkSync(a, b); // asset lớn (video): hardlink, khác ổ đĩa thì chép
        } catch {
          fs.copyFileSync(a, b, fs.constants.COPYFILE_FICLONE);
        }
      } else fs.copyFileSync(a, b);
    }
  }
}

export async function materialize(versionDir: string, workDir: string, opts: MaterializeOptions): Promise<void> {
  if (!fs.existsSync(path.join(versionDir, 'index.html'))) throw new AppError('HTML_VERSION_MISSING', 'Thư mục phiên bản không có index.html', 409);
  fs.mkdirSync(workDir, { recursive: true });
  copyTree(versionDir, workDir, opts.mode, '', opts);
  const rt = htmlRuntimeDir();
  for (const [dest, src] of Object.entries(runtimeFileMap())) {
    const to = path.join(workDir, ...dest.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(rt, ...src.split('/')), to);
  }
}
