import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Download, type ElementHandle, type Page } from 'playwright-core';
import type { Job } from './client.js';
import { RepeatGuard, assertBrowserAction, controlLabel, isAllowedBrowserUrl, isDownloadControl, isLoginPage, isSubmitControl, siteOf, wrongSiteMessage, type ControlInfo } from './browser-policy.js';
import { DEFAULT_VIDEO_SETTINGS, comparePrompt, evaluateUploads, evaluateVideoSettings, normalizePrompt, parseCredits, precheckError, type ComposerSnapshot, type Issue } from './precheck.js';
import { describeControlFn, installPickerStubFn, pickerUsedFn, readComposerFn, removePickerStubFn } from './page-scripts.js';
import { WAIT_MAX_SECONDS, WAIT_MIN_SECONDS } from './tools.js';

type ApiFn = <T = any>(method: string, url: string, body?: unknown, lease?: string, jobId?: number, extra?: Record<string, string>) => Promise<T>;
export interface UploadRecord { files: string[]; url: string; method: 'input' | 'filechooser' | 'showOpenFilePicker' }
export interface ExecutorDeps {
  api: ApiFn;
  /** ROOT của repo/test; mọi đường dẫn file được phép đều nằm dưới `<root>/refs` hoặc `<root>/output`. */
  root: string;
  /** Test: dùng browser đã mở sẵn thay vì kết nối CDP. Executor không đóng browser này. */
  browser?: Browser;
  cdpUrl?: string;
  /** Upload đã thực hiện (khôi phục từ checkpoint khi resume). */
  uploads?: UploadRecord[];
  sleep?: (ms: number) => Promise<void>;
}
type Described = ControlInfo & { tag: string; text: string; download: boolean; disabled: boolean };

const key = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
/** browser_click trên nút tải: chờ sự kiện download chừng này rồi coi như nút chỉ mở menu. */
const CLICK_DOWNLOAD_WAIT_MS = 5000;
const pageKey = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return url; } };
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const PICKER_STUB_LIMIT = 25 * 1024 * 1024;
const CHIP_TEXT = /^(?=[\s\S]*\d{3,4}\s?p\b)(?=[\s\S]*(?:^|[^\d:])\d{1,2}\s*(?:s|secs?|giây)\b)(?=[\s\S]*(?:^|[^\p{L}\d])x\s?\d(?![\p{L}\d]))/iu;
// Gồm cả mục menu/lựa chọn dạng role (menu Download: `720p Original`, popover cài đặt: 9:16, 10s, x1) để model có ref bấm được.
const SNAPSHOT_SELECTOR = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="tab"], [role="switch"], [role="checkbox"], [role="combobox"], textarea, input, [contenteditable="true"], a[href]';
const CHIP_SELECTOR = 'button, [role="button"], [role="combobox"], [role="tab"], [aria-haspopup]';

/** Id action cho lượt submit kế tiếp: lần đầu `media-<job>`; sau khi đối soát `nothing_created` là `media-<job>-<n>`. */
export function nextActionId(jobId: number, actions: { id: string }[]): string {
  return actions.length === 0 ? `media-${jobId}` : `media-${jobId}-${actions.length + 1}`;
}
export const liveActionOf = <T extends { state: string }>(actions: T[]): T | undefined => [...actions].reverse().find((a) => a.state !== 'abandoned');

/** A single executor per CDP profile. Model input never becomes JS or shell. */
export class BrowserTools {
  browser: Browser | null = null;
  page: Page | null = null;
  refs: ElementHandle[] = [];
  uploads: UploadRecord[];
  private ownsBrowser = false;
  private repeats = new RepeatGuard();
  private sleep: (ms: number) => Promise<void>;
  constructor(private job: Job, private alive: () => Promise<void>, private deps: ExecutorDeps) {
    this.uploads = [...(deps.uploads ?? [])];
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  private allowed = (url: string) => isAllowedBrowserUrl(url, this.job.type);
  private get api() { return this.deps.api; }

  async connect() {
    if (this.browser) return;
    if (this.deps.browser) this.browser = this.deps.browser;
    else {
      const endpoint = this.deps.cdpUrl ?? process.env.BROWSER_CDP_URL ?? 'http://127.0.0.1:9222';
      const u = new URL(endpoint);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('CDP phải là HTTP loopback');
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      this.ownsBrowser = true;
    }
    this.page = this.context().pages().find((p) => this.allowed(p.url())) ?? null;
  }
  private context(): BrowserContext {
    const c = this.browser?.contexts()[0];
    if (!c) throw new Error('Browser chưa có context để mở trang');
    return c;
  }
  async guard() {
    await this.alive();
    await this.api('POST', `/api/worker/jobs/${this.job.id}/browser-lease`, { profile: 'media' }, this.job.lease_id);
    await this.connect();
  }
  /** Trang hiện tại, chỉ khi đang ở đúng site của loại job. Sai site không bị coi là LOGIN_REQUIRED (không được fail/pause job vì model lạc trang). */
  private current(): Page {
    if (!this.page) throw new Error('Mở trang ChatGPT/Flow bằng browser_open trước');
    const url = this.page.url();
    if (!siteOf(url)) {
      // Chỉ trang đăng nhập mới dừng job/tạm dừng hàng đợi; bấm nhầm link ngoài site chỉ là lỗi để model quay lại.
      if (isLoginPage(url)) throw new Error('LOGIN_REQUIRED: hoàn tất đăng nhập trong cửa sổ browser');
      throw new Error(`OFF_SITE: trang hiện tại (${(() => { try { return new URL(url).hostname || url; } catch { return url; } })()}) không phải ChatGPT/Flow. Dùng browser_open hoặc browser_select để quay lại đúng site của job.`);
    }
    if (!this.allowed(url)) throw new Error(wrongSiteMessage(this.job.type, url));
    return this.page;
  }
  private async setRefs(next: ElementHandle[]) {
    const old = this.refs;
    this.refs = next;
    await Promise.all(old.map((h) => h.dispose().catch(() => undefined)));
  }
  /** Ref gắn với đúng phần tử DOM lúc snapshot (ElementHandle). DOM đổi/phần tử bị gỡ thì thao tác lỗi thay vì trúng phần tử khác cùng chỉ số. */
  private ref(n: unknown): ElementHandle {
    const el = typeof n === 'number' ? this.refs[n] : undefined;
    if (!el || !this.page) throw new Error('Ref không hợp lệ. Chụp snapshot mới.');
    this.current();
    return el;
  }
  private async describe(el: ElementHandle): Promise<Described> {
    return el.evaluate(describeControlFn) as Promise<Described>;
  }
  private async actions(): Promise<{ id: string; state: string; evidence: Record<string, any> }[]> {
    return this.api('GET', `/api/worker/jobs/${this.job.id}/actions`);
  }
  private journal(id: string, state: string, evidence: Record<string, unknown>) {
    return this.api('POST', `/api/worker/jobs/${this.job.id}/actions`, { id, profile: 'media', kind: this.job.type, state, evidence }, this.job.lease_id);
  }
  private uploadedFiles(url: string): string[] {
    const k = pageKey(url);
    return this.uploads.filter((u) => u.url === k).flatMap((u) => u.files);
  }

  async run(name: string, args: Record<string, any>): Promise<any> {
    await this.guard();
    this.repeats.check(name, args);
    if (name === 'browser_wait') return this.wait(args.seconds);
    if (name === 'browser_open') {
      if (!this.allowed(String(args.url))) throw new Error(isAllowedBrowserUrl(String(args.url)) ? wrongSiteMessage(this.job.type, String(args.url)) : 'Chỉ mở ChatGPT hoặc Google Flow đúng site của job');
      this.page = await this.context().newPage();
      await this.page.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.setRefs([]);
      return { url: this.page.url() };
    }
    if (name === 'browser_select') {
      const p = this.context().pages()[args.tab];
      if (!p) throw new Error('Tab không hợp lệ');
      if (!this.allowed(p.url())) throw new Error(isAllowedBrowserUrl(p.url()) ? wrongSiteMessage(this.job.type, p.url()) : 'Tab không hợp lệ');
      this.page = p; await this.setRefs([]); return { url: p.url() };
    }
    const page = this.current();
    if (name === 'browser_snapshot') return this.snapshot(page);
    if (name === 'browser_fill') {
      await this.ref(args.ref).fill(String(args.text), { timeout: 10000 });
      return { ok: true };
    }
    if (name === 'browser_upload') return this.upload(page, args);
    if (name === 'browser_click') {
      const el = this.ref(args.ref);
      const d = await this.describe(el);
      assertBrowserAction('click', controlLabel(d), d.type ?? null, d.download, { control: d, jobType: this.job.type });
      if (!isDownloadControl(d)) {
        await el.click({ timeout: 10000 });
        return { ok: true };
      }
      // Nút tải bấm bằng click thường: Flow chỉ mở menu, ChatGPT tải thẳng. Nếu có file tải về thì xử lý y như browser_download
      // (cần lượt đã submit, đúng loại file, lưu đúng output của job) thay vì để file rơi vào thư mục tải của Chrome.
      const pending = page.waitForEvent('download', { timeout: CLICK_DOWNLOAD_WAIT_MS }).catch(() => null);
      await el.click({ timeout: 10000 });
      const dl = await pending;
      if (!dl) return { ok: true, downloaded: false, note: 'Không có file tải về (có thể nút này chỉ mở menu tải). Chụp snapshot rồi dùng browser_download cho đúng mục.' };
      return { ...(await this.saveDownload(page, dl)), via: 'click' };
    }
    if (name === 'browser_submit') return this.submit(page, args);
    if (name === 'browser_download') return this.download(page, args);
    throw new Error('Công cụ browser không hỗ trợ');
  }

  private async wait(seconds: unknown) {
    const s = Math.min(WAIT_MAX_SECONDS, Math.max(WAIT_MIN_SECONDS, Math.round(Number(seconds) || WAIT_MIN_SECONDS)));
    let remaining = s * 1000;
    // Chờ có heartbeat và giữ browser lease; không gọi inference trong lúc chờ.
    while (remaining > 0) {
      const chunk = Math.min(10_000, remaining);
      await this.sleep(chunk);
      remaining -= chunk;
      await this.guard();
    }
    return { waited_s: s };
  }

  private async snapshot(page: Page) {
    const handles = await page.$$(SNAPSHOT_SELECTOR);
    const kept: ElementHandle[] = [];
    const controls = [];
    for (const h of handles.slice(0, 300)) {
      if (!await h.isVisible()) { await h.dispose().catch(() => undefined); continue; }
      const label = await h.evaluate((e) => {
        const sel = ['aria-selected', 'aria-checked', 'aria-pressed'].map((a) => e.getAttribute(a)).find((v) => v !== null) ?? e.getAttribute('data-state');
        return { tag: e.tagName, text: (e.textContent ?? '').slice(0, 100), label: e.getAttribute('aria-label'), title: e.getAttribute('title'), type: e.getAttribute('type'), state: sel };
      });
      controls.push({ ref: kept.length, ...label }); kept.push(h);
    }
    for (const h of handles.slice(300)) await h.dispose().catch(() => undefined);
    await this.setRefs(kept);
    return { url: page.url(), tabs: this.context().pages().map((p) => p.url()), text: (await page.locator('body').innerText()).slice(0, 14000), controls,
      image: 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' })).toString('base64') };
  }

  // ------------------------------------------------------------------ upload

  private async upload(page: Page, args: Record<string, any>) {
    const files = args.files as unknown;
    if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== 'string')) throw new Error('Cần files: danh sách file lấy từ payload.upload_files');
    const expected = ((this.job.payload.upload_files ?? []) as string[]).map(key);
    const own = Object.values(this.job.payload.output ?? {}).map((v) => key(String(v)));
    const given = (files as string[]).map(key);
    if (given.some((f) => own.includes(f))) throw new Error('Không được upload file output của chính job');
    const done = this.uploadedFiles(page.url());
    if (done.length >= expected.length) throw new Error('UPLOAD_ORDER: đã upload đủ file của job, không upload thêm');
    const next = expected.slice(done.length, done.length + given.length);
    if (given.length !== next.length || given.some((f, i) => f !== next[i])) {
      throw new Error(`UPLOAD_ORDER: phải upload đúng thứ tự payload.upload_files; file tiếp theo là "${expected[done.length]}" (đã upload ${done.length}/${expected.length}). Có thể upload từng file một.`);
    }
    const realRoot = fs.realpathSync(this.deps.root);
    const abs = given.map((f) => {
      const p = fs.realpathSync(path.resolve(this.deps.root, f));
      if (!['refs', 'output'].some((d) => p.startsWith(path.join(realRoot, d) + path.sep))) throw new Error('File ngoài refs/ và output/');
      if (!fs.statSync(p).isFile()) throw new Error('Không phải file thường');
      return p;
    });
    const el = this.ref(args.ref);
    const d = await this.describe(el);
    assertBrowserAction('upload', controlLabel(d), d.type ?? null, false, { control: d, jobType: this.job.type });
    let method: UploadRecord['method'];
    if ((d.type ?? '').toLowerCase() === 'file') { await el.setInputFiles(abs); method = 'input'; }
    else method = await this.uploadViaDialog(page, el, abs);
    this.uploads.push({ files: given, url: pageKey(page.url()), method });
    return { ok: true, method, uploaded: done.length + given.length, of: expected.length, note: 'Chụp snapshot để xác nhận ảnh đã xuất hiện trong khung soạn trước khi submit.' };
  }

  /** Control không phải <input type=file>: hộp chọn file thật (filechooser) hoặc File System Access API (showOpenFilePicker, stub có kiểm soát). */
  private async uploadViaDialog(page: Page, el: ElementHandle, abs: string[]): Promise<UploadRecord['method']> {
    const total = abs.reduce((n, p) => n + fs.statSync(p).size, 0);
    const canStub = total <= PICKER_STUB_LIMIT;
    if (canStub) {
      const payload = abs.map((p) => ({ name: path.basename(p), type: MIME[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream', data: fs.readFileSync(p).toString('base64') }));
      await page.evaluate(installPickerStubFn, payload);
    }
    const chooserP = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
    const usedP = canStub ? page.waitForFunction(pickerUsedFn, undefined, { timeout: 6000, polling: 100 }).then(() => true, () => false) : Promise.resolve(false);
    try {
      await el.click({ timeout: 5000 });
      const winner = await new Promise<'chooser' | 'picker' | null>((resolve) => {
        let pending = 2;
        const settle = (v: 'chooser' | 'picker' | null) => { if (v) resolve(v); else if (--pending === 0) resolve(null); };
        void chooserP.then((c) => settle(c ? 'chooser' : null));
        void usedP.then((u) => settle(u ? 'picker' : null));
      });
      if (winner === 'chooser') { const chooser = await chooserP; await chooser!.setFiles(abs); return 'filechooser'; }
      if (winner === 'picker') return 'showOpenFilePicker';
      throw new Error('UPLOAD_FAILED: không có hộp chọn file nào mở ra (không phải input[type=file] hay showOpenFilePicker). Chưa upload gì; không coi là thành công.');
    } finally {
      if (canStub) await page.evaluate(removePickerStubFn).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ submit

  private async readComposer(el: ElementHandle): Promise<ComposerSnapshot> {
    return el.evaluate(readComposerFn) as Promise<ComposerSnapshot>;
  }

  /** Mở popover cài đặt (chip `Video · 720p · 8s · x1`) để đọc lựa chọn đang chọn và dòng credit. Trả chip nếu đã mở. */
  private async openSettings(page: Page) {
    const chip = page.locator(CHIP_SELECTOR).filter({ hasText: CHIP_TEXT }).last();
    if (!await chip.count() || !await chip.isVisible()) return null;
    await chip.click({ timeout: 4000 });
    await page.waitForTimeout(500);
    return chip;
  }
  private async closeSettings(page: Page, chip: Awaited<ReturnType<BrowserTools['openSettings']>>, el: ElementHandle) {
    const stillOpen = async () => { const s = await this.readComposer(el); return s.options.length > 0 || parseCredits(s.text).length > 0; };
    if (!chip) return;
    await chip.click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    if (!await stillOpen()) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (await stillOpen()) throw precheckError([{ item: 'settings_popover', detail: 'không đóng được popover cài đặt sau khi đọc; đóng thủ công bằng browser_click rồi gọi lại' }]);
  }

  private async precheck(page: Page, el: ElementHandle): Promise<Record<string, unknown>> {
    const payload = this.job.payload;
    const issues: Issue[] = [];
    const uploaded = this.uploadedFiles(page.url());
    issues.push(...evaluateUploads(uploaded, (payload.upload_files ?? []) as string[], Object.values(payload.output ?? {}).map(String)));
    let snap = await this.readComposer(el);
    const evidence: Record<string, unknown> = { uploads: uploaded };
    if (this.job.type === 'video') {
      const want = { ...DEFAULT_VIDEO_SETTINGS, ...(payload.settings ?? {}) };
      let settings = evaluateVideoSettings(snap, want, payload.credits_expected);
      const popoverOpen = snap.options.length > 0 || parseCredits(snap.text).length > 0;
      if (settings.length && !popoverOpen && snap.chips.length) {
        const chip = await this.openSettings(page);
        if (chip) {
          try { snap = await this.readComposer(el); settings = evaluateVideoSettings(snap, want, payload.credits_expected); }
          finally { await this.closeSettings(page, chip, el); }
        }
      }
      issues.push(...settings);
      if (!snap.prompt.found) issues.push({ item: 'prompt', detail: 'không tìm thấy ô prompt (textarea/contenteditable) gần nút gửi' });
      else if (snap.prompt.ambiguous) issues.push({ item: 'prompt', detail: `có ${snap.prompt.candidates} ô nhập cùng gần nút gửi; không xác định được ô prompt` });
      else { const c = comparePrompt(snap.prompt.text, String(payload.scene?.prompt ?? '')); if (c) issues.push(c); }
      evidence.settings = { chips: snap.chips, credits: parseCredits(snap.text) };
      evidence.prompt_sha256 = crypto.createHash('sha256').update(normalizePrompt(String(payload.scene?.prompt ?? ''))).digest('hex');
    } else if (snap.prompt.found && !snap.prompt.ambiguous && !normalizePrompt(snap.prompt.text)) {
      issues.push({ item: 'prompt', detail: 'ô prompt đang trống' });
    }
    if (issues.length) throw precheckError(issues);
    return evidence;
  }

  private async submit(page: Page, args: Record<string, any>) {
    const el = this.ref(args.ref);
    const d = await this.describe(el);
    const label = controlLabel(d);
    if (/purchase|buy|upgrade|mua thêm|nâng cấp|thanh toán/i.test(label)) throw new Error('Không tự mua credit');
    if (!isSubmitControl(d)) throw new Error('Điều khiển này không phải nút gửi/tạo (nhãn: "' + label.slice(0, 60) + '"); dùng browser_click cho thao tác thường');
    const actions = await this.actions();
    if (actions.some((a) => a.state !== 'abandoned')) throw new Error('Đã có submit intent cho job: tìm lại kết quả, không gửi/tạo lần nữa');
    const evidence = await this.precheck(page, el);
    // Chưa ghi intent nếu nút không bấm được (che khuất, disabled…): tránh biến lỗi UI thành trạng thái "uncertain".
    try { await el.click({ trial: true, timeout: 5000 }); }
    catch { throw precheckError([{ item: 'submit_control', detail: 'nút gửi không bấm được (bị che, vô hiệu hóa hoặc đã bị gỡ khỏi trang); chụp snapshot mới' }]); }
    const id = nextActionId(this.job.id, actions);
    await this.journal(id, 'intent', { url: page.url(), prompt_hash: crypto.createHash('sha256').update(JSON.stringify(this.job.payload)).digest('hex'), precheck: evidence });
    try {
      await this.alive();
      await el.click({ timeout: 5000 });
      await this.journal(id, 'submitted', { url: page.url() });
      return { ok: true, submitted: true, url: page.url(), action_id: id };
    } catch (err) {
      try { await this.journal(id, 'uncertain', { url: page.url() }); } catch { /* lease may be gone; intent remains durable */ }
      throw err;
    }
  }

  // ------------------------------------------------------------------ download

  private async downloadable() {
    const output = this.job.type === 'video' ? this.job.payload.output.video_path : this.job.payload.output.storyboard_path;
    const root = this.deps.root;
    const dest = path.resolve(root, output);
    if (!dest.startsWith(path.join(root, 'output') + path.sep)) throw new Error('Output ngoài phạm vi');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.realpathSync(path.dirname(dest)).startsWith(fs.realpathSync(path.join(root, 'output')) + path.sep)) throw new Error('Output symlink không hợp lệ');
    const live = liveActionOf(await this.actions());
    if (!live || !['submitted', 'uncertain', 'downloaded'].includes(live.state)) throw new Error('Chưa có lượt tạo đã submit trong journal; không tải để tránh lấy nhầm kết quả cũ');
    return { output, dest, live };
  }

  private async download(page: Page, args: Record<string, any>) {
    await this.downloadable();
    const el = this.ref(args.ref);
    const d = await this.describe(el);
    assertBrowserAction('download', controlLabel(d), d.type ?? null, d.download, { control: d, jobType: this.job.type });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), el.click({ timeout: 5000 })]);
    return this.saveDownload(page, dl);
  }

  private async saveDownload(page: Page, dl: Download) {
    let target: Awaited<ReturnType<BrowserTools['downloadable']>>;
    try { target = await this.downloadable(); }
    catch (e) { await dl.delete().catch(() => undefined); throw e; }
    const { output, dest, live } = target;
    const partial = dest + '.partial';
    await dl.saveAs(partial);
    try {
      const suggested = dl.suggestedFilename();
      const bad = this.job.type === 'video' ? /\.(gif|webp|png|jpe?g)$/i : /\.(mp4|mov|webm|gif)$/i;
      if (bad.test(suggested)) throw new Error(`File tải về (${suggested}) không đúng loại ${this.job.type}; không lưu`);
      const head = Buffer.alloc(16);
      const fd = fs.openSync(partial, 'r');
      try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
      if (fs.statSync(partial).size < 100) throw new Error('File tải về không hợp lệ');
      const isVideo = head.subarray(4, 8).toString('latin1') === 'ftyp' || head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      const isImage = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP');
      if (this.job.type === 'video' ? !isVideo : !isImage) throw new Error('Nội dung file tải về không phải ' + (this.job.type === 'video' ? 'video' : 'ảnh') + '; không lưu');
      fs.renameSync(partial, dest);
    } catch (e) {
      fs.rmSync(partial, { force: true });
      throw e;
    }
    await this.journal(live.id, 'downloaded', { url: page.url(), file_path: output });
    return { file_path: output };
  }

  async close() {
    await this.setRefs([]).catch(() => undefined);
    if (this.browser && this.ownsBrowser) await this.browser.close();
  }
}
