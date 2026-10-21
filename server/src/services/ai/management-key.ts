import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Local management credential, never a provider OAuth token. Upgrade old stores once. */
export function managementKey(dir: string): string {
  const keyFile = path.join(dir, 'management-key');
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  const configFile = path.join(dir, 'config.yaml');
  const config = fs.readFileSync(configFile, 'utf8');
  const match = /^(\s+secret-key:\s*)(.+)$/m.exec(config);
  if (!match) throw new Error('management_not_configured');
  const existing = match[2].trim().replace(/^["']|["']$/g, '');
  const key = existing && !existing.startsWith('$2') ? existing : crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
  if (key !== existing) {
    const backup = path.join(dir, 'config.before-quota.yaml');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, config, { mode: 0o600 });
    const temp = configFile + '.quota.tmp';
    fs.writeFileSync(temp, config.replace(/^(\s+secret-key:\s*).+$/m, `$1${JSON.stringify(key)}`), { mode: 0o600 });
    fs.renameSync(temp, configFile);
  }
  return key;
}
