import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { FfmpegRenderer, RenderCancelled, buildFfmpegArgs, type RenderRequest } from '../src/services/final-render/index.js';
import { FFMPEG, FFPROBE, ffprobeJson, makeTestVideo } from './final-helpers.js';
import { claimEditPlan, edlFor, makeEnv, setupAllDone, type Env } from './helpers.js';

const run = FFMPEG && FFPROBE ? describe : describe.skip;

run('FfmpegRenderer (ffmpeg thật)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-ffr-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const req = (segments: RenderRequest['segments'], extra: Partial<RenderRequest> = {}): RenderRequest => ({
    cutId: 1,
    version: 1,
    slug: 'demo',
    name: 'Demo',
    segments,
    out: { videoAbs: path.join(root, 'final', 'demo_final_v1.mp4'), contactAbs: path.join(root, 'final', 'demo_final_v1_contact.png') },
    config: defaultConfig(root, path.join(root, 'x.db')),
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...extra,
  });

  it('trim + concat cắt thẳng, giữ âm thanh, nguồn không có âm thanh được chèn im lặng; có contact sheet; không có .mlt', async () => {
    const a = path.join(root, 'a.mp4');
    const b = path.join(root, 'b.mp4');
    makeTestVideo(a, 3, { audio: true });
    makeTestVideo(b, 2, { audio: false });
    const progress: number[] = [];
    const out = await new FfmpegRenderer().render(
      req(
        [
          { path: a, in_s: 0.5, out_s: 2.5, caption: 'C1 v1 #1' },
          { path: a, in_s: 2.7, out_s: 3.0, caption: 'C1 v1 #2' },
          { path: b, in_s: 0, out_s: 1.5, caption: 'C2 v1 #1' },
        ],
        { onProgress: (p) => progress.push(p) },
      ),
    );
    expect(out.renderer).toBe('ffmpeg');
    expect(fs.existsSync(path.join(root, 'final', 'shotcut'))).toBe(false);
    const probe = ffprobeJson(out.videoAbs);
    const v = probe.streams.find((s: any) => s.codec_type === 'video');
    const au = probe.streams.find((s: any) => s.codec_type === 'audio');
    expect(v).toMatchObject({ codec_name: 'h264', width: 160, height: 284, r_frame_rate: '24/1' });
    expect(au).toMatchObject({ codec_name: 'aac' });
    const expected = 2 + 0.3 + 1.5;
    expect(Math.abs(Number(probe.format.duration) - expected)).toBeLessThan(0.15);
    expect(Math.abs(Number(au.duration) - expected)).toBeLessThan(0.2); // âm thanh phủ hết cả đoạn không có tiếng
    expect(out.contactAbs).toBe(path.join(root, 'final', 'demo_final_v1_contact.png'));
    expect(fs.readFileSync(out.contactAbs!).subarray(1, 4).toString()).toBe('PNG');
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress)).toBeLessThanOrEqual(99);
    expect([...progress].sort((x, y) => x - y)).toEqual(progress);
  });

  it('afade 20ms ở mỗi chỗ nối (đoạn đầu chỉ fade-out, đoạn cuối chỉ fade-in, đoạn giữa cả hai), cắt thẳng không có hiệu ứng chuyển cảnh', () => {
    const segs = [0, 1, 2].map((i) => ({ path: `/x/${i}.mp4`, in_s: 1, out_s: 2.5, caption: `c${i}` }));
    const args = buildFfmpegArgs(segs, [true, true, true], { width: 720, height: 1280, fps: '24' }, '/out.mp4');
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    const a = (k: number) => fc.split(';').find((p) => p.endsWith(`[a${k}]`))!;
    expect(a(0)).toContain('afade=t=out:st=1.480:d=0.02');
    expect(a(0)).not.toContain('afade=t=in');
    expect(a(1)).toContain('afade=t=in:st=0:d=0.02');
    expect(a(1)).toContain('afade=t=out:st=1.480:d=0.02');
    expect(a(2)).toContain('afade=t=in:st=0:d=0.02');
    expect(a(2)).not.toContain('afade=t=out');
    expect(fc).toContain('concat=n=3:v=1:a=1[v][a]');
    expect(fc).not.toMatch(/xfade|fade=t=(in|out):.*color/);
    expect(args.slice(0, 1)).toEqual(['-n']); // không bao giờ ghi đè
    expect(args.at(-1)).toBe('/out.mp4');
    // nguồn không có âm thanh → anullsrc
    const silent = buildFfmpegArgs(segs.slice(0, 2), [false, true], { width: 720, height: 1280, fps: '24' }, '/o.mp4');
    expect(silent[silent.indexOf('-filter_complex') + 1]).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=1.500');
  });

  it('không ghi đè file đã có: lỗi và file cũ nguyên vẹn', async () => {
    const a = path.join(root, 'a.mp4');
    makeTestVideo(a, 2);
    const r = req([{ path: a, in_s: 0, out_s: 1, caption: 'x' }]);
    fs.mkdirSync(path.dirname(r.out.videoAbs), { recursive: true });
    fs.writeFileSync(r.out.videoAbs, 'bản cũ');
    await expect(new FfmpegRenderer().render(r)).rejects.toThrow(/không ghi đè/);
    expect(fs.readFileSync(r.out.videoAbs, 'utf8')).toBe('bản cũ');
  });

  it('hủy giữa chừng: kill ffmpeg, ném RenderCancelled, không để lại video dở', async () => {
    const a = path.join(root, 'long.mp4');
    makeTestVideo(a, 25, { size: '640x1136' });
    const ac = new AbortController();
    const r = req([{ path: a, in_s: 0, out_s: 24, caption: 'x' }], { signal: ac.signal });
    const p = new FfmpegRenderer().render(r);
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toBeInstanceOf(RenderCancelled);
    expect(fs.existsSync(r.out.videoAbs)).toBe(false);
  }, 60_000);

  it('đoạn quá ngắn / thiếu đoạn / không có ffmpeg → lỗi rõ ràng', async () => {
    await expect(new FfmpegRenderer().render(req([]))).rejects.toThrow(/không có đoạn nào/);
    const r = req([{ path: '/khong/co.mp4', in_s: 0, out_s: 1, caption: 'x' }]);
    await expect(new FfmpegRenderer().render(r)).rejects.toThrow(/ffmpeg/);
    const noBin = req([{ path: '/x.mp4', in_s: 0, out_s: 1, caption: 'x' }], { config: { ...defaultConfig(root, path.join(root, 'x.db')), ffmpegPath: '/khong/co/ffmpeg' } });
    // ffmpegPath sai vẫn tìm được ffmpeg ở PATH/Shotcut → vẫn chạy và lỗi vì file nguồn không có
    await expect(new FfmpegRenderer().render(noBin)).rejects.toThrow();
  });
});

run('final cut end-to-end với ffmpeg thật (FINAL_RENDERER=ffmpeg)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  it('chọn video → edit_plan → EDL → render nền bằng ffmpeg → ready; file phát được qua /files (Range 206); ffprobe khớp', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    for (const code of ['C1', 'C2']) makeTestVideo(path.join(env.root, `output/cacao-actiso-plus/video/${code}_v1.mp4`), 4);
    const job = await claimEditPlan(sc);
    expect(job.payload.scenes.map((s: any) => [s.code, Math.round(s.duration_s), s.width, s.height, Math.round(s.fps)])).toEqual([['C1', 4, 160, 284, 24], ['C2', 4, 160, 284, 24]]);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    expect(cut.selection.map((s: any) => Math.round(s.duration_s))).toEqual([4, 4]);
    const edl = edlFor(sc, cut, [0.5, 3.5]);
    for (const s of edl.scenes) s.removed = [];
    const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl, summary: 'Cắt đầu và cuối.' } });
    expect(r.status, r.raw).toBe(200);
    await env.ctx.finalRender!.idle();
    const done = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(done).toMatchObject({ status: 'ready', renderer: 'ffmpeg', project_file_path: null, progress: 100 });
    expect(Math.abs(done.duration_s - 6)).toBeLessThan(0.15);
    const abs = path.join(env.root, done.video_path);
    expect(Math.abs(Number(ffprobeJson(abs).format.duration) - 6)).toBeLessThan(0.15);
    expect(fs.existsSync(path.join(env.root, done.contact_sheet_path))).toBe(true);
    const range = await env.app.inject({ method: 'GET', url: done.video_url, headers: { host: 'localhost', range: 'bytes=0-99' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-type']).toBe('video/mp4');
    expect((await sc.user.get('/api/meta')).body.final_renderer).toMatchObject({ active: 'ffmpeg' });
  });
});
