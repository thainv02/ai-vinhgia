import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { FFMPEG, FFPROBE, ffprobeJson } from './final-helpers.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';

/**
 * Tích hợp THẬT: HAI tiến trình tool xoá logo Veo (gemini-watermark-remover: node + static server cổng ngẫu nhiên + Chromium headless riêng)
 * chạy CÙNG LÚC qua hàng đợi render song song (RENDER_CONCURRENCY=2), mỗi tiến trình trên một clip ngắn 2,5 giây khác nhau. Kiểm tra:
 * - hai tiến trình `gwr.mjs remove` thật sự sống cùng lúc (ps) và hai việc cùng `processing` trong DB;
 * - cả hai xong `ready`, đúng thời lượng, còn âm thanh, vùng logo thực sự bị đổi, không có file lẫn nhau/file tạm sót.
 * Mọi file nằm trong ROOT tạm; clip cắt từ video mẫu Veo CÓ SẴN trong repo của tool. Chỉ chạy khi có tool thật, video mẫu và Chromium của Playwright.
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

/** Số tiến trình `gwr.mjs remove` đang sống (chỉ đếm tiến trình node của tool, không đếm Chromium). */
function liveGwrProcesses(root: string): number {
  const out = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l.includes('gwr.mjs') && l.includes(' remove ') && l.includes(root)).length;
}

/** Độ lệch xám trung bình giữa hai video ở một vùng cắt, tại giây `t`. */
function regionDiff(a: string, b: string, t: number, crop: string): number {
  const grab = (f: string) => spawnSync(FFMPEG!, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', `crop=${crop},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  const x = grab(a);
  const y = grab(b);
  expect(x.length).toBeGreaterThan(0);
  expect(y.length).toBe(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!);
  return sum / x.length;
}

(available ? describe : describe.skip)('hai tiến trình xoá logo THẬT chạy song song', () => {
  it('RENDER_CONCURRENCY=2: hai clip ngắn xử lý cùng lúc bằng tool thật, cả hai ra bản sạch hợp lệ, không lẫn file', async () => {
    L = await makeLanEnv({ config: { finalRenderer: 'ffmpeg', watermarkRemover: 'auto', gwrCli: CLI, gwrTimeoutMs: 8 * 60_000, renderConcurrency: 2 } });
    expect(L.env.ctx.finalRender!.concurrency).toBe(2);
    const wm = await L.env.ctx.finalRender!.watermarkStatus(true);
    expect(wm, JSON.stringify(wm)).toMatchObject({ mode: 'auto', active: true });
    const c1 = L.client({ ip: '192.168.1.21' });
    const c2 = L.client({ ip: '192.168.1.22' });
    await c1.login();
    await c2.login();

    // hai clip KHÁC NHAU (đoạn 0–2,5 giây và 3–5,5 giây của video mẫu), cắt vào thư mục tạm
    const cut = (name: string, ss: number) => {
      const out = path.join(L.env.root, name);
      const r = spawnSync(FFMPEG!, ['-y', '-loglevel', 'error', '-ss', String(ss), '-t', '2.5', '-i', SAMPLE, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
      expect(r.status).toBe(0);
      return out;
    };
    const clipA = cut('mau-a.mp4', 0);
    const clipB = cut('mau-b.mp4', 3);

    const t0 = Date.now();
    const [upA, upB] = await Promise.all([
      c1.uploadVideo('/lan/api/tools/jobs', { name: 'a.mp4', data: fs.readFileSync(clipA) }, { created_by_name: 'A' }),
      c2.uploadVideo('/lan/api/tools/jobs', { name: 'b.mp4', data: fs.readFileSync(clipB) }, { created_by_name: 'B' }),
    ]);
    expect(upA.status, upA.raw).toBe(201);
    expect(upB.status, upB.raw).toBe(201);
    const idA = upA.body.job.id as number;
    const idB = upB.body.job.id as number;

    let maxProcessing = 0;
    let maxProcs = 0;
    const poll = setInterval(() => {
      const n = (L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM lan_tool_jobs WHERE status = 'processing'").get() as { n: number }).n;
      maxProcessing = Math.max(maxProcessing, n);
      maxProcs = Math.max(maxProcs, liveGwrProcesses(L.env.root));
    }, 150);
    await L.env.ctx.finalRender!.idle();
    clearInterval(poll);
    const secs = (Date.now() - t0) / 1000;

    const jobA = (await c1.get(`/lan/api/tools/jobs/${idA}`)).body;
    const jobB = (await c2.get(`/lan/api/tools/jobs/${idB}`)).body;
    process.stderr.write(`[gwr-parallel] tổng ${secs.toFixed(1)}s; tối đa ${maxProcessing} việc processing; tối đa ${maxProcs} tiến trình gwr.mjs sống cùng lúc; A=${jobA.status} B=${jobB.status}\n`);
    expect(jobA, String(jobA.error)).toMatchObject({ status: 'ready', error: null });
    expect(jobB, String(jobB.error)).toMatchObject({ status: 'ready', error: null });
    expect(maxProcessing).toBe(2);
    expect(maxProcs).toBeGreaterThanOrEqual(2);

    for (const [id, clip] of [
      [idA, clipA],
      [idB, clipB],
    ] as const) {
      const dir = path.join(L.env.root, 'output', 'lan-tools', String(id));
      expect(fs.readdirSync(dir).sort()).toEqual(['clean.mp4', 'input.mp4']); // không file tạm sót, không lẫn file của việc kia
      const inP = ffprobeJson(path.join(dir, 'input.mp4'));
      const outP = ffprobeJson(path.join(dir, 'clean.mp4'));
      expect(Math.abs(Number(outP.format.duration) - Number(inP.format.duration))).toBeLessThanOrEqual(0.25);
      expect(outP.streams.some((s: any) => s.codec_type === 'video')).toBe(true);
      expect(outP.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
      expect(fs.statSync(path.join(dir, 'clean.mp4')).size).toBeGreaterThan(1000);
      // đầu vào của từng việc đúng là clip của nó (không bị đổi chỗ giữa hai tiến trình)
      expect(fs.readFileSync(path.join(dir, 'input.mp4')).equals(fs.readFileSync(clip))).toBe(true);
      // vùng logo (góc dưới phải) bị đổi nhiều hơn vùng góc trên trái: tool thật đã xử lý clip này
      const br = regionDiff(path.join(dir, 'input.mp4'), path.join(dir, 'clean.mp4'), 1, '120:120:600:1160');
      const tl = regionDiff(path.join(dir, 'input.mp4'), path.join(dir, 'clean.mp4'), 1, '120:120:0:0');
      process.stderr.write(`[gwr-parallel] việc #${id}: khác biệt góc dưới phải=${br.toFixed(2)} góc trên trái=${tl.toFixed(2)}\n`);
      expect(br).toBeGreaterThan(tl);
    }
  }, 600_000);
});
