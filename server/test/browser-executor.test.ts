import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext } from 'playwright-core';
import { BrowserTools, nextActionId } from '../../worker/src/browser.js';
import { client, makeEnv, type Env } from './helpers.js';
import { mediaScenario } from './helpers-media.js';
import { chromeAvailable, installSites, launchHeadless, type SiteCounters } from './helpers-browser.js';

/**
 * Executor media chạy trên Chrome headless riêng với fixture https://flow.google.com và https://chatgpt.com
 * (nhãn thật: "Generated image 1", chip `Video · 720p · 8s · x1`, dòng credit, menu Download, ProseMirror).
 * Journal đi qua server thật (app.inject): kiểm chứng được "không ghi intent, không click" khi precheck không qua.
 */
const FLOW = 'https://flow.google.com/project/test';
const CHAT = 'https://chatgpt.com/';

let browser: Browser;
let context: BrowserContext;
let counters: SiteCounters;
let env: Env;
let refs: { stick: string; box: string };
const mw = (lease?: string, jobId?: number) => client(env.app, { authorization: 'Bearer test-worker-token', 'x-worker-id': 'W1', ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}) });

function api(app = () => env.app) {
  return async (method: string, url: string, body?: unknown, lease?: string, jobId?: number, extra: Record<string, string> = {}) => {
    const res = await app().inject({ method: method as 'GET', url, payload: body as object | undefined, headers: {
      host: 'localhost:8787', authorization: 'Bearer test-worker-token', 'x-worker-id': 'W1', ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}), ...extra } });
    const parsed = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) throw Object.assign(new Error(parsed?.error?.message ?? `HTTP ${res.statusCode}`), { code: parsed?.error?.code });
    return parsed;
  };
}

beforeAll(async () => { if (chromeAvailable) browser = await launchHeadless(); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  if (!chromeAvailable) return;
  env = await makeEnv({ config: { workerMode: 'managed', managedJobTypes: ['storyboard', 'video'] } });
  context = await browser.newContext();
  counters = await installSites(context);
});
afterEach(async () => {
  // Không request nào được rơi vào route chặn mặc định (nghĩa là không gọi tới site/CDN ngoài fixture).
  if (chromeAvailable) expect(counters.blocked).toEqual([]);
  await context?.close(); await env?.close();
});

/** Dự án 1 cảnh có 2 ảnh tham chiếu (stick, box) → storyboard/video job managed đã claim (xem helpers-media). */
async function storyboardJob() { const ms = await mediaScenario(env); refs = ms.refs; return ms.storyboard(); }
async function videoJob() {
  const ms = await mediaScenario(env); refs = ms.refs;
  const job = await ms.video();
  expect(job.payload.upload_files).toEqual([refs.stick, refs.box, job.payload.upload_files[2]]);
  return job;
}
function tools(job: any, opts: { uploads?: any[] } = {}) {
  const a = api();
  const alive = async () => { await a('POST', `/api/worker/jobs/${job.id}/heartbeat`, {}, job.lease_id); };
  return new BrowserTools(job, alive, { api: a, root: env.root, browser, sleep: async () => undefined, uploads: opts.uploads });
}
type Control = { ref: number; tag: string; text: string; label: string | null; title: string | null; state: string | null };
async function snap(t: BrowserTools) { return (await t.run('browser_snapshot', {})) as { controls: Control[]; text: string; url: string; image: string };}
async function ref(t: BrowserTools, re: RegExp | ((c: Control) => boolean)) {
  const s = await snap(t);
  const c = s.controls.find((x) => (typeof re === 'function' ? re(x) : re.test([x.text, x.label, x.title].filter(Boolean).join(' ').replace(/\s+/g, ' '))));
  if (!c) throw new Error(`không thấy điều khiển ${re}: ${s.controls.map((x) => x.label ?? x.text).join(' | ')}`);
  return c.ref;
}
const press = async (t: BrowserTools, re: RegExp) => t.run('browser_click', { ref: await ref(t, re) });
const actionsOf = async (job: any) => (await mw().get(`/api/worker/jobs/${job.id}/actions`)).body as { id: string; state: string }[];
const submits = (t: BrowserTools) => t.page!.evaluate(() => (window as any).__submits as number);

/** Chọn 9:16 / 10s / x1 trong popover (chip còn 720p). */
async function settleSettings(t: BrowserTools) {
  await press(t, /Video · 720p/);
  await press(t, /^9:16$/);
  await press(t, /^10s$/);
  await press(t, /^x1$/);
}
async function uploadAll(t: BrowserTools, job: any, perCall = 1, control = /Upload media/) {
  const files: string[] = job.payload.upload_files;
  for (let i = 0; i < files.length; i += perCall) await t.run('browser_upload', { ref: await ref(t, control), files: files.slice(i, i + perCall) });
}
const chatPrompt = (c: Control) => (c as any).tag === 'DIV';
async function fillPrompt(t: BrowserTools, text: string, control: RegExp | ((c: Control) => boolean) = /Prompt/) { await t.run('browser_fill', { ref: await ref(t, control), text }); }
const submitRef = (t: BrowserTools) => ref(t, /Create|arrow_forward/);

const d = chromeAvailable ? describe : describe.skip;

d('F1 phân loại nút và site theo loại job (Chrome headless + fixture)', () => {
  it('ChatGPT: bấm được "Generated image 1", "Share/Edit generated image 1" bằng browser_click; Send prompt bị chặn; submit từ chối nút không phải gửi', async () => {
    const job = await storyboardJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: CHAT });
      await uploadAll(t, job, 1, /Attach files/);
      await fillPrompt(t, 'bất kỳ prompt nào', chatPrompt);
      await t.run('browser_submit', { ref: await ref(t, /Send prompt/) });
      expect(counters.chatSend).toBe(1);
      for (const re of [/Share generated image 1$/, /Edit generated image 1$/, /^Generated image 1$/]) {
        await expect(t.run('browser_click', { ref: await ref(t, re) })).resolves.toMatchObject({ ok: true });
      }
      await expect(t.run('browser_click', { ref: await ref(t, /Send prompt/) })).rejects.toThrow(/browser_submit/);
      await expect(t.run('browser_submit', { ref: await ref(t, /Share generated image 1$/) })).rejects.toThrow(/không phải nút gửi/);
      expect(counters.chatSend).toBe(1);
    } finally { await t.close(); }
  });
  it('nút trong form prompt không khai báo type (mặc định là submit) bị coi là nút gửi', async () => {
    const job = await storyboardJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: CHAT });
      await expect(t.run('browser_click', { ref: await ref(t, /Tools/) })).rejects.toThrow(/browser_submit/);
      await expect(t.run('browser_click', { ref: await ref(t, /Attach files/) })).resolves.toMatchObject({ ok: true });
    } finally { await t.close(); }
  });
  it('storyboard chỉ ChatGPT, video chỉ Flow: browser_open/select/submit sai site → WRONG_SITE rõ ràng (không phải LOGIN_REQUIRED)', async () => {
    const sb = await storyboardJob();
    const ts = tools(sb);
    try {
      await expect(ts.run('browser_open', { url: FLOW })).rejects.toThrow(/WRONG_SITE.*chatgpt\.com/);
      await expect(ts.run('browser_open', { url: 'https://accounts.google.com/' })).rejects.toThrow(/Chỉ mở ChatGPT/);
      // tab Flow có sẵn → select cũng bị từ chối
      const other = await context.newPage();
      await other.goto(FLOW);
      await expect(ts.run('browser_select', { tab: context.pages().indexOf(other) })).rejects.toThrow(/WRONG_SITE/);
      // trang sai site đang là page hiện tại: submit/snapshot/click đều từ chối
      ts.page = other;
      for (const name of ['browser_snapshot', 'browser_submit', 'browser_click']) {
        const err = await ts.run(name, { ref: 0 }).catch((e: Error) => e);
        expect((err as Error).message).toMatch(/WRONG_SITE/);
        expect((err as Error).message).not.toMatch(/LOGIN_REQUIRED|CAPTCHA/);
      }
      expect(await actionsOf(sb)).toEqual([]);
    } finally { await ts.close(); }
  });
  it('trang ngoài site (bấm nhầm link) chỉ là lỗi OFF_SITE cho model; chỉ trang đăng nhập mới là LOGIN_REQUIRED', async () => {
    const job = await videoJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: FLOW });
      const off = await context.newPage();
      await off.goto('https://example.org/');
      t.page = off;
      const e1 = await t.run('browser_snapshot', {}).catch((e: Error) => e);
      expect((e1 as Error).message).toMatch(/^OFF_SITE: .*example\.org/);
      expect((e1 as Error).message).not.toMatch(/LOGIN_REQUIRED/);
      const login = await context.newPage();
      await login.goto('https://accounts.google.com/signin');
      t.page = login;
      await expect(t.run('browser_snapshot', {})).rejects.toThrow(/^LOGIN_REQUIRED/);
    } finally { await t.close(); }
  });
  it('job video không mở được ChatGPT', async () => {
    const job = await videoJob();
    const t = tools(job);
    try {
      await expect(t.run('browser_open', { url: CHAT })).rejects.toThrow(/WRONG_SITE.*flow\.google\.com/);
      await expect(t.run('browser_open', { url: FLOW })).resolves.toMatchObject({ url: expect.stringContaining('flow.google.com') });
    } finally { await t.close(); }
  });
});

d('F2 precheck cứng trước browser_submit (video/Flow)', () => {
  async function ready(job: any, query = '', opts: { skipSettings?: boolean; skipUpload?: boolean; prompt?: string } = {}) {
    const t = tools(job);
    await t.run('browser_open', { url: `${FLOW}${query}` });
    if (!opts.skipSettings) await settleSettings(t);
    if (!opts.skipUpload) await uploadAll(t, job);
    await fillPrompt(t, opts.prompt ?? job.payload.scene.prompt);
    return t;
  }
  async function expectRefused(t: BrowserTools, job: any, re: RegExp) {
    const err = await t.run('browser_submit', { ref: await submitRef(t) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^PRECHECK_FAILED: /);
    expect((err as Error).message).toMatch(re);
    expect(await actionsOf(job)).toEqual([]); // KHÔNG ghi intent
    expect(await submits(t)).toBe(0);         // KHÔNG click
    expect(counters.flowGenerate).toBe(0);
  }

  it('đủ điều kiện: 9:16, 10s, x1, 720p, 15 credit, prompt khớp (khác khoảng trắng), upload đúng thứ tự → ghi intent rồi submitted, bấm đúng một lần', async () => {
    const job = await videoJob();
    const t = await ready(job, '', { prompt: 'Style: warm kitchen.\n  Shot 1:   hand opens the box.' });
    try {
      const r = await t.run('browser_submit', { ref: await submitRef(t) });
      expect(r).toMatchObject({ ok: true, submitted: true, action_id: `media-${job.id}` });
      expect((await actionsOf(job)).map((a) => [a.id, a.state])).toEqual([[`media-${job.id}`, 'submitted']]);
      expect(await submits(t)).toBe(1);
      expect(counters.flowGenerate).toBe(1);
      const ev = (await mw().get(`/api/worker/jobs/${job.id}/actions`)).body[0].evidence;
      expect(ev).toBeTruthy();
      // lần thứ hai: đã có journal → từ chối, không bấm
      await expect(t.run('browser_submit', { ref: await submitRef(t) })).rejects.toThrow(/Đã có submit intent/);
      expect(await submits(t)).toBe(1);
    } finally { await t.close(); }
  });
  it('nút tạo chỉ có icon ligature arrow_forward (không nhãn) vẫn được nhận là nút gửi', async () => {
    const job = await videoJob();
    const t = await ready(job, '?variant=icononly');
    try {
      await expect(t.run('browser_click', { ref: await ref(t, /^arrow_forward$/) })).rejects.toThrow(/browser_submit/);
      expect(await submits(t)).toBe(0);
      await expect(t.run('browser_submit', { ref: await ref(t, /^arrow_forward$/) })).resolves.toMatchObject({ submitted: true });
      expect(counters.flowGenerate).toBe(1);
    } finally { await t.close(); }
  });
  it('popover đang đóng: executor tự mở chip để đọc dòng credit và lựa chọn 9:16, đóng lại rồi mới bấm', async () => {
    const job = await videoJob();
    const t = await ready(job); // settleSettings để popover mở; đóng nó bằng cách bấm chip lần nữa
    try {
      await press(t, /Video · 720p/);
      expect(await t.page!.locator('#pop.open').count()).toBe(0);
      await expect(t.run('browser_submit', { ref: await submitRef(t) })).resolves.toMatchObject({ submitted: true });
      expect(await t.page!.locator('#pop.open').count()).toBe(0);
    } finally { await t.close(); }
  });
  it('chip còn 8s → PRECHECK_FAILED duration, không journal, không click', async () => {
    const job = await videoJob();
    const t = await ready(job, '', { skipSettings: true });
    try { await expectRefused(t, job, /duration.*8s.*10s/); } finally { await t.close(); }
  });
  it('tỉ lệ 16:9 đang chọn → từ chối aspect_ratio', async () => {
    const job = await videoJob();
    const t = await ready(job, '', { skipSettings: true });
    try {
      await press(t, /Video · 720p/); await press(t, /^10s$/);
      await expectRefused(t, job, /aspect_ratio.*16:9/);
    } finally { await t.close(); }
  });
  it('không xác minh được lựa chọn đang chọn (nút không có trạng thái) → từ chối', async () => {
    const job = await videoJob();
    const t = await ready(job, '?nostate=1&duration=10&aspect=9:16', { skipSettings: true });
    try { await expectRefused(t, job, /aspect_ratio.*không xác minh/); } finally { await t.close(); }
  });
  it('số credit trên trang khác credits_expected, hoặc không có dòng credit → từ chối credits', async () => {
    const job = await videoJob();
    const t = await ready(job, '?duration=10&aspect=9:16&credits=20', { skipSettings: true });
    try { await press(t, /Video · 720p/); await expectRefused(t, job, /credits.*20 credit.*15/); } finally { await t.close(); }
    await context.pages().at(-1)!.close();
    const t2 = await ready(job, '?duration=10&aspect=9:16&credits=none', { skipSettings: true });
    try { await expectRefused(t2, job, /credits.*không thấy dòng/); } finally { await t2.close(); }
  });
  it('prompt trong ô khác prompt của job → từ chối prompt; ô trống cũng từ chối', async () => {
    const job = await videoJob();
    const t = await ready(job, '', { prompt: 'Style: warm kitchen. Shot 1: hand opens the box. EXTRA' });
    try { await expectRefused(t, job, /prompt.*khác prompt/); } finally { await t.close(); }
    await context.pages().at(-1)!.close();
    const t2 = await ready(job, '', { prompt: ' ' });
    try { await expectRefused(t2, job, /prompt/); } finally { await t2.close(); }
  });
  it('upload thiếu hoặc sai thứ tự → từ chối trước khi chạm trang; file output của chính job không được upload', async () => {
    const job = await videoJob();
    const t = await ready(job, '', { skipUpload: true });
    try {
      await expectRefused(t, job, /uploads.*0\/3/);
      const up = await ref(t, /Upload media/);
      await expect(t.run('browser_upload', { ref: up, files: [refs.box] })).rejects.toThrow(/UPLOAD_ORDER.*tiếp theo/);
      await expect(t.run('browser_upload', { ref: await ref(t, /Upload media/), files: [job.payload.output.video_path] })).rejects.toThrow(/output của chính job/);
      await expect(t.run('browser_upload', { ref: await ref(t, /Upload media/), files: ['output/other/hack.png'] })).rejects.toThrow(/UPLOAD_ORDER/);
      expect(await t.page!.locator('#attachments li').count()).toBe(0);
      await t.run('browser_upload', { ref: await ref(t, /Upload media/), files: [refs.stick] });
      await expectRefused(t, job, /uploads.*1\/3/);
      await t.run('browser_upload', { ref: await ref(t, /Upload media/), files: [refs.box, job.payload.upload_files[2]] });
      await expect(t.run('browser_upload', { ref: await ref(t, /Upload media/), files: [refs.stick] })).rejects.toThrow(/đã upload đủ/);
      await expect(t.run('browser_submit', { ref: await submitRef(t) })).resolves.toMatchObject({ submitted: true });
    } finally { await t.close(); }
  });
  it('upload hợp lệ qua showOpenFilePicker (stub có kiểm soát): file đến đúng thứ tự; stub tự gỡ', async () => {
    const job = await videoJob();
    const t = await ready(job, '?upload=picker', { skipUpload: true });
    try {
      const first = await t.run('browser_upload', { ref: await ref(t, /Upload media/), files: [job.payload.upload_files[0]] });
      expect(first).toMatchObject({ ok: true, method: 'showOpenFilePicker', uploaded: 1, of: 3 });
      await t.run('browser_upload', { ref: await ref(t, /Upload media/), files: job.payload.upload_files.slice(1) });
      expect(await t.page!.locator('#attachments li').allTextContents()).toEqual(job.payload.upload_files.map((f: string) => path.basename(f)));
      expect(await t.page!.evaluate(() => /native code/.test(String((window as any).showOpenFilePicker)) && !(window as any).__avPicker)).toBe(true);
    } finally { await t.close(); }
  });
  it('upload qua input[type=file] (filechooser): hoạt động; nút không mở hộp chọn file → báo lỗi, không giả thành công và không ghi nhận', async () => {
    const job = await videoJob();
    const t = await ready(job, '?upload=input', { skipUpload: true });
    try {
      expect(await t.run('browser_upload', { ref: await ref(t, /Upload media/), files: [job.payload.upload_files[0]] })).toMatchObject({ method: 'filechooser' });
      expect(await t.page!.locator('#attachments li').count()).toBe(1);
    } finally { await t.close(); }
    await context.pages().at(-1)!.close();
    const t2 = await ready(job, '?upload=none', { skipUpload: true });
    try {
      await expect(t2.run('browser_upload', { ref: await ref(t2, /Upload media/), files: [job.payload.upload_files[0]] })).rejects.toThrow(/UPLOAD_FAILED/);
      expect(t2.uploads).toEqual([]);
      expect(await t2.page!.evaluate(() => /native code/.test(String((window as any).showOpenFilePicker)) && !(window as any).__avPicker)).toBe(true);
    } finally { await t2.close(); }
  });
  it('upload ghi nhận bằng checkpoint: executor mới (resume) cùng trang vẫn thấy upload; đổi trang thì không', async () => {
    const job = await videoJob();
    const t = await ready(job, '', { skipUpload: true });
    try {
      await uploadAll(t, job);
      const saved = JSON.parse(JSON.stringify(t.uploads));
      const resumed = tools(job, { uploads: saved });
      await resumed.connect();
      resumed.page = t.page; // cùng tab đang mở
      await fillPrompt(resumed, job.payload.scene.prompt);
      await expect(resumed.run('browser_submit', { ref: await submitRef(resumed) })).resolves.toMatchObject({ submitted: true });
    } finally { await t.close(); }
  });
});

d('F2 tải kết quả: menu Download và mục 720p Original', () => {
  async function submitted(job: any) {
    const t = tools(job);
    await t.run('browser_open', { url: FLOW });
    await settleSettings(t);
    await uploadAll(t, job);
    await fillPrompt(t, job.payload.scene.prompt);
    await t.run('browser_submit', { ref: await submitRef(t) });
    return t;
  }
  it('mở menu Download bằng click thường, tải mục 720p Original; 1080p Upscaled/4K (Upgrade)/270p GIF bị cấm và không bị bấm', async () => {
    const job = await videoJob();
    const t = await submitted(job);
    try {
      await press(t, /Download/); // mở menu
      for (const re of [/1080p Upscaled/, /4K \(Upgrade\)/, /270p GIF/]) {
        await expect(t.run('browser_download', { ref: await ref(t, re) })).rejects.toThrow(/upscale|nâng cấp|Không tự mua/);
        await expect(t.run('browser_click', { ref: await ref(t, re) })).rejects.toThrow();
      }
      expect(await t.page!.evaluate(() => (window as any).__upscale)).toBe(0);
      expect(counters.upscale).toBe(0); expect(await t.page!.evaluate(() => (window as any).__gif ?? 0)).toBe(0);
      const r = await t.run('browser_download', { ref: await ref(t, /720p Original/) });
      expect(r).toEqual({ file_path: job.payload.output.video_path });
      expect(fs.readFileSync(path.join(env.root, job.payload.output.video_path)).subarray(4, 8).toString()).toBe('ftyp');
      expect(fs.existsSync(path.join(env.root, job.payload.output.video_path + '.partial'))).toBe(false);
      expect((await actionsOf(job)).map((a) => a.state)).toEqual(['downloaded']);
    } finally { await t.close(); }
  });
  it('không tải khi chưa có lượt submit trong journal (tránh lấy kết quả cũ)', async () => {
    const job = await videoJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: FLOW });
      const err = await t.run('browser_download', { ref: 0 }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/Chưa có lượt tạo đã submit/);
      expect(fs.existsSync(path.join(env.root, job.payload.output.video_path))).toBe(false);
    } finally { await t.close(); }
  });
  it('ChatGPT: bấm ảnh "Generated image 1" rồi Download lưu đúng output path của storyboard', async () => {
    const job = await storyboardJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: CHAT });
      await uploadAll(t, job, 1, /Attach files/);
      await fillPrompt(t, 'storyboard prompt', chatPrompt);
      await t.run('browser_submit', { ref: await ref(t, /Send prompt/) });
      await press(t, /^Generated image 1$/);
      expect(await t.run('browser_download', { ref: await ref(t, /Download/) })).toEqual({ file_path: job.payload.output.storyboard_path });
      expect((await actionsOf(job)).map((a) => a.state)).toEqual(['downloaded']);
    } finally { await t.close(); }
  });
  it('ChatGPT thật (job #37): model bấm nút Download bằng browser_click → file vẫn được bắt, lưu đúng output và ghi journal', async () => {
    const job = await storyboardJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: CHAT });
      await uploadAll(t, job, 1, /Attach files/);
      await fillPrompt(t, 'storyboard prompt', chatPrompt);
      await t.run('browser_submit', { ref: await ref(t, /Send prompt/) });
      await press(t, /^Generated image 1$/);
      expect(await press(t, /Download/)).toEqual({ file_path: job.payload.output.storyboard_path, via: 'click' });
      expect(fs.existsSync(path.join(env.root, job.payload.output.storyboard_path))).toBe(true);
      expect((await actionsOf(job)).map((a) => a.state)).toEqual(['downloaded']);
    } finally { await t.close(); }
  });
  it('bấm cùng một nút 3 lần liên tiếp không chụp lại trang → REPEATED_ACTION, lần thứ 3 không được bấm', async () => {
    const job = await storyboardJob();
    const t = tools(job);
    try {
      await t.run('browser_open', { url: CHAT });
      await uploadAll(t, job, 1, /Attach files/);
      await fillPrompt(t, 'storyboard prompt', chatPrompt);
      await t.run('browser_submit', { ref: await ref(t, /Send prompt/) });
      const r = await ref(t, /^Generated image 1$/); // ref() chụp snapshot nên bộ đếm bắt đầu từ 0
      await t.run('browser_click', { ref: r });
      await t.run('browser_click', { ref: r });
      await expect(t.run('browser_click', { ref: r })).rejects.toThrow(/REPEATED_ACTION/);
      await expect(t.run('browser_click', { ref: await ref(t, /^Generated image 1$/) })).resolves.toMatchObject({ ok: true });
    } finally { await t.close(); }
  });
});

d('F5 browser_wait', () => {
  it('chờ theo từng nhịp có heartbeat, kẹp 5..60 giây, không cần trang', async () => {
    const job = await videoJob();
    let hb = 0;
    const base = api();
    const counting = async (m: string, u: string, ...rest: any[]) => { if (u.endsWith('/heartbeat')) hb++; return (base as any)(m, u, ...rest); };
    const t = new BrowserTools(job, async () => { await counting('POST', `/api/worker/jobs/${job.id}/heartbeat`, {}, job.lease_id); }, { api: counting as any, root: env.root, browser, sleep: async () => undefined });
    try {
      expect(await t.run('browser_wait', { seconds: 1 })).toEqual({ waited_s: 5 });
      expect(await t.run('browser_wait', { seconds: 999 })).toEqual({ waited_s: 60 });
      expect(hb).toBe(2 + 7); // mỗi run() 1 lần guard + mỗi nhịp 10s 1 lần: 5s → 1 nhịp, 60s → 6 nhịp
      expect(await actionsOf(job)).toEqual([]);
    } finally { await t.close(); }
  });
});

describe('nextActionId', () => {
  it('lần đầu media-<job>, sau đối soát nothing_created là media-<job>-<n> (id mới, không trùng)', () => {
    expect(nextActionId(31, [])).toBe('media-31');
    expect(nextActionId(31, [{ id: 'media-31' }])).toBe('media-31-2');
    expect(nextActionId(31, [{ id: 'media-31' }, { id: 'media-31-2' }])).toBe('media-31-3');
    expect(new Set(['media-3-12', 'media-31-2']).size).toBe(2);
  });
});
