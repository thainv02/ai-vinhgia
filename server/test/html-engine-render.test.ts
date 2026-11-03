/** Dựng + chụp thật 2 giây bằng chrome-headless-shell; CHỈ chạy khi HTML_RENDERER_BROWSER trỏ tới chrome-headless-shell.exe. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureFrames, lintComposition, materialize, runRender } from '../src/services/html/engine/index.js';
import { FFPROBE, ffprobeJson } from './final-helpers.js';
import { makeEnv, type Env } from './helpers.js';
import { FIXTURE_INDEX, writeFixture } from './helpers-html-engine.js';

const HAS_BROWSER = !!process.env.HTML_RENDERER_BROWSER && fs.existsSync(process.env.HTML_RENDERER_BROWSER);

describe.skipIf(!HAS_BROWSER)('engine thật (cần HTML_RENDERER_BROWSER)', () => {
  let env: Env;
  let tmp: string;
  beforeAll(async () => {
    env = await makeEnv();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-eng-test-'));
  });
  afterAll(async () => {
    await env.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('lint đạt, dựng 720p (720x1280, 30 fps, 2 s) và chụp khung', async () => {
    const ver = path.join(tmp, 'v1');
    writeFixture(ver);
    const rep = await lintComposition(ver, { aspect: '9:16', durationS: 2 });
    expect(rep.errors, JSON.stringify(rep.errors)).toEqual([]);
    expect(rep.ok).toBe(true);

    const t0 = Date.now();
    const work = path.join(tmp, 'work-render');
    await materialize(ver, work, { mode: 'render' });
    expect(fs.existsSync(path.join(work, '__hf', 'gsap.min.js'))).toBe(true);
    const out = path.join(tmp, 'out', 'video.mp4');
    const progress: number[] = [];
    const ac = new AbortController();
    const r = await runRender(env.ctx, { workDir: work, outPath: out, aspect: '9:16', quality: '720p', durationS: 2, signal: ac.signal, onProgress: (p) => progress.push(p) });
    const renderMs = Date.now() - t0;
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    const pr = ffprobeJson(out);
    const v = pr.streams.find((s: any) => s.codec_type === 'video');
    expect(FFPROBE).toBeTruthy();
    expect([v.codec_name, v.width, v.height, v.r_frame_rate]).toEqual(['h264', 720, 1280, '30/1']);
    expect(Math.abs(Number(pr.format.duration) - 2)).toBeLessThan(0.1);
    expect(pr.streams.some((s: any) => s.codec_type === 'audio')).toBe(false);
    console.log(`[html-engine] render 2s 720p: ${renderMs} ms, progress=${progress.join(',')}, ffprobe=${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate} dur=${pr.format.duration}`);

    const t1 = Date.now();
    const cap = path.join(tmp, 'work-capture');
    await materialize(ver, cap, { mode: 'capture' });
    const frames = await captureFrames(env.ctx, { workDir: cap, aspect: '9:16', times: [0.2, 1.0, 1.8], signal: ac.signal });
    const capMs = Date.now() - t1;
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(f.subarray(1, 4).toString()).toBe('PNG');
      expect([f.readUInt32BE(16), f.readUInt32BE(20)]).toEqual([360, 640]);
    }
    expect(frames[0]!.equals(frames[2]!)).toBe(false); // GSAP có tiến triển
    console.log(`[html-engine] capture 3 frames: ${capMs} ms`);
  }, 120_000);

  it('composition độc hại (bỏ qua lint): <head> giả trong <title>, WebSocket/fetch/Worker/popup né lint → honeypot loopback 0 lượt, dựng vẫn xong', async () => {
    const hits: string[] = [];
    const honey = http.createServer((q, r) => {
      hits.push(`${q.method} ${q.url}`);
      r.end('x');
    });
    honey.on('upgrade', (q, s) => {
      hits.push(`WS ${q.url}`);
      s.destroy();
    });
    await new Promise<void>((r) => honey.listen(0, '127.0.0.1', () => r()));
    const hp = (honey.address() as { port: number }).port;
    try {
      const ver = path.join(tmp, 'evil');
      writeFixture(ver);
      const evil = `<script>
        const W = self['Web' + 'Socket']; try { new W('ws://127.0.0.1:${hp}/ws'); } catch (e) {}
        try { self['fe' + 'tch']('http://127.0.0.1:${hp}/fetch').catch(() => {}); } catch (e) {}
        try { new self['Wor' + 'ker']('data:text/javascript,1'); } catch (e) {}
        try { self['op' + 'en']('http://127.0.0.1:${hp}/popup'); } catch (e) {}
        try { const a = document.createElement('a'); a.href = 'http://127.0.0.1:${hp}/a'; a.target = '_blank'; a.click(); } catch (e) {}
        try { new Image().src = 'http://127.0.0.1:${hp}/img'; } catch (e) {}
      </script>`;
      // CSP từng bị dò sai chỗ khi AI viết <head> giả trong <title>, hoặc tắt hẳn khi file có chuỗi data-hf-engine
      const html = FIXTURE_INDEX.replace('<title>Fixture 2s</title>', '<title><head> data-hf-engine</title>').replace('<body>', `<body>${evil}`);
      fs.writeFileSync(path.join(ver, 'index.html'), html);
      const work = path.join(tmp, 'work-evil');
      await materialize(ver, work, { mode: 'render' });
      const out = path.join(tmp, 'evil.mp4');
      await runRender(env.ctx, { workDir: work, outPath: out, aspect: '9:16', quality: '720p', durationS: 2, signal: new AbortController().signal, onProgress: () => undefined });
      expect(fs.existsSync(out)).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((r) => honey.close(() => r()));
    }
  }, 120_000);

  it('hủy: kill cả cây, chờ thoát, thư mục tạm bị dọn', async () => {
    const ver = path.join(tmp, 'v2');
    writeFixture(ver);
    const work = path.join(tmp, 'work-abort');
    await materialize(ver, work, { mode: 'render' });
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('hfr-'));
    const ac = new AbortController();
    const p = runRender(env.ctx, { workDir: work, outPath: path.join(tmp, 'abort.mp4'), aspect: '9:16', quality: '720p', durationS: 2, signal: ac.signal, onProgress: () => undefined });
    setTimeout(() => ac.abort(), 1500);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('hfr-'))).toEqual(before);
  }, 60_000);
});
