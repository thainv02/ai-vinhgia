import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { descendants } from '../src/services/final-render/index.js';
import { FFMPEG, FFPROBE, ffprobeJson } from './final-helpers.js';
import { claimEditPlan, edlFor, makeEnv, setupAllDone, type Env } from './helpers.js';

/**
 * Tích hợp THẬT với tool xoá logo Veo (gemini-watermark-remover: node + Chromium headless + onnxruntime-web).
 * Chỉ chạy khi có tool thật (GWR_CLI, mặc định <repo>/gemini-watermark-remover/bin/gwr.mjs) và Chromium của Playwright.
 * Media nằm trong thư mục tạm: copy 1 video Cacao (chỉ ĐỌC từ output/cacao-smoothie/video/) rồi cắt clip ngắn 2,5 giây.
 */
const CLI = process.env.GWR_CLI || path.join(REPO_ROOT, 'gemini-watermark-remover', 'bin', 'gwr.mjs');
const SRC = fileURLToPath(new URL('../../output/cacao-smoothie/video/C1_v2.mp4', import.meta.url));
const HOME = process.env.HOME ?? '';
const hasChromium = fs.existsSync(path.join(HOME, 'Library', 'Caches', 'ms-playwright')) || fs.existsSync(path.join(HOME, '.cache', 'ms-playwright'));
const available = fs.existsSync(CLI) && fs.existsSync(path.join(path.dirname(CLI), '..', 'node_modules')) && hasChromium && fs.existsSync(SRC) && !!FFMPEG && !!FFPROBE;

let env: Env;
afterEach(async () => {
  await env?.close();
});

/** Giá trị xám trung bình tuyệt đối giữa hai video tại một vùng cắt (giây `t`). */
function regionDiff(a: string, b: string, t: number, crop: string): number {
  const grab = (f: string) =>
    spawnSync(FFMPEG!, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', `crop=${crop},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  const x = grab(a);
  const y = grab(b);
  expect(x.length).toBeGreaterThan(0);
  expect(y.length).toBe(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!);
  return sum / x.length;
}

(available ? describe : describe.skip)('tool xoá logo Veo THẬT', () => {
  it('clip Cacao 2,5 giây → final dựng bằng ffmpeg → xoá logo bằng tool thật → ready: raw + bản sạch, đúng thời lượng, còn âm thanh, vùng logo thay đổi', async () => {
    env = await makeEnv({ config: { watermarkRemover: 'auto', gwrCli: CLI, gwrTimeoutMs: 8 * 60_000 } });
    const wm = await env.ctx.finalRender!.watermarkStatus(true);
    expect(wm, JSON.stringify(wm)).toMatchObject({ mode: 'auto', active: true });

    const sc = await setupAllDone(env, { scenes: 2 });
    // clip ngắn từ bản sao video Cacao (cùng độ phân giải 720x1280, có âm thanh, logo ở góc dưới phải)
    const clip = path.join(env.root, 'clip.mp4');
    const cut = spawnSync(FFMPEG!, ['-y', '-loglevel', 'error', '-ss', '0', '-t', '2.5', '-i', SRC, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
    expect(cut.status).toBe(0);
    for (const code of ['C1', 'C2']) fs.copyFileSync(clip, path.join(env.root, `output/cacao-actiso-plus/video/${code}_v1.mp4`));

    const job = await claimEditPlan(sc);
    expect(job.payload.scenes.map((s: any) => [Math.round(s.duration_s * 10) / 10, s.width, s.height])).toEqual([[2.5, 720, 1280], [2.5, 720, 1280]]);
    const c = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, c, [0.2, 2.3]), summary: 'Cắt đầu cuối.' } });
    expect(r.status, r.raw).toBe(200);

    const stages = new Set<string>();
    const orig = env.ctx.sse.publish.bind(env.ctx.sse);
    env.ctx.sse.publish = (e: string, d: any, p: number | null) => {
      if (e === 'final_cut.updated' && d.final_cut.stage) stages.add(`${d.final_cut.stage}`);
      orig(e, d, p);
    };
    env.ctx.sse.add({ writeHead() {}, write() {}, on() {}, end() {} } as any, sc.project.id);
    const t0 = Date.now();
    await env.ctx.finalRender!.idle();
    const done = (await sc.user.get(`/api/final-cuts/${c.id}`)).body;
    process.stderr.write(`[gwr-integration] ${done.status} trong ${(Date.now() - t0) / 1000}s; error=${done.error}\n`);
    expect(done, String(done.error)).toMatchObject({ status: 'ready', watermark_removed: true, stage: null, failed_stage: null, renderer: 'ffmpeg' });
    expect(done.watermark_meta).toMatchObject({ kind: 'video' });

    const rawAbs = path.join(env.root, done.raw_video_path);
    const cleanAbs = path.join(env.root, done.video_path);
    expect(done.raw_video_path).toBe('output/cacao-actiso-plus/final/cacao-actiso-plus_final_v1_raw.mp4');
    expect(done.video_path).toBe('output/cacao-actiso-plus/final/cacao-actiso-plus_final_v1.mp4');
    expect(fs.existsSync(rawAbs) && fs.existsSync(cleanAbs)).toBe(true);
    expect(fs.readdirSync(path.dirname(cleanAbs)).filter((f) => f.includes('.tmp'))).toEqual([]);
    const rp = ffprobeJson(rawAbs);
    const cp = ffprobeJson(cleanAbs);
    const expected = 2 * (2.3 - 0.2);
    const rd = Number(rp.format.duration);
    const cd = Number(cp.format.duration);
    process.stderr.write(`[gwr-integration] raw=${rd}s clean=${cd}s (kỳ vọng ${expected}s)\n`);
    expect(Math.abs(rd - expected)).toBeLessThan(0.25);
    expect(Math.abs(cd - rd)).toBeLessThan(0.25);
    expect(cp.streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 720, height: 1280 });
    expect(cp.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    // vùng logo (góc dưới phải) khác hẳn bản raw nhiều hơn vùng góc trên trái
    const br = regionDiff(rawAbs, cleanAbs, 1, '200:200:520:1080');
    const tl = regionDiff(rawAbs, cleanAbs, 1, '200:200:0:0');
    process.stderr.write(`[gwr-integration] khác biệt góc dưới phải=${br.toFixed(2)} góc trên trái=${tl.toFixed(2)}\n`);
    expect(br).toBeGreaterThan(tl);
    expect(stages).toEqual(new Set(['render', 'clean']));
    expect(fs.readFileSync(path.join(env.root, 'output', 'cacao-actiso-plus', 'log.md'), 'utf8')).toContain('đã xoá logo Veo');
    // không còn tiến trình con (Chromium) của tool
    await new Promise((res) => setTimeout(res, 500));
    expect(descendants(process.pid).filter((p) => p !== process.pid).length).toBeLessThan(5);
  }, 300_000);
});
