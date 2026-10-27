// Shotcut MCP giả (stdio, JSON-RPC mỗi dòng một message) dùng cho test. Điều khiển bằng biến môi trường:
//   FAKE_MCP_LOG   file ghi lại mọi request (mỗi dòng một JSON) + env nhận được
//   FAKE_MCP_MODE  ok | create_error | render_fail | hang | die_on_start_render
//   FAKE_MCP_CHECK ok | bad  (kết quả của --check)
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.FAKE_MCP_LOG;
const mode = process.env.FAKE_MCP_MODE || 'ok';
const record = (o) => log && fs.appendFileSync(log, JSON.stringify(o) + '\n');

if (process.argv.includes('--check')) {
  const ok = (process.env.FAKE_MCP_CHECK || 'ok') === 'ok';
  console.log(JSON.stringify({ runtime_ready: ok, runtime: { shotcut: { found: ok }, melt: { found: ok } } }));
  process.exit(0);
}

record({
  started: true,
  env: { SHOTCUT_MCP_ALLOWED_ROOTS: process.env.SHOTCUT_MCP_ALLOWED_ROOTS, SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS: process.env.SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS, SHOTCUT_MCP_MAX_ACTIVE_RENDERS: process.env.SHOTCUT_MCP_MAX_ACTIVE_RENDERS },
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const jobs = new Map();
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const text = (obj, isError = false) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], isError });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  record({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-shotcut-mcp', version: '0' } });
  if (msg.method === 'notifications/initialized') return;
  if (msg.method !== 'tools/call') return reply(msg.id, {});
  const { name, arguments: a } = msg.params;
  switch (name) {
    case 'create_project':
      if (mode === 'create_error') return reply(msg.id, text('Project path is outside the authorized roots', true));
      fs.mkdirSync(a.project_path.replace(/\/[^/]+$/, ''), { recursive: true });
      fs.writeFileSync(a.project_path, `<mlt>${JSON.stringify(a.clips)}</mlt>`);
      return reply(msg.id, text({ created: true, path: a.project_path }));
    case 'render_contact_sheet':
      fs.writeFileSync(a.output_path, PNG);
      return reply(msg.id, text({ created: true, path: a.output_path }));
    case 'start_render': {
      if (mode === 'die_on_start_render') process.exit(7);
      const job = { id: `fake-job-${jobs.size + 1}`, output: a.output_path, polls: 0, cancelled: false };
      jobs.set(job.id, job);
      return reply(msg.id, text({ job_id: job.id, status: 'running' }));
    }
    case 'render_status': {
      const job = jobs.get(a.job_id);
      if (!job) return reply(msg.id, text('unknown job', true));
      job.polls++;
      if (job.cancelled) return reply(msg.id, text({ job_id: job.id, status: 'cancelled', progress_percent: 30 }));
      if (mode === 'hang') return reply(msg.id, text({ job_id: job.id, status: 'running', progress_percent: 5 }));
      if (mode === 'render_fail' && job.polls >= 2) return reply(msg.id, text({ job_id: job.id, status: 'failed', return_code: 1, progress_percent: 40, log_tail: 'melt: codec error\nline2' }));
      if (job.polls >= 3) {
        fs.writeFileSync(job.output, 'fake-shotcut-output');
        return reply(msg.id, text({ job_id: job.id, status: 'completed', return_code: 0, progress_percent: 100, delivery_complete: true }));
      }
      return reply(msg.id, text({ job_id: job.id, status: 'running', progress_percent: job.polls * 30 }));
    }
    case 'cancel_render': {
      const job = jobs.get(a.job_id);
      if (job) job.cancelled = true;
      return reply(msg.id, text({ job_id: a.job_id, status: 'cancelled' }));
    }
    default:
      return reply(msg.id, text(`unknown tool ${name}`, true));
  }
});
