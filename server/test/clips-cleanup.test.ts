import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupSegments, editCleanupCuts, retimeWords, segmentDuration, validateCleanup, type CleanupWord } from '../src/lib/clip-cleanup.js';
import { ApiFailure } from '../../worker/src/api-failure.js';
import { handleJob, type RunnerDeps } from '../../worker/src/runner.js';
import { createAccount } from '../src/services/ai/accounts.js';
import { cleanupPayload, completeCleanup, createCleanup, expireWaitingCleanup, CLEANUP_WORKER_TIMEOUT_MS } from '../src/services/clips/cleanup.js';
import { patchClip, thumbsIdle } from '../src/services/clips/clips.js';
import { getClipRow } from '../src/services/clips/repo.js';
import { buildClipArgs, buildFilterGraph, renderDurationTolerance } from '../src/services/clips/render.js';
import { getJobRow } from '../src/services/repo.js';
import { completeJob, failJob, sweepStaleJobs } from '../src/services/jobs.js';
import { makeEnv, userClient, type Env } from './helpers.js';
import { libassFfmpeg, seedClipProject, waitFor } from './helpers-clips.js';
import { FFMPEG, ffprobeJson, makeTestVideo } from './final-helpers.js';
import { buildAss, buildClipSrt } from '../src/services/clips/captions.js';
import { planQuotaBlock, jobIsActive } from '../../web/src/clips/jobState.js';
import { MIGRATIONS_DIR, openDb, runMigrations } from '../src/db/index.js';

const words: CleanupWord[] = 'tôi ừm muốn nói tôi tôi muốn chia sẻ điều này cho mọi người nghe'.split(' ').map((w, i) => ({ i, w, start: i * 0.5, end: i * 0.5 + 0.4 }));
const filler = { kind: 'filler', start_word: 1, end_word: 1, quote: 'ừm', confidence: 0.98, reason: 'Tiếng đệm không mang ý nghĩa' };
const repeat = { kind: 'repetition', start_word: 4, end_word: 4, quote: 'tôi', confidence: 0.95, reason: 'Nói lặp rồi bắt đầu lại', replacement: { start_word: 5, end_word: 7, quote: 'tôi muốn chia' } };

describe('đề xuất làm gọn và timeline', () => {
  it('chỉ số và câu trích khớp; chưa duyệt giữ nguyên; duyệt mới rút thời lượng và dời phụ đề', () => {
    const p = validateCleanup(words, 0, 8, [filler, repeat]);
    expect(cleanupSegments(0, 8, p, [])).toEqual([{ start: 0, end: 8 }]);
    const segments = cleanupSegments(0, 8, p, [1, 2]);
    expect(segmentDuration(segments)).toBe(7);
    const retimed = retimeWords(words, segments);
    expect(retimed.map((w) => w.w).join(' ')).toBe('tôi muốn nói tôi muốn chia sẻ điều này cho mọi người nghe');
    expect(retimed.find((w) => w.i === 2)!.start).toBe(0.5);
    expect(retimed.find((w) => w.i === 5)!.start).toBe(1.5);
    expect(retimed.every((w) => w.end <= 7)).toBe(true);
  });
  it.each([
    { ...filler, start_word: 500 }, { ...filler, quote: 'từ bịa' }, { ...filler, confidence: 0.7 },
    { ...filler, start_word: 2, end_word: 2, quote: 'muốn' }, { ...repeat, replacement: undefined },
    { ...repeat, replacement: { start_word: 2, end_word: 3, quote: 'muốn nói' } },
    { ...repeat, replacement: { start_word: 5, end_word: 7, quote: 'tôi muốn khác' } },
  ])('từ chối đề xuất thiếu căn cứ %#', (bad) => {
    expect(() => validateCleanup(words, 0, 8, [bad])).toThrow();
  });
  it('từ chối chồng nhau, lựa chọn lạ/lặp, timestamp chồng từ hàng xóm và bỏ quá nhiều', () => {
    expect(() => validateCleanup(words, 0, 8, [filler, filler])).toThrow(/chồng/);
    const p = validateCleanup(words, 0, 8, [filler]);
    expect(() => cleanupSegments(0, 8, p, [9])).toThrow();
    expect(() => cleanupSegments(0, 8, p, [1, 1])).toThrow();
    expect(() => validateCleanup(words.map((w) => w.i === 0 ? { ...w, end: 0.6 } : w), 0, 8, [filler])).toThrow(/chồng/);
    expect(() => cleanupSegments(0, 8, [{ ...p[0]!, start: 1, end: 6 }], [1])).toThrow(/60%/);
  });
  it('không cho xoá cả phần nói lại; ẩn từ vẫn giữ đồng hồ mới trong đoạn ghép', () => {
    const p = validateCleanup(words, 0, 8, [repeat]);
    expect(() => cleanupSegments(0, 8, [p[0]!, { ...p[0]!, id: 2, start_word: 6, end_word: 6, start: 3, end: 3.4, replacement: undefined }], [1, 2])).toThrow(/giữ nguyên/);
    expect(retimeWords([{ w: 'Cacao', start: 0, end: 4 }], [{ start: 0, end: 1 }, { start: 3, end: 4 }])).toEqual([{ w: 'Cacao', start: 0, end: 2 }]);
  });
});

let env: Env;
beforeEach(async () => { env = await makeEnv({ config: { clipMinFreeGb: 0, workerMode: 'managed', managedJobTypes: ['clip_plan'], clipFfmpegPath: libassFfmpeg() } }); });
afterEach(async () => { vi.restoreAllMocks(); await env.ctx.finalRender?.idle(); await thumbsIdle(env.ctx); await env.close(); });
const user = () => userClient(env.app);
async function seededClip() {
  const seeded = seedClipProject(env, { sentences: [words.map((w) => w.w).join(' ')], wordS: 0.5, video: { seconds: 12, size: '160x284' } });
  const res = await user().post(`/api/projects/${seeded.projectId}/clips`, { start_word: 0, end_word: words.length - 1 });
  expect(res.status).toBe(201);
  return { seeded, clip: res.body.clip as any };
}
function completeFixture(id: number, proposals: unknown[]) {
  completeCleanup(env.ctx, getJobRow(env.ctx, id), { proposals, summary: 'Kết quả giả lập' });
  env.ctx.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
}
const api: RunnerDeps['api'] = async (method, url, body, lease, jobId, extra = {}) => {
  if (url.endsWith('/infer')) return { message: { content: JSON.stringify({ proposals: [filler, repeat], summary: 'Bỏ tiếng đệm và phần nói lặp.' }) } } as never;
  const res = await env.app.inject({ method: method as 'GET', url, payload: body as object, headers: { host: 'localhost', authorization: 'Bearer test-worker-token', 'x-worker-id': 'W1', ...(lease ? { 'x-job-lease': lease } : {}), ...(jobId ? { 'x-job-id': String(jobId) } : {}), ...extra } });
  if (res.statusCode === 204) return null as never;
  const b = JSON.parse(res.body);
  if (res.statusCode >= 400) throw new ApiFailure(b.error.code, b.error.message, b.error.details);
  return b;
};

describe('AI làm gọn: API + managed worker giả inference', () => {
  it('claim → infer → checkpoint → complete tự áp dụng bắt buộc; chỉnh từng chỗ; undo, phát hiện xung đột và không lẫn với job chọn clip', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createAccount(env.ctx, { alias: 'Test', provider: 'codex', model: 'fake', base_url: 'http://127.0.0.1:1/v1', priority: 1, capabilities: ['text'] });
    const { seeded, clip } = await seededClip();
    const created = await user().post(`/api/clips/${clip.id}/cleanup-plan`, {});
    expect(created.status, created.raw).toBe(201);
    expect(await api('GET', '/api/worker/next?mode=managed&types=clip_plan')).toBeNull(); // old worker cannot claim cleanup
    const job = await api<any>('GET', '/api/worker/next?mode=managed&features=clip_cleanup&types=clip_plan');
    expect(job.payload).toMatchObject({ mode: 'cleanup', clip_id: clip.id, words: expect.any(Array) });
    const browser = { guard: vi.fn(), run: vi.fn(), close: vi.fn(), uploads: [] };
    await handleJob(job, { api, root: env.root, sleep: async () => undefined, stopping: () => false, makeBrowser: () => browser as never });
    expect(browser.guard).not.toHaveBeenCalled();
    const d = (await user().get(`/api/clip-projects/${seeded.projectId}`)).body;
    expect(d.plan_job).toBeNull();
    expect(d.clips).toHaveLength(1);
    expect(d.clips[0].cleanup_job.status).toBe('done');
    expect(d.clips[0].cleanup.selected_ids).toEqual([1, 2]);
    expect(d.clips[0].cleanup_state).toBe('ready');
    expect(d.clips[0].latest_cut).toBeNull();
    expect(getJobRow(env.ctx, job.id).status).toBe('done');
    const apply = { job_id: job.id, revision: 0, selected_ids: [1] };
    const approved = await user().put(`/api/clips/${clip.id}/cleanup`, apply);
    expect(approved.status, approved.raw).toBe(200);
    expect(approved.body.clip.edited_duration_s).toBeCloseTo(clip.duration_s - 0.5);
    expect((await user().put(`/api/clips/${clip.id}/cleanup`, apply)).body.error.code).toBe('STALE_CLEANUP');
    expect((await user().post(`/api/clips/${clip.id}/cleanup-plan`, {})).body.error.code).toBe('CLEANUP_APPLIED');
    const undo = await user().put(`/api/clips/${clip.id}/cleanup`, { ...apply, revision: 1, selected_ids: [] });
    expect(undo.body.clip.edited_duration_s).toBe(clip.duration_s);
    const checkpoint = JSON.parse(getJobRow(env.ctx, job.id).checkpoint!);
    expect(checkpoint.complete.result.proposals).toHaveLength(2);
    await handleJob({ ...job, checkpoint }, { api, root: env.root, sleep: async () => undefined, stopping: () => false, makeBrowser: () => browser as never });
    expect((await user().get(`/api/clips/${clip.id}`)).body.clip.cleanup).toMatchObject({ revision: 2, selected_ids: [] }); // replay cannot overwrite user approval

  });
  it('tạo clip tự xếp hàng; chặn dựng khi chưa xử lý; nối tiếp tuần tự, lỗi không lặp vô hạn và retry có chủ ý', async () => {
    const { seeded, clip } = await seededClip();
    const second = (await user().post(`/api/projects/${seeded.projectId}/clips`, { start_word: 0, end_word: words.length - 1 })).body.clip;
    const pending = (await user().get(`/api/clip-projects/${seeded.projectId}`)).body.clips;
    expect(pending.every((c: any) => c.cleanup === null)).toBe(true);
    expect((await user().post(`/api/clips/${clip.id}/render`, { captions_preset: 'none' })).body.error.code).toBe('CLEANUP_REQUIRED');
    const active = () => env.ctx.db.prepare("SELECT * FROM jobs WHERE project_id=? AND status='queued'").all(seeded.projectId) as any[];
    expect(active()).toHaveLength(1);
    const firstId = active()[0].id;
    env.ctx.db.prepare("UPDATE jobs SET status='claimed' WHERE id=?").run(firstId);
    completeJob(env.ctx, firstId, { result: { proposals: [filler], summary: 'Bỏ tiếng đệm' } });
    expect((await user().get(`/api/clips/${clip.id}`)).body.clip).toMatchObject({ cleanup_state: 'ready', cleanup: { selected_ids: [1] } });
    expect(active()).toHaveLength(1);
    const secondId = active()[0].id;
    expect(JSON.parse(active()[0].payload).clip_id).toBe(second.id);
    env.ctx.db.prepare("UPDATE jobs SET status='claimed' WHERE id=?").run(secondId);
    failJob(env.ctx, secondId, { error: 'Lỗi giả lập', code: 'OTHER' });
    expect(active()).toHaveLength(0);
    expect((await user().get(`/api/clips/${second.id}`)).body.clip.cleanup_state).toBe('failed');
    const retry = await user().post(`/api/projects/${seeded.projectId}/process-clips`, {});
    expect(retry.status, retry.raw).toBe(201);
    expect(retry.body.job.id).not.toBe(secondId);
    expect(active()).toHaveLength(1);
  });
  it('chỉnh hai đầu theo từ, lưu/khôi phục; từ chối ngoài clip và phần nói lại cần giữ', async () => {
    const { clip } = await seededClip();
    const jobId = createCleanup(env.ctx, clip.id);
    completeFixture(jobId, [filler, repeat]);
    const base = { job_id: jobId, revision: 0, selected_ids: [1, 2] };
    const bad = await user().put(`/api/clips/${clip.id}/cleanup`, { ...base, edits: [{ id: 1, start_word: 1, end_word: 99 }] });
    expect(bad.body.error.code).toBe('INVALID_CLEANUP');
    const protectedRange = await user().put(`/api/clips/${clip.id}/cleanup`, { ...base, edits: [{ id: 2, start_word: 4, end_word: 5 }] });
    expect(protectedRange.body.error.code).toBe('INVALID_CLEANUP');
    const result = await user().put(`/api/clips/${clip.id}/cleanup`, { ...base, edits: [{ id: 1, start_word: 1, end_word: 2 }] });
    expect(result.status, result.raw).toBe(200);
    const p = result.body.clip.cleanup.proposals[0];
    expect(p).toMatchObject({ edited: true, start_word: 1, end_word: 2, text: 'ừm muốn', original: { start_word: 1, end_word: 1 } });
    expect(p.start).toBeLessThanOrEqual(0.5 + words[1]!.start);
    const restored = await user().put(`/api/clips/${clip.id}/cleanup`, { ...base, revision: 1, selected_ids: [] });
    expect(restored.body.clip.edited_duration_s).toBe(clip.duration_s);
    const proposals = validateCleanup(words, 0, 8, [filler, repeat]);
    expect(() => editCleanupCuts(words, 0, 8, proposals, [{ id: 1, start_word: 1, end_word: 1 }, { id: 1, start_word: 1, end_word: 2 }])).toThrow(/Trùng/);
  });
  it('đổi điểm cắt rồi đổi về vẫn làm mất hiệu lực đề xuất cũ; huỷ job; ngăn hai việc AI cùng dự án', async () => {
    const { clip } = await seededClip();
    const jobId = createCleanup(env.ctx, clip.id);
    const job = getJobRow(env.ctx, jobId);
    expect(createCleanup(env.ctx, clip.id)).toBe(jobId);
    patchClip(env.ctx, clip.id, { start_word: 1 });
    patchClip(env.ctx, clip.id, { start_word: 0 });
    expect(() => completeCleanup(env.ctx, job, { proposals: [filler], summary: 'cũ' })).toThrow(/thay đổi/);
    expect(getClipRow(env.ctx, clip.id).cleanup).toBeNull();
    expect((await user().post(`/api/jobs/${jobId}/cancel`, {})).status).toBe(200);
    expect(getJobRow(env.ctx, jobId).status).toBe('cancelled');
    expect(() => cleanupPayload(env.ctx, job)).toThrow();
  });
  it('worker hủy cleanup cũ sau khi đổi điểm cắt rồi tự xếp bản mới để không kẹt bước bắt buộc', async () => {
    createAccount(env.ctx, { alias: 'Test', provider: 'codex', model: 'fake', base_url: 'http://127.0.0.1:1/v1', priority: 1, capabilities: ['text'] });
    const { clip } = await seededClip();
    const oldId = createCleanup(env.ctx, clip.id);
    patchClip(env.ctx, clip.id, { start_word: 1 });
    expect(await api('GET', '/api/worker/next?mode=managed&features=clip_cleanup&types=clip_plan')).toBeNull();
    expect(getJobRow(env.ctx, oldId).status).toBe('cancelled');
    const next = await api<any>('GET', '/api/worker/next?mode=managed&features=clip_cleanup&types=clip_plan');
    expect(next.id).not.toBe(oldId);
    expect(next.payload).toMatchObject({ mode: 'cleanup', clip_id: clip.id, edit_revision: 1 });
  });
  it('bản dựng giữ nguyên lựa chọn và phụ đề lúc xếp hàng dù người dùng undo/đổi chữ trước khi ffmpeg chạy', async () => {
    const { clip } = await seededClip();
    const jobId = createCleanup(env.ctx, clip.id);
    completeFixture(jobId, [filler]);
    await user().put(`/api/clips/${clip.id}/cleanup`, { job_id: jobId, revision: 0, selected_ids: [1] });
    const enqueue = vi.spyOn(env.ctx.finalRender!, 'enqueueClipTask').mockImplementation(() => undefined);
    await user().put(`/api/clips/${clip.id}/captions`, { words: [{ i: 2, w: 'Muốn' }] });
    const first = await user().post(`/api/clips/${clip.id}/render`, { aspect: 'source', captions_preset: libassFfmpeg() ? 'highlight' : 'none' });
    expect(first.status, first.raw).toBe(201);
    await user().put(`/api/clips/${clip.id}/cleanup`, { job_id: jobId, revision: 1, selected_ids: [] });
    await user().put(`/api/clips/${clip.id}/captions`, { words: [{ i: 2, w: 'ĐÃ ĐỔI' }] });
    const callback = enqueue.mock.calls[0]![3];
    await callback(new AbortController());
    enqueue.mockRestore();
    const cut = (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut;
    expect(cut.status, cut.error).toBe('ready');
    expect(cut.cleanup_count).toBe(1);
    expect((await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut_stale).toBe(true);
    expect((await user().get(`/api/projects/${clip.project_id}/clips.zip`)).status).not.toBe(200);
    expect(cut.duration_s).toBeCloseTo(clip.duration_s - 0.5, 1);
    const srt = fs.readFileSync(path.join(env.root, decodeURIComponent(cut.srt_url).replace('/files/', '')), 'utf8');
    expect(srt).not.toMatch(/ừm|ĐÃ ĐỔI/);
    expect(srt).toContain('Muốn');
    const output = ffprobeJson(path.join(env.root, cut.video_url.replace('/files/', '')));
    expect(output.streams.map((s: any) => s.codec_type)).toEqual(expect.arrayContaining(['video', 'audio']));
    const second = await user().post(`/api/clips/${clip.id}/render`, { aspect: 'source', captions_preset: 'none' });
    expect(second.status).toBe(201);
    await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut, (c) => c.status !== 'rendering', 30_000);
    const ready = (await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut;
    expect(ready.status, ready.error).toBe('ready');
    expect(ready.version).toBe(2);
    expect(ready.cleanup_count).toBe(0);
    expect(fs.existsSync(path.join(env.root, cut.video_url.replace('/files/', '')))).toBe(true);
  }, 60_000);
});

it('migration 015 trên DB 014 có dữ liệu giữ nguyên clip/cut, thêm mặc định và kiểm tra toàn vẹn', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-migration-'));
  const dir = path.join(tmp, 'migrations'); fs.mkdirSync(dir);
  const db = openDb(path.join(tmp, 'old.db'));
  try {
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f) && f < '015')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    runMigrations(db, dir);
    db.prepare("INSERT INTO projects(slug,name,created_at,updated_at) VALUES('old','old','t','t')").run();
    db.prepare("INSERT INTO source_videos(project_id,path,original_name,bytes,content_hash,created_at) VALUES(1,'old.mp4','old.mp4',123,'hash','t')").run();
    db.prepare("INSERT INTO clips(project_id,source_id,code,start_sentence,end_sentence,start_word,end_word,start_s,end_s,created_by,created_at,updated_at) VALUES(1,1,'K1',0,2,0,20,0,10,'user','t','t')").run();
    db.prepare("INSERT INTO clip_cuts(clip_id,project_id,version,start_s,end_s,created_at,status,video_path) VALUES(1,1,1,0,10,'t','ready','old.mp4')").run();
    expect(runMigrations(db)).toEqual(['015_clip_cleanup', '016_cleanup_routing', '017_clip_parts', '018_storyboard_generator', '019_lan_autovideo']);
    expect(db.prepare('SELECT code,cleanup,edit_revision FROM clips').get()).toEqual({ code: 'K1', cleanup: null, edit_revision: 0 });
    expect(db.prepare('SELECT video_path,edit_snapshot FROM clip_cuts').get()).toEqual({ video_path: 'old.mp4', edit_snapshot: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

it.each([true, false])('ffmpeg ghép đúng nội dung hình ở giữa clip, có audio=%s', (audio) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-video-'));
  try {
    const src = path.join(tmp, 'in.mp4'), out = path.join(tmp, 'out.mp4');
    makeTestVideo(src, 6, { size: '160x284', audio });
    const segments = [{ start: 0, end: 2 }, { start: 3, end: 5 }];
    const graph = buildFilterGraph({ srcW: 160, srcH: 284, aspect: 'source', reframe: 'native', ass: null, hasAudio: audio, segments }).graph;
    const r = spawnSync(FFMPEG!, buildClipArgs({ src, startS: 0, durS: 4, graph, hasAudio: audio, editedAudio: true, out }), { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(Number(ffprobeJson(out).format.duration)).toBeCloseTo(4, 1);
    // Compare a known output frame after the join to source 1s later: removed frames really disappeared.
    const frame = (file: string, at: number) => spawnSync(FFMPEG!, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=16:28', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']).stdout;
    const edited = frame(out, 2.5), expected = frame(src, 3.5), uncut = frame(src, 2.5);
    const diff = (a: Buffer, b: Buffer) => a.reduce((sum, n, i) => sum + Math.abs(n - b[i]!), 0) / a.length;
    expect(edited.length).toBe(16 * 28);
    expect(diff(edited, expected)).toBeLessThan(diff(edited, uncut));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}, 30_000);

it('giữ từ ASR độ dài 0 ở phần giữ, không nhân đôi ở mối nối hay giữ từ trong phần đã bỏ; SRT/ASS giữ chữ', () => {
  const w = [0, 1, 2, 3, 4].map((t) => ({ w: `từ${t}`, start: t, end: t }));
  const plain = retimeWords(w, [{ start: 0, end: 4 }], 4);
  expect(plain).toEqual(w);
  const edited = retimeWords(w, [{ start: 0, end: 1 }, { start: 2, end: 4 }], 4);
  expect(edited).toEqual([w[0], { w: 'từ2', start: 1, end: 1 }, { w: 'từ3', start: 2, end: 2 }, { w: 'từ4', start: 3, end: 3 }]);
  expect(retimeWords(w, [{ start: 0, end: 2 }, { start: 2, end: 4 }], 4)).toEqual(w);
  expect(retimeWords(w, [{ start: 0, end: 3 }], 4).map((x) => x.w)).toEqual(['từ0', 'từ1', 'từ2']);
  expect(buildClipSrt(plain, 0, 4)).toContain('từ2');
  expect(buildAss(plain, { preset: 'highlight', width: 160, height: 284, font: 'Arial', clipStart: 0, clipEnd: 4 })).toContain('từ2');
});

it('worker cũ/legacy không nhận cleanup: hết hạn thành failed và mở khóa AI chọn clip; không tạo vòng retry', async () => {
  const { seeded, clip } = await seededClip();
  const id = createCleanup(env.ctx, clip.id);
  expect(await api('GET', '/api/worker/next?mode=managed&types=clip_plan')).toBeNull();
  expect(await api('GET', '/api/worker/next?types=clip_plan')).toBeNull();
  env.clock.advance(CLEANUP_WORKER_TIMEOUT_MS + 1);
  sweepStaleJobs(env.ctx);
  expect(getJobRow(env.ctx, id)).toMatchObject({ status: 'failed', error_code: 'OTHER' });
  expect(getJobRow(env.ctx, id).error).toContain('clip_cleanup');
  expect(expireWaitingCleanup(env.ctx)).toEqual([]);
  const next = await user().post(`/api/projects/${seeded.projectId}/clip-plan`, {});
  expect(next.status, next.raw).toBe(201);
});

it('không hết hạn backlog có worker hỗ trợ, lượt chờ quota hoặc hàng đợi tạm dừng', async () => {
  await api('GET', '/api/worker/next?mode=managed&features=clip_cleanup&types=clip_plan');
  const { clip } = await seededClip();
  const id = createCleanup(env.ctx, clip.id);
  env.clock.advance(CLEANUP_WORKER_TIMEOUT_MS + 1);
  await api('GET', '/api/worker/ping?mode=managed'); // heartbeat preserves advertised support
  expect(expireWaitingCleanup(env.ctx)).toEqual([]);
  env.ctx.db.prepare("UPDATE worker_sessions SET features='[]'").run();
  env.ctx.db.prepare("UPDATE jobs SET wait_reason='ai_quota',next_attempt_at=? WHERE id=?").run(new Date(env.clock.now() + 3600000).toISOString(), id);
  expect(expireWaitingCleanup(env.ctx)).toEqual([]);
  env.ctx.db.prepare('UPDATE jobs SET wait_reason=NULL WHERE id=?').run(id);
  env.ctx.db.prepare('UPDATE worker_state SET queue_paused=1').run();
  expect(expireWaitingCleanup(env.ctx)).toEqual([]);
  expect(getJobRow(env.ctx, id).status).toBe('queued');
});

it('khóa lưu kết quả cũ khi cùng clip đang làm gọn lại; giữ revision và tiếp tục polling job mới', async () => {
  const { seeded, clip } = await seededClip();
  const oldId = createCleanup(env.ctx, clip.id);
  completeFixture(oldId, []);
  const next = createCleanup(env.ctx, clip.id);
  env.ctx.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(next);
  const save = await user().put(`/api/clips/${clip.id}/cleanup`, { job_id: oldId, revision: 0, selected_ids: [] });
  expect(save.body.error.code).toBe('CLEANUP_RUNNING');
  expect(getClipRow(env.ctx, clip.id).edit_revision).toBe(0);
  const detail = (await user().get(`/api/clip-projects/${seeded.projectId}`)).body;
  expect(detail.clips[0].cleanup_job.id).toBe(next);
  expect(jobIsActive(detail.clips[0].cleanup_job)).toBe(true);
  expect(getJobRow(env.ctx, next).status).toBe('running');
});

it('cleanup/điểm cắt/phụ đề dùng nguồn của clip cũ khi dự án có nguồn mới hơn', async () => {
  const { seeded, clip } = await seededClip();
  await user().post(`/api/jobs/${createCleanup(env.ctx, clip.id)}/cancel`, {});
  const source = env.ctx.db.prepare('SELECT * FROM source_videos WHERE id=?').get(seeded.sourceId) as any;
  const t = structuredClone(seeded.transcript); t.words.forEach((w) => { w.w = 'NGUỒN_KHÁC'; w.start += 100; w.end += 100; });
  const newerPath = `output/${seeded.slug}/clips/newer-transcript.json`;
  fs.writeFileSync(path.join(env.root, newerPath), JSON.stringify(t));
  env.ctx.db.prepare("INSERT INTO source_videos(project_id,path,original_name,bytes,content_hash,status,transcript_path,created_at) VALUES(?,?,'new.mp4',123,'new-hash','transcribed',?,?)").run(seeded.projectId, source.path, newerPath, env.ctx.now());
  const id = createCleanup(env.ctx, clip.id);
  expect(JSON.parse(getJobRow(env.ctx, id).payload).source_id).toBe(seeded.sourceId);
  expect(cleanupPayload(env.ctx, getJobRow(env.ctx, id)).words[1]!.w).toBe('ừm');
  completeFixture(id, [filler]);
  const detail = (await user().get(`/api/clip-projects/${seeded.projectId}`)).body;
  expect(detail.clips[0].transcript_excerpt).not.toContain('NGUỒN_KHÁC');
  const caps = await user().put(`/api/clips/${clip.id}/captions`, { words: [{ i: 0, w: 'TÔI' }] });
  expect(caps.body.clip.caption_words[1].w).toBe('ừm');
  expect(patchClip(env.ctx, clip.id, { start_word: 1 }).start_s).toBeLessThan(10);
});

it('một truy vấn cleanup cho cả dự án, index loại payload chọn clip lớn và trả sẵn đoạn giữ', async () => {
  const { seeded, clip } = await seededClip();
  const id = createCleanup(env.ctx, clip.id); completeFixture(id, [filler]);
  for (let i = 0; i < 8; i++) await user().post(`/api/projects/${seeded.projectId}/clips`, { start_word: 0, end_word: words.length - 1 });
  const payload = JSON.stringify({ sentences: 'x'.repeat(200000) });
  for (let i = 0; i < 10; i++) env.ctx.db.prepare("INSERT INTO jobs(project_id,type,status,payload,created_at) VALUES(?,'clip_plan','done',?,?)").run(seeded.projectId, payload, env.ctx.now());
  const prepare = vi.spyOn(env.ctx.db, 'prepare');
  const detail = (await user().get(`/api/clip-projects/${seeded.projectId}`)).body;
  expect(prepare.mock.calls.filter(([sql]) => String(sql).includes('AS cleanup_clip_id'))).toHaveLength(1);
  expect(detail.clips[0].retained_segments).toEqual(cleanupSegments(clip.start_s, clip.end_s, detail.clips[0].cleanup.proposals, [1]));
  const plan = env.ctx.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE project_id=? AND type='clip_plan' AND json_extract(payload,'$.mode')='cleanup' AND json_extract(payload,'$.clip_id')=? AND json_extract(payload,'$.edit_revision')=? ORDER BY id DESC LIMIT 1").all(seeded.projectId, clip.id, 0);
  expect(JSON.stringify(plan)).toContain('idx_jobs_clip_cleanup');
});

it('hạn mức làm gọn lấy plan, độc lập số lượt dựng trên LAN', () => {
  const renderExhausted = { render: 0, plan: 2 }, planExhausted = { render: 10, plan: 0 };
  expect(planQuotaBlock(renderExhausted)).toBeNull();
  expect(planQuotaBlock(planExhausted)).not.toBeNull();
});

it('25 fps, 30 điểm bỏ: chấp nhận sai số ghép theo số đoạn nhưng vẫn chặn sai độ dài lớn', async () => {
  expect(renderDurationTolerance(1, 25)).toBe(0.5);
  expect(renderDurationTolerance(31, 25)).toBeCloseTo(1.74);
  const tokens = Array.from({ length: 121 }, (_, i) => i % 4 === 2 ? 'ừm' : 'từ');
  const s = seedClipProject(env, { sentences: [tokens.join(' ')], wordS: 0.1, video: { seconds: 15, fps: 25, size: '160x284' } });
  env.ctx.db.prepare('UPDATE source_videos SET fps=25 WHERE id=?').run(s.sourceId);
  const clip = (await user().post(`/api/projects/${s.projectId}/clips`, { start_word: 0, end_word: 120 })).body.clip;
  const proposals = s.transcript.words.filter((w) => w.w === 'ừm').map((w) => ({ kind: 'filler', start_word: w.i, end_word: w.i, quote: w.w, reason: 'Tiếng đệm', confidence: 0.99 }));
  completeFixture(createCleanup(env.ctx, clip.id), proposals);
  const r = await user().post(`/api/clips/${clip.id}/render`, { aspect: 'source', captions_preset: 'none' });
  expect(r.status, r.raw).toBe(201);
  const ready = await waitFor(async () => (await user().get(`/api/clips/${clip.id}`)).body.clip, (c) => c.latest_cut.status !== 'rendering', 30000);
  expect(ready.latest_cut.status, ready.latest_cut.error).toBe('ready');
  const drift = Math.abs(ready.latest_cut.duration_s - ready.edited_duration_s);
  expect(drift).toBeLessThanOrEqual(renderDurationTolerance(31, 25));
}, 30000);

it.each([true, false])('31 đoạn không thẳng biên khung hình giữ đúng đồng hồ hình/phụ đề, audio=%s', (audio) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-many-joins-'));
  try {
    const src = path.join(tmp, 'in.mp4'), out = path.join(tmp, 'out.mp4');
    makeTestVideo(src, 7, { size: '160x284', fps: 25, audio });
    const segments = Array.from({ length: 31 }, (_, i) => ({ start: 0.001 + i * 0.2, end: 0.15 + i * 0.2 }));
    const duration = segmentDuration(segments);
    const graph = buildFilterGraph({ srcW: 160, srcH: 284, aspect: 'source', reframe: 'native', hasAudio: audio, ass: null, fps: 25, segments }).graph;
    const r = spawnSync(FFMPEG!, buildClipArgs({ src, startS: 0, durS: duration, graph, hasAudio: audio, editedAudio: true, out }), { encoding: 'utf8', timeout: 30000 });
    expect(r.status, r.stderr).toBe(0);
    const info = ffprobeJson(out);
    // Old per-segment STARTPTS + concat produced 3.72s for the silent 4.619s edit.
    expect(Math.abs(Number(info.format.duration) - duration)).toBeLessThan(0.05);
    expect(info.streams.some((s: any) => s.codec_type === 'audio')).toBe(audio);
    const point = retimeWords([{ w: 'cuối', start: 6.1, end: 6.12 }], segments);
    expect(point[0]!.end).toBeLessThanOrEqual(Number(info.format.duration));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

it('migration 016 từ DB 015 giữ dữ liệu job/worker, thêm capability và index cho job đã có', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-routing-mig-'));
  const dir = path.join(tmp, 'migrations'); fs.mkdirSync(dir);
  const db = openDb(path.join(tmp, 'old.db'));
  try {
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f) && f < '016')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    runMigrations(db, dir);
    db.prepare("INSERT INTO projects(slug,name,created_at,updated_at) VALUES('old','old','t','t')").run();
    db.prepare("INSERT INTO jobs(project_id,type,payload,created_at) VALUES(1,'clip_plan',?, 't')").run(JSON.stringify({ mode: 'cleanup', clip_id: 7, edit_revision: 0 }));
    db.prepare("INSERT INTO worker_sessions VALUES('old-worker','managed','t')").run();
    const before = db.prepare('SELECT * FROM jobs').all();
    expect(runMigrations(db)).toEqual(['016_cleanup_routing', '017_clip_parts', '018_storyboard_generator', '019_lan_autovideo']);
    expect(db.prepare('SELECT * FROM jobs').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM worker_sessions').get()).toEqual({ worker_id: 'old-worker', mode: 'managed', last_seen_at: 't', features: '[]' });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE project_id=1 AND type='clip_plan' AND json_extract(payload,'$.mode')='cleanup' AND json_extract(payload,'$.clip_id')=7").all();
    expect(JSON.stringify(plan)).toContain('idx_jobs_clip_cleanup');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

it('cờ cần dựng lại tồn tại sau khi đổi phụ đề và mở từ kết nối khác, kể cả bản legacy thiếu snapshot', async () => {
  const { seeded, clip } = await seededClip();
  completeFixture(createCleanup(env.ctx, clip.id), []);
  env.ctx.db.prepare("INSERT INTO clip_cuts(clip_id,project_id,version,status,start_s,end_s,created_at,video_path) VALUES(?,?,1,'ready',?,?,?,'old.mp4')").run(clip.id, seeded.projectId, clip.start_s, clip.end_s, env.ctx.now());
  expect((await user().get(`/api/clips/${clip.id}`)).body.clip.latest_cut_stale).toBe(false);
  expect((await user().put(`/api/clips/${clip.id}/captions`, { words: [{ i: 0, w: 'TÔI ĐÃ SỬA' }] })).status).toBe(200);
  const second = await env.second();
  expect((await userClient(second).get(`/api/clips/${clip.id}`)).body.clip.latest_cut_stale).toBe(true);
});
