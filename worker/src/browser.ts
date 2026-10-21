import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, type Browser, type Page, type Locator } from 'playwright-core';
import { api, root, type Job } from './client.js';
import { assertBrowserAction, isAllowedBrowserUrl as allowed } from './browser-policy.js';

/** A single executor per CDP profile. Model input never becomes JS or shell. */
export class BrowserTools {
  browser: Browser | null = null;
  page: Page | null = null;
  refs: Locator[] = [];
  constructor(private job: Job, private alive: () => Promise<void>) {}
  async connect() {
    if (!this.browser) {
      const endpoint = process.env.BROWSER_CDP_URL ?? 'http://127.0.0.1:9222';
      const u = new URL(endpoint);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('CDP phải là HTTP loopback');
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      this.page = this.browser.contexts()[0]?.pages().find((p) => allowed(p.url())) ?? null;
    }
  }
  async guard() {
    await this.alive();
    await api('POST', `/api/worker/jobs/${this.job.id}/browser-lease`, { profile: 'media' }, this.job.lease_id);
    await this.connect();
  }
  async locator(ref: number) {
    const el = this.refs[ref];
    if (!el || !this.page || !allowed(this.page.url())) throw new Error('Ref/website không hợp lệ. Chụp snapshot mới.');
    return el;
  }
  async journal(state: string, evidence: Record<string, unknown>) {
    return api('POST', `/api/worker/jobs/${this.job.id}/actions`, {
      id: `media-${this.job.id}`, profile: 'media', kind: this.job.type, state, evidence,
    }, this.job.lease_id);
  }
  async run(name: string, args: Record<string, any>): Promise<any> {
    await this.guard();
    if (name === 'browser_open') {
      if (!allowed(args.url)) throw new Error('Chỉ mở ChatGPT hoặc Google Flow');
      this.page = await this.browser!.contexts()[0]!.newPage();
      await this.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.refs = [];
      return { url: this.page.url() };
    }
    if (name === 'browser_select') {
      const p = this.browser!.contexts()[0]!.pages()[args.tab];
      if (!p || !allowed(p.url())) throw new Error('Tab không hợp lệ');
      this.page = p; this.refs = []; return { url: p.url() };
    }
    if (!this.page) throw new Error('Mở trang ChatGPT/Flow bằng browser_open trước');
    if (!allowed(this.page.url())) throw new Error('LOGIN_REQUIRED: hoàn tất đăng nhập trong cửa sổ browser');
    if (name === 'browser_snapshot') {
      const elements = this.page.locator('button, [role="button"], textarea, input, [contenteditable="true"], a[href]');
      this.refs = [];
      const controls = [];
      for (let i = 0; i < Math.min(await elements.count(), 300); i++) {
        const el = elements.nth(i);
        if (!await el.isVisible()) continue;
        const label = await el.evaluate((e) => ({ tag: e.tagName, text: (e.textContent ?? '').slice(0, 100), label: e.getAttribute('aria-label'), title: e.getAttribute('title'), type: e.getAttribute('type') }));
        controls.push({ ref: this.refs.length, ...label }); this.refs.push(el);
      }
      return { url: this.page.url(), tabs: this.browser!.contexts()[0]!.pages().map((p) => p.url()), text: (await this.page.locator('body').innerText()).slice(0, 14000), controls,
        image: 'data:image/jpeg;base64,' + (await this.page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' })).toString('base64') };
    }
    if (name === 'browser_fill') {
      await (await this.locator(args.ref)).fill(String(args.text));
      return { ok: true };
    }
    if (name === 'browser_upload') {
      const permitted: string[] = [...(this.job.payload.upload_files ?? [])];
      if (this.job.payload.storyboard_path) permitted.push(this.job.payload.storyboard_path);
      const files = args.files as string[];
      if (!Array.isArray(files) || files.some((f) => !permitted.includes(f))) throw new Error('File không thuộc upload_files của job');
      const abs = files.map((f) => {
        const p = fs.realpathSync(path.resolve(root, f));
        const r = fs.realpathSync(root);
        if (!p.startsWith(r + path.sep)) throw new Error('File ngoài ROOT');
        return p;
      });
      const el = await this.locator(args.ref);
      assertBrowserAction('upload', [await el.innerText(), await el.getAttribute('aria-label'), await el.getAttribute('title')].filter(Boolean).join(' '), await el.getAttribute('type'));
      if (await el.getAttribute('type') === 'file') await el.setInputFiles(abs);
      else { const [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout: 5000 }), el.click({ timeout: 5000 })]); await chooser.setFiles(abs); }
      return { ok: true };
    }
    if (name === 'browser_click' || name === 'browser_submit') {
      const el = await this.locator(args.ref);
      const label = [await el.innerText(), await el.getAttribute('aria-label'), await el.getAttribute('title')].filter(Boolean).join(' ');
      if (name === 'browser_click') {
        assertBrowserAction('click', label, await el.getAttribute('type'));
        await el.click(); return { ok: true };
      }
      if (/purchase|buy|upgrade|mua thêm|nâng cấp|thanh toán/i.test(label)) throw new Error('Không tự mua credit');
      const prior = await api<any[]>('GET', `/api/worker/jobs/${this.job.id}/actions`);
      if (prior.some((a) => a.id === `media-${this.job.id}`)) throw new Error('Đã có submit intent cho job: tìm lại kết quả, không gửi/tạo lần nữa');
      await this.journal('intent', { url: this.page.url(), prompt_hash: crypto.createHash('sha256').update(JSON.stringify(this.job.payload)).digest('hex') });
      try {
        await this.alive();
        await el.click();
        await this.journal('submitted', { url: this.page.url() });
        return { ok: true, submitted: true, url: this.page.url() };
      } catch (err) {
        try { await this.journal('uncertain', { url: this.page.url() }); } catch { /* lease may be gone; intent remains durable */ }
        throw err;
      }
    }
    if (name === 'browser_download') {
      const output = this.job.type === 'video' ? this.job.payload.output.video_path : this.job.payload.output.storyboard_path;
      const dest = path.resolve(root, output);
      if (!dest.startsWith(path.join(root, 'output') + path.sep)) throw new Error('Output ngoài phạm vi');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.realpathSync(path.dirname(dest)).startsWith(fs.realpathSync(path.join(root, 'output')) + path.sep)) throw new Error('Output symlink không hợp lệ');
      const el = await this.locator(args.ref);
      assertBrowserAction('download', [await el.innerText(), await el.getAttribute('aria-label'), await el.getAttribute('title')].filter(Boolean).join(' '), await el.getAttribute('type'), (await el.getAttribute('download')) !== null);
      const [d] = await Promise.all([this.page.waitForEvent('download', { timeout: 30000 }), el.click({ timeout: 5000 })]);
      await d.saveAs(dest + '.partial');
      if (fs.statSync(dest + '.partial').size < 100) throw new Error('File tải về không hợp lệ');
      fs.renameSync(dest + '.partial', dest);
      await this.journal('downloaded', { url: this.page.url(), file_path: output });
      return { file_path: output };
    }
    throw new Error('Công cụ browser không hỗ trợ');
  }
  async close() { if (this.browser) await this.browser.close(); }
}
