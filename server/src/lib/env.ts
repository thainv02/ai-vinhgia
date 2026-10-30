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

/** Bảng ký tự mã truy cập LAN: 32 ký tự, bỏ I/O/0/1 để dễ đọc và dễ gõ (so khớp không phân biệt hoa thường). */
export const LAN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Mã truy cập ngẫu nhiên (CSPRNG, không lệch phân phối: 32 ký tự → crypto.randomInt đều). 8 ký tự ≈ 40 bit. */
export function generateLanAccessCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += LAN_CODE_ALPHABET[crypto.randomInt(LAN_CODE_ALPHABET.length)];
  return out;
}

/** Ghi KEY=value vào file .env (thay dòng cũ nếu có, ngược lại thêm cuối file), quyền 0600. */
export function setEnvValue(file: string, key: string, value: string): void {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Tạo tự động. Xem .env.example để biết các biến khác.\n';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, () => `${key}=${value}`);
  } else {
    if (content.length && !content.endsWith('\n')) content += '\n';
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // `mode` chỉ có tác dụng khi tạo file mới; .env có sẵn cũng phải owner-only
}

/** Nếu chưa có LAN_ACCESS_CODE thì sinh ngẫu nhiên, ghi vào .env và đặt vào env (giống WORKER_TOKEN). Trả về mã. */
export function ensureLanAccessCode(file: string, env: NodeJS.ProcessEnv = process.env): string {
  const existing = (env.LAN_ACCESS_CODE ?? '').trim();
  if (existing) return existing;
  const code = generateLanAccessCode();
  setEnvValue(file, 'LAN_ACCESS_CODE', code);
  env.LAN_ACCESS_CODE = code;
  return code;
}
