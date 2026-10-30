import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { client, makeEnv, multipart, setupProject, userClient, type Env } from './helpers.js';
import { seedClipProject, speechWords, sttConfig, startFakeStt, waitFor, type FakeStt } from './helpers-clips.js';
import { clip, movOf } from './helpers-video.js';

let fake: FakeStt;
let env: Env;
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
  fake.polls.length = 0;
  fake.jobHasWords = true;
  fake.pollRunning = 0;
  fake.release();
  env = await makeEnv({ config: sttConfig(fake) });
});
afterEach(async () => {
  fake.release();
  await thumbsIdle(env.ctx);
  await env.close();
});

const u = () => userClient(env.app);
const uploadTo = (id: number, data: Buffer, name = 'live.mp4', type = 'video/mp4') => {
  const m = multipart([{ name: 'file', filename: name, data, type }]);
  return env.app.inject({ method: 'POST', url: `/api/projects/${id}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) as any }));
};
const mkProject = async (extra: Record<string, unknown> = {}) => (await u().post('/api/clip-projects', { name: 'Live cacao', ...extra })).body.project.id as number;
const source = async (pid: number) => (await u().get(`/api/clip-projects/${pid}`)).body.source;
const settled = (pid: number, status = 'transcribed') => waitFor(() => source(pid), (s) => s?.status === status, 20_000, `video ${status}`);

describe('dự án cắt clip', () => {
  it('POST /api/clip-projects → 201 ClipProjectDetail; danh sách /api/projects có kind', async () => {
    const r = await u().post('/api/clip-projects', { name: '  Live cacao tối  ', stt_terms: 'Cacao, Actiso' });
    expect(r.status).toBe(201);
    expect(r.body.project).toMatchObject({ name: 'Live cacao tối', kind: 'clips', source: 'app', stt_terms: 'Cacao, Actiso', created_by_name: null });
    expect(typeof r.body.project.slug).toBe('string');
    expect(r.body).toMatchObject({ source: null, clips: [], plan_job: null, delete_block: null });
    const sc = await setupProject(env, { scenes: 1 });
    const list = (await u().get('/api/projects')).body as any[];
    expect(list.find((p) => p.id === sc.project.id).kind).toBe('scenes');
    const mine = list.find((p) => p.id === r.body.project.id);
    expect(mine).toMatchObject({ kind: 'clips', clip_count: 0, source_video: null, stt_terms: 'Cacao, Actiso' });
  });

  it('GET/PATCH: đổi tên và tên riêng; dự án kind=scenes trả 404 ở các route cắt clip; thiếu tên → 400', async () => {
    const id = await mkProject();
    const g = await u().get(`/api/clip-projects/${id}`);
    expect(g.status).toBe(200);
    const p = await u().patch(`/api/clip-projects/${id}`, { name: 'Tên mới', stt_terms: 'A, B' });
    expect(p.body.project).toMatchObject({ name: 'Tên mới', stt_terms: 'A, B' });
    expect((await u().patch(`/api/clip-projects/${id}`, { stt_terms: '' })).body.project.stt_terms).toBeNull();
    const sc = await setupProject(env, { scenes: 1 });
    expect((await u().get(`/api/clip-projects/${sc.project.id}`)).status).toBe(404);
    expect((await uploadTo(sc.project.id, clip(3))).status).toBe(404);
    expect((await u().post('/api/clip-projects', { name: '' })).status).toBe(400);
    expect((await u().post('/api/clip-projects', { name: 'x', stt_terms: 'a'.repeat(501) })).status).toBe(400);
  });
});

describe('tải video nguồn và nhận dạng lời nói (STT giả)', () => {
  it('tải lên → transcribing → transcribed; transcript.json, SRT/TXT, trang transcript, tên riêng gửi đi', async () => {
    const id = await mkProject({ stt_terms: 'Cacao, Actiso' });
    const up = await uploadTo(id, clip(3));
    expect(up.status).toBe(201);
    const s0 = up.body.source;
    expect(s0).toMatchObject({ original_name: 'live.mp4', status: 'transcribing', width: 160, height: 284, queue: { state: expect.stringMatching(/waiting|running/) } });
    expect(s0.video_url).toMatch(/^\/files\/output\/live-cacao\/clips\/source\/[0-9a-f]{16}\.mp4$/);
    expect(s0.duration_s).toBeGreaterThan(2.5);
    const done = await settled(id);
    expect(done).toMatchObject({ status: 'transcribed', progress: 100, error: null, error_code: null, word_count: fake.words.length, queue: { state: null, position: null } });
    expect(done.speech_ratio).toBeGreaterThan(0);
    expect(fake.calls[0]).toMatchObject({ prompt: 'Cacao, Actiso', tenant: 's-omnix-studio' });
    const row = env.ctx.db.prepare('SELECT * FROM source_videos').get() as any;
    expect(row.transcript_path).toBe('output/live-cacao/clips/transcript.json');
    expect(JSON.parse(row.stt_meta)).toMatchObject({ model: 'gipformer1.5-68M-rnnt', word_count: fake.words.length, terms: 'Cacao, Actiso' });
    expect(fs.existsSync(path.join(env.root, row.transcript_path))).toBe(true);
    expect(fs.readdirSync(path.join(env.root, 'output/live-cacao/clips')).filter((f) => f.startsWith('.stt-'))).toEqual([]); // audio tạm đã xoá

    const page = (await u().get(`/api/sources/${done.id}/transcript?from=0&limit=1`)).body;
    expect(page.total).toBe(2);
    expect(page.sentences).toHaveLength(1);
    expect(page.sentences[0].words[0]).toMatchObject({ i: 0, w: 'xin' });
    expect((await u().get(`/api/sources/${done.id}/transcript?from=1&limit=10`)).body.sentences[0].id).toBe(1);
    expect((await u().get(`/api/sources/${done.id}/transcript?from=-1`)).status).toBe(400);
    const srt = await u().get(`/api/sources/${done.id}/transcript.srt`);
    expect(srt.headers['content-disposition']).toContain('transcript-live-cacao.srt');
    expect(srt.raw).toContain('Xin chào cả nhà hôm nay có ưu đãi');
    const txt = await u().get(`/api/sources/${done.id}/transcript.txt`);
    expect(txt.raw).toMatch(/^\[00:00:00\] Xin chào/);
  });

  it('tải lại ĐÚNG file đó trong dự án → dùng lại (cùng source id, không nhận dạng lại)', async () => {
    const id = await mkProject();
    const a = await uploadTo(id, clip(3));
    await settled(id);
    const b = await uploadTo(id, clip(3));
    expect(b.status).toBe(201);
    expect(b.body.source.id).toBe(a.body.source.id);
    expect(b.body.source.status).toBe('transcribed');
    expect(fake.calls.length).toBe(1);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM source_videos').get()).toEqual({ n: 1 });
  });

  it('cache theo content_hash + tên riêng: dự án khác tải cùng file + cùng tên riêng → không gọi dịch vụ lại; đổi tên riêng thì gọi lại', async () => {
    const a = await mkProject({ stt_terms: 'Cacao' });
    await uploadTo(a, clip(3));
    await settled(a);
    expect(fake.calls.length).toBe(1);
    // Simulate a pre-fix cache entry. Reuse ASR, measure pauses locally for the new project,
    // and leave the old project's IDs/file untouched.
    const sa = await source(a);
    const oldRel = (env.ctx.db.prepare('SELECT transcript_path FROM source_videos WHERE id = ?').get(sa.id) as any).transcript_path;
    const oldPath = path.join(env.root, oldRel);
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    delete old.pauses; delete old.pause_detect;
    const oldContent = JSON.stringify(old);
    fs.writeFileSync(oldPath, oldContent);
    const b = await mkProject({ stt_terms: 'Cacao' });
    await uploadTo(b, clip(3));
    const sb = await settled(b);
    expect(fake.calls.length).toBe(1);
    expect(JSON.parse((env.ctx.db.prepare('SELECT stt_meta FROM source_videos WHERE id = ?').get(sb.id) as any).stt_meta).cached).toBe(true);
    const newRel = (env.ctx.db.prepare('SELECT transcript_path FROM source_videos WHERE id = ?').get(sb.id) as any).transcript_path;
    expect(JSON.parse(fs.readFileSync(path.join(env.root, newRel), 'utf8')).pauses).toEqual(expect.any(Array));
    expect(fs.readFileSync(oldPath, 'utf8')).toBe(oldContent);
    const c = await mkProject({ stt_terms: 'Actiso' });
    await uploadTo(c, clip(3));
    await settled(c);
    expect(fake.calls.length).toBe(2);
  });

  it('kiểm tra: không phải video 415; không có tiếng 422; quá dài 422; quá lớn 413; ổ đĩa không đủ 507', async () => {
    const id = await mkProject();
    const bad = await uploadTo(id, Buffer.from('đây không phải video, chỉ là chữ'), 'a.mp4');
    expect([bad.status, bad.body.error.code]).toEqual([415, 'UNSUPPORTED_FILE_TYPE']);
    const mute = await uploadTo(id, clip(3, { audio: false }));
    expect([mute.status, mute.body.error.code]).toEqual([422, 'NO_AUDIO']);
    const fakeVideo = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(100, 1)]);
    expect((await uploadTo(id, fakeVideo)).body.error.code).toBe('INVALID_VIDEO'); // có ftyp nhưng ffprobe không đọc được
    expect(fs.readdirSync(path.join(env.root, 'output/live-cacao/clips/source')).filter((f) => f.startsWith('.lan-upload'))).toEqual([]); // file tạm dọn sạch

    const small = await makeEnv({ config: sttConfig(fake, { clipSourceMaxS: 2, clipSourceMaxBytes: 5000 }) });
    try {
      const sc = userClient(small.app);
      const pid = (await sc.post('/api/clip-projects', { name: 'x' })).body.project.id;
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: clip(3), type: 'video/mp4' }]);
      const big = await small.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      expect([big.statusCode, JSON.parse(big.body).error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    } finally {
      await small.close();
    }
    const longEnv = await makeEnv({ config: sttConfig(fake, { clipSourceMaxS: 2 }) });
    try {
      const pid = (await userClient(longEnv.app).post('/api/clip-projects', { name: 'x' })).body.project.id;
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: clip(3), type: 'video/mp4' }]);
      const r = await longEnv.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      expect([r.statusCode, JSON.parse(r.body).error.code]).toEqual([422, 'VIDEO_DURATION']);
    } finally {
      await longEnv.close();
    }
    const full = await makeEnv({ config: sttConfig(fake, { clipMinFreeGb: 1e9 }) });
    try {
      const pid = (await userClient(full.app).post('/api/clip-projects', { name: 'x' })).body.project.id;
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: clip(3), type: 'video/mp4' }]);
      const r = await full.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      expect([r.statusCode, JSON.parse(r.body).error.code]).toEqual([507, 'INSUFFICIENT_STORAGE']);
    } finally {
      await full.close();
    }
  });

  it('nhận .mov (QuickTime) và đặt tên file theo hash16', async () => {
    const id = await mkProject();
    const up = await uploadTo(id, movOf(clip(3)), 'live.mov', 'video/quicktime');
    expect(up.status).toBe(201);
    expect(up.body.source.video_url).toMatch(/\/[0-9a-f]{16}\.mov$/);
  });

  it('video khác khi đã có video: thay được nếu chưa có clip; có clip → 409 SOURCE_EXISTS', async () => {
    const id = await mkProject();
    const a = await uploadTo(id, clip(3));
    await settled(id);
    const b = await uploadTo(id, clip(3, { size: '240x426' }));
    expect(b.status).toBe(201);
    expect(b.body.source.id).not.toBe(a.body.source.id);
    expect(b.body.source.width).toBe(240);
    await settled(id);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM source_videos').get()).toEqual({ n: 1 });
    expect(fs.readdirSync(path.join(env.root, 'output/live-cacao/clips')).filter((f) => f.startsWith('transcript'))).toEqual(['transcript.json', 'transcript.v1.json']); // bản cũ được lưu, không ghi đè
    const sid = b.body.source.id;
    env.ctx.db.prepare("INSERT INTO clips (project_id, source_id, code, start_sentence, end_sentence, start_word, end_word, start_s, end_s, created_by, created_at, updated_at) VALUES (?, ?, 'K1', 0, 0, 0, 1, 0, 5, 'user', 'a', 'a')").run(id, sid);
    const c = await uploadTo(id, clip(3, { size: '200x356' }));
    expect([c.status, c.body.error.code]).toEqual([409, 'SOURCE_EXISTS']);
  });

  it('dịch vụ lỗi tạm (503) nhiều lần → failed kèm error_code; POST transcribe thử lại được; lỗi 400 → STT_REJECTED', async () => {
    const e2 = await makeEnv({ config: sttConfig(fake, { sttMaxRetries: 1 }) });
    try {
      const c = userClient(e2.app);
      const pid = (await c.post('/api/clip-projects', { name: 'Lỗi' })).body.project.id;
      fake.fallback = 'busy';
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: clip(3), type: 'video/mp4' }]);
      await e2.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      const failed = await waitFor(async () => (await c.get(`/api/clip-projects/${pid}`)).body.source, (s) => s?.status === 'failed', 15_000);
      expect(failed.error_code).toBe('STT_UNAVAILABLE');
      expect(failed.error).toMatch(/Dịch vụ nhận dạng lời nói/);
      expect(fake.calls.length).toBe(2); // 1 + 1 lần thử lại
      fake.fallback = 'ok';
      const r = await c.post(`/api/sources/${failed.id}/transcribe`);
      expect(r.status).toBe(200);
      expect(r.body.source.status).toBe('transcribing');
      await waitFor(async () => (await c.get(`/api/clip-projects/${pid}`)).body.source, (s) => s?.status === 'transcribed', 15_000);
      expect((await c.post(`/api/sources/${failed.id}/transcribe`)).body.error.code).toBe('INVALID_STATE'); // đã xong, tên riêng không đổi
      // lỗi không retry
      const pid2 = (await c.post('/api/clip-projects', { name: 'Lỗi 2' })).body.project.id;
      fake.steps.push('bad');
      const m2 = multipart([{ name: 'file', filename: 'b.mp4', data: clip(3, { size: '200x356' }), type: 'video/mp4' }]);
      await e2.app.inject({ method: 'POST', url: `/api/projects/${pid2}/source`, payload: m2.payload, headers: { ...m2.headers, host: 'localhost' } });
      const rej = await waitFor(async () => (await c.get(`/api/clip-projects/${pid2}`)).body.source, (s) => s?.status === 'failed', 15_000);
      expect(rej.error_code).toBe('STT_REJECTED');
    } finally {
      await e2.close();
    }
  });

  it('hủy khi đang chạy: status cancelled, kết quả muộn không ghi đè; sau đó thử lại được', async () => {
    const id = await mkProject();
    fake.hold();
    const up = await uploadTo(id, clip(3));
    await waitFor(() => fake.calls.length, (n) => n >= 1, 10_000, 'dịch vụ nhận file');
    const c = await u().post(`/api/sources/${up.body.source.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.source.status).toBe('cancelled');
    fake.release();
    await new Promise((r) => setTimeout(r, 200));
    expect((await source(id)).status).toBe('cancelled');
    expect(env.ctx.db.prepare('SELECT transcript_path FROM source_videos').get()).toEqual({ transcript_path: null });
    expect((await u().post(`/api/sources/${up.body.source.id}/cancel`)).status).toBe(409);
    expect((await u().post(`/api/sources/${up.body.source.id}/transcribe`)).status).toBe(200);
    await settled(id);
  });

  it('đổi tên riêng sau khi nhận dạng xong → nhận dạng lại được (bản cũ lưu lại); có clip thì 409 CLIPS_EXIST', async () => {
    const id = await mkProject({ stt_terms: 'A' });
    await uploadTo(id, clip(3));
    const s = await settled(id);
    expect((await u().post(`/api/sources/${s.id}/transcribe`)).status).toBe(409);
    await u().patch(`/api/clip-projects/${id}`, { stt_terms: 'B, C' });
    expect((await u().post(`/api/sources/${s.id}/transcribe`)).status).toBe(200);
    await settled(id);
    expect(fake.calls.map((x) => x.prompt)).toEqual(['A', 'B, C']);
    expect(fs.existsSync(path.join(env.root, 'output/live-cacao/clips/transcript.v1.json'))).toBe(true);
    env.ctx.db.prepare("INSERT INTO clips (project_id, source_id, code, start_sentence, end_sentence, start_word, end_word, start_s, end_s, created_by, created_at, updated_at) VALUES (?, ?, 'K1', 0, 0, 0, 1, 0, 5, 'user', 'a', 'a')").run(id, s.id);
    await u().patch(`/api/clip-projects/${id}`, { stt_terms: 'D' });
    expect((await u().post(`/api/sources/${s.id}/transcribe`)).body.error.code).toBe('CLIPS_EXIST');
  });

  it('chưa cấu hình dịch vụ (STT_PROVIDER=none): tải lên được nhưng failed STT_NOT_CONFIGURED; transcribe → 409', async () => {
    const e2 = await makeEnv({ config: { clipMinFreeGb: 0 } });
    try {
      const c = userClient(e2.app);
      const pid = (await c.post('/api/clip-projects', { name: 'Chưa cấu hình' })).body.project.id;
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: clip(3), type: 'video/mp4' }]);
      const r = await e2.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      const src = JSON.parse(r.body).source;
      expect(r.statusCode).toBe(201);
      expect(src).toMatchObject({ status: 'failed', error_code: 'STT_NOT_CONFIGURED' });
      expect(src.error).toMatch(/Chưa cấu hình nhận dạng lời nói/);
      const t = await c.post(`/api/sources/${src.id}/transcribe`);
      expect([t.status, t.body.error.code]).toEqual([409, 'STT_NOT_CONFIGURED']);
      expect((await c.get('/api/clip-status')).body.stt).toEqual({ configured: false });
    } finally {
      await e2.close();
    }
  });

  it('hàng đợi một việc một lúc: việc thứ hai chờ với vị trí 1; app trước LAN', async () => {
    const a = await mkProject();
    const b = await mkProject({ name: 'Live hai' });
    fake.hold();
    await uploadTo(a, clip(3));
    await waitFor(() => fake.calls.length, (n) => n >= 1, 10_000);
    await uploadTo(b, clip(3, { size: '200x356' }));
    const sb = await source(b);
    expect(sb.queue).toEqual({ state: 'waiting', position: 1 });
    expect((await source(a)).queue).toEqual({ state: 'running', position: null });
    fake.release();
    await settled(a);
    await settled(b);
    expect(fake.calls.length).toBe(2);
  });

  it('tiến độ ước tính theo thời gian (duration/20 + 5 s), kẹp 95% cho tới khi xong, rồi 100', async () => {
    const e2 = await makeEnv({ config: sttConfig(fake), stt: { progressTickMs: 20 } });
    try {
      const c = userClient(e2.app);
      const pid = (await c.post('/api/clip-projects', { name: 'Tiến độ' })).body.project.id;
      fake.hold();
      const m = multipart([{ name: 'file', filename: 'a.mp4', data: clip(3), type: 'video/mp4' }]);
      await e2.app.inject({ method: 'POST', url: `/api/projects/${pid}/source`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
      const p1 = await waitFor(async () => (await c.get(`/api/clip-projects/${pid}`)).body.source.progress, (p) => p >= 1, 10_000, 'tiến độ ước tính');
      expect(p1).toBeLessThanOrEqual(95);
      const { estimateSeconds } = await import('../src/services/clips/stt.js');
      expect(estimateSeconds(3600)).toBe(185); // 1 giờ ≈ 180 s + 5 s
      expect(estimateSeconds(0)).toBe(5);
      await new Promise((r) => setTimeout(r, 400)); // quá ước tính 5.15 s? chưa: vẫn dưới 95
      expect((await c.get(`/api/clip-projects/${pid}`)).body.source.progress).toBeLessThanOrEqual(95);
      fake.release();
      await waitFor(async () => (await c.get(`/api/clip-projects/${pid}`)).body.source, (s) => s?.status === 'transcribed', 15_000);
      expect((await c.get(`/api/clip-projects/${pid}`)).body.source.progress).toBe(100);
    } finally {
      fake.release();
      await e2.close();
    }
  });

  it('khởi động lại: video đang nhận dạng có job id → lấy kết quả theo job id (nếu có words), không thì chạy lại từ đầu', async () => {
    const seeded = seedClipProject(env, { status: 'transcribing', sentences: ['một hai ba'], video: { seconds: 4 } });
    env.ctx.db.prepare("UPDATE source_videos SET stt_job_id = 'job-cu', progress = 40 WHERE id = ?").run(seeded.sourceId);
    fake.registerJob('job-cu');
    const app2 = await env.second({ config: sttConfig(fake) });
    const s = await waitFor(async () => (await client(app2).get(`/api/clip-projects/${seeded.projectId}`)).body.source, (x) => x?.status === 'transcribed', 15_000);
    expect(s.word_count).toBe(fake.words.length);
    expect(fake.calls.length).toBe(0); // KHÔNG gửi lại file
    expect(fake.polls.map((p) => p.id)).toContain('job-cu');
    await app2.close();

    // job id không còn ở dịch vụ (hoặc kết quả thiếu words) → chạy lại từ đầu (tách audio từ video nguồn thật)
    const seeded2 = seedClipProject(env, { status: 'transcribing', sentences: ['bốn năm sáu'], video: { seconds: 4 } });
    env.ctx.db.prepare("UPDATE source_videos SET stt_job_id = 'job-mat' WHERE id = ?").run(seeded2.sourceId);
    const app3 = await env.second({ config: sttConfig(fake) });
    await waitFor(async () => (await client(app3).get(`/api/clip-projects/${seeded2.projectId}`)).body.source, (x) => x?.status === 'transcribed', 15_000);
    expect(fake.calls.length).toBe(1);
    await app3.close();
  });

  it('khởi động lại khi chưa cấu hình dịch vụ: việc đang nhận dạng → failed STT_NOT_CONFIGURED', async () => {
    const seeded = seedClipProject(env, { status: 'transcribing', video: false });
    const app2 = await env.second({ config: { clipMinFreeGb: 0, sttProvider: 'none', sttUrl: '' } });
    const s = (await client(app2).get(`/api/clip-projects/${seeded.projectId}`)).body.source;
    expect(s).toMatchObject({ status: 'failed', error_code: 'STT_NOT_CONFIGURED' });
    await app2.close();
  });
});

describe('SSE và trạng thái', () => {
  it('source.updated có tiến độ/trạng thái; clip.updated khi tạo clip; GET /api/meta và /api/clip-status có giới hạn', async () => {
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
    const events: { event: string; data: any }[] = [];
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let raw = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          let i: number;
          while ((i = raw.indexOf('\n\n')) >= 0) {
            const block = raw.slice(0, i);
            raw = raw.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.+)$/m.exec(block);
            if (ev && data) events.push({ event: ev[1]!, data: JSON.parse(data[1]!) });
          }
        }
      } catch {
        /* đã đóng */
      }
    })();
    const id = await mkProject();
    await uploadTo(id, clip(3));
    await settled(id);
    // SSE đến sau phản hồi HTTP một nhịp: chờ sự kiện cuối thay vì giả định đã tới
    const statuses = () => events.filter((e) => e.event === 'source.updated').map((e) => e.data.source.status as string);
    await waitFor(statuses, (a) => a.includes('transcribed'), 5000, 'source.updated transcribed');
    const srcEvents = statuses();
    expect(srcEvents).toContain('transcribing');
    const last = events.filter((e) => e.event === 'source.updated').pop()!.data.source;
    expect(last).toMatchObject({ project_id: id, status: 'transcribed' });
    // tạo clip tay → clip.updated
    const r = await u().post(`/api/projects/${id}/clips`, { start_word: 0, end_word: 13, title: 'Thử' });
    expect(r.status).toBe(201);
    await waitFor(() => events.find((e) => e.event === 'clip.updated'), Boolean, 5000, 'clip.updated');
    ctl.abort();
    const meta = (await u().get('/api/meta')).body;
    expect(meta.job_types).toContain('clip_plan');
    expect(meta.clips).toMatchObject({ max_bytes: 4 * 1024 ** 3, max_s: 10_800, stt: { configured: true }, plan: { max_count: 15 } });
    const st = (await u().get('/api/clip-status')).body;
    expect(st).toMatchObject({ aspects: ['9:16', '1:1', '16:9', 'source'], duration_presets: ['15_30', '30_60', '60_90', '90_180'] });
  });
});

describe('seed: transcript đủ dài cho API clip', () => {
  it('seedClipProject tạo dự án đọc được qua API (dùng cho các test sau)', async () => {
    const s = seedClipProject(env, { sentences: ['một hai ba bốn năm sáu bảy tám chín mười'.repeat(1)], video: false });
    const d = (await u().get(`/api/clip-projects/${s.projectId}`)).body;
    expect(d.source).toMatchObject({ status: 'transcribed', word_count: 10 });
    expect(speechWords(['a b']).length).toBe(2);
  });
});
