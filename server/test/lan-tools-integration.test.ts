import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { FFMPEG, FFPROBE, ffprobeJson } from './final-helpers.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';

/**
 * Tích hợp THẬT: công cụ "Xoá logo Veo" của LAN chạy tool gemini-watermark-remover thật (node + Chromium headless) trên một clip ngắn 2,5 giây
 * cắt (bằng ffmpeg, vào thư mục TẠM) từ video mẫu Veo CÓ SẴN trong repo của chính tool (src/assets/video-samples). ROOT/DB tạm; không đọc/ghi
 * output/ thật. Chỉ chạy khi có tool thật, video mẫu và Chromium của Playwright.
 */
const CLI = process.env.GWR_CLI || path.join(REPO_ROOT, 'gemini-watermark-remover', 'bin', 'gwr.mjs');
const SAMPLE = path.join(path.dirname(CLI), '..', 'src', 'assets', 'video-samples', '20260619.mp4'); // 720x1280, có âm thanh, có logo Veo
const HOME = process.env.HOME ?? '';
const hasChromium = fs.existsSync(path.join(HOME, 'Library', 'Caches', 'ms-playwright')) || fs.existsSync(path.join(HOME, '.cache', 'ms-playwright'));
const available = fs.existsSync(CLI) && fs.existsSync(path.join(path.dirname(CLI), '..', 'node_modules')) && hasChromium && fs.existsSync(SAMPLE) && !!FFMPEG && !!FFPROBE;

let L: LanEnv;
afterEach(async () => {
  await L?.close();
});

(available ? describe : describe.skip)('công cụ xoá logo LAN với tool THẬT', () => {
  it('clip mẫu Veo 720x1280 dài 2,5 giây → upload qua LAN → xoá logo bằng tool thật → bản sạch đúng thời lượng, còn âm thanh, tải được; mọi file nằm trong thư mục tạm', async () => {
    L = await makeLanEnv({ config: { finalRenderer: 'ffmpeg', watermarkRemover: 'auto', gwrCli: CLI, gwrTimeoutMs: 8 * 60_000 } });
    const wm = await L.env.ctx.finalRender!.watermarkStatus(true);
    expect(wm, JSON.stringify(wm)).toMatchObject({ mode: 'auto', active: true });
    const c = L.client();
    await c.login();
    const status = (await c.get('/lan/api/tools/status')).body;
    expect(status.remove_logo.available, JSON.stringify(status)).toBe(true);

    const clipPath = path.join(L.env.root, 'mau-2-5s.mp4'); // trong thư mục tạm của test
    const cut = spawnSync(FFMPEG!, ['-y', '-loglevel', 'error', '-ss', '0', '-t', '2.5', '-i', SAMPLE, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipPath]);
    expect(cut.status).toBe(0);
    const input = fs.readFileSync(clipPath);
    const t0 = Date.now();
    const up = await c.uploadVideo('/lan/api/tools/jobs', { name: 'clip-that.mp4', data: input }, { created_by_name: 'Kiểm thử' });
    expect(up.status, up.raw).toBe(201);
    const id = up.body.job.id as number;
    await L.env.ctx.finalRender!.idle();
    const job = (await c.get(`/lan/api/tools/jobs/${id}`)).body;
    process.stderr.write(`[lan-tool-integration] ${job.status} trong ${(Date.now() - t0) / 1000}s; error=${job.error}\n`);
    expect(job, String(job.error)).toMatchObject({ status: 'ready', progress: 100, error: null });

    const dir = path.join(L.env.root, 'output', 'lan-tools', String(id));
    expect(fs.readdirSync(dir).sort()).toEqual(['clean.mp4', 'input.mp4']);
    expect(L.env.root.startsWith(fs.realpathSync(process.env.TMPDIR ?? '/tmp')) || L.env.root.includes('autovideo-test-')).toBe(true);
    const inProbe = ffprobeJson(path.join(dir, 'input.mp4'));
    const outProbe = ffprobeJson(path.join(dir, 'clean.mp4'));
    const dur = (p: any) => Number(p.format.duration);
    expect(Math.abs(dur(outProbe) - dur(inProbe))).toBeLessThanOrEqual(0.25);
    expect(outProbe.streams.some((s: any) => s.codec_type === 'video')).toBe(true);
    expect(outProbe.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    expect(fs.statSync(path.join(dir, 'clean.mp4')).size).toBeGreaterThan(1000);
    expect(job.output.url).toBe(`/lan/files/output/lan-tools/${id}/clean.mp4`);
    const dl = await c.get(job.output.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('video/mp4');
  }, 600_000);
});
