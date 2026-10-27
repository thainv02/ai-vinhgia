import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { api, root, workerId, ApiFailure, sleep, type Job } from './client.js';
import { BrowserTools } from './browser.js';
import { handleJob, type RunnerDeps } from './runner.js';

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
const once = process.argv.includes('--once');
const types = process.env.WORKER_TYPES ?? (process.env.BROWSER_CDP_URL ? 'analyze_brief,revise_prompt,edit_plan,clip_plan,storyboard,video' : 'analyze_brief,revise_prompt,edit_plan,clip_plan');
const lockDir = path.join(os.homedir(), '.local/share/autovideo');
fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
const lock = path.join(lockDir, 'managed-worker.lock');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  let live = false; try { process.kill(pid, 0); live = true; } catch { /* stale */ }
  if (live) throw new Error('Đã có managed worker trên máy; dừng worker cũ trước khi khởi động');
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
process.on('exit', () => { try { fs.unlinkSync(lock); } catch { /* gone */ } });

const deps: RunnerDeps = { api, root, sleep, stopping: () => stopping, makeBrowser: (job, alive) => new BrowserTools(job, alive, { api, root, uploads: job.checkpoint?.uploads }) };

try {
  console.log(`Managed worker ${workerId}; types=${types}`);
  // Không còn lỗi WORKER_MODE khi lệch chế độ (server chỉ trả 204): cảnh báo sớm nếu cấu hình khiến worker không nhận được loại nào.
  try {
    const ping = await api<{ managed_job_types?: string[] }>('GET', '/api/worker/ping');
    if (ping.managed_job_types) {
      const eligible = types.split(',').filter((t) => ping.managed_job_types!.includes(t));
      console.log(`Server giao cho managed worker: ${ping.managed_job_types.join(',') || '(không loại nào)'}; worker này sẽ nhận: ${eligible.join(',') || '(không loại nào)'}`);
      if (!eligible.length) console.warn('Cảnh báo: server không giao loại job nào cho worker này (kiểm tra WORKER_MODE, MANAGED_JOB_TYPES và WORKER_TYPES).');
    }
  } catch { /* server chưa chạy: vòng lặp bên dưới sẽ thử lại */ }
  while (!stopping) {
    try {
      const job = await api<Job | null>('GET', `/api/worker/next?mode=managed&types=${encodeURIComponent(types)}`);
      if (job) await handleJob(job, deps);
      if (once) break;
      await sleep(job ? 1000 : 5000);
    } catch (e) {
      console.error(e instanceof ApiFailure ? `${e.code}: ${e.message}` : 'Không kết nối được API');
      if (once || (e instanceof ApiFailure && ['UNAUTHORIZED'].includes(e.code))) { process.exitCode = 1; break; }
      await sleep(5000);
    }
  }
} finally { try { fs.unlinkSync(lock); } catch { /* exit handler */ } }
