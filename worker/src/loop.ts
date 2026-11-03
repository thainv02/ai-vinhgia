import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { api, root, workerId, ApiFailure, sleep, type Job } from './client.js';
import { handleJob, type RunnerDeps } from './runner.js';

/**
 * Vòng lặp managed worker: giữ khoá một worker mỗi máy, nhận job `types` rồi chạy tới khi có tín hiệu dừng.
 */
export async function runWorker(opts: { types: string }): Promise<void> {
  const { types } = opts;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
  // Worker nhúng: tiến trình cha (server) giữ pipe stdin; pipe đóng = server đã thoát → dừng theo
  if (process.env.AUTOVIDEO_EMBEDDED) process.stdin.on('end', () => { stopping = true; }).on('error', () => { stopping = true; }).resume();
  const once = process.argv.includes('--once');
  const lockDir = process.env.AUTOVIDEO_LOCK_DIR ?? path.join(os.homedir(), '.local/share/autovideo');
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

  const deps: RunnerDeps = { api, root, sleep, stopping: () => stopping };
  const active=new Set<Promise<void>>();

  try {
    console.log(`Managed worker ${workerId}; types=${types}`);
    // Cảnh báo sớm nếu cấu hình khiến worker không nhận được loại job nào.
    try {
      const ping = await api<{ managed_job_types?: string[] }>('GET', '/api/worker/ping');
      if (ping.managed_job_types) {
        const eligible = types.split(',').filter((t) => ping.managed_job_types!.includes(t));
        console.log(`Server giao cho managed worker: ${ping.managed_job_types.join(',') || '(không loại nào)'}; worker này sẽ nhận: ${eligible.join(',') || '(không loại nào)'}`);
        if (!eligible.length) console.warn('Cảnh báo: server không giao loại job nào cho worker này (kiểm tra WORKER_TYPES).');
      }
    } catch { /* server chưa chạy: vòng lặp bên dưới sẽ thử lại */ }
    while (!stopping) {
      try {
        if(active.size>=3){await Promise.race(active);continue;}
        const available=active.size?'html_compose':types;
        const job = await api<Job | null>('GET', `/api/worker/next?mode=managed&types=${encodeURIComponent(available)}`);
        if(job){
          if(job.type==='html_compose'&&!once){
            const task=handleJob(job,deps).catch(e=>{console.error(e instanceof ApiFailure?`${e.code}: ${e.message}`:'Lỗi xử lý đoạn HTML');}).finally(()=>active.delete(task));active.add(task);
          }else await handleJob(job,deps);
        }
        if (once) break;
        await sleep(job ? 1000 : 5000);
      } catch (e) {
        console.error(e instanceof ApiFailure ? `${e.code}: ${e.message}` : 'Không kết nối được API');
        if (once || (e instanceof ApiFailure && ['UNAUTHORIZED'].includes(e.code))) { process.exitCode = 1; break; }
        await sleep(5000);
      }
    }
  } finally { await Promise.allSettled(active);try { fs.unlinkSync(lock); } catch { /* exit handler */ } }
}
