import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readOnlyDb } from '../../server/src/db/readonly.js';
import { loadConfig } from '../../server/src/config.js';
import './client.js';

const [action, rawId] = process.argv.slice(2);
const id = Number(rawId);
if (!Number.isSafeInteger(id) || id <= 0 || !['login', 'serve'].includes(action)) throw new Error('Dùng: npm run ai:login -- <account-id> hoặc npm run ai:proxy -- <account-id>');
const config = loadConfig();
const db = readOnlyDb(config.dbPath);
const a = db.prepare('SELECT provider,key_env FROM ai_accounts WHERE id=?').get(id) as { provider: string; key_env: string | null } | undefined;
db.close();
if (!a || !['codex', 'antigravity'].includes(a.provider) || a.key_env) throw new Error('Account này dùng gateway ngoài/API chính thức; không có CLI OAuth login');
const dir = path.join(config.aiHome, String(id));
const binary = process.env.CLIPROXY_BIN ?? path.join(os.homedir(), '.local/share/autovideo/cliproxy/8.0.37/cli-proxy-api');
if (!fs.existsSync(binary)) throw new Error('Chưa cài proxy. Chạy npm run ai:setup');
// Lock one login/serve process per store to avoid refresh races.
const lock = path.join(dir, 'process.lock');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  let live = false; try { process.kill(pid, 0); live = true; } catch { /* stale */ }
  if (live) throw new Error('Store đang có tiến trình login/proxy; dừng tiến trình đó trước khi tiếp tục');
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
const args = ['-config', path.join(dir, 'config.yaml'), '-local-model'];
if (action === 'login') args.push(a.provider === 'codex' ? '-codex-device-login' : '-antigravity-login');
console.log(`${action}: account #${id}; credential store riêng. Hoàn tất đăng nhập trong luồng của provider.`);
const child = spawn(binary, args, { stdio: 'inherit', env: { ...process.env }, cwd: dir });
const cleanup = () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
child.on('error', () => { cleanup(); console.error('Không khởi động được proxy'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  if (action === 'login' && code === 0) {
    const auth = path.join(dir, 'auth');
    const names = fs.existsSync(auth) ? fs.readdirSync(auth).filter((f) => f.endsWith('.json')) : [];
    if (names.length === 1) {
      // The provider-generated filename identifies this login; do not read raw OAuth tokens.
      fs.writeFileSync(path.join(dir, 'identity'), crypto.createHash('sha256').update(names[0].toLowerCase()).digest('hex'), { mode: 0o600 });
    }
  }
  cleanup(); process.exitCode = code ?? 1;
});
