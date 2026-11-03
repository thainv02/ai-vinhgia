import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { lanQueueLoad } from '../src/services/lan-queue.js';
import { listTrash } from '../src/services/trash.js';
import { userClient } from './helpers.js';
import { ffprobeJson } from './final-helpers.js';
import { libassFfmpeg, seedClipProject, sttConfig, startFakeStt, waitFor, type FakeStt } from './helpers-clips.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { clip as videoClip } from './helpers-video.js';

const LIBASS = await libassFfmpeg();
let fake: FakeStt;
let L: LanEnv;
let a: LanClient;
let b: LanClient;
beforeAll(async () => {
  fake = await startFakeStt();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.steps.length = 0;
  fake.fallback = 'ok';
  fake.calls.length = 0;
  fake.release();
  L = await makeLanEnv({ config: { ...sttConfig(fake), clipFfmpegPath: LIBASS, ...(LIBASS ? { ffmpegPath: LIBASS } : {}) } });
  a = L.client({ ip: '192.168.1.10' });
  b = L.client({ ip: '192.168.1.11' });
});
afterEach(async () => {
  fake.release();
  await L.env.ctx.finalRender?.idle();
  await thumbsIdle(L.env.ctx);
  await L.close();
});

const db = () => L.env.ctx.db;
const app = () => userClient(L.env.app);
const mkProject = async (c: LanClient, name = 'Live LAN', extra: Record<string, unknown> = {}) => {
  const r = await c.post('/lan/api/clip-projects', { name, created_by_name: 'Minh', ...extra });
  expect(r.status, r.raw).toBe(201);
  return r.body as any;
};
const upload = (c: LanClient, id: number, data: Buffer = videoClip(3), name = 'live.mp4') => c.uploadVideo(`/lan/api/projects/${id}/source`, { name, data });
const lanSource = async (c: LanClient, id: number) => (await c.get(`/lan/api/clip-projects/${id}`)).body.source;

describe('dự án cắt clip trên LAN', () => {
  it('tạo dự án (source=lan, cookie client), danh sách chỉ có dự án cắt clip của LAN, ai cũng xoá được (một người dùng); kế hoạch prompt và dự án app không lẫn vào', async () => {
    const d = await mkProject(a, 'Live tối');
    expect(d.project).toMatchObject({ name: 'Live tối', kind: 'clips', source: 'lan', created_by_name: 'Minh' });
    expect(d).toMatchObject({ can_delete: true, delete_block: null, source: null, clips: [], plan_job: null });
    expect(a.cookie).toMatch(/autovideo_lan_client=/);
    const other = await mkProject(b, 'Của B');
    const plan = (await a.post('/lan/api/plans', { name: 'Kế hoạch prompt', created_by_name: 'Minh' })).body.plan;
    const appProj = (await app().post('/api/clip-projects', { name: 'Của chủ máy' })).body.project;

    const list = (await a.get('/lan/api/clip-projects')).body as any[];
    expect(list.map((p) => p.name).sort()).toEqual(['Của B', 'Live tối']);
    expect(list.find((p) => p.name === 'Live tối')).toMatchObject({ kind: 'clips', source: 'lan', can_delete: true, clip_count: 0, source_video: null });
    expect(list.find((p) => p.name === 'Của B')!.can_delete).toBe(true);
    // /lan/api/plans không chứa dự án cắt clip
    expect(((await a.get('/lan/api/plans')).body as any[]).map((p) => p.name)).toEqual(['Kế hoạch prompt']);
    // cách ly theo loại và nguồn
    expect((await a.get(`/lan/api/clip-projects/${plan.id}`)).status).toBe(404);
    expect((await a.get(`/lan/api/plans/${d.project.id}`)).status).toBe(404);
    expect((await a.get(`/lan/api/clip-projects/${appProj.id}`)).status).toBe(404);
    expect((await upload(a, appProj.id)).status).toBe(404);
    expect((await a.get(`/lan/api/clip-projects/${other.project.id}`)).status).toBe(200); // mọi người trong LAN xem được
    expect((await a.get('/lan/api/projects')).status).toBe(404); // route app chính không có trên LAN
  });

  it('PATCH đổi tên/tên riêng; xoá → xoá vĩnh viễn (không thùng rác), kể cả dự án không có cookie người tạo; đường xoá kế hoạch cũng dùng được', async () => {
    const d = await mkProject(a, 'Sẽ xoá');
    const id = d.project.id;
    const renamed = await a.patch(`/lan/api/clip-projects/${id}`, { name: 'Tên mới', stt_terms: 'Cacao, Actiso' });
    expect(renamed.body.project).toMatchObject({ name: 'Tên mới', stt_terms: 'Cacao, Actiso', source: 'lan' });
    const del = await b.del(`/lan/api/clip-projects/${id}`);
    expect(del.status, del.raw).toBe(200);
    expect(del.body).toMatchObject({ ok: true, restorable_days: 0 });
    expect(db().prepare('SELECT id FROM projects WHERE id = ?').get(id)).toBeUndefined();
    expect((await a.get(`/lan/api/clip-projects/${id}`)).status).toBe(404);
    expect(((await a.get('/lan/api/clip-projects')).body as any[]).map((x) => x.id)).not.toContain(id);
    expect(listTrash(L.env.ctx).map((t) => t.id)).not.toContain(id);
    const d2 = await mkProject(a, 'Xoá qua kế hoạch');
    expect((await a.del(`/lan/api/plans/${d2.project.id}`)).status).toBe(200);
  });

});

describe('tải video nguồn trên LAN', () => {
  it('giới hạn riêng của LAN (≤ 2 GiB, ≤ 3 giờ), tự nhận dạng, bản xem thử 480p; video gốc KHÔNG được phục vụ qua LAN (app chính vẫn phục vụ có Range)', async () => {
    const d = await mkProject(a);
    const up = await upload(a, d.project.id);
    expect(up.status, up.raw).toBe(201);
    const s0 = up.body.source;
    expect(s0.status).toBe('transcribing');
    expect(s0.video_url).toBeNull(); // chưa có bản xem thử
    const slug = d.project.slug;
    await waitFor(() => lanSource(a, d.project.id), (s) => s?.status === 'transcribed' && !!s.video_url && !!s.poster_url, 30_000, 'nhận dạng + xem thử');
    const s = await lanSource(a, d.project.id);
    expect(s.video_url).toBe(`/lan/files/output/${slug}/clips/source/preview_480p.mp4`);
    expect(s.poster_url).toBe(`/lan/files/output/${slug}/clips/thumbs/poster.jpg`);
    const prev = ffprobeJson(path.join(L.env.root, `output/${slug}/clips/source/preview_480p.mp4`));
    const v = prev.streams.find((x: any) => x.codec_type === 'video');
    expect([v.codec_name, Math.min(v.width, v.height)]).toEqual(['h264', 480]);
    // LAN phục vụ bản xem thử + poster
    const pv = await a.get(s.video_url);
    expect(pv.status).toBe(200);
    expect((await a.get(s.poster_url)).status).toBe(200);
    // video gốc, transcript.json: KHÔNG qua LAN
    const srcRel = (db().prepare('SELECT path FROM source_videos').get() as any).path as string;
    expect((await a.get(`/lan/files/${srcRel}`)).status).toBe(404);
    expect((await a.get(`/lan/files/output/${slug}/clips/transcript.json`)).status).toBe(404);
    expect((await a.get(`/lan/files/output/${slug}/clips/source/.lan-upload-abc.tmp`)).status).toBe(404);
    // app chính phục vụ video gốc, Range hoạt động
    const r = await L.env.app.inject({ method: 'GET', url: `/files/${srcRel}`, headers: { host: 'localhost', range: 'bytes=0-99' } });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.length).toBe(100);
    // app chính: video_url là video gốc
    expect((await app().get(`/api/clip-projects/${d.project.id}`)).body.source.video_url).toBe(`/files/${srcRel}`);
  });

  it('kiểm tra trên LAN: quá dài theo giới hạn LAN, không phải video, không có tiếng; quá dung lượng → 413', async () => {
    const small = await makeLanEnv({ config: { ...sttConfig(fake), lanClipSourceMaxS: 2, lanClipSourceMaxBytes: 1_000_000 } });
    try {
      const c = small.client({ ip: '192.168.1.20' });
      const id = (await c.post('/lan/api/clip-projects', { name: 'x', created_by_name: 'M' })).body.project.id;
      const long = await c.uploadVideo(`/lan/api/projects/${id}/source`, { name: 'a.mp4', data: videoClip(3) });
      expect([long.status, long.body.error.code]).toEqual([422, 'VIDEO_DURATION']);
      expect((await c.uploadVideo(`/lan/api/projects/${id}/source`, { name: 'a.mp4', data: Buffer.from('chữ thường, không phải video') })).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    } finally {
      await small.close();
    }
    const tiny = await makeLanEnv({ config: { ...sttConfig(fake), lanClipSourceMaxBytes: 3000 } });
    try {
      const c = tiny.client({ ip: '192.168.1.21' });
      const id = (await c.post('/lan/api/clip-projects', { name: 'x', created_by_name: 'M' })).body.project.id;
      const big = await c.uploadVideo(`/lan/api/projects/${id}/source`, { name: 'a.mp4', data: videoClip(3) });
      expect([big.status, big.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    } finally {
      await tiny.close();
    }
  });

  it('tối đa 1 lượt tải đồng thời mỗi IP (429 UPLOAD_BUSY); IP khác vẫn tải được', async () => {
    const d1 = await mkProject(a, 'A1');
    const d2 = await mkProject(a, 'A2');
    const d3 = await mkProject(b, 'B1');
    const pass = new PassThrough();
    const data = videoClip(3);
    const slow = a.uploadVideo(`/lan/api/projects/${d1.project.id}/source`, { name: 'slow.mp4', data: pass, size: data.length });
    pass.write(data.subarray(0, 4096));
    await new Promise((r) => setTimeout(r, 150)); // chờ route nhận request và giữ cổng
    const busy = await upload(a, d2.project.id);
    expect([busy.status, busy.body.error.code]).toEqual([429, 'UPLOAD_BUSY']);
    expect((await upload(b, d3.project.id)).status).toBe(201);
    pass.end(data.subarray(4096));
    expect((await slow).status).toBe(201);
    // xong rồi thì tải tiếp được
    expect((await upload(a, d2.project.id)).status).toBe(201);
  });


});

describe('luồng cắt clip trên LAN và file được phục vụ', () => {
  it('AI chọn đoạn (hạn mức 6/giờ), duyệt/sửa (120/giờ), dựng, tải: URL qua /lan/files; allowlist chỉ preview, poster, ảnh clip, clip ready (mp4/srt); .ass, transcript, clip chưa ready, dự án khác → 404', async () => {
    const seeded = seedClipProject(L.env, { lan: true, video: { seconds: 40 }, clientHash: 'x' });
    const slug = seeded.slug;
    // gắn quyền sở hữu: tạo qua API để có cookie
    const mine = await mkProject(a, 'Của A');
    void mine;
    const other = seedClipProject(L.env, { lan: true, video: { seconds: 20 } });

    // chọn đoạn bằng AI: job vào hàng đợi, có queue; chạy lại được (không hạn mức theo giờ)
    const plan = await a.post(`/lan/api/projects/${seeded.projectId}/clip-plan`, { count: 2, duration_preset: '15_30' });
    expect(plan.status).toBe(201);
    expect(plan.body.job).toMatchObject({ status: 'queued', queue: { state: 'waiting' } });
    expect(lanQueueLoad(L.env.ctx).clips).toBe(1);
    db().prepare("UPDATE jobs SET status = 'cancelled' WHERE project_id = ?").run(seeded.projectId);
    expect((await a.post(`/lan/api/projects/${seeded.projectId}/clip-plan`, {})).status).toBe(201);
    db().prepare("UPDATE jobs SET status = 'cancelled' WHERE project_id = ?").run(seeded.projectId);

    // clip tay → dựng → ready
    const c1 = (await a.post(`/lan/api/projects/${seeded.projectId}/clips`, { start_word: 0, end_word: 23, title: 'Đoạn A' })).body.clip;
    await thumbsIdle(L.env.ctx);
    const got = (await a.get(`/lan/api/clips/${c1.id}`)).body.clip;
    expect(got.thumb_url).toMatch(new RegExp(`^/lan/files/output/${slug}/clips/thumbs/K1\\.jpg\\?v=\\d+$`));
    expect((await a.get(got.thumb_url.split('?')[0])).status).toBe(200);
    const rr = await a.post(`/lan/api/clips/${c1.id}/render`, { captions_preset: LIBASS ? 'highlight' : 'none' });
    expect(rr.status).toBe(201);
    const cut = await waitFor(async () => (await a.get(`/lan/api/clips/${c1.id}`)).body.clip.latest_cut, (c) => c?.status === 'ready', 60_000, 'bản dựng');
    expect(cut.video_url).toBe(`/lan/files/output/${slug}/clips/clips/K1_v1.mp4`);
    expect(cut.srt_url).toBe(`/lan/files/output/${slug}/clips/clips/K1_v1.srt`);
    expect((await a.get(cut.video_url)).status).toBe(200);
    expect((await a.get(cut.srt_url)).status).toBe(200);
    expect((await a.get(`/lan/files/output/${slug}/clips/clips/K1_v1.ass`)).status).toBe(404);
    expect((await a.get(`/lan/files/output/${slug}/clips/transcript.json`)).status).toBe(404);
    expect((await a.get(`/lan/files/${seeded.sourceRel}`)).status).toBe(404);
    expect((await a.get(`/lan/files/output/${slug}/clips/thumbs/../transcript.json`)).status).toBe(404);
    // file của bản dựng chưa ready không được phục vụ
    fs.writeFileSync(path.join(L.env.root, `output/${slug}/clips/clips/K1_v2.mp4`), 'dở');
    db().prepare("INSERT INTO clip_cuts (clip_id, project_id, version, status, video_path, start_s, end_s, created_at) VALUES (?, ?, 2, 'rendering', ?, 0, 5, 'x')").run(c1.id, seeded.projectId, `output/${slug}/clips/clips/K1_v2.mp4`);
    expect((await a.get(`/lan/files/output/${slug}/clips/clips/K1_v2.mp4`)).status).toBe(404);
    // dự án khác: không có clip ready nào; file thumbs của dự án app chính không phục vụ qua LAN
    const appSeed = seedClipProject(L.env, { video: { seconds: 10 } });
    fs.mkdirSync(path.join(L.env.root, `output/${appSeed.slug}/clips/thumbs`), { recursive: true });
    fs.writeFileSync(path.join(L.env.root, `output/${appSeed.slug}/clips/thumbs/K1.jpg`), 'x');
    expect((await a.get(`/lan/files/output/${appSeed.slug}/clips/thumbs/K1.jpg`)).status).toBe(404);
    expect((await a.get(`/files/output/${appSeed.slug}/clips/thumbs/K1.jpg`)).status).toBe(404); // LAN không có /files của app
    // ZIP
    const zip = await a.get(`/lan/api/projects/${seeded.projectId}/clips.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect((await a.get(`/lan/api/projects/${other.projectId}/clips.zip`)).status).toBe(404);
    expect((await a.patch(`/lan/api/clips/${c1.id}`, { title: 'Tên mới' })).status).toBe(200);
  }, 120_000);

  it('lỗi dựng trên LAN không lộ đường dẫn máy chủ; app chính thấy đủ', async () => {
    const s = seedClipProject(L.env, { lan: true, video: { seconds: 20 } });
    const c1 = (await a.post(`/lan/api/projects/${s.projectId}/clips`, { start_word: 0, end_word: 23 })).body.clip;
    db().prepare("INSERT INTO clip_cuts (clip_id, project_id, version, status, error, start_s, end_s, created_at) VALUES (?, ?, 1, 'failed', ?, 0, 5, 'x')").run(c1.id, s.projectId, 'ffmpeg thoát với mã 1: /Users/thainv/code/autovideo/output/x/a.mp4: Invalid data');
    db().prepare("UPDATE source_videos SET error = '/Users/thainv/x/y lỗi', status = 'failed' WHERE id = ?").run(s.sourceId);
    const lan = (await a.get(`/lan/api/clip-projects/${s.projectId}`)).body;
    expect(lan.clips[0].latest_cut.error).not.toContain('/Users');
    expect(lan.source.error).not.toContain('/Users');
    const appView = (await app().get(`/api/clip-projects/${s.projectId}`)).body;
    expect(appView.clips[0].latest_cut.error).toContain('/Users/thainv');
  });
});

