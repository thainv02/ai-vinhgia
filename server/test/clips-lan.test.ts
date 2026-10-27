import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LAN_RATE } from '../src/lan/routes.js';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { expireClipSources } from '../src/services/clips/source.js';
import { lanQueueLoad } from '../src/services/lan-queue.js';
import { listTrash, restoreProject } from '../src/services/trash.js';
import { userClient } from './helpers.js';
import { ffprobeJson } from './final-helpers.js';
import { libassFfmpeg, seedClipProject, sttConfig, startFakeStt, waitFor, type FakeStt } from './helpers-clips.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { clip as videoClip } from './helpers-video.js';

const LIBASS = libassFfmpeg();
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
  await a.login();
  await b.login();
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
  it('tạo dự án (source=lan, cookie client), danh sách chỉ có dự án cắt clip của LAN, can_delete theo cookie; kế hoạch prompt và dự án app không lẫn vào', async () => {
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
    expect(list.find((p) => p.name === 'Của B')!.can_delete).toBe(false);
    // /lan/api/plans không chứa dự án cắt clip
    expect(((await a.get('/lan/api/plans')).body as any[]).map((p) => p.name)).toEqual(['Kế hoạch prompt']);
    // cách ly theo loại và nguồn
    expect((await a.get(`/lan/api/clip-projects/${plan.id}`)).status).toBe(404);
    expect((await a.get(`/lan/api/plans/${d.project.id}`)).status).toBe(404);
    expect((await a.get(`/lan/api/clip-projects/${appProj.id}`)).status).toBe(404);
    expect((await upload(a, appProj.id)).status).toBe(404);
    expect((await a.get(`/lan/api/clip-projects/${other.project.id}`)).status).toBe(200); // mọi người trong LAN xem được
    expect((await a.get('/lan/api/projects')).status).toBe(404); // route app chính không có trên LAN
    // GET /api/lan: đếm riêng
    expect((await app().get('/api/lan')).body).toMatchObject({ plan_count: 1, clip_project_count: 2 });
  });

  it('PATCH đổi tên/tên riêng; xoá bởi người tạo (cookie) → thùng rác (deleted_by=lan), người khác → 403; khôi phục được', async () => {
    const d = await mkProject(a, 'Sẽ xoá');
    const id = d.project.id;
    const renamed = await a.patch(`/lan/api/clip-projects/${id}`, { name: 'Tên mới', stt_terms: 'Cacao, Actiso' });
    expect(renamed.body.project).toMatchObject({ name: 'Tên mới', stt_terms: 'Cacao, Actiso', source: 'lan' });
    const forbidden = await b.del(`/lan/api/clip-projects/${id}`);
    expect([forbidden.status, forbidden.body.error.code]).toEqual([403, 'NOT_PLAN_OWNER']);
    const del = await a.del(`/lan/api/clip-projects/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ ok: true, restorable_days: 30 });
    expect(db().prepare('SELECT deleted_by FROM projects WHERE id = ?').get(id)).toEqual({ deleted_by: 'lan' });
    expect((await a.get(`/lan/api/clip-projects/${id}`)).status).toBe(404);
    expect(((await a.get('/lan/api/clip-projects')).body as any[]).map((x) => x.id)).not.toContain(id);
    expect(listTrash(L.env.ctx).map((t) => t.id)).toContain(id);
    restoreProject(L.env.ctx, id);
    expect((await a.get(`/lan/api/clip-projects/${id}`)).status).toBe(200);
    // đường xoá chung của kế hoạch cũng dùng được cho dự án cắt clip
    expect((await a.del(`/lan/api/plans/${id}`)).status).toBe(200);
  });

  it('hạn mức tạo dự án 10/giờ/IP: lần 11 → 429 kèm Retry-After; /lan/api/status có remaining.clip_*, clip và rate', async () => {
    for (let i = 0; i < LAN_RATE.clipProject.max; i++) await mkProject(a, `P${i}`);
    const r = await a.post('/lan/api/clip-projects', { name: 'Thừa', created_by_name: 'Minh' });
    expect([r.status, r.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    const st = (await a.get('/lan/api/status')).body;
    expect(st.remaining).toMatchObject({ clip_project: 0, clip_source: 3, clip_plan: 6, clip_render: 30, clip_edit: 120 });
    expect(st.rate).toMatchObject({ clipProject: { max: 10 }, clipSource: { max: 3 }, clipPlan: { max: 6 }, clipRender: { max: 30 }, clipEdit: { max: 120 } });
    expect(st.clip).toMatchObject({ max_bytes: 2 * 1024 ** 3, max_s: 10_800, retention_days: 7, stt: { configured: true }, plan: { max_count: 15 } });
    expect(st.queue).toMatchObject({ clips: 0 });
    expect((await b.get('/lan/api/status')).body.remaining.clip_project).toBe(10); // theo IP
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
      await c.login();
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
      await c.login();
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

  it('3 nguồn/giờ/IP: lần 4 → 429; chỉ lượt thành công mới tính', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await mkProject(a, `P${i}`)).project.id);
    expect((await upload(a, ids[0]!, Buffer.from('không phải video'))).status).toBe(415); // lỗi không tính
    for (let i = 0; i < 3; i++) expect((await upload(a, ids[i]!)).status, `lần ${i + 1}`).toBe(201);
    const r = await upload(a, ids[3]!);
    expect([r.status, r.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect((await a.get('/lan/api/status')).body.remaining.clip_source).toBe(0);
  });

  it('trần hàng đợi LAN (6) tính cả việc cắt clip: đầy thì tải/AI/dựng đều 429 QUEUE_FULL; việc của app chính không bị chặn', async () => {
    const d = await mkProject(a);
    const seeded = seedClipProject(L.env, { lan: true, video: { seconds: 10 } });
    const now = L.env.ctx.now();
    for (let i = 0; i < 6; i++) db().prepare("INSERT INTO lan_tool_jobs (kind, status, original_name, client_id_hash, meta, created_at) VALUES ('remove_logo', 'queued', 'x.mp4', 'h', '{}', ?)").run(now);
    expect(lanQueueLoad(L.env.ctx)).toMatchObject({ tools: 6, clips: 0, total: 6, cap: 6 });
    const r = await upload(a, d.project.id);
    expect([r.status, r.body.error.code]).toEqual([429, 'QUEUE_FULL']);
    expect((await a.post(`/lan/api/projects/${seeded.projectId}/clip-plan`, {})).body.error.code).toBe('QUEUE_FULL');
    const c1 = (await a.post(`/lan/api/projects/${seeded.projectId}/clips`, { start_word: 0, end_word: 23 })).body.clip;
    expect((await a.post(`/lan/api/clips/${c1.id}/render`, { captions_preset: 'none' })).body.error.code).toBe('QUEUE_FULL');
    db().prepare("UPDATE lan_tool_jobs SET status = 'ready'").run();
    expect(lanQueueLoad(L.env.ctx).total).toBe(0);
    const ok = await a.post(`/lan/api/clips/${c1.id}/render`, { captions_preset: 'none' });
    expect(ok.status).toBe(201);
    expect(lanQueueLoad(L.env.ctx).clips).toBe(1); // bản đang dựng tính vào trần
    await a.post(`/lan/api/clip-cuts/${ok.body.cut.id}/cancel`);
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

    // chọn đoạn bằng AI: job vào hàng đợi, có queue; quá hạn mức → 429
    const plan = await a.post(`/lan/api/projects/${seeded.projectId}/clip-plan`, { count: 2, duration_preset: '15_30' });
    expect(plan.status).toBe(201);
    expect(plan.body.job).toMatchObject({ status: 'queued', queue: { state: 'waiting' } });
    expect(lanQueueLoad(L.env.ctx).clips).toBe(1);
    for (let i = 0; i < LAN_RATE.clipPlan.max - 1; i++) {
      db().prepare("UPDATE jobs SET status = 'cancelled' WHERE project_id = ?").run(seeded.projectId);
      expect((await a.post(`/lan/api/projects/${seeded.projectId}/clip-plan`, {})).status, `plan ${i + 2}`).toBe(201);
    }
    db().prepare("UPDATE jobs SET status = 'cancelled' WHERE project_id = ?").run(seeded.projectId);
    const over = await a.post(`/lan/api/projects/${seeded.projectId}/clip-plan`, {});
    expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);

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
    // sửa: hạn mức 120/giờ (đã dùng 1 lần tạo clip)
    for (let i = 0; i < 119; i++) expect((await a.patch(`/lan/api/clips/${c1.id}`, { title: `Tên ${i}` })).status, `sửa ${i + 1}`).toBe(200);
    const edits = await a.patch(`/lan/api/clips/${c1.id}`, { title: 'Quá hạn mức' });
    expect([edits.status, edits.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect((await a.put(`/lan/api/clips/${c1.id}/captions`, { words: [{ i: 0, w: 'X' }] })).status).toBe(429);
    expect((await b.patch(`/lan/api/clips/${c1.id}`, { title: 'IP khác vẫn sửa được' })).status).toBe(200);
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

describe('hạn lưu video nguồn LAN', () => {
  it('quá LAN_CLIP_SOURCE_RETENTION_DAYS ngày: xoá video gốc, giữ transcript/xem thử/clip; status vẫn transcribed kèm source_deleted; không dựng/chọn đoạn mới; dự án app không bị đụng', async () => {
    const lanSeed = seedClipProject(L.env, { lan: true, video: { seconds: 20 } });
    const appSeed = seedClipProject(L.env, { video: { seconds: 20 } });
    const young = seedClipProject(L.env, { lan: true, video: { seconds: 20 } });
    const busy = seedClipProject(L.env, { lan: true, video: { seconds: 20 } });
    const old = new Date(L.env.clock.now() - 8 * 86_400_000).toISOString();
    for (const x of [lanSeed, appSeed, busy]) db().prepare('UPDATE source_videos SET created_at = ? WHERE id = ?').run(old, x.sourceId);
    db().prepare("UPDATE source_videos SET status = 'transcribing' WHERE id = ?").run(busy.sourceId);
    const c1 = (await a.post(`/lan/api/projects/${lanSeed.projectId}/clips`, { start_word: 0, end_word: 23 })).body.clip;
    const rr = await a.post(`/lan/api/clips/${c1.id}/render`, { captions_preset: 'none' });
    const cut = await waitFor(async () => (await a.get(`/lan/api/clips/${c1.id}`)).body.clip.latest_cut, (c) => c?.status === 'ready', 60_000);
    void rr;
    fs.mkdirSync(path.join(L.env.root, `output/${lanSeed.slug}/clips/source`), { recursive: true });
    fs.writeFileSync(path.join(L.env.root, `output/${lanSeed.slug}/clips/source/preview_480p.mp4`), 'xem thử');
    const r = expireClipSources(L.env.ctx);
    expect(r.expired).toBe(1);
    expect(fs.existsSync(path.join(L.env.root, lanSeed.sourceRel))).toBe(false);
    expect(fs.existsSync(path.join(L.env.root, appSeed.sourceRel))).toBe(true); // app chính giữ đến khi xoá dự án
    expect(fs.existsSync(path.join(L.env.root, young.sourceRel))).toBe(true);
    expect(fs.existsSync(path.join(L.env.root, busy.sourceRel))).toBe(true); // đang nhận dạng: bỏ qua
    expect(fs.existsSync(path.join(L.env.root, `output/${lanSeed.slug}/clips/transcript.json`))).toBe(true);
    expect(fs.existsSync(path.join(L.env.root, `output/${lanSeed.slug}/clips/source/preview_480p.mp4`))).toBe(true);
    const s = await lanSource(a, lanSeed.projectId);
    expect(s).toMatchObject({ status: 'transcribed', source_deleted: true });
    expect(s.video_url).toBe(`/lan/files/output/${lanSeed.slug}/clips/source/preview_480p.mp4`);
    expect(await a.get(cut.video_url).then((x) => x.status)).toBe(200); // clip đã dựng vẫn tải được
    // transcript vẫn xem được; không dựng/chọn đoạn mới
    expect((await a.get(`/lan/api/sources/${s.id}/transcript?from=0&limit=5`)).status).toBe(200);
    const r2 = await a.post(`/lan/api/clips/${c1.id}/render`, { captions_preset: 'none' });
    expect([r2.status, r2.body.error.code]).toEqual([409, 'SOURCE_DELETED']);
    expect((await a.post(`/lan/api/projects/${lanSeed.projectId}/clip-plan`, {})).body.error.code).toBe('SOURCE_DELETED');
    expect((await a.post(`/lan/api/sources/${s.id}/transcribe`)).body.error.code).toBe('SOURCE_DELETED');
    // chạy lại không xoá thêm
    expect(expireClipSources(L.env.ctx).expired).toBe(0);
    // app chính vẫn thấy source_deleted
    expect((await app().get(`/api/clip-projects/${lanSeed.projectId}`)).body.source).toMatchObject({ source_deleted: true, video_url: null });
  }, 120_000);

  it('dọn file tải dở quá 1 giờ trong clips/source', async () => {
    const s = seedClipProject(L.env, { lan: true, video: false });
    const dir = path.join(L.env.root, `output/${s.slug}/clips/source`);
    const stale = path.join(dir, '.lan-upload-abc123.tmp');
    const fresh = path.join(dir, '.lan-upload-def456.tmp');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const t = (Date.now() - 2 * 3600_000) / 1000;
    fs.utimesSync(stale, t, t);
    expect(expireClipSources(L.env.ctx).staleTmp).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
