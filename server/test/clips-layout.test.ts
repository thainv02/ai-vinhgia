import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAss, captionLayoutSchema, layoutMargins, parseCaptionStyle, sameCaptionStyle, type CapWord } from '../src/services/clips/captions.js';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { FRAMES_KEEP } from '../src/services/clips/preview-frame.js';
import { buildFilterGraph, escapeFilterPath } from '../src/services/clips/render.js';
import { makeEnv, userClient, type Env } from './helpers.js';
import { FFMPEG, ffprobeJson } from './final-helpers.js';
import { libassFfmpeg, seedClipProject, waitFor } from './helpers-clips.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';

const LIBASS = libassFfmpeg();
const FF = LIBASS ?? FFMPEG!;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const WORDS: CapWord[] = ['Xin', 'chào', 'cả', 'nhà', 'hôm', 'nay', 'có', 'ưu', 'đãi', 'rất', 'lớn,', 'mua', 'ngay', 'nhé'].map((w, k) => ({ w, start: 10.15 + k * 0.4 + (k > 8 ? 0.5 : 0), end: 10.15 + k * 0.4 + 0.35 + (k > 8 ? 0.5 : 0) }));
const base = { font: 'Arial', clipStart: 10, clipEnd: 17 } as const;
/** Alignment, MarginL, MarginR, MarginV của dòng Style (4 cột trước Encoding). */
const margins = (ass: string): number[] => ass.split('\n').find((l) => l.startsWith('Style: Default,'))!.split(',').slice(-5, -1).map(Number);

describe('ASS: lề theo layout', () => {
  it('1080x1920: MarginL = left*W, MarginR = (1-left-width)*W, MarginV = bottom*H, alignment vẫn 2', () => {
    const a = buildAss(WORDS, { ...base, preset: 'highlight', width: 1080, height: 1920, layout: { left: 0.1, width: 0.8, bottom: 0.2 } });
    expect(margins(a)).toEqual([2, 108, 108, 384]);
    expect(a).toContain('WrapStyle: 0');
  });
  it('720x1280: lề tính theo độ phân giải đầu ra, làm tròn', () => {
    expect(margins(buildAss(WORDS, { ...base, preset: 'karaoke', width: 720, height: 1280, layout: { left: 0.25, width: 0.5, bottom: 0.15 } }))).toEqual([2, 180, 180, 192]);
    expect(margins(buildAss(WORDS, { ...base, preset: 'minimal', width: 720, height: 1280, layout: { left: 1 / 3, width: 0.4, bottom: 0.333 } }))).toEqual([2, 240, 192, 426]);
  });
  it('cực trị: width 1, left 0, bottom 0, bottom 0.9; left + width = 1 không sinh lề âm do sai số float', () => {
    expect(margins(buildAss(WORDS, { ...base, preset: 'highlight', width: 1080, height: 1920, layout: { left: 0, width: 1, bottom: 0 } }))).toEqual([2, 0, 0, 0]);
    expect(margins(buildAss(WORDS, { ...base, preset: 'highlight', width: 1080, height: 1920, layout: { left: 0.3, width: 0.7, bottom: 0.9 } }))).toEqual([2, 324, 0, 1728]);
    expect(layoutMargins({ left: 0.1, width: 0.9, bottom: 0 }, 1080, 1920).marginR).toBe(0);
    expect(layoutMargins({ left: 0.7, width: 0.3, bottom: 0 }, 1080, 1920).marginR).toBe(0);
  });
  it('layout chỉ đổi Style: Dialogue (thời gian, chữ, escape) giữ nguyên khi hộp đủ rộng', () => {
    const words = [{ w: 'a{b}\\c', start: 10.2, end: 10.5 }, ...WORDS.slice(1)];
    const dl = (s: string): string[] => s.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const without = buildAss(words, { ...base, preset: 'highlight', width: 1080, height: 1920 });
    const wide = buildAss(words, { ...base, preset: 'highlight', width: 1080, height: 1920, layout: { left: 0, width: 1, bottom: 0.2 } });
    expect(dl(without)[0]).toContain('a(b)/c');
    expect(dl(wide)).toEqual(dl(without));
  });
  it('hộp hẹp: ngắt dòng theo bề rộng hộp', () => {
    const w3: CapWord[] = ['Chúng', 'tôi', 'khuyến'].map((w, k) => ({ w, start: 10.2 + k * 0.3, end: 10.45 + k * 0.3 }));
    expect(buildAss(w3, { ...base, preset: 'highlight', width: 1080, height: 1920, layout: { left: 0.35, width: 0.3, bottom: 0.2 } })).toContain('\\N');
    expect(buildAss(w3, { ...base, preset: 'highlight', width: 1080, height: 1920, layout: { left: 0, width: 1, bottom: 0.2 } })).not.toContain('\\N');
  });
  it('mặc định (không layout) giống hệt bản trước khi có layout (băm SHA-256 lấy từ code cũ)', () => {
    const golden: Record<string, string> = {
      'highlight 1080 1920': '4c125fb9ea295a82',
      'highlight 720 1280': 'ca7e41b94894cb46',
      'highlight 1920 1080': 'b2bef62bbd7a7ffe',
      'karaoke 1080 1920': '3318bd8fa55c959a',
      'karaoke 720 1280': '287132622bdfbed5',
      'karaoke 1920 1080': 'd40d333d4187ebfa',
      'minimal 1080 1920': 'bdefe61349177c30',
      'minimal 720 1280': '1bd194407a208407',
      'minimal 1920 1080': 'bab7e887f58fb4ef',
    };
    for (const [k, h] of Object.entries(golden)) {
      const [preset, width, height] = k.split(' ') as [any, string, string];
      expect(sha(buildAss(WORDS, { ...base, preset, width: Number(width), height: Number(height) })), k).toBe(h);
      expect(sha(buildAss(WORDS, { ...base, preset, width: Number(width), height: Number(height), layout: null })), k + ' null').toBe(h);
    }
  });
});

describe('layout: kiểm tra và so sánh', () => {
  const ok = (l: unknown) => captionLayoutSchema.safeParse(l).success;
  it('zod từ chối ngoài khoảng, nhận đúng biên', () => {
    expect(ok({ left: 0, width: 0.25, bottom: 0 })).toBe(true);
    expect(ok({ left: 0.75, width: 0.25, bottom: 0.9 })).toBe(true);
    expect(ok({ left: 0, width: 1, bottom: 0.5 })).toBe(true);
    expect(ok({ left: -0.01, width: 0.5, bottom: 0.1 })).toBe(false);
    expect(ok({ left: 0.1, width: 0.24, bottom: 0.1 })).toBe(false);
    expect(ok({ left: 0.8, width: 0.25, bottom: 0.1 })).toBe(false);
    expect(ok({ left: 0.1, width: 0.5, bottom: 0.91 })).toBe(false);
    expect(ok({ left: 0.1, width: 0.5, bottom: -0.1 })).toBe(false);
    expect(ok({ left: 0.1, width: 1.2, bottom: 0.1 })).toBe(false);
    expect(ok({ left: '0.1', width: 0.5, bottom: 0.1 })).toBe(false);
    expect(ok({ left: Number.NaN, width: 0.5, bottom: 0.1 })).toBe(false);
    expect(ok({ left: 0.1, width: 0.5 })).toBe(false);
  });
  it('kiểu đã lưu hỏng hoặc ngoài khoảng thì về mặc định; so sánh bỏ qua sai số nhỏ', () => {
    expect(parseCaptionStyle(null)).toEqual({ preset: 'highlight', layout: null });
    expect(parseCaptionStyle('{không phải json')).toEqual({ preset: 'highlight', layout: null });
    expect(parseCaptionStyle('{"preset":"minimal","layout":{"left":5,"width":0.5,"bottom":0.1}}')).toEqual({ preset: 'minimal', layout: null });
    const a = { preset: 'highlight' as const, layout: { left: 0.1, width: 0.8, bottom: 0.2 } };
    expect(sameCaptionStyle(a, { ...a, layout: { left: 0.100001, width: 0.8, bottom: 0.2 } })).toBe(true);
    expect(sameCaptionStyle(a, { ...a, layout: { left: 0.11, width: 0.8, bottom: 0.2 } })).toBe(false);
    expect(sameCaptionStyle(a, { preset: 'highlight', layout: null })).toBe(false);
  });
});

describe('đường dẫn trong bộ lọc subtitles (Windows)', () => {
  it('đổi gạch chéo ngược thành /, escape dấu : của ổ đĩa; khoảng trắng và tiếng Việt giữ nguyên', () => {
    const p = 'C:\\Users\\Nguyễn Văn\\dự án 1\\.K1_x.ass';
    expect(escapeFilterPath(p, true)).toBe('C\\:/Users/Nguyễn Văn/dự án 1/.K1_x.ass');
    expect(escapeFilterPath('/a b/c.ass', false)).toBe('/a b/c.ass');
    expect(escapeFilterPath("C:\\it's.ass", true)).toBe("C\\:/it'\\''s.ass");
    if (process.platform === 'win32') {
      const { graph } = buildFilterGraph({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'fit', ass: { file: p, fontsDir: 'C:\\fonts dir' } });
      expect(graph).toContain("fontsdir='C\\:/fonts dir'");
      expect(graph).not.toContain('Users\\');
    }
  });
  it('ptsOffsetS chèn setpts trước subtitles; không có thì đồ thị như cũ', () => {
    const ass = { file: '/t/a.ass', fontsDir: null };
    expect(buildFilterGraph({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'native', ass, ptsOffsetS: 1.5 }).graph).toContain('[base]setpts=PTS+1.500/TB,subtitles=filename=');
    expect(buildFilterGraph({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'native', ass }).graph).toContain('[base]subtitles=filename=');
  });
});

// ---------------------------------------------------------------- API + ffmpeg thật

let env: Env;
beforeEach(async () => {
  env = await makeEnv({ config: { clipMinFreeGb: 0, clipFfmpegPath: LIBASS, ...(LIBASS ? { ffmpegPath: LIBASS } : {}) } });
});
afterEach(async () => {
  await env.ctx.finalRender?.idle();
  await thumbsIdle(env.ctx);
  await env.close();
});
const user = () => userClient(env.app);
const LAYOUT = { left: 0.1, width: 0.8, bottom: 0.4 };

async function withClip(o: { slug?: string } = {}) {
  const s = seedClipProject(env, { video: { seconds: 20, size: '640x360' } });
  if (o.slug) {
    // thư mục dự án có khoảng trắng và tiếng Việt: dời cây thư mục, cập nhật đường dẫn trong DB
    fs.renameSync(path.join(env.root, `output/${s.slug}`), path.join(env.root, `output/${o.slug}`));
    env.ctx.db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run(o.slug, s.projectId);
    env.ctx.db.prepare('UPDATE source_videos SET path = replace(path, ?, ?), transcript_path = replace(transcript_path, ?, ?) WHERE project_id = ?').run(s.slug, o.slug, s.slug, o.slug, s.projectId);
    s.slug = o.slug;
    s.sourceRel = s.sourceRel.replace(/^output\/[^/]+/, `output/${o.slug}`);
  }
  const r = await user().post(`/api/projects/${s.projectId}/clips`, { start_word: 0, end_word: 11, title: 'Đoạn thử' });
  expect(r.status, r.raw).toBe(201);
  return { s, clip: r.body.clip as any };
}
const clipOf = async (id: number) => (await user().get(`/api/clips/${id}`)).body.clip;
const cutReady = (id: number, version: number) => waitFor(async () => (await user().get(`/api/clips/${id}`)).body.clip, (c) => c.latest_cut?.version === version && c.latest_cut.status === 'ready', 60_000, `bản v${version}`);

describe.skipIf(!LIBASS)('lưu layout, dựng lại, đánh dấu cần dựng lại', () => {
  it('PATCH lưu layout và preset vào clip; layout sai thì 400 và không đổi gì; null về mặc định', async () => {
    const { clip } = await withClip();
    expect(clip.captions).toEqual({ preset: 'highlight', layout: null });
    for (const bad of [{ left: 0.8, width: 0.5, bottom: 0.1 }, { left: 0, width: 0.2, bottom: 0.1 }, { left: 0, width: 0.5, bottom: 0.95 }, { left: -1, width: 0.5, bottom: 0.1 }]) {
      expect((await user().patch(`/api/clips/${clip.id}`, { captions: { layout: bad } })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { preset: 'neon' } })).status).toBe(400);
    expect((await clipOf(clip.id)).captions).toEqual({ preset: 'highlight', layout: null });
    const ok = await user().patch(`/api/clips/${clip.id}`, { captions: { layout: LAYOUT, preset: 'karaoke' } });
    expect(ok.status).toBe(200);
    expect(ok.body.clip.captions).toEqual({ preset: 'karaoke', layout: LAYOUT });
    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { layout: { ...LAYOUT, left: 0 } } })).body.clip.captions).toEqual({ preset: 'karaoke', layout: { ...LAYOUT, left: 0 } });
    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { layout: null } })).body.clip.captions).toEqual({ preset: 'karaoke', layout: null });
  });

  it('đổi layout sau khi dựng thì captions_outdated; dựng lại dùng layout đã lưu và hết outdated; về mặc định lại outdated', async () => {
    const { s, clip } = await withClip();
    expect((await user().post(`/api/clips/${clip.id}/render`, { captions_layout: { left: 0.9, width: 0.5, bottom: 0 } })).status).toBe(400);

    expect((await user().post(`/api/clips/${clip.id}/render`, {})).status).toBe(201);
    const v1 = await cutReady(clip.id, 1);
    expect(v1.captions_outdated).toBe(false);
    expect(v1.latest_cut.captions).toEqual({ preset: 'highlight' }); // dạng cũ khi không có layout
    expect(fs.readFileSync(path.join(env.root, `output/${s.slug}/clips/clips/K1_v1.ass`), 'utf8')).toContain(',2,60,60,300,1');

    const patched = await user().patch(`/api/clips/${clip.id}`, { captions: { layout: LAYOUT } });
    expect(patched.body.clip.captions_outdated).toBe(true);
    expect(patched.body.clip.latest_cut.version).toBe(1);

    expect((await user().post(`/api/clips/${clip.id}/render`, {})).status).toBe(201);
    const v2 = await cutReady(clip.id, 2);
    expect(v2.captions_outdated).toBe(false);
    expect(v2.latest_cut.captions).toEqual({ preset: 'highlight', layout: LAYOUT });
    expect(fs.readFileSync(path.join(env.root, `output/${s.slug}/clips/clips/K1_v2.ass`), 'utf8')).toContain(',2,108,108,768,1');

    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { preset: 'minimal' } })).body.clip.captions_outdated).toBe(true);
    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { preset: 'highlight' } })).body.clip.captions_outdated).toBe(false);
    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { layout: null } })).body.clip.captions_outdated).toBe(true);
  }, 120_000);

  it('clip chưa dựng bản nào thì không outdated', async () => {
    const { clip } = await withClip();
    expect((await user().patch(`/api/clips/${clip.id}`, { captions: { layout: LAYOUT } })).body.clip.captions_outdated).toBe(false);
  });
});

const decodeGray = (jpg: string): Buffer => {
  const r = spawnSync(FF, ['-v', 'error', '-i', jpg, '-vf', 'scale=108:192', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 });
  expect(r.status).toBe(0);
  return r.stdout;
};
/** Trọng tâm dọc (0 = đỉnh, 1 = đáy) của các điểm ảnh khác nhau giữa hai khung. */
const diffCentroidY = (a: Buffer, b: Buffer): number => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > 60) {
      sum += Math.floor(i / 108) / 192;
      n++;
    }
  }
  return n ? sum / n : NaN;
};
const urlToFile = (url: string): string => path.join(env.root, ...decodeURIComponent(url.replace(/^\/(lan\/)?files\//, '')).split('/'));

describe.skipIf(!LIBASS)('xem thử một khung hình (ffmpeg thật)', () => {
  it('ra jpg 1080x1920 có phụ đề; vị trí chữ đổi theo layout; thư mục dự án có khoảng trắng và tiếng Việt vẫn chạy', async () => {
    const { clip } = await withClip({ slug: 'dự án thử nghiệm 1' });
    const shot = async (body: object) => {
      const r = await user().post(`/api/clips/${clip.id}/preview-frame`, { at: 1.2, ...body });
      expect(r.status, r.raw).toBe(200);
      expect(r.body.url).toMatch(/^\/files\/output\/d%E1%BB%B1%20%C3%A1n%20th%E1%BB%AD%20nghi%E1%BB%87m%201\/clips\/frames\/K1_[a-z0-9]+\.jpg$/);
      const file = urlToFile(r.body.url);
      expect(fs.readFileSync(file).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      const v = ffprobeJson(file).streams[0];
      expect([v.width, v.height]).toEqual([1080, 1920]);
      return file;
    };
    const none = await shot({ captions: { preset: 'none' } });
    const low = await shot({ captions: { layout: { left: 0.05, width: 0.9, bottom: 0.05 } } });
    const high = await shot({ captions: { layout: { left: 0.05, width: 0.9, bottom: 0.75 } } });
    const def = await shot({});
    const g = [none, low, high, def].map(decodeGray);
    const yLow = diffCentroidY(g[0]!, g[1]!);
    const yHigh = diffCentroidY(g[0]!, g[2]!);
    const yDef = diffCentroidY(g[0]!, g[3]!);
    expect(yLow).toBeGreaterThan(0.85);
    expect(yHigh).toBeLessThan(0.3);
    expect(yDef).toBeGreaterThan(0.7);
    expect(yDef).toBeLessThan(yLow);
  }, 90_000);

  it('layout chưa lưu chỉ để xem thử, không ghi vào clip; tham số sai 400; clip lạ 404', async () => {
    const { clip } = await withClip();
    const pr = await user().post(`/api/clips/${clip.id}/preview-frame`, { at: 1, captions: { layout: LAYOUT } });
    expect(pr.status, pr.raw).toBe(200);
    expect((await clipOf(clip.id)).captions.layout).toBeNull();
    expect((await user().post(`/api/clips/${clip.id}/preview-frame`, { at: -1 })).status).toBe(400);
    expect((await user().post(`/api/clips/${clip.id}/preview-frame`, { captions: { layout: { left: 0.9, width: 0.5, bottom: 0 } } })).status).toBe(400);
    expect((await user().post('/api/clips/9999/preview-frame', {})).status).toBe(404);
  });

  it('chỉ giữ vài ảnh gần nhất, ASS tạm bị xoá; yêu cầu bị thay trả 409 PREVIEW_STALE còn yêu cầu mới thành công', async () => {
    const { s, clip } = await withClip();
    const dir = path.join(env.root, `output/${s.slug}/clips/frames`);
    const urls = new Set<string>();
    for (let i = 0; i < FRAMES_KEEP + 3; i++) {
      const r = await user().post(`/api/clips/${clip.id}/preview-frame`, { at: 1 + i * 0.1 });
      expect(r.status).toBe(200);
      urls.add(r.body.url);
    }
    expect(urls.size).toBe(FRAMES_KEEP + 3);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).length).toBeLessThanOrEqual(FRAMES_KEEP);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.ass'))).toEqual([]);
    const [first, second] = await Promise.all([user().post(`/api/clips/${clip.id}/preview-frame`, { at: 1 }), user().post(`/api/clips/${clip.id}/preview-frame`, { at: 2 })]);
    expect(second.status, second.raw).toBe(200);
    expect([200, 409]).toContain(first.status);
    if (first.status === 409) expect(first.body.error.code).toBe('PREVIEW_STALE');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.ass'))).toEqual([]);
  }, 90_000);

  it('video hỏng thì lỗi gọn, không để ảnh hoặc ASS dở', async () => {
    const { s, clip } = await withClip();
    fs.writeFileSync(path.join(env.root, s.sourceRel), 'không phải video');
    const r = await user().post(`/api/clips/${clip.id}/preview-frame`, { at: 1 });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const dir = path.join(env.root, `output/${s.slug}/clips/frames`);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });
});

describe.skipIf(!LIBASS)('xem thử trên LAN', () => {
  let L: LanEnv;
  afterEach(async () => {
    await L?.env.ctx.finalRender?.idle();
    await L?.close();
  });
  it('dự án LAN xem thử được, ảnh phục vụ qua /lan/files; dự án app thì 404 trên LAN', async () => {
    L = await makeLanEnv({ config: { clipMinFreeGb: 0, clipFfmpegPath: LIBASS, ffmpegPath: LIBASS! } });
    const c = L.client({ ip: '192.168.1.10' });
    await c.login();
    const lanSeed = seedClipProject(L.env, { lan: true, video: { seconds: 20 } });
    const created = await c.post(`/lan/api/projects/${lanSeed.projectId}/clips`, { start_word: 0, end_word: 11 });
    expect(created.status, created.raw).toBe(201);
    const r = await c.post(`/lan/api/clips/${created.body.clip.id}/preview-frame`, { at: 1, captions: { layout: LAYOUT } });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.url).toMatch(/^\/lan\/files\/output\/[^/]+\/clips\/frames\/K1_[a-z0-9]+\.jpg$/);
    expect((await c.get(r.body.url)).status).toBe(200);
    expect((await c.get(r.body.url.replace(/K1_[a-z0-9]+\.jpg$/, '.x.ass'))).status).toBe(404);

    const appSeed = seedClipProject(L.env, { video: { seconds: 20 } });
    const appClip = (await userClient(L.env.app).post(`/api/projects/${appSeed.projectId}/clips`, { start_word: 0, end_word: 11 })).body.clip;
    expect((await c.post(`/lan/api/clips/${appClip.id}/preview-frame`, {})).status).toBe(404);
  }, 90_000);
});
