import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const baseline = spawnSync('git', ['rev-parse', 'before-account-pool-20261021^{commit}'], { encoding: 'utf8' });
if (baseline.status !== 0) throw new Error('Thiếu tag baseline');
// This script lives in scripts/, so resolve backup relative to the workspace parent.
const backup = new URL('../../autovideo-local-backups/before-account-pool-20261021/', import.meta.url);
for (const name of ['manifest.json', 'app.db', 'workspace.tar.gz']) {
  if (!fs.existsSync(new URL(name, backup))) throw new Error(`Thiếu backup ${name}`);
}
console.log(`Baseline ${baseline.stdout.trim()} verified; runtime backup exists. No changes made.`);
