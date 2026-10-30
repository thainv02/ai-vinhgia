import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const binary = process.env.CHROME_BIN ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const profile = path.join(os.homedir(), '.local/share/autovideo/browser/media');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const port = Number(process.env.BROWSER_CDP_PORT ?? 9222);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CDP port không hợp lệ');
const child = spawn(binary, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'https://chatgpt.com', 'https://flow.google.com'], { stdio: 'ignore', detached: true });
child.on('error', () => { console.error('Không mở được Chrome. Đặt CHROME_BIN tới executable trên máy.'); process.exitCode = 1; });
child.unref();
console.log(`Chrome profile media riêng; CDP http://127.0.0.1:${port}. Đăng nhập ChatGPT/Flow trong cửa sổ này.`);
