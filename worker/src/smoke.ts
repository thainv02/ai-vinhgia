import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { buildApp } from '../../server/src/app.js';
import { readOnlyDb } from '../../server/src/db/readonly.js';
import { loadConfig } from '../../server/src/config.js';
import { root } from './client.js';

const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1) throw new Error('Dùng npm run ai:smoke -- <account-id>. Lệnh này dùng một lượt inference thật.');
const cfg = loadConfig(), source = readOnlyDb(cfg.dbPath);
const row = source.prepare('SELECT * FROM ai_accounts WHERE id=?').get(id) as Record<string, any> | undefined;
source.close();
if (!row) throw new Error('Không tìm thấy account');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-live-smoke-'));
const app = await buildApp({ rootDir: temp, logger: false, config: { workerMode: 'managed', workerToken: cfg.workerToken, aiHome: cfg.aiHome, watermarkRemover: 'off', finalRenderer: 'ffmpeg' } });
let faultGateway: http.Server | null = null;
try {
  const keys = Object.keys(row);
  app.ctx.db.prepare(`INSERT INTO ai_accounts(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  app.ctx.db.prepare("UPDATE ai_accounts SET state='ready',retry_after=NULL,reserved_until=NULL,reservation_id=NULL WHERE id=?").run(id);
  if (process.argv.includes('--fallback')) {
    faultGateway = http.createServer((_req, res) => { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' }); res.end('{"error":{"code":"quota_exhausted"}}'); });
    await new Promise<void>((r) => faultGateway!.listen(0, '127.0.0.1', r));
    process.env.AUTOVIDEO_SMOKE_FAULT_KEY = 'local-fault-injection';
    const port = (faultGateway.address() as { port: number }).port;
    app.ctx.db.prepare('INSERT INTO ai_accounts(alias,provider,base_url,model,key_env,priority,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('Injected quota A', row.provider, `http://127.0.0.1:${port}/v1`, row.model, 'AUTOVIDEO_SMOKE_FAULT_KEY', -1, app.ctx.now());
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: { host: 'localhost' }, payload: { name: 'Account pool smoke', brief: 'Tạo đúng một cảnh 10 giây, 9:16: ly sinh tố cacao trên bàn gỗ, ánh sáng cửa sổ. Không người, không sản phẩm thương hiệu, không chữ, không thoại. Chỉ viết prompt, chưa tạo ảnh/video.' } })).json();
  await app.inject({ method: 'POST', url: `/api/projects/${project.id}/brief`, headers: { host: 'localhost' }, payload: {} });
  console.log(`Thử một job phân tích qua ${row.alias}/${row.model}, API và DB tạm riêng.`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'worker/src/main.ts', '--once'], { cwd: root, env: { ...process.env, AUTOVIDEO_API: url, WORKER_TOKEN: cfg.workerToken, WORKER_TYPES: 'analyze_brief', AUTOVIDEO_WORKER_ID: 'live-smoke' }, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
  await new Promise<void>((resolve, reject) => { child.on('exit', () => resolve()); child.on('error', reject); }); clearTimeout(timeout);
  const job = app.ctx.db.prepare('SELECT status,error_code,wait_reason FROM jobs ORDER BY id DESC LIMIT 1').get() as any;
  const scenes = app.ctx.db.prepare('SELECT code,status FROM scenes ORDER BY id').all();
  const attempts = app.ctx.db.prepare('SELECT account_id,model,outcome,latency_ms FROM ai_attempts ORDER BY id').all() as { account_id: number; outcome: string }[];
  const faultPassed = !faultGateway || (attempts[0]?.outcome === 'quota_exhausted' && attempts.some((a) => a.account_id === id && a.outcome === 'ok'));
  const summary = { at: new Date().toISOString(), provider: row.provider, account_alias: row.alias, model: row.model, job, scenes, attempts, simulated_quota: !!faultGateway, passed: job.status === 'done' && scenes.length > 0 && faultPassed };
  fs.mkdirSync(path.join(root, '.ai-local'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, '.ai-local/last-smoke.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
} finally { await app.close(); if (faultGateway) await new Promise<void>((r) => faultGateway!.close(() => r())); fs.rmSync(temp, { recursive: true, force: true }); }
