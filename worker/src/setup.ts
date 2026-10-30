import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const version = '8.0.37';
if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Cấu hình CLIPROXY_BIN thủ công cho hệ điều hành này');
const platform = process.platform;
const arch = process.arch === 'arm64' ? 'aarch64' : 'amd64';
const file = `CLIProxyAPI_${version}_${platform}_${arch}.tar.gz`;
const base = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/`;
async function download(name: string) {
  const r = await fetch(base + name, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`Không tải được ${name}`);
  return Buffer.from(await r.arrayBuffer());
}
const hashes = (await download('checksums.txt')).toString();
const expected = hashes.split('\n').find((l) => l.trim().endsWith(file))?.split(/\s+/)[0];
if (!expected) throw new Error('Không có checksum cho kiến trúc này');
const bytes = await download(file);
if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Checksum không khớp');
const dest = path.join(os.homedir(), '.local/share/autovideo/cliproxy', version);
fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
const archive = path.join(dest, file); fs.writeFileSync(archive, bytes, { mode: 0o600 });
const entries = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
if (entries.status !== 0 || entries.stdout.split('\n').some((p) => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('Archive không hợp lệ');
const result = spawnSync('tar', ['-xzf', archive, '-C', dest], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Không giải nén được proxy');
console.log(`Đã cài CLIProxyAPI ${version}; SHA256 ${expected}`);
