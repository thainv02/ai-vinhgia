import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClipArgs, buildFilterGraph, captionSupport, escapeFilterValue, hasSubtitlesFilter, resolveReframe, targetSize } from '../src/services/clips/render.js';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { resolveBinary } from '../src/services/media.js';
import { client, makeEnv, userClient, type Env } from './helpers.js';
import { FFMPEG, ffprobeJson } from './final-helpers.js';
import { libassFfmpeg, seedClipProject, waitFor } from './helpers-clips.js';
import { unzipEntries } from './helpers-zip.js';

const LIBASS = libassFfmpeg();
const FF = FFMPEG!;

let env: Env;
beforeEach(async () => {
  // cùng một ffmpeg cho mọi bản dựng để so khung có/không phụ đề công bằng
  env = await makeEnv({ config: { clipMinFreeGb: 0, clipFfmpegPath: LIBASS, ...(LIBASS ? { ffmpegPath: LIBASS } : {}) } });
});
afterEach(async () => {
  await env.ctx.finalRender?.idle();
  await thumbsIdle(env.ctx);
  await env.close();
});
const user = () => userClient(env.app);

/** Dự án có video nguồn thật dài `seconds` giây và một clip tay từ từ `sw` tới `ew`. */
async function withClip(o: { seconds?: number; size?: string; sw?: number; ew?: number; status?: 'approved' | 'rejected' } = {}) {
  const s = seedClipProject(env, { video: { seconds: o.seconds ?? 30, size: o.size ?? '640x360' } });
  const r = await user().post(`/api/projects/${s.projectId}/clips`, { start_word: o.sw ?? 0, end_word: o.ew ?? 23, title: 'Đoạn thử' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (o.status === 'rejected') await user().patch(`/api/clips/${r.body.clip.id}`, { status: 'rejected' });
  return { s, clip: r.body.clip as any };
}
const cutOf = async (id: number, status = 'ready') => waitFor(async () => (await user().get(`/api/clips/${id}`)).body.clip.latest_cut, (c) => c?.status === status, 60_000, `bản dựng ${status}`);
const probe = (rel: string) => ffprobeJson(path.join(env.root, rel));
const frameHash = (file: string, t: number, filter = ''): string => {
  const out = path.join(os.tmpdir(), `f-${process.pid}-${Math.random().toString(16).slice(2)}.png`);
  const r = spawnSync(FF, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', ...(filter ? ['-vf', filter] : []), out]);
  expect(r.status).toBe(0);
  const h = fs.readFileSync(out).toString('base64');
  fs.rmSync(out, { force: true });
  return h;
};

describe('filtergraph và tham số ffmpeg (thuần)', () => {
  it('kích thước đích theo tỉ lệ; nhận biết nguồn đã đúng tỉ lệ', () => {
    expect(targetSize('9:16', 1920, 1080)).toEqual({ w: 1080, h: 1920 });
    expect(targetSize('1:1', 1920, 1080)).toEqual({ w: 1080, h: 1080 });
    expect(targetSize('16:9', 1280, 720)).toEqual({ w: 1920, h: 1080 });
    expect(targetSize('source', 1279, 719)).toEqual({ w: 1280, h: 720 });
    expect(resolveReframe(1920, 1080, 1080, 1920, undefined, '9:16')).toBe('fit'); // nguồn ngang → mặc định fit
    expect(resolveReframe(1920, 1080, 1080, 1920, 'center', '9:16')).toBe('center');
    expect(resolveReframe(1080, 1920, 1080, 1920, 'center', '9:16')).toBe('native'); // nguồn dọc: bỏ qua reframe
    expect(resolveReframe(720, 1280, 1080, 1920, 'fit', '9:16')).toBe('native'); // 9:16 khác độ phân giải
    expect(resolveReframe(1920, 1080, 1920, 1080, undefined, '16:9')).toBe('native');
    expect(resolveReframe(1920, 1080, 1920, 1080, 'fit', 'source')).toBe('native');
  });
  it('fit: tách nền (phóng phủ khung + làm mờ + giảm sáng) và lớp chính scale 1080:-2 (giữ tỉ lệ, chẵn) overlay giữa', () => {
    const { graph } = buildFilterGraph({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'fit', ass: null });
    expect(graph).toContain('split=2[bg0][fg0]');
    expect(graph).toContain('force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,scale=1080:1920,eq=brightness=-0.10[bg]');
    expect(graph).toContain('[fg0]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2');
    expect(graph).toContain('overlay=(W-w)/2:(H-h)/2');
    expect(graph.endsWith('[base]format=yuv420p[v]')).toBe(true);
  });
  it('center: crop giữa theo tỉ lệ đích (kích thước chẵn) rồi scale 1080x1920; nguồn dọc hơn thì cắt chiều cao', () => {
    expect(buildFilterGraph({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'center', ass: null }).graph).toContain('crop=606:1080:(iw-606)/2:(ih-1080)/2,scale=1080:1920');
    expect(buildFilterGraph({ srcW: 1000, srcH: 2400, aspect: '9:16', reframe: 'center', ass: null }).graph).toContain('crop=1000:1776:(iw-1000)/2:(ih-1776)/2,scale=1080:1920');
    expect(buildFilterGraph({ srcW: 1080, srcH: 1920, aspect: '9:16', reframe: 'native', ass: null }).graph).toContain('scale=1080:1920:flags=lanczos,setsar=1[base]');
  });
  it('subtitles: có fontsdir, đường dẫn có khoảng trắng / dấu : \' , được escape hai tầng', () => {
    const { graph } = buildFilterGraph({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'fit', ass: { file: "/tmp/a b:c/it's,x.ass", fontsDir: '/tmp/fonts dir' } });
    expect(graph).toContain("subtitles=filename='");
    expect(graph).toContain(":fontsdir='/tmp/fonts dir'");
    expect(escapeFilterValue("/a b:c/it's,x.ass")).toBe("/a b\\\\:c/it\\\\\\'s\\,x.ass");
    expect(graph).not.toContain('a b:c/'); // dấu : đã escape
  });
  it('tham số: -ss TRƯỚC -i (mã hoá lại nên chính xác), -t, afade 0.06 s hai đầu, crf 18, preset medium, aac 160k, faststart', () => {
    const args = buildClipArgs({ src: '/s.mp4', startS: 12.3456, durS: 30.5, graph: 'GRAPH', hasAudio: true, out: '/o.mp4' });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('12.346');
    expect(args[args.indexOf('-t') + 1]).toBe('30.500');
    expect(args).toContain('-filter_complex');
    expect(args[args.indexOf('-af') + 1]).toBe('afade=t=in:st=0:d=0.06,afade=t=out:st=30.440:d=0.06');
    const j = args.join(' ');
    for (const must of ['-c:v libx264', '-preset medium', '-crf 18', '-c:a aac', '-b:a 160k', '-movflags +faststart', '-progress pipe:1']) expect(j).toContain(must);
    expect(buildClipArgs({ src: '/s', startS: 0, durS: 5, graph: 'G', hasAudio: false, out: '/o' })).not.toContain('-af');
  });
});

describe('ffmpeg có libass', () => {
  it('hasSubtitlesFilter / captionSupport', () => {
    const def = resolveBinary('ffmpeg', null);
    expect(typeof hasSubtitlesFilter(def!)).toBe('boolean');
    if (LIBASS) {
      expect(hasSubtitlesFilter(LIBASS)).toBe(true);
      expect(captionSupport(env.ctx)).toMatchObject({ available: true, ffmpeg: LIBASS });
    }
    expect(hasSubtitlesFilter('/khong/co/ffmpeg')).toBe(false);
  });
});

describe('dựng clip bằng ffmpeg thật (không phụ đề)', () => {
  it('9:16 nền mờ: đúng độ dài ±0.1 s, 1080×1920, có tiếng, faststart; thư mục/tên file; srt; ảnh đại diện; ZIP', async () => {
    const { s, clip } = await withClip();
    expect(clip.thumb_url).toBeNull(); // chưa dựng xong ảnh
    await thumbsIdle(env.ctx);
    expect((await user().get(`/api/clips/${clip.id}`)).body.clip.thumb_url).toMatch(new RegExp(`^/files/output/${s.slug}/clips/thumbs/K1\\.jpg\\?v=\\d+$`));
    const r = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    expect(r.status).toBe(201);
    expect(r.body.cut).toMatchObject({ clip_id: clip.id, version: 1, status: 'rendering', aspect: '9:16', reframe: { mode: 'fit' }, captions: { preset: 'none' }, video_url: null });
    const cut = await cutOf(clip.id);
    expect(cut).toMatchObject({ version: 1, status: 'ready', progress: 100, stage: null, error: null, queue_state: null, queue_position: null });
    expect(cut.video_url).toBe(`/files/output/${s.slug}/clips/clips/K1_v1.mp4`);
    expect(cut.srt_url).toBe(`/files/output/${s.slug}/clips/clips/K1_v1.srt`);
    const rel = `output/${s.slug}/clips/clips/K1_v1.mp4`;
    const info = probe(rel);
    const v = info.streams.find((x: any) => x.codec_type === 'video');
    const a = info.streams.find((x: any) => x.codec_type === 'audio');
    expect([v.width, v.height, v.codec_name, v.pix_fmt]).toEqual([1080, 1920, 'h264', 'yuv420p']);
    expect(a.codec_name).toBe('aac');
    const durS = clip.end_s - clip.start_s;
    expect(Math.abs(Number(info.format.duration) - durS)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(Number(v.duration) - durS)).toBeLessThanOrEqual(0.1);
    expect(cut.duration_s).toBeCloseTo(durS, 1);
    // faststart: moov đứng trước mdat
    const head = fs.readFileSync(path.join(env.root, rel)).subarray(0, 4096).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(fs.readFileSync(path.join(env.root, rel)).toString('latin1').indexOf('mdat'));
    const srt = fs.readFileSync(path.join(env.root, `output/${s.slug}/clips/clips/K1_v1.srt`), 'utf8');
    expect(srt).toMatch(/^1\n00:00:0\d,\d{3} --> /);
    expect(fs.existsSync(path.join(env.root, `output/${s.slug}/clips/clips/K1_v1.ass`))).toBe(false); // không phụ đề thì không có .ass
    // clip: latest_cut và cuts_count
    const c2 = (await user().get(`/api/clips/${clip.id}`)).body.clip;
    expect(c2).toMatchObject({ cuts_count: 1, latest_cut: { id: cut.id } });
    // ZIP: mp4 + srt của bản mới nhất
    const zip = await env.app.inject({ method: 'GET', url: `/api/projects/${s.projectId}/clips.zip`, headers: { host: 'localhost' } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const names = unzipEntries(zip.rawPayload).map((e) => e.name);
    expect(names).toEqual(['K1_doan-thu_v1.mp4', 'K1_doan-thu_v1.srt']);
    expect(unzipEntries(zip.rawPayload)[0]!.data.equals(fs.readFileSync(path.join(env.root, rel)))).toBe(true);
    // chưa có clip dựng xong → 404
    const empty = seedClipProject(env, { video: false });
    expect((await env.app.inject({ method: 'GET', url: `/api/projects/${empty.projectId}/clips.zip`, headers: { host: 'localhost' } })).statusCode).toBe(404);
  });

  it('center: cắt giữa khung; fit và center cho ảnh khác nhau; nguồn dọc 9:16 được bỏ qua reframe (native)', async () => {
    const { s, clip } = await withClip();
    const fit = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none', reframe_mode: 'fit' });
    await cutOf(clip.id);
    const ctr = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none', reframe_mode: 'center' });
    expect(ctr.body.cut).toMatchObject({ version: 2, reframe: { mode: 'center' } });
    await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut, (c) => c?.version === 2 && c.status === 'ready', 60_000);
    expect(fit.body.cut.version).toBe(1);
    const base = `${env.root}/output/${s.slug}/clips/clips`;
    for (const f of ['K1_v1.mp4', 'K1_v2.mp4']) expect(probe(`output/${s.slug}/clips/clips/${f}`).streams.find((x: any) => x.codec_type === 'video').height).toBe(1920);
    expect(frameHash(`${base}/K1_v1.mp4`, 1)).not.toBe(frameHash(`${base}/K1_v2.mp4`, 1));
    // nền mờ: góc trên-trái của bản fit gần như phẳng (mờ), của bản center (testsrc2 chi tiết) thì không
    const stddev = (file: string) => {
      const r = spawnSync(FF, ['-hide_banner', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'crop=200:200:0:0,signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/lavfi\.signalstats\.YHIGH=(\d+)/.exec(r.stderr)?.[1]) - Number(/lavfi\.signalstats\.YLOW=(\d+)/.exec(r.stderr)?.[1]);
    };
    expect(stddev(`${base}/K1_v1.mp4`)).toBeLessThan(stddev(`${base}/K1_v2.mp4`) + 1);
    // nguồn dọc 9:16
    const vert = await withClip({ size: '360x640' });
    const rv = await user().post(`/api/clips/${vert.clip.id}/render`, { captions_preset: 'none', reframe_mode: 'center' });
    expect(rv.body.cut.reframe).toEqual({ mode: 'center', native: true });
    await cutOf(vert.clip.id);
  });

  it('khung 1:1 và 16:9', async () => {
    const { s, clip } = await withClip();
    await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none', aspect: '1:1' });
    await cutOf(clip.id);
    const v1 = probe(`output/${s.slug}/clips/clips/K1_v1.mp4`).streams.find((x: any) => x.codec_type === 'video');
    expect([v1.width, v1.height]).toEqual([1080, 1080]);
    await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none', aspect: '16:9' });
    await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut, (c) => c?.version === 2 && c.status === 'ready', 60_000);
    const v2 = probe(`output/${s.slug}/clips/clips/K1_v2.mp4`).streams.find((x: any) => x.codec_type === 'video');
    expect([v2.width, v2.height]).toEqual([1920, 1080]);
  });

  it('không ghi đè: version kế tiếp bỏ qua tên file đã có trên đĩa; bản cũ giữ nguyên', async () => {
    const { s, clip } = await withClip();
    const dir = path.join(env.root, `output/${s.slug}/clips/clips`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'K1_v1.mp4'), 'cũ');
    fs.writeFileSync(path.join(dir, 'K1_v2.srt'), 'cũ');
    const r = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    expect(r.body.cut.version).toBe(3);
    await cutOf(clip.id);
    expect(fs.readFileSync(path.join(dir, 'K1_v1.mp4'), 'utf8')).toBe('cũ');
    expect(fs.readFileSync(path.join(dir, 'K1_v2.srt'), 'utf8')).toBe('cũ');
  });
});

describe('điều kiện và lỗi khi dựng', () => {
  it('clip đã bỏ → 409; đang có bản đang dựng → 409 CUT_ACTIVE; tham số sai → 400; không tồn tại → 404', async () => {
    const { clip } = await withClip({ status: 'rejected' });
    const rej = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    expect([rej.status, rej.body.error.code]).toEqual([409, 'INVALID_STATE']);
    await user().patch(`/api/clips/${clip.id}`, { status: 'approved' });
    expect((await user().post(`/api/clips/${clip.id}/render`, { aspect: '4:3' })).status).toBe(400);
    expect((await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'neon' })).status).toBe(400);
    expect((await user().post(`/api/clips/${clip.id}/render`, { reframe_mode: 'face' })).status).toBe(400);
    expect((await user().post('/api/clips/9999/render', {})).status).toBe(404);
    // CUT_ACTIVE: tạo bản `rendering` giả trong DB
    env.ctx.db.prepare("INSERT INTO clip_cuts (clip_id, project_id, version, status, start_s, end_s, created_at) VALUES (?, ?, 1, 'rendering', 0, 5, 'x')").run(clip.id, clip.project_id);
    expect((await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' })).body.error.code).toBe('CUT_ACTIVE');
  });

  it('video gốc đã xoá → 409 SOURCE_DELETED; ổ đĩa không đủ → 507', async () => {
    const { s, clip } = await withClip();
    env.ctx.db.prepare('UPDATE source_videos SET deleted_at = ? WHERE id = ?').run('x', s.sourceId);
    expect((await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' })).body.error.code).toBe('SOURCE_DELETED');
    env.ctx.db.prepare('UPDATE source_videos SET deleted_at = NULL WHERE id = ?').run(s.sourceId);
    env.ctx.config.clipMinFreeGb = 1e9;
    const r = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    expect([r.status, r.body.error.code]).toEqual([507, 'INSUFFICIENT_STORAGE']);
    env.ctx.config.clipMinFreeGb = 0;
  });

  it('ffmpeg thiếu libass mà chọn phụ đề → 409 CAPTIONS_UNAVAILABLE với hướng dẫn; "Không phụ đề" vẫn dựng được', async () => {
    const e2 = await makeEnv({ config: { clipMinFreeGb: 0, clipFfmpegPath: '/khong/co/ffmpeg-libass' } });
    try {
      const s = seedClipProject(e2, { video: { seconds: 20 } });
      const c = userClient(e2.app);
      const clip = (await c.post(`/api/projects/${s.projectId}/clips`, { start_word: 0, end_word: 23 })).body.clip;
      if (captionSupport(e2.ctx).available) return; // máy có ffmpeg-full: ca này không áp dụng
      const r = await c.post(`/api/clips/${clip.id}/render`, { captions_preset: 'highlight' });
      expect([r.status, r.body.error.code]).toEqual([409, 'CAPTIONS_UNAVAILABLE']);
      expect(r.body.error.message).toMatch(/libass/);
      expect((await c.get('/api/clip-status')).body.captions.available).toBe(false);
      expect((await c.post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' })).status).toBe(201);
      await e2.ctx.finalRender!.idle();
    } finally {
      await thumbsIdle(e2.ctx);
      await e2.close();
    }
  });

  it('ffmpeg lỗi (video nguồn hỏng) → failed kèm thông báo, không để file dở', async () => {
    const { s, clip } = await withClip();
    fs.writeFileSync(path.join(env.root, s.sourceRel), 'không phải video');
    const r = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    expect(r.status).toBe(201);
    const cut = await cutOf(clip.id, 'failed');
    expect(cut.error).toBeTruthy();
    const dir = path.join(env.root, `output/${s.slug}/clips/clips`);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('hủy, khôi phục, hàng đợi', () => {
  it('hủy giữa chừng: ffmpeg bị dừng, trạng thái cancelled, xoá file dở (mp4 tạm, srt, ass); dựng lại được với version mới', async () => {
    const { s, clip } = await withClip({ seconds: 600, size: '1280x720', sw: 0, ew: 23 });
    // clip dài để render đủ lâu: sửa điểm cắt trực tiếp trong DB (60 s)
    env.ctx.db.prepare('UPDATE clips SET end_s = 120 WHERE id = ?').run(clip.id);
    const r = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: LIBASS ? 'highlight' : 'none' });
    expect(r.status).toBe(201);
    const running = await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut, (c) => c?.status === 'rendering' && (c.progress ?? 0) > 0, 60_000, 'tiến độ');
    expect(running).toMatchObject({ stage: 'render', queue_state: 'running', queue_position: null, running_count: 1, concurrency: 2 });
    const cancel = await user().post(`/api/clip-cuts/${running.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.cut).toMatchObject({ status: 'cancelled', video_url: null, error: null });
    await env.ctx.finalRender!.idle();
    const dir = path.join(env.root, `output/${s.slug}/clips/clips`);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect((await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut.status).toBe('cancelled');
    expect((await user().post(`/api/clip-cuts/${running.id}/cancel`)).status).toBe(409);
    // không còn tiến trình ffmpeg của bản dựng này
    const ps = spawnSync('ps', ['-A', '-o', 'command=']).stdout.toString();
    expect(ps.split('\n').filter((l) => l.includes(`K1_v1`) && l.includes('ffmpeg'))).toEqual([]);
    const again = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    expect(again.body.cut.version).toBe(2);
    await user().post(`/api/clip-cuts/${again.body.cut.id}/cancel`);
  }, 120_000);

  it('khởi động lại: bản đang rendering của tiến trình cũ → failed, dọn file dở; việc hoàn tất cũ giữ nguyên', async () => {
    const { s, clip } = await withClip();
    const dir = path.join(env.root, `output/${s.slug}/clips/clips`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.K1_v1.tmp.mp4'), 'dở');
    fs.writeFileSync(path.join(dir, 'K1_v1.srt'), 'dở');
    env.ctx.db.prepare("INSERT INTO clip_cuts (clip_id, project_id, version, status, stage, progress, start_s, end_s, created_at) VALUES (?, ?, 1, 'rendering', 'render', 50, 0, 5, 'x')").run(clip.id, clip.project_id);
    fs.writeFileSync(path.join(dir, 'K1_v2.mp4'), 'xong');
    env.ctx.db.prepare("INSERT INTO clip_cuts (clip_id, project_id, version, status, video_path, start_s, end_s, created_at) VALUES (?, ?, 2, 'ready', ?, 0, 5, 'x')").run(clip.id, clip.project_id, `output/${s.slug}/clips/clips/K1_v2.mp4`);
    const app2 = await env.second({ config: { clipMinFreeGb: 0, clipFfmpegPath: LIBASS } });
    const cuts = (await client(app2).get(`/api/clips/${clip.id}/cuts`)).body as any[];
    expect(cuts.map((c) => [c.version, c.status])).toEqual([[2, 'ready'], [1, 'failed']]);
    expect(cuts[1].error).toMatch(/khởi động lại/);
    expect(fs.readdirSync(dir).sort()).toEqual(['K1_v2.mp4']);
    await app2.close();
  });

  it('hàng đợi chung: concurrency 1 → bản thứ hai chờ (position 1) rồi chạy; app đứng trước LAN', async () => {
    const e2 = await makeEnv({ config: { clipMinFreeGb: 0, clipFfmpegPath: LIBASS, renderConcurrency: 1 } });
    try {
      const c = userClient(e2.app);
      const mk = async (name: string, lan = false) => {
        const s = seedClipProject(e2, { name, video: { seconds: 300, size: '960x540' }, lan });
        const clip = (await c.post(`/api/projects/${s.projectId}/clips`, { start_word: 0, end_word: 23 })).body.clip;
        e2.ctx.db.prepare('UPDATE clips SET end_s = 80 WHERE id = ?').run(clip.id);
        return clip;
      };
      const a = await mk('A');
      const b = await mk('B');
      const l = await mk('L', true);
      // LAN chen vào hàng đợi trước, rồi B của app: app phải đứng trước việc LAN đang chờ
      const ra = await c.post(`/api/clips/${a.id}/render`, { captions_preset: 'none' });
      e2.ctx.finalRender!.enqueueClipTask('clip', 99999, true, async () => undefined); // việc LAN giả đang chờ
      const rb = await c.post(`/api/clips/${b.id}/render`, { captions_preset: 'none' });
      void l;
      expect(ra.body.cut).toMatchObject({ queue_state: 'running', concurrency: 1 });
      expect(rb.body.cut).toMatchObject({ status: 'rendering', queue_state: 'waiting', queue_position: 1, running_count: 1 });
      expect(e2.ctx.finalRender!.queueInfo('clip', 99999)).toMatchObject({ state: 'waiting', position: 2 });
      await c.post(`/api/clip-cuts/${ra.body.cut.id}/cancel`);
      await waitFor(async () => (await c.get(`/api/clips/${b.id}`)).body.clip.latest_cut, (x) => x?.queue_state === 'running', 30_000, 'bản B chạy');
      await c.post(`/api/clip-cuts/${rb.body.cut.id}/cancel`);
      await e2.ctx.finalRender!.idle();
    } finally {
      await thumbsIdle(e2.ctx);
      await e2.close();
    }
  }, 120_000);

  it('không cho xoá dự án khi đang dựng; xoá được sau khi hủy', async () => {
    const { s, clip } = await withClip({ seconds: 300 });
    env.ctx.db.prepare('UPDATE clips SET end_s = 100 WHERE id = ?').run(clip.id);
    const r = await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    const blocked = await user().del(`/api/projects/${s.projectId}`, { confirm_name: 'Phiên live cacao' });
    expect([blocked.status, blocked.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
    expect(blocked.body.error.message).toMatch(/Đang dựng 1 clip/);
    expect((await user().get(`/api/clip-projects/${s.projectId}`)).body.delete_block).toMatchObject({ code: 'CLIP_ACTIVE' });
    await user().post(`/api/clip-cuts/${r.body.cut.id}/cancel`);
    await env.ctx.finalRender!.idle();
    expect((await user().del(`/api/projects/${s.projectId}`, { confirm_name: 'Phiên live cacao' })).status).toBe(200);
  }, 60_000);
});

describe.skipIf(!LIBASS)('cháy phụ đề (ffmpeg có libass)', () => {
  it('phụ đề cháy vào phần dưới khung, phần trên giữ nguyên (so khung có/không phụ đề bằng PSNR); .ass + .srt được ghi; font Arial', async () => {
    const { s, clip } = await withClip({ sw: 0, ew: 23 });
    await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' });
    await cutOf(clip.id);
    await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'highlight' });
    const cut2 = await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut, (c) => c?.version === 2 && c.status === 'ready', 60_000);
    expect(cut2.captions).toEqual({ preset: 'highlight' });
    const dir = path.join(env.root, `output/${s.slug}/clips/clips`);
    expect(fs.readdirSync(dir).sort()).toEqual(['K1_v1.mp4', 'K1_v1.srt', 'K1_v2.ass', 'K1_v2.mp4', 'K1_v2.srt']);
    const ass = fs.readFileSync(path.join(dir, 'K1_v2.ass'), 'utf8');
    expect(ass).toContain('Style: Default,Arial,72');
    expect(ass).toContain('{\\c&H00FFFF&}');
    const psnr = (crop: string): number => {
      const r = spawnSync(FF, ['-hide_banner', '-ss', '1', '-t', '2', '-i', path.join(dir, 'K1_v1.mp4'), '-ss', '1', '-t', '2', '-i', path.join(dir, 'K1_v2.mp4'), '-lavfi', `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]psnr`, '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /PSNR y:([\d.]+|inf)/.exec(r.stderr);
      return m ? (m[1] === 'inf' ? 100 : Number(m[1])) : NaN;
    };
    const top = psnr('crop=1080:900:0:0');
    const bottom = psnr('crop=1080:420:0:1300');
    expect(top).toBeGreaterThan(38); // phần trên gần như không đổi
    expect(bottom).toBeLessThan(top - 6); // phụ đề làm phần dưới khác rõ rệt
    // chữ trắng/vàng hiện ở vùng phụ đề của bản có phụ đề, không có ở bản không phụ đề
    const bright = (file: string): number => {
      const r = spawnSync(FF, ['-hide_banner', '-ss', '1.5', '-i', file, '-frames:v', '1', '-vf', 'crop=1080:300:0:1400,signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/lavfi\.signalstats\.YMAX=(\d+)/.exec(r.stderr)?.[1]);
    };
    expect(bright(path.join(dir, 'K1_v2.mp4'))).toBeGreaterThan(200);
  }, 120_000);

  it('chữ đã sửa tay vào ASS; ẩn từ; "Không phụ đề" không có .ass', async () => {
    const { s, clip } = await withClip({ sw: 0, ew: 23 });
    await user().put(`/api/clips/${clip.id}/captions`, { words: [{ i: 0, w: 'Cacao' }, { i: 1, w: '' }, { i: 2, w: '{\\an8}Actiso' }] });
    await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'karaoke' });
    await cutOf(clip.id);
    const dir = path.join(env.root, `output/${s.slug}/clips/clips`);
    const ass = fs.readFileSync(path.join(dir, 'K1_v1.ass'), 'utf8');
    expect(ass).toContain('Cacao');
    expect(ass).toContain('(/an8)Actiso');
    expect(ass).not.toMatch(/\{\\an8\}/);
    expect(ass).toContain('{\\c&H00FF00&}'); // karaoke xanh lá
    expect(fs.readFileSync(path.join(dir, 'K1_v1.srt'), 'utf8')).toContain('Cacao (/an8)Actiso');
  }, 120_000);
});
