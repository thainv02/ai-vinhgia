// Tiến trình con: claim job liên tục trên cùng file DB cho tới khi hết, in ra danh sách id đã claim (JSON).
import { defaultConfig } from '../../src/config.js';
import { AppContext } from '../../src/context.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import { systemClock } from '../../src/lib/clock.js';
import { claimNext } from '../../src/services/jobs.js';
import { SseHub } from '../../src/services/sse.js';

const [dbPath, root, who] = process.argv.slice(2) as [string, string, string];
const db = openDb(dbPath);
runMigrations(db);
const ctx = new AppContext(db, { ...defaultConfig(root, dbPath), workerToken: 'x', maxConcurrentVideoJobs: 1000 }, systemClock, new SseHub());
const ids: number[] = [];
for (;;) {
  const job = claimNext(ctx, who);
  if (!job) break;
  ids.push(job.id);
}
console.log(JSON.stringify(ids));
db.close();
