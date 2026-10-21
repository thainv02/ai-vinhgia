import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readOnlyDb } from '../../server/src/db/readonly.js';
import { loadConfig } from '../../server/src/config.js';
import { root, sleep } from './client.js';

const config = loadConfig();
let stopping = false;
const owned = new Map<number, ChildProcess>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; for (const c of owned.values()) c.kill(signal); });
console.log('Account proxy supervisor: tự giữ proxy cho tài khoản đã đăng nhập; Ctrl+C dừng proxy do supervisor này mở.');
while (!stopping) {
  const db = readOnlyDb(config.dbPath);
  const rows = db.prepare("SELECT id,provider,enabled,key_env,reserved_until FROM ai_accounts").all() as { id: number; provider: string; enabled: number; key_env: string | null; reserved_until: string | null }[];
  db.close();
  for (const row of rows) {
    if (!row.enabled) { if (!row.reserved_until || Date.parse(row.reserved_until) <= Date.now()) owned.get(row.id)?.kill('SIGTERM'); continue; }
    if (owned.has(row.id) || row.key_env || !['codex', 'antigravity'].includes(row.provider)) continue;
    const dir = path.join(config.aiHome, String(row.id));
    if (!fs.existsSync(path.join(dir, 'auth')) || !fs.readdirSync(path.join(dir, 'auth')).some((f) => f.endsWith('.json'))) continue;
    const lock = path.join(dir, 'process.lock');
    if (fs.existsSync(lock)) {
      let live = false; try { process.kill(Number(fs.readFileSync(lock, 'utf8')), 0); live = true; } catch { /* stale */ }
      if (live) continue;
    }
    const c = spawn(process.execPath, ['--import', 'tsx', 'worker/src/proxy.ts', 'serve', String(row.id)], { cwd: root, stdio: 'inherit', env: process.env });
    owned.set(row.id, c);
    c.on('exit', () => owned.delete(row.id)); c.on('error', () => owned.delete(row.id));
  }
  await sleep(5000);
}
await Promise.all([...owned.values()].map((c) => new Promise<void>((r) => { if (c.exitCode !== null) r(); else c.once('exit', () => r()); })));
