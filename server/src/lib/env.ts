import fs from 'node:fs';
import crypto from 'node:crypto';

/** Đọc file .env đơn giản (KEY=VALUE), không ghi đè biến môi trường đã có. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
}

/** Nếu chưa có WORKER_TOKEN thì sinh ngẫu nhiên và ghi vào file .env. */
export function ensureWorkerToken(file: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORKER_TOKEN) return env.WORKER_TOKEN;
  const token = crypto.randomBytes(24).toString('hex');
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Tạo tự động. Xem .env.example để biết các biến khác.\n';
  if (/^WORKER_TOKEN=.*$/m.test(content)) {
    content = content.replace(/^WORKER_TOKEN=.*$/m, `WORKER_TOKEN=${token}`);
  } else {
    if (content.length && !content.endsWith('\n')) content += '\n';
    content += `WORKER_TOKEN=${token}\n`;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  env.WORKER_TOKEN = token;
  return token;
}
