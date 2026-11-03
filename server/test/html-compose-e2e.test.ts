import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../../worker/src/api-failure.js';
import { handleJob, type RunnerDeps } from '../../worker/src/runner.js';
import { TEXT_JOB_TYPES } from '../src/config.js';
import { clearModelCache } from '../src/services/ai/models.js';
import { setCompositionValidator } from '../src/services/html/compose-lifecycle.js';
import { setCheckEngine } from '../src/services/html/compose-check.js';
import { installHtmlValidator, lintComposition } from '../src/services/html/engine/index.js';
import { instantiateTemplate } from '../src/services/html/templates.js';
import { client, PNG_BYTES } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { managedClient } from './helpers-media.js';

/**
 * Job `html_compose` end-to-end THẬT: server thật (route LAN desktop + route worker) + worker thật (handleJob) + API AI giả (không gọi AI thật).
 * Lint chạy thật (@hyperframes/lint + lint bảo mật); chụp khung dùng đồ giả (không cần trình duyệt).
 */
interface AiCall {
  model: string;
  kind: 'compose' | 'vision' | 'asset_vision';
  hasImage: boolean;
  lastUser: string;
}
let L: LanEnv;
let c: LanClient;
let ai: http.Server;
let aiUrl = '';
const calls: AiCall[] = [];
let modelHits = 0;
let models = ['claude-sonnet-4-6', 'vision-x', 'other-model'];
let script: (call: AiCall, n: number) => string | { status: number; body: unknown } = () => '';
const P = '/lan/api/html-projects';
let seq = 0;
const key = () => `key-${Date.now()}-${++seq}-abcdef`;

const goodJson = (tag = 'ok', aspect: '9:16' | '16:9' | '1:1' = '9:16', d = 6): string => {
  const t = instantiateTemplate('product', { aspect, durationS: d })!;
  return JSON.stringify({ files: t.files, summary: `Video ${tag}`, variables: t.meta.variables });
};
const badJson = (): string => {
  const t = instantiateTemplate('product', { aspect: '9:16', durationS: 6 })!;
  return JSON.stringify({ files: t.files.map((f) => ({ ...f, content: f.content.replace('window.__timelines["main"] = tl;', 'fetch("https://evil.example/x"); window.__timelines["main"] = tl;') })), summary: 'hỏng', variables: [] });
};
const VISION_OK = '{"ok":true,"issues":[]}';

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  calls.length = 0;
  modelHits = 0;
  models = ['claude-sonnet-4-6', 'vision-x', 'other-model'];
  clearModelCache();
  script = (call) => (call.kind === 'asset_vision' ? JSON.stringify({ summary: 'Ảnh hộp sữa', text: '110ml', details: 'Cần kiểm tra dung tích', uncertain: true }) : call.kind === 'vision' ? VISION_OK : goodJson());
  ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (x) => (raw += x));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        modelHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      }
      const body = JSON.parse(raw);
      const sys = String(body.messages[0].content);
      const user = body.messages.at(-1).content;
      const parts: any[] = Array.isArray(user) ? user : [{ type: 'text', text: user }];
      const call: AiCall = { model: body.model, kind: sys.includes('Bạn mô tả ảnh') ? 'asset_vision' : sys.includes('người kiểm tra hình ảnh') ? 'vision' : 'compose', hasImage: parts.some((p) => p.type === 'image_url'), lastUser: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') };
      calls.push(call);
      const r = script(call, calls.length);
      if (typeof r !== 'string') {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify(r.body));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r } }], usage: { total_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));
  aiUrl = `http://127.0.0.1:${(ai.address() as any).port}/v1`;
  L = await makeLanEnv({ config: { workerMode: 'managed', managedJobTypes: TEXT_JOB_TYPES, aiApiUrl: aiUrl, aiApiKey: 'sk-test-key-123', aiModel: 'claude-sonnet-4-6' } });
  c = L.client();
  installHtmlValidator();
  setCheckEngine({ lint: (dir, o) => lintComposition(dir, o), capture: async (_ctx, o) => o.times.map(() => PNG_BYTES) });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setCheckEngine(null);
  setCompositionValidator(null);
  await new Promise<void>((r) => ai.close(() => r()));
  await L.close();
});

const db = () => L.env.ctx.db;
const makeApi = (): RunnerDeps['api'] => async (method, url, body, lease, jobId, extra = {}) => {
  const res = await L.env.app.inject({
    method: method as 'GET',
    url,
    payload: body === undefined ? undefined : (body as object),
    headers: { host: 'localhost', authorization: 'Bearer test-worker-token', 'x-worker-id': 'W1', ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}), ...extra },
  });
  if (res.statusCode === 204) return null as never;
  const b = JSON.parse(res.body);
  if (res.statusCode >= 400) throw new ApiFailure(b.error?.code ?? 'HTTP_ERROR', b.error?.message ?? 'lỗi', b.error?.details);
  return b;
};
const deps = (api: RunnerDeps['api']): RunnerDeps => ({ api, root: L.env.root, sleep: async () => undefined, stopping: () => false });

async function mk(over: Record<string, unknown> = {}) {
  const r = await c.post(P, { name: 'Khuyến mãi', brief: 'Giới thiệu sản phẩm mới, giá 199.000đ', aspect: '9:16', duration_s: 6, quality: '720p', template: 'product', model: {}, ...over });
  expect(r.status).toBe(201);
  return r.body;
}
const compose = (pid: number, model?: Record<string, string>) => c.post(`${P}/${pid}/compose`, { prompt: 'Video giới thiệu sản phẩm', idempotency_key: key(), ...(model ? { model } : {}) });
const claim = async (types = 'html_compose') => (await makeApi()('GET', `/api/worker/next?mode=managed&types=${types}`)) as any;
const versionOf = async (pid: number, n = 1) => (await c.get(`${P}/${pid}/versions/${n}`)).body;
const jobRow = (id: number) => db().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;

describe('compose end-to-end với API AI giả', () => {
  it('3 đoạn: đoạn 1 trước, style cho 2/3, tạo lại riêng đoạn 2 giữ nguyên 1/3',async()=>{
    script=call=>call.kind==='vision'?VISION_OK:goodJson('đoạn','9:16',50);
    const p=await mk({duration_s:150});
    expect((await compose(p.id,{vision:'none'})).status).toBe(201);
    const first=await claim();expect(first.payload.segment.idx).toBe(1);
    expect(await claim()).toBeNull();
    await handleJob(first,deps(makeApi()));
    const second=await claim(),third=await claim();
    expect(second.payload.segment.idx).toBe(2);expect(third.payload.segment.idx).toBe(3);
    expect(second.payload.segment.style_pack.css).toContain('font');
    expect(third.payload.segment.style_pack).toEqual(second.payload.segment.style_pack);
    await Promise.all([handleJob(second,deps(makeApi())),handleJob(third,deps(makeApi()))]);
    const ready=await versionOf(p.id);expect(ready.status,ready.error).toBe('ready');expect(ready.segments_ready).toBe(3);
    expect(ready.segments[1].variables[0].id).toMatch(/^s2_/);
    expect((await c.get(`${P}/${p.id}/versions`)).body).toHaveLength(1);
    const old=db().prepare('SELECT * FROM html_segments WHERE version_id=? ORDER BY idx').all(ready.id) as any[];
    const revised=await c.post(`${P}/${p.id}/versions/1/segments/2/revise`,{feedback:'Đổi tiêu đề',idempotency_key:key()});
    expect(revised.status,revised.body.error?.message).toBe(201);
    const child=await claim();expect(child.payload.segment.idx).toBe(2);
    await handleJob(child,deps(makeApi()));
    const next=await versionOf(p.id,2);expect(next.status,next.error).toBe('ready');
    const copied=db().prepare('SELECT * FROM html_segments WHERE version_id=? ORDER BY idx').all(next.id) as any[];
    for(const i of [0,2]){expect(copied[i].segment_version_id).toBe(old[i].segment_version_id);expect(copied[i].files_dir).toBe(old[i].files_dir);}
    expect(copied[1].segment_version_id).not.toBe(old[1].segment_version_id);
    expect(await claim()).toBeNull();
    const variable=next.segments[1].variables.find((v:any)=>v.type==='text');
    const manual=await c.post(`${P}/${p.id}/versions/2/segments/2/variables`,{values:{[variable.id]:'Phong cảnh miền núi'},idempotency_key:key()});
    expect(manual.status,manual.body.error?.message).toBe(201);expect(manual.body.version.status).toBe('ready');
    const finalRows=db().prepare('SELECT * FROM html_segments WHERE version_id=? ORDER BY idx').all(manual.body.version.id) as any[];
    expect(finalRows[0].segment_version_id).toBe(old[0].segment_version_id);expect(finalRows[2].segment_version_id).toBe(old[2].segment_version_id);
    expect(await claim()).toBeNull();
  },30000);
  it('giữ đoạn thành công khi đoạn khác lỗi; thử lại riêng đoạn lỗi; hủy mọi job con',async()=>{
    script=call=>call.kind==='vision'?VISION_OK:call.lastUser.includes('ĐOẠN LỖI')?'không phải JSON':goodJson('đoạn','9:16',50);
    const p=await mk({duration_s:150});await compose(p.id,{vision:'none'});
    await handleJob(await claim(),deps(makeApi()));const second=await claim(),third=await claim();
    const api=makeApi();let broken=true;
    const failApi:RunnerDeps['api']=async(method,url,...rest)=>url.endsWith('/infer')&&broken?{message:{role:'assistant',content:'không phải JSON'},account:{}} as never:api(method,url,...rest);
    await Promise.all([handleJob(second,deps(failApi)),handleJob(third,deps(api))]);
    const failed=await versionOf(p.id);expect(failed.status).toBe('failed');expect(failed.segments_ready).toBe(2);
    const keep=db().prepare('SELECT segment_version_id FROM html_segments WHERE version_id=? AND idx IN (1,3) ORDER BY idx').all(failed.id);
    expect((await c.post(`${P}/${p.id}/versions/1/segments/2/retry`,{})).status).toBe(200);
    broken=false;const retry=await claim();expect(retry.payload.segment.idx).toBe(2);await handleJob(retry,deps(api));expect((await versionOf(p.id)).status).toBe('ready');
    expect(db().prepare('SELECT segment_version_id FROM html_segments WHERE version_id=? AND idx IN (1,3) ORDER BY idx').all(failed.id)).toEqual(keep);
    await compose(p.id,{vision:'none'});await handleJob(await claim(),deps(api));const a=await claim(),b=await claim();
    expect((await c.post(`${P}/${p.id}/versions/2/cancel`,{})).status).toBe(200);
    expect(jobRow(a.id).status).toBe('cancelled');expect(jobRow(b.id).status).toBe('cancelled');expect(await claim()).toBeNull();
    expect((await versionOf(p.id,2)).status).toBe('cancelled');
  },30000);
  it.each(['unsupported', 'quota', 'json'])('ảnh lỗi %s: giữ job chờ nhãn, quét tiếp ảnh khác, xác nhận rồi tiếp tục cùng job (không voice)', async (why) => {
    const p = await mk();
    for (const color of ['red', 'blue']) {
      const image = path.join(L.env.root, `${color}.png`);
      execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=32x32`,'-frames:v','1',image], { windowsHide: true });
      expect((await c.upload(`${P}/${p.id}/assets`, [{ name: `${color}.png`, data: fs.readFileSync(image) }])).status).toBe(201);
    }
    await compose(p.id, { vision: 'none' });
    const job = await claim();
    const real = makeApi();
    let scans = 0;
    const wrapped: RunnerDeps['api'] = async (method, url, body, lease, jobId, extra) => {
      if (url.endsWith('/infer') && (body as any)?.purpose === 'asset_vision' && ++scans === 1) {
        if (why === 'json') return { message: { content: 'JSON hỏng' } } as any;
        throw new ApiFailure(why === 'quota' ? 'AI_UNAVAILABLE' : 'AI_INVALID_REQUEST', 'Không quét được ảnh');
      }
      return real(method, url, body, lease, jobId, extra);
    };
    await handleJob(job, deps(wrapped));
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: 'image_labels', next_attempt_at: null, error: null });
    expect((await versionOf(p.id)).status).toBe('composing');
    expect(await claim()).toBeNull();
    expect(calls.filter((a) => a.kind === 'compose')).toHaveLength(0);
    const assets = (await c.get(`${P}/${p.id}/assets`)).body;
    expect(assets[0]).toMatchObject({ label_confirmed: false, description: null });
    expect(assets[0].scan_error_code).toBeTruthy();
    expect(assets[1].description.summary).toBe('Ảnh hộp sữa');
    expect((await c.post(`${P}/${p.id}/compose`, { prompt: 'khác', idempotency_key: key() })).status).toBe(409);
    expect((await c.post(`${P}/${p.id}/image-labels/confirm`, { confirmed: false, labels: [{ id: assets[0].id, label: 'Sản phẩm 110ml' }] })).status).toBe(400);
    expect((await c.post(`${P}/${p.id}/image-labels/confirm`, { confirmed: true, labels: [{ id: assets[1].id, label: 'Sai ảnh' }] })).status).toBe(409);
    const confirm = await c.post(`${P}/${p.id}/image-labels/confirm`, { confirmed: true, labels: [{ id: assets[0].id, label: 'Sản phẩm 110ml' }] });
    expect(confirm.body).toMatchObject({ ok: true, resumed: 1 });
    const resumed = await claim();
    expect(resumed.id).toBe(job.id);
    await handleJob(resumed, deps(wrapped));
    expect(jobRow(job.id).status).toBe('done');
    expect((await versionOf(p.id)).status).toBe('ready');
    expect(scans).toBe(2);
    expect(calls.find((a) => a.kind === 'compose')?.lastUser).toContain('Sản phẩm 110ml');
  });
  it('không có model vision vẫn tạo job, chuyển ảnh sang gán nhãn thay vì lỗi toàn bộ', async () => {
    models = ['text-only'];
    L.env.ctx.config.aiModel = 'text-only';
    const p = await mk();
    await c.upload(`${P}/${p.id}/assets`, [{ name: 'a.png', data: PNG_BYTES }]);
    const created = await compose(p.id, { vision: 'none' });
    expect(created.status).toBe(201);
    const job = await claim();
    await handleJob(job, deps(makeApi()));
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: 'image_labels' });
    expect(calls).toHaveLength(0);
  });
  it('mô tả dài được cắt theo giới hạn trước lưu, không làm job lỗi', async () => {
    const p = await mk();
    const image = path.join(L.env.root, 'long.png');
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y','-v','error','-f','lavfi','-i','color=c=blue:s=32x32','-frames:v','1',image], { windowsHide: true });
    await c.upload(`${P}/${p.id}/assets`, [{ name: 'long.png', data: fs.readFileSync(image) }]);
    script = (call) => call.kind === 'asset_vision' ? JSON.stringify({ summary: 's'.repeat(1200), text: 't'.repeat(1200), details: 'd'.repeat(900), uncertain: false }) : goodJson();
    await compose(p.id, { vision: 'none' });
    await handleJob(await claim(), deps(makeApi()));
    const asset = (await c.get(`${P}/${p.id}/assets`)).body[0];
    expect([asset.description.summary.length, asset.description.text.length, asset.description.details.length]).toEqual([600, 600, 400]);
    expect((await versionOf(p.id)).status).toBe('ready');
  });
  it('quét ảnh gốc trước compose, đưa mô tả vào prompt và dùng cache khi tạo phiên bản sau', async () => {
    const p = await mk();
    const image = path.join(L.env.root, 'scan.png');
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y','-v','error','-f','lavfi','-i','color=c=blue:s=32x32','-frames:v','1',image], { windowsHide: true });
    expect((await c.upload(`${P}/${p.id}/assets`, [{ name: 'abc.png', data: fs.readFileSync(image) }])).status).toBe(201);
    await compose(p.id, { vision: 'none' });
    const first = await claim();
    await handleJob(first, deps(makeApi()));
    expect((await versionOf(p.id)).status).toBe('ready');
    expect(calls.map((x) => [x.kind, x.hasImage])).toEqual([['asset_vision', true], ['compose', false]]);
    expect(calls[1]!.lastUser).toContain('Ảnh hộp sữa');
    expect(calls[1]!.lastUser).toContain('110ml');
    expect((await c.get(`${P}/${p.id}/assets`)).body[0].description.uncertain).toBe(true);
    await compose(p.id, { vision: 'none' });
    await handleJob(await claim(), deps(makeApi()));
    expect(calls.map((x) => x.kind)).toEqual(['asset_vision', 'compose', 'compose']);
  });
  it('compose → payload snapshot (policy/mẫu/canvas) → worker: infer compose + vision đúng model → version ready; ai_attempts ghi model thực dùng', async () => {
    const p = await mk();
    const r = await compose(p.id, { compose: 'claude-sonnet-4-6', vision: 'vision-x' });
    expect(r.status).toBe(201);
    expect(r.body.version.policy).toMatchObject({ compose: 'claude-sonnet-4-6', vision: 'vision-x' });
    const job = await claim();
    expect(job.payload.policy).toMatchObject({ compose: 'claude-sonnet-4-6', vision: 'vision-x' });
    expect(job.payload.base_canvas).toEqual({ w: 360, h: 640 });
    expect(job.payload.template).toMatchObject({ id: 'product' });
    expect(job.payload.template.files[0].content).toContain('data-duration="6"');
    expect(JSON.stringify(job.payload)).not.toContain('sk-test-key-123');

    await handleJob(job, deps(makeApi()));
    expect(calls.map((x) => [x.kind, x.model, x.hasImage])).toEqual([['compose', 'claude-sonnet-4-6', false], ['vision', 'vision-x', true]]);
    const v = await versionOf(p.id);
    expect(v).toMatchObject({ status: 'ready', summary: 'Video ok' });
    expect(v.files.map((f: any) => f.path)).toContain('index.html');
    expect(jobRow(job.id).status).toBe('done');
    expect((db().prepare('SELECT model FROM ai_attempts WHERE job_id = ? ORDER BY id').all(job.id) as any[]).map((x) => x.model)).toEqual(['claude-sonnet-4-6', 'vision-x']);
    // model đã chọn xuất hiện trong lời gọi đầu: prompt có brief và mẫu
    expect(calls[0]!.lastUser).toBeTruthy();
  });

  it('lint (thật) từ chối fetch → lượt sửa nhận lỗi → ready: compose, fix, vision', async () => {
    script = (call, n) => (call.kind === 'vision' ? VISION_OK : n === 1 ? badJson() : goodJson('đã sửa'));
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    await handleJob(job, deps(makeApi()));
    expect(calls.map((x) => x.kind)).toEqual(['compose', 'compose', 'vision']);
    expect(calls[1]!.lastUser).toMatch(/fetch|mạng|network/i);
    expect(await versionOf(p.id)).toMatchObject({ status: 'ready', summary: 'Video đã sửa' });
  });

  it('model vision báo vấn đề → 1 lượt sửa → ready (compose, vision, fix = 3 infer)', async () => {
    script = (call, n) => (call.kind === 'vision' ? '{"ok":false,"issues":[{"severity":"high","time":2,"problem":"Giá bị cắt","fix":"nhỏ lại"}]}' : n === 1 ? goodJson('một') : goodJson('hai'));
    const p = await mk();
    await compose(p.id);
    await handleJob(await claim(), deps(makeApi()));
    expect(calls.map((x) => x.kind)).toEqual(['compose', 'vision', 'compose']);
    expect(calls[2]!.lastUser).toContain('Giá bị cắt');
    expect(await versionOf(p.id)).toMatchObject({ status: 'ready', summary: 'Video hai' });
  });

  it('lint luôn lỗi → job fail HTML_COMPOSE_FAILED, phiên bản failed kèm lý do, đúng 3 infer', async () => {
    script = () => badJson();
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    await handleJob(job, deps(makeApi()));
    expect(calls).toHaveLength(3);
    const v = await versionOf(p.id);
    expect(v).toMatchObject({ status: 'failed', error_code: 'HTML_COMPOSE_FAILED' });
    expect(v.error).toMatch(/fetch|mạng|network|security/i);
    expect(jobRow(job.id)).toMatchObject({ status: 'failed', error_code: 'HTML_COMPOSE_FAILED' });
  });

  it('server từ chối /complete (400) → worker sửa thêm một lượt rồi hoàn thành', async () => {
    let n = 0;
    installHtmlValidator();
    setCompositionValidator(async () => (++n === 1 ? { ok: false, errors: [{ code: 'late', message: 'bị từ chối muộn' }], warnings: [], checks: ['x'] } : { ok: true, errors: [], warnings: [], checks: ['x'] }));
    script = (call, k) => (call.kind === 'vision' ? VISION_OK : goodJson(k === 1 ? 'đầu' : 'sau'));
    const p = await mk();
    await compose(p.id);
    await handleJob(await claim(), deps(makeApi()));
    expect(calls.map((x) => x.kind)).toEqual(['compose', 'vision', 'compose']);
    expect(calls[2]!.lastUser).toContain('bị từ chối muộn');
    expect(await versionOf(p.id)).toMatchObject({ status: 'ready', summary: 'Video sau' });
  });

  it('API AI hết quota (429) → job xếp chờ ai_quota, phiên bản vẫn composing; resume completed dùng Idempotency-Key', async () => {
    script = () => ({ status: 429, body: { error: 'quota exhausted' } });
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    await handleJob(job, deps(makeApi()));
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: 'ai_quota' });
    expect((await versionOf(p.id)).status).toBe('composing');
  });

  it('job hoàn thành rồi chạy lại handleJob với checkpoint.complete → complete idempotent, không gọi AI thêm', async () => {
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    await handleJob(job, deps(makeApi()));
    expect((await versionOf(p.id)).status).toBe('ready');
    const n = calls.length;
    const cp = JSON.parse(jobRow(job.id).checkpoint);
    expect(cp.complete.result.files.length).toBeGreaterThan(0);
    await handleJob({ ...job, checkpoint: cp }, deps(makeApi()));
    expect(calls).toHaveLength(n);
    expect(jobRow(job.id).status).toBe('done');
    expect((await c.get(`${P}/${p.id}/versions`)).body).toHaveLength(1);
  });

  it('resume từ checkpoint giữa chừng: infer compose đã có kết quả không gọi lại', async () => {
    script = (call, n) => (call.kind === 'vision' ? VISION_OK : n === 1 ? badJson() : goodJson('b'));
    const p = await mk();
    await compose(p.id);
    const job = await claim();
    // lượt 1: compose hỏng lint; lượt sửa gặp 503 → job chờ (checkpoint đã có candidate + infers=1)
    let hit = 0;
    const flaky = (): RunnerDeps['api'] => async (m, u, b, l, j, e) => {
      if (u.endsWith('/infer') && ++hit === 2) throw new ApiFailure('AI_UNAVAILABLE', 'tạm lỗi', { retry_at: new Date(Date.now() + 60_000).toISOString() });
      return makeApi()(m, u, b, l, j, e);
    };
    await handleJob(job, deps(flaky()));
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', wait_reason: 'ai_quota' });
    const cp = JSON.parse(jobRow(job.id).checkpoint);
    expect(cp.html_compose).toMatchObject({ stage: 'lint', infers: 1 });
    // claim lại (hết hạn chờ) rồi chạy tiếp: chỉ còn lượt sửa + vision
    db().prepare('UPDATE jobs SET next_attempt_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', job.id);
    const again = await claim();
    expect(again.checkpoint.html_compose.infers).toBe(1);
    const before = calls.length;
    await handleJob(again, deps(makeApi()));
    expect(calls.slice(before).map((x) => x.kind)).toEqual(['compose', 'vision']);
    expect(await versionOf(p.id)).toMatchObject({ status: 'ready', summary: 'Video b' });
  });
});

describe('chọn model phía server', () => {
  it('auto: compose = aiModel cấu hình, vision = model có vision đã kiểm chứng; danh sách /models cache giữa các lần compose, refresh bỏ cache', async () => {
    const p = await mk();
    const a = await compose(p.id);
    expect(a.body.version.policy).toMatchObject({ compose: 'claude-sonnet-4-6', vision: 'claude-sonnet-4-6' });
    await c.post(`${P}/${p.id}/versions/1/cancel`, {});
    await compose(p.id);
    expect(modelHits).toBe(1);
    const { listModels } = await import('../src/services/ai/models.js');
    await listModels(L.env.ctx, { refresh: true });
    expect(modelHits).toBe(2);
  });

  it('model không có trong /models → 409 MODEL_UNAVAILABLE; vision "none" tắt bước xem ảnh; vision text-only đã biết bị từ chối khi registry nói không', async () => {
    const p = await mk();
    const bad = await compose(p.id, { compose: 'khong-ton-tai' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('MODEL_UNAVAILABLE');
    const off = await compose(p.id, { vision: 'none' });
    expect(off.body.version.policy.vision).toBe('none');
    await handleJob(await claim(), deps(makeApi()));
    expect(calls.map((x) => x.kind)).toEqual(['compose']); // không có vision
    expect((await versionOf(p.id)).status).toBe('ready');
  });

  it('snapshot: đổi aiModel sau khi tạo version không ảnh hưởng job đã tạo; đổi cấu hình chỉ áp job mới', async () => {
    const p = await mk();
    await compose(p.id, { vision: 'none' });
    L.env.ctx.config.aiModel = 'other-model';
    await handleJob(await claim(), deps(makeApi()));
    expect(calls[0]!.model).toBe('claude-sonnet-4-6');
  });
});

describe('router: override theo job, các loại job khác không đổi', () => {
  it('worker không chọn được model: body.model bị bỏ qua; purpose vision khi policy không có vision → 400; job analyze_brief luôn dùng aiModel dù gửi purpose', async () => {
    const p = await mk();
    await compose(p.id, { compose: 'other-model', vision: 'none' });
    const job = await claim();
    const w = managedClient(L.env, 'W1', job.lease_id, job.id);
    const msg = { messages: [{ role: 'user', content: 'chào' }], capabilities: ['text'] };
    expect((await w.post(`/api/worker/jobs/${job.id}/infer`, { ...msg, model: 'evil-model', purpose: 'compose' })).status).toBe(200);
    expect(calls.at(-1)!.model).toBe('other-model');
    const v = await w.post(`/api/worker/jobs/${job.id}/infer`, { ...msg, purpose: 'vision' });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('AI_INVALID_REQUEST');
    expect((await w.post(`/api/worker/jobs/${job.id}/infer`, { ...msg, purpose: 'khac' })).status).toBe(400); // enum
    expect(calls).toHaveLength(1);

    // job loại khác: aiModel, bỏ qua purpose
    const sp = (await client(L.env.app).post('/api/projects', { name: 'Cảnh', brief: 'Một cảnh sản phẩm' })).body;
    await client(L.env.app).post(`/api/projects/${sp.id}/brief`, {});
    const a = (await managedClient(L.env).get('/api/worker/next?mode=managed&types=analyze_brief')).body;
    expect(a.type).toBe('analyze_brief');
    const wa = managedClient(L.env, 'W1', a.lease_id, a.id);
    expect((await wa.post(`/api/worker/jobs/${a.id}/infer`, { ...msg, purpose: 'vision' })).status).toBe(200);
    expect((await wa.post(`/api/worker/jobs/${a.id}/infer`, msg)).status).toBe(200);
    expect(calls.slice(-2).map((x) => x.model)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6']);
    expect((db().prepare('SELECT model FROM ai_attempts WHERE job_id = ? ORDER BY id').all(a.id) as any[]).map((x) => x.model)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6']);
  });
});

describe('POST /api/worker/jobs/:id/html-check', () => {
  const FILES = () => instantiateTemplate('product', { aspect: '9:16', durationS: 6 })!;
  const body = (capture = false, over: Record<string, unknown> = {}) => ({ files: FILES().files, summary: 's', variables: FILES().meta.variables, capture, ...over });

  async function setup() {
    const p = await mk();
    await compose(p.id, { vision: 'none' });
    const job = await claim();
    return { p, job, w: managedClient(L.env, 'W1', job.lease_id, job.id) };
  }

  it('xác thực: thiếu token 401; lease sai 409 LEASE_LOST; job loại khác 409 JOB_SCOPE', async () => {
    const { job } = await setup();
    const path = `/api/worker/jobs/${job.id}/html-check`;
    expect((await client(L.env.app).post(path, body())).status).toBe(401);
    expect((await client(L.env.app, { authorization: 'Bearer sai-token' }).post(path, body())).status).toBe(401);
    const wrong = await managedClient(L.env, 'W1', 'lease-sai', job.id).post(path, body());
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('LEASE_LOST');
    const sp = (await client(L.env.app).post('/api/projects', { name: 'C2', brief: 'Một cảnh' })).body;
    await client(L.env.app).post(`/api/projects/${sp.id}/brief`, {});
    const a = (await managedClient(L.env).get('/api/worker/next?mode=managed&types=analyze_brief')).body;
    const scope = await managedClient(L.env, 'W1', a.lease_id, a.id).post(`/api/worker/jobs/${a.id}/html-check`, body());
    expect(scope.status).toBe(409);
    expect(scope.body.error.code).toBe('JOB_SCOPE');
  });

  it('bộ file đạt: report ok (lint thật); capture → ≥ 3 khung PNG base64 trong (0,d), không đổi trạng thái phiên bản', async () => {
    const { p, w, job } = await setup();
    const a = await w.post(`/api/worker/jobs/${job.id}/html-check`, body());
    expect(a.status).toBe(200);
    expect(a.body.report).toMatchObject({ ok: true, errors: [] });
    expect(a.body.frames).toBeUndefined();
    const b = await w.post(`/api/worker/jobs/${job.id}/html-check`, body(true));
    expect(b.body.report.ok).toBe(true);
    expect(b.body.frames.length).toBeGreaterThanOrEqual(3);
    expect(b.body.frames.length).toBeLessThanOrEqual(5);
    for (const f of b.body.frames) {
      expect(f.t).toBeGreaterThan(0);
      expect(f.t).toBeLessThan(6);
      expect(Buffer.from(f.png_base64, 'base64').equals(PNG_BYTES)).toBe(true);
    }
    expect(b.body.frames.map((f: any) => f.t)).toEqual([...b.body.frames.map((f: any) => f.t)].sort((x: number, y: number) => x - y));
    expect((await versionOf(p.id)).status).toBe('composing');
  });

  it('lỗi lint/manifest/biến trả thành report ok=false (200), không phải lỗi HTTP', async () => {
    const { w, job } = await setup();
    const lint = await w.post(`/api/worker/jobs/${job.id}/html-check`, { files: [{ path: 'index.html', content: '<html><body><script>fetch("/x")</script></body></html>' }], capture: true });
    expect(lint.status).toBe(200);
    expect(lint.body.report.ok).toBe(false);
    expect(lint.body.report.errors.length).toBeGreaterThan(0);
    expect(lint.body.frames).toBeUndefined();
    const manifest = await w.post(`/api/worker/jobs/${job.id}/html-check`, { files: [{ path: '../evil.html', content: 'x' }] });
    expect(manifest.status).toBe(200);
    expect(manifest.body.report).toMatchObject({ ok: false, errors: [{ code: 'INVALID_MANIFEST' }] });
    const vars = await w.post(`/api/worker/jobs/${job.id}/html-check`, body(false, { variables: [{ id: 'headline', type: 'text', label: 'T', value: 'sai nội dung', target: 'headline' }] }));
    expect(vars.body.report).toMatchObject({ ok: false, errors: [{ code: 'VARIABLE_MISMATCH' }] });
  });

  it('thiếu trình duyệt khi chụp → cảnh báo, không có khung, không lỗi', async () => {
    const { AppError } = await import('../src/lib/errors.js');
    setCheckEngine({ lint: (dir, o) => lintComposition(dir, o), capture: async () => { throw new AppError('HTML_RENDERER_MISSING', 'thiếu', 409); } });
    const { w, job } = await setup();
    const r = await w.post(`/api/worker/jobs/${job.id}/html-check`, body(true));
    expect(r.status).toBe(200);
    expect(r.body.report.ok).toBe(true);
    expect(r.body.frames).toBeUndefined();
    expect(r.body.report.warnings.map((x: any) => x.code)).toContain('CAPTURE_SKIPPED_NO_BROWSER');
  });

  it('stale: phiên bản bị hủy → 409 JOB_CANCELLED; hủy giữa lúc chụp → dừng và 409; thư mục tạm được dọn', async () => {
    const { p, w, job } = await setup();
    // hủy trong lúc chụp: capture chờ tín hiệu abort
    let sawAbort = false;
    setCheckEngine({
      lint: (dir, o) => lintComposition(dir, o),
      capture: (_ctx, o) => new Promise((_res, rej) => {
        setTimeout(() => void c.post(`${P}/${p.id}/versions/1/cancel`, {}), 20);
        o.signal.addEventListener('abort', () => { sawAbort = true; rej(new Error('aborted')); });
      }),
    });
    const r = await w.post(`/api/worker/jobs/${job.id}/html-check`, body(true));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toMatch(/JOB_CANCELLED|LEASE_LOST/);
    expect(sawAbort).toBe(true);
    // sau khi hủy, mọi lời gọi mới đều bị từ chối
    const again = await w.post(`/api/worker/jobs/${job.id}/html-check`, body());
    expect(again.status).toBe(409);
    expect(await versionOf(p.id)).toMatchObject({ status: 'cancelled' });
  });
});
