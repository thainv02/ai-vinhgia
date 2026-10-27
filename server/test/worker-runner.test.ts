import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright-core';
import { ApiFailure } from '../../worker/src/api-failure.js';
import { BrowserTools } from '../../worker/src/browser.js';
import { handleJob, type RunnerDeps } from '../../worker/src/runner.js';
import { toolPairProblems } from '../../worker/src/conversation.js';
import { client, makeEnv, type Env } from './helpers.js';
import { managedClient, mediaScenario } from './helpers-media.js';
import { chromeAvailable, installSites, launchHeadless, type SiteCounters } from './helpers-browser.js';
import { FFMPEG, FFPROBE, makeTestVideo } from './final-helpers.js';
import { createAccount } from '../src/services/ai/accounts.js';

/**
 * Vòng lặp media của worker (runner.ts) chạy end-to-end: server thật (inject) + gateway giả có kịch bản +
 * executor thật trên Chrome headless với fixture ChatGPT/Flow. Không gọi inference hay website thật.
 */
const FLOW = 'https://flow.google.com/project/test?aspect=9:16&duration=10';
const CHAT = 'https://chatgpt.com/';
type Msg = Record<string, any>;
type Step = (messages: Msg[], ctx: { jobId: number; payload: any }) => Msg;

let browser: Browser;
let context: BrowserContext;
let counters: SiteCounters;
let env: Env;
let gateway: http.Server;
let gatewayUrl = '';
let received: { messages: Msg[]; tools?: unknown[]; parallel_tool_calls?: boolean }[] = [];
let script: Step[] = [];
let tmpVideo = '';
let tmpPng = '';

beforeAll(async () => {
  if (!chromeAvailable) return;
  browser = await launchHeadless();
  if (FFMPEG && FFPROBE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-runner-'));
    tmpVideo = path.join(dir, 'clip.mp4'); makeTestVideo(tmpVideo, 1, { audio: false });
    // PNG thật đủ lớn (> 100 byte, ngưỡng hợp lệ của tool tải) để ffprobe xác nhận được
    tmpPng = path.join(dir, 'image.png');
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x96:rate=1:duration=1', '-frames:v', '1', tmpPng]);
  }
});
afterAll(async () => { await browser?.close(); if (tmpVideo) fs.rmSync(path.dirname(tmpVideo), { recursive: true, force: true }); });
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  if (!chromeAvailable) return;
  env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: ['storyboard', 'video'] } });
  fs.writeFileSync(path.join(env.root, 'video-production-rules.md'), 'Quy tắc thử nghiệm');
  fs.writeFileSync(path.join(env.root, 'WORKER.md'), 'Giao thức thử nghiệm: dùng browser tools.');
  context = await browser.newContext();
  counters = await installSites(context, { png: tmpPng ? fs.readFileSync(tmpPng) : undefined, mp4: tmpVideo ? fs.readFileSync(tmpVideo) : undefined });
  received = []; script = []; checkpoints.length = 0;
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push({ messages: body.messages, tools: body.tools, parallel_tool_calls: body.parallel_tool_calls });
      const job = currentJob;
      const step = script[received.length - 1] ?? (() => ({ role: 'assistant', content: 'KẾT THÚC NGOÀI KỊCH BẢN' }));
      const message = step(body.messages, { jobId: job.id, payload: job.payload }) as Msg;
      if (message.__status) { res.writeHead(message.__status, { 'Content-Type': 'application/json' }); res.end('{"error":"x"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}/v1`;
  createAccount(env.ctx, { alias: 'A', provider: 'codex', model: 'm', base_url: gatewayUrl, priority: 1, capabilities: ['text', 'vision', 'tools'] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!chromeAvailable) return;
  expect(counters.blocked).toEqual([]);
  await new Promise<void>((r) => gateway.close(() => r()));
  await context.close(); await env.close();
});

let currentJob: any;
const call = (name: string, args: object = {}, id = `call-${Math.random().toString(16).slice(2)}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (...calls: ReturnType<typeof call>[]): Msg => ({ role: 'assistant', content: null, tool_calls: calls });
/** Gateway từ chối request (không phải hết quota): worker không được tự submit lại. */
const gatewayRejects: Step = () => ({ __status: 400 } as any);
const finalJson = (verdict = 'pass'): Step => () => ({ role: 'assistant', content: JSON.stringify({ verdict, verdict_note: 'xem ảnh: đạt' }) });
/** Tìm ref của điều khiển trong snapshot gần nhất mà model đã nhận. */
function refOf(messages: Msg[], re: RegExp): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool') continue;
    try {
      const out = JSON.parse(m.content);
      if (!out.controls) continue;
      const c = out.controls.find((x: any) => re.test([x.text, x.label, x.title].filter(Boolean).join(' ').replace(/\s+/g, ' ')));
      if (c) return c.ref;
    } catch { /* không phải snapshot */ }
  }
  throw new Error(`gateway giả: không có điều khiển ${re}`);
}
const snapshot = (): Step => () => say(call('browser_snapshot'));
const act = (name: string, re: RegExp, extra: (ctx: any) => object = () => ({})): Step => (m, ctx) => say(call(name, { ref: refOf(m, re), ...extra(ctx) }));

const checkpoints: any[] = [];
function runnerDeps(opts: { stopping?: () => boolean } = {}): RunnerDeps {
  const a = async (method: string, url: string, body?: unknown, lease?: string, jobId?: number, extra: Record<string, string> = {}) => {
    if (method === 'POST' && url.endsWith('/checkpoint')) checkpoints.push(JSON.parse(JSON.stringify(body)));
    const res = await env.app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: {
      host: 'localhost:8787', authorization: 'Bearer test-worker-token', 'x-worker-id': 'W1', ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}), ...extra } });
    if (res.statusCode === 204) return null as any;
    const parsed = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) throw new ApiFailure(parsed?.error?.code ?? 'HTTP_ERROR', parsed?.error?.message ?? 'x', parsed?.error?.details);
    return parsed;
  };
  return {
    api: a, root: env.root, sleep: async () => undefined, stopping: opts.stopping ?? (() => false),
    makeBrowser: (job, alive) => new BrowserTools(job, alive, { api: a, root: env.root, browser, sleep: async () => undefined, uploads: job.checkpoint?.uploads }),
  };
}
const claimAgain = async () => (await managedClient(env, 'W1').get('/api/worker/next?mode=managed')).body;
const actionStates = (id: number) => (env.ctx.db.prepare('SELECT id,state FROM external_actions WHERE job_id=? ORDER BY created_at,rowid').all(id)) as { id: string; state: string }[];
const jobRow = (id: number) => env.ctx.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;

const d = chromeAvailable && FFMPEG && FFPROBE ? describe : describe.skip; // cần ffmpeg/ffprobe thật để tạo clip/ảnh mẫu và xác nhận asset
const dv = d;

d('vòng lặp media end-to-end (storyboard/ChatGPT)', () => {
  it('F6: model trả nhiều tool call → chỉ lệnh đầu chạy, các lệnh còn lại nhận lỗi, job không hỏng; request gửi parallel_tool_calls=false', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.storyboard(); currentJob = job;
    const files = job.payload.upload_files as string[];
    script = [
      () => say(call('browser_open', { url: CHAT }, 'o1'), call('browser_submit', { ref: 0 }, 'o2'), call('browser_click', { ref: 0 }, 'o3')),
      snapshot(),
      act('browser_upload', /Attach files/, () => ({ files: [files[0]] })),
      act('browser_upload', /Attach files/, () => ({ files: [files[1]] })),
      act('browser_fill', /^$/, () => ({ text: 'ảnh storyboard bếp ấm' })),
      act('browser_submit', /Send prompt/),
      () => say(call('browser_wait', { seconds: 5 })),
      snapshot(),
      act('browser_click', /^Generated image 1$/),
      snapshot(),
      act('browser_download', /Download/),
      finalJson(),
    ];
    await handleJob(job, runnerDeps());
    expect(received.every((r) => r.parallel_tool_calls === false)).toBe(true);
    expect(received[0]!.tools!.length).toBeGreaterThan(0);
    // lượt 2 nhận đủ 3 phản hồi tool cho 3 tool_call_id, hai cái sau là lỗi "một thao tác mỗi lượt"
    const second = received[1]!.messages;
    const tools3 = second.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, JSON.parse(m.content)]);
    expect(tools3.map((t) => t[0])).toEqual(['o1', 'o2', 'o3']);
    expect(tools3[0]![1]).toMatchObject({ url: expect.stringContaining('chatgpt.com') });
    expect(tools3[1]![1].error).toMatch(/Chỉ một thao tác/);
    expect(tools3[2]![1].error).toMatch(/Chỉ một thao tác/);
    expect(toolPairProblems(second)).toEqual([]);
    // submit trong cùng lượt KHÔNG chạy; submit thật chỉ một lần, job hoàn thành
    expect(counters.chatSend).toBe(1);
    expect(actionStates(job.id).map((a) => a.state)).toEqual(['committed']);
    const row = jobRow(job.id);
    expect(row.status).toBe('done');
    expect(fs.existsSync(path.join(env.root, job.payload.output.storyboard_path))).toBe(true);
    expect(env.ctx.db.prepare('SELECT kind FROM assets WHERE job_id=?').all(job.id)).toEqual([{ kind: 'storyboard' }]);
  });

  it('F5: hơn 60 message → nén thành tóm tắt + 30 message gần nhất, mọi tool_call_id vẫn có phản hồi, không lỗi giới hạn ngữ cảnh; job vẫn hoàn thành', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.storyboard(); currentJob = job;
    const files = job.payload.upload_files as string[];
    script = [() => say(call('browser_open', { url: CHAT })), snapshot()];
    for (let i = 0; i < 40; i++) script.push(i % 5 === 0 ? () => say(call('browser_wait', { seconds: 5 })) : snapshot());
    script.push(
      snapshot(),
      act('browser_upload', /Attach files/, () => ({ files: [files[0]] })),
      act('browser_upload', /Attach files/, () => ({ files: [files[1]] })),
      act('browser_fill', /^$/, () => ({ text: 'storyboard' })),
      act('browser_submit', /Send prompt/),
      snapshot(),
      act('browser_click', /^Generated image 1$/),
      snapshot(),
      act('browser_download', /Download/),
      finalJson(),
    );
    await handleJob(job, runnerDeps());
    expect(jobRow(job.id).status).toBe('done');
    const sizes = received.map((r) => r.messages.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64); // luôn < 100 của server và quanh ngưỡng 60
    const compacted = received.find((r) => r.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Tóm tắt tự động')));
    expect(compacted).toBeTruthy();
    for (const r of received) expect(toolPairProblems(r.messages)).toEqual([]);
    // phần đầu giữ nguyên: system + payload + protocol
    expect(received.at(-1)!.messages[0]!.role).toBe('system');
    expect(String(received.at(-1)!.messages[2]!.content)).toContain('Giao thức worker');
    const summary = String(compacted!.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('[Tóm tắt tự động'))!.content);
    expect(summary).toMatch(/browser_wait seconds=5 → ok/);
    expect(summary).toMatch(/Action journal: chưa có action nào/);
    // checkpoint (bản lưu sau mỗi lượt) cũng ở dạng đã nén, không phình, và giữ danh sách upload
    const inference = checkpoints.filter((c) => c.step === 'inference');
    expect(Math.max(...inference.map((c) => c.messages.length))).toBeLessThan(64);
    expect(inference.at(-1).uploads.flatMap((u: any) => u.files)).toEqual(files);
    expect(inference.some((c) => c.messages.some((m: any) => m.summary === true))).toBe(true);
    // 60 lượt là giới hạn: kịch bản này dùng < 60 lượt
    expect(received.length).toBeLessThan(60);
  });

  it('hết 60 lượt → lỗi rõ ràng; chưa submit nên job failed (không chờ đối soát)', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.storyboard(); currentJob = job;
    script = Array.from({ length: 80 }, () => snapshot());
    script[0] = () => say(call('browser_open', { url: CHAT }));
    await handleJob(job, runnerDeps());
    expect(received.length).toBe(60);
    const row = jobRow(job.id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/Hết giới hạn 60 lượt/);
    expect(actionStates(job.id)).toEqual([]);
  });
});

dv('vòng lặp media end-to-end (video/Flow)', () => {
  /** Kịch bản video tới khi đã submit; `tail` là phần còn lại. */
  const toSubmit = (files: string[]): Step[] => [
    () => say(call('browser_open', { url: FLOW })),
    snapshot(),
    act('browser_upload', /Upload media/, () => ({ files: [files[0]] })),
    act('browser_upload', /Upload media/, () => ({ files: [files[1]] })),
    act('browser_upload', /Upload media/, () => ({ files: [files[2]] })),
    act('browser_fill', /Prompt/, (c) => ({ text: c.payload.scene.prompt })),
    act('browser_submit', /Create/),
  ];
  const download: Step[] = [
    snapshot(),
    act('browser_click', /Download/),
    snapshot(),
    act('browser_download', /720p Original/),
  ];

  it('video: precheck chặn khi thiếu upload, rồi đủ điều kiện thì submit một lần, tải 720p, hoàn thành, ledger đúng một lần', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.video(); currentJob = job;
    const files = job.payload.upload_files as string[];
    script = [
      () => say(call('browser_open', { url: FLOW })),
      snapshot(),
      act('browser_upload', /Upload media/, () => ({ files: [files[0]] })),
      act('browser_fill', /Prompt/, (c) => ({ text: c.payload.scene.prompt })),
      act('browser_submit', /Create/), // thiếu 2 upload → PRECHECK_FAILED, chưa ghi gì
      act('browser_upload', /Upload media/, () => ({ files: [files[1]] })),
      act('browser_upload', /Upload media/, () => ({ files: [files[2]] })),
      act('browser_submit', /Create/),
      ...download,
      finalJson(),
    ];
    await handleJob(job, runnerDeps());
    const toolOut = (i: number) => JSON.parse(received[i + 1]!.messages.filter((m) => m.role === 'tool').at(-1)!.content);
    expect(toolOut(4).error).toMatch(/^PRECHECK_FAILED: uploads/);
    expect(counters.flowGenerate).toBe(1);
    expect(jobRow(job.id)).toMatchObject({ status: 'done', credits_cost: 15 });
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE job_id=?').get(job.id)).toEqual({ n: 1 });
    expect(env.ctx.db.prepare('SELECT kind FROM assets WHERE job_id=? ORDER BY id').all(job.id)).toEqual([{ kind: 'video' }, { kind: 'grid' }]);
    expect(actionStates(job.id).map((a) => a.state)).toEqual(['committed']);
  });

  it('model trả JSON kết luận trước khi tải asset → bị yêu cầu tiếp tục (không đẩy job sang đối soát), tải xong mới hoàn thành', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.video(); currentJob = job;
    const files = job.payload.upload_files as string[];
    script = [...toSubmit(files), finalJson('pass'), ...download, finalJson('pass')];
    await handleJob(job, runnerDeps());
    const rejected = received[8]!.messages.at(-1)!;
    expect(String(rejected.content)).toMatch(/Chưa thể kết thúc: action media-\d+ đang ở trạng thái submitted/);
    expect(jobRow(job.id).status).toBe('done');
    expect(counters.flowGenerate).toBe(1);
  });

  it('lỗi sau submit → chờ đối soát; retry_download → resume giữ upload/checkpoint, KHÔNG submit lại; model thử submit lần nữa bị từ chối; hoàn thành với đúng một lượt tạo', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.video(); currentJob = job;
    const files = job.payload.upload_files as string[];
    // lần chạy 1: submit xong thì gateway từ chối request kế tiếp → lỗi sau submit → needs_reconciliation
    script = [...toSubmit(files), gatewayRejects];
    await handleJob(job, runnerDeps());
    expect(counters.flowGenerate).toBe(1);
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: 'needs_reconciliation' });
    expect(actionStates(job.id).map((a) => a.state)).toEqual(['submitted']);
    // người dùng đối soát: kết quả đã được tạo
    const rec = await client(env.app).post(`/api/jobs/${job.id}/reconcile`, { outcome: 'retry_download' });
    expect(rec.status).toBe(200);
    // lần chạy 2 (resume): model cố submit lại trước, rồi tìm và tải
    const resumed = await claimAgain();
    expect(resumed.id).toBe(job.id);
    expect(resumed.checkpoint.uploads.flatMap((u: any) => u.files)).toEqual(files);
    currentJob = resumed;
    received = []; script = [
      snapshot(),
      act('browser_submit', /Create/), // phải bị từ chối: đã có action
      ...download,
      finalJson(),
    ];
    await handleJob(resumed, runnerDeps());
    const refused = JSON.parse(received[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content);
    expect(refused.error).toMatch(/Đã có submit intent/);
    expect(counters.flowGenerate).toBe(1); // vẫn đúng một lượt tạo
    expect(jobRow(job.id)).toMatchObject({ status: 'done', credits_cost: 15 });
    expect(env.ctx.db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE job_id=?').get(job.id)).toEqual({ n: 1 });
    // resume không đẩy lại toàn bộ WORKER.md: chỉ một message tiếp tục ngắn
    const first = received[0]!.messages;
    expect(first.filter((m) => typeof m.content === 'string' && m.content.startsWith('Giao thức worker')).length).toBe(1);
    expect(first.at(-1)!.content).toMatch(/Tiếp tục job sau gián đoạn/);
  });

  it('nothing_created: chạy lại từ đầu với action id mới media-<job>-2 và submit được đúng một lần nữa', async () => {
    const ms = await mediaScenario(env);
    const job = await ms.video(); currentJob = job;
    const files = job.payload.upload_files as string[];
    script = [...toSubmit(files), gatewayRejects];
    await handleJob(job, runnerDeps());
    expect(counters.flowGenerate).toBe(1);
    expect((await client(env.app).post(`/api/jobs/${job.id}/reconcile`, { outcome: 'nothing_created' })).status).toBe(200);
    const again = await claimAgain();
    expect(again.checkpoint).toBeNull();
    currentJob = again;
    received = [];
    // trang cũ vẫn còn ảnh/prompt: model mở trang mới rồi làm lại từ đầu (không dùng upload ghi nhận cũ)
    script = [...toSubmit(files), ...download, finalJson()];
    await handleJob(again, runnerDeps());
    expect(String(received[0]!.messages.at(-1)!.content)).toContain('media-' + job.id + '=abandoned');
    expect(String(received[0]!.messages.at(-1)!.content)).toMatch(/đã bị bỏ sau đối soát/);
    expect(actionStates(job.id)).toEqual([{ id: `media-${job.id}`, state: 'abandoned' }, { id: `media-${job.id}-2`, state: 'committed' }]);
    expect(counters.flowGenerate).toBe(2); // lượt mới do người dùng xác nhận chưa có gì được tạo
    expect(jobRow(job.id).status).toBe('done');
  });
});
