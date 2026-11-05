/**
 * Clip ghép nhiều đoạn (montage): tạo/sửa qua API, làm gọn theo từng đoạn, dựng bằng ffmpeg thật (thứ tự phát khác thứ tự thời gian),
 * kiểm tra kết quả AI phía server và phía worker (prompt, đọc/kiểm tra `parts`, khử trùng, kiểm định, khôi phục dấu câu).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupPayload, completeCleanup, createCleanup } from '../src/services/clips/cleanup.js';
import { thumbsIdle } from '../src/services/clips/clips.js';
import { validateClipPlan } from '../src/services/clips/plan.js';
import { buildClipArgs, buildFilterGraph, splitByParts } from '../src/services/clips/render.js';
import { getJobRow } from '../src/services/repo.js';
import { snapBounds } from '../src/services/clips/transcript.js';
import { segmentDuration } from '../src/lib/clip-cleanup.js';
import { cleanupSystem, cleanupUserContent, parseCleanupResult, MULTI_PART_NOTE, type CleanupPayload } from '../../worker/src/clip-cleanup.js';
import {
  VERIFY_SYSTEM,
  applyFix,
  checkMoment,
  dedupeMoments,
  momentOverlap,
  momentsSystem,
  parseMoments,
  runClipPlan,
  verifyItemText,
  type Candidate,
  type ClipPlanDeps,
  type ClipPlanPayload,
  type Moment,
  type PlanSentence,
} from '../../worker/src/clip-plan.js';
import { makeEnv, userClient, workerClient, type Env } from './helpers.js';
import { FFMPEG, ffprobeJson, makeTestVideo } from './final-helpers.js';
import { finishCleanupFixture, libassFfmpeg, seedClipProject, waitFor } from './helpers-clips.js';

const LIBASS = libassFfmpeg();
let env: Env;
beforeEach(async () => {
  env = await makeEnv({ config: { clipMinFreeGb: 0, workerMode: 'managed', managedJobTypes: ['clip_plan'], clipFfmpegPath: LIBASS, ...(LIBASS ? { ffmpegPath: LIBASS } : {}) } });
});
afterEach(async () => {
  await env.ctx.finalRender?.idle();
  await thumbsIdle(env.ctx);
  await env.close();
});
const user = () => userClient(env.app);

/** n câu × 10 từ (0,5 s/từ, cách 1 s): câu k = từ 10k..10k+9, `ừm` ở đầu và cuối mỗi câu. */
const sentencesOf = (n: number): string[] => Array.from({ length: n }, (_, i) => ['ừm', ...Array.from({ length: 8 }, (_, k) => `c${i}t${k + 1}`), 'ừm'].join(' '));
const seed = (n = 8, video: { seconds: number; size?: string } | false = false) => seedClipProject(env, { video, wordS: 0.5, sentences: sentencesOf(n) });
const filler = (i: number) => ({ kind: 'filler', start_word: i, end_word: i, quote: 'ừm', confidence: 0.97, reason: 'Tiếng đệm' });

describe('clip ghép: tạo và sửa qua API', () => {
  it('POST parts: thứ tự phát giữ nguyên, cột của dòng là khung bao, duration_s = tổng các đoạn, đoạn trích ngăn bằng …', async () => {
    const s = seed();
    const r = await user().post(`/api/projects/${s.projectId}/clips`, { parts: [{ start_word: 40, end_word: 49 }, { start_word: 10, end_word: 19 }], title: 'Ghép' });
    expect(r.status, r.raw).toBe(201);
    const c = r.body.clip;
    const a = snapBounds(s.transcript, 40, 49), b = snapBounds(s.transcript, 10, 19);
    expect(c.parts).toEqual([
      { start_word: 40, end_word: 49, start_s: a.start_s, end_s: a.end_s, start_sentence: 4, end_sentence: 4 },
      { start_word: 10, end_word: 19, start_s: b.start_s, end_s: b.end_s, start_sentence: 1, end_sentence: 1 },
    ]);
    expect(c).toMatchObject({ code: 'K1', status: 'approved', start_word: 10, end_word: 49, start_s: b.start_s, end_s: a.end_s, start_sentence: 1, end_sentence: 4 });
    expect(c.duration_s).toBeCloseTo(a.end_s - a.start_s + b.end_s - b.start_s, 3);
    expect(c.transcript_excerpt).toMatch(/^ừm c4t1 .* ừm … ừm c1t1 .* ừm$/);
    // một đoạn trong parts = clip thường
    const one = await user().post(`/api/projects/${s.projectId}/clips`, { parts: [{ start_word: 20, end_word: 29 }] });
    expect(one.body.clip).toMatchObject({ parts: null, start_word: 20, end_word: 29 });
    const single = await user().post(`/api/projects/${s.projectId}/clips`, { start_word: 20, end_word: 29 });
    expect(single.body.clip.parts).toBeNull();
    expect(single.body.clip.duration_s).toBe(one.body.clip.duration_s);
  });

  it('kiểm tra: đoạn chồng nhau, đoạn < 1,5 s, quá 6 đoạn, gửi cả start_word lẫn parts, thiếu cả hai, chỉ số sai', async () => {
    const s = seed(10);
    const post = (b: object) => user().post(`/api/projects/${s.projectId}/clips`, b);
    expect((await post({ parts: [{ start_word: 0, end_word: 9 }, { start_word: 5, end_word: 15 }] })).body.error.code).toBe('PARTS_OVERLAP');
    const short = await post({ parts: [{ start_word: 0, end_word: 9 }, { start_word: 25, end_word: 25 }] });
    expect([short.status, short.body.error.code, short.body.error.details.part]).toEqual([400, 'CLIP_LENGTH', 1]);
    expect(short.body.error.message).toMatch(/Đoạn 2/);
    expect((await post({ parts: Array.from({ length: 7 }, (_, k) => ({ start_word: k * 10, end_word: k * 10 + 9 })) })).status).toBe(400);
    expect((await post({ start_word: 0, end_word: 9, parts: [{ start_word: 20, end_word: 29 }, { start_word: 0, end_word: 9 }] })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ title: 'x' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ parts: [{ start_word: 0, end_word: 9 }, { start_word: 90, end_word: 999 }] })).body.error.code).toBe('INVALID_WORD_RANGE');
    // hai đoạn liền kề theo từ (đảo thứ tự): hợp lệ, không phát lặp khoảng lặng
    const adj = await post({ parts: [{ start_word: 10, end_word: 19 }, { start_word: 0, end_word: 9 }] });
    expect(adj.status, adj.raw).toBe(201);
    expect(adj.body.clip.parts[1].end_s).toBeLessThanOrEqual(adj.body.clip.parts[0].start_s);
  });

  it('PATCH parts: đổi thứ tự/đoạn → bám lại, giữ chữ đã sửa của từ còn trong clip, xoá làm gọn, revision+1; start/end đưa về một đoạn; captions ngoài các đoạn → 400', async () => {
    const s = seed();
    const c = (await user().post(`/api/projects/${s.projectId}/clips`, { parts: [{ start_word: 40, end_word: 49 }, { start_word: 10, end_word: 19 }] })).body.clip;
    const caps = await user().put(`/api/clips/${c.id}/captions`, { words: [{ i: 41, w: 'Cacao' }, { i: 12, w: 'Actiso' }] });
    expect(caps.status, caps.raw).toBe(200);
    expect(caps.body.clip.caption_words).toHaveLength(20);
    const out = await user().put(`/api/clips/${c.id}/captions`, { words: [{ i: 25, w: 'x' }] }); // trong khung bao nhưng ngoài các đoạn
    expect([out.status, out.body.error.code]).toEqual([400, 'INVALID_WORD_RANGE']);
    const same = await user().patch(`/api/clips/${c.id}`, { parts: [{ start_word: 40, end_word: 49 }, { start_word: 10, end_word: 19 }] });
    expect(same.body.clip.edit_revision).toBe(c.edit_revision); // không đổi gì
    const moved = (await user().patch(`/api/clips/${c.id}`, { parts: [{ start_word: 10, end_word: 19 }, { start_word: 40, end_word: 49 }, { start_word: 60, end_word: 69 }] })).body.clip;
    expect(moved.parts.map((p: any) => p.start_word)).toEqual([10, 40, 60]);
    expect(moved).toMatchObject({ start_word: 10, end_word: 69, edit_revision: c.edit_revision + 1, cleanup: null, caption_edited: true });
    expect(moved.caption_words.find((w: any) => w.i === 41).w).toBe('Cacao');
    expect(moved.caption_words.find((w: any) => w.i === 12).w).toBe('Actiso');
    expect(moved.caption_words.find((w: any) => w.i === 61).w).toBe('c6t1');
    expect((await user().patch(`/api/clips/${c.id}`, { parts: [{ start_word: 10, end_word: 19 }, { start_word: 15, end_word: 25 }] })).body.error.code).toBe('PARTS_OVERLAP');
    const single = (await user().patch(`/api/clips/${c.id}`, { start_word: 10, end_word: 29 })).body.clip;
    expect(single).toMatchObject({ parts: null, start_word: 10, end_word: 29, edit_revision: c.edit_revision + 2 });
    expect(single.caption_words.map((w: any) => w.i)).toEqual(Array.from({ length: 20 }, (_, k) => 10 + k));
  });
});

describe('làm gọn clip ghép', () => {
  it('payload theo thứ tự phát; chỗ bỏ trong từng đoạn; đoạn giữ lại nối theo thứ tự phát; chỗ bỏ vắt qua hai đoạn bị từ chối', async () => {
    const s = seed();
    // hai đoạn liền kề theo từ nhưng đảo thứ tự: từ 29 (cuối đoạn 2) và 30 (đầu đoạn 1) đều là "ừm"
    const c = (await user().post(`/api/projects/${s.projectId}/clips`, { parts: [{ start_word: 30, end_word: 39 }, { start_word: 20, end_word: 29 }] })).body.clip;
    const jobId = createCleanup(env.ctx, c.id);
    const payload = cleanupPayload(env.ctx, getJobRow(env.ctx, jobId));
    expect(payload.parts.map((p) => [p.start_word, p.end_word])).toEqual([[30, 39], [20, 29]]);
    expect(payload.words.map((w) => w.i)).toEqual([...Array.from({ length: 10 }, (_, k) => 30 + k), ...Array.from({ length: 10 }, (_, k) => 20 + k)]);
    expect([payload.start_s, payload.end_s]).toEqual([c.start_s, c.end_s]); // khung bao cho worker cũ
    // worker: prompt có lưu ý ranh giới đoạn; chỗ bỏ vắt qua hai đoạn bị chặn ngay ở worker
    const wp = payload as unknown as CleanupPayload;
    expect(cleanupSystem(wp)).toContain(MULTI_PART_NOTE);
    expect(JSON.parse(cleanupUserContent(wp)).parts).toHaveLength(2);
    const cross = { ...filler(29), end_word: 30, quote: 'ừm ừm' };
    expect(() => parseCleanupResult(JSON.stringify({ proposals: [cross], summary: 's' }), wp)).toThrow(/một đoạn/);
    expect(parseCleanupResult(JSON.stringify({ proposals: [filler(30), filler(29)], summary: 's' }), wp).proposals).toHaveLength(2);
    // server: chỗ bỏ chỉ được nằm trong một đoạn
    expect(() => completeCleanup(env.ctx, getJobRow(env.ctx, jobId), { proposals: [cross], summary: 's' })).toThrow(/một đoạn/);
    completeCleanup(env.ctx, getJobRow(env.ctx, jobId), { proposals: [filler(30), filler(29)], summary: 'Bỏ hai tiếng đệm' });
    env.ctx.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(jobId);
    const after = (await user().get(`/api/clips/${c.id}`)).body.clip;
    expect(after.cleanup.proposals.map((p: any) => [p.id, p.start_word])).toEqual([[1, 30], [2, 29]]); // mã theo thứ tự phát
    const seg = after.retained_segments;
    expect(seg).toHaveLength(2);
    expect(seg[0].start).toBeGreaterThan(seg[1].end); // đoạn sau trong video phát trước
    expect(seg[0].end).toBe(c.parts[0].end_s);
    expect(seg[1].start).toBe(c.parts[1].start_s);
    expect(after.edited_duration_s).toBeCloseTo(c.duration_s - (seg[0].start - c.parts[0].start_s) - (c.parts[1].end_s - seg[1].end), 3);
    expect(after.transcript_excerpt).toMatch(/^c3t1 .* ừm … ừm c2t1 .* c2t8$/);
    // chỉnh tay hai đầu chỗ bỏ: không được kéo sang đoạn khác
    const bad = await user().put(`/api/clips/${c.id}/cleanup`, { job_id: jobId, revision: 0, selected_ids: [1, 2], edits: [{ id: 2, start_word: 29, end_word: 30 }] });
    expect(bad.body.error.code).toBe('INVALID_CLEANUP');
    const ok = await user().put(`/api/clips/${c.id}/cleanup`, { job_id: jobId, revision: 0, selected_ids: [2] });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.clip.retained_segments[0]).toEqual({ start: c.parts[0].start_s, end: c.parts[0].end_s });
  });
});

describe('dựng clip ghép', () => {
  it('filtergraph/tham số (thuần): mỗi đoạn một input -ss/-t, select/atrim trong đoạn, concat theo thứ tự phát; không tiếng: concat a=0', () => {
    const parts = [{ duration: 2, segments: [{ start: 0, end: 0.8 }, { start: 1.2, end: 2 }] }, { duration: 1.5, segments: [{ start: 0, end: 1.5 }] }];
    const { graph } = buildFilterGraph({ srcW: 160, srcH: 284, aspect: 'source', reframe: 'native', ass: null, hasAudio: true, fps: 24, parts });
    expect(graph).toContain("[0:v]select='gte(t,0.000)*lt(t,0.800)+gte(t,1.200)*lt(t,2.000)',setpts='PTS-(0.000+0.400*gte(T,1.200))/TB',fps=24:start_time=0[pv0]");
    expect(graph).toContain("[1:v]select='gte(t,0.000)*lt(t,1.500)'");
    expect(graph).toContain('[0:a:0]asplit=2[ca0_0][ca0_1]');
    expect(graph).toContain('[sa0_0][sa0_1]concat=n=2:v=0:a=1[pa0]');
    expect(graph).toContain('[pv0][pa0][pv1][pa1]concat=n=2:v=1:a=1[joinedv][joineda]');
    expect(graph).toContain('[joineda]afade=t=in:st=0:d=0.06,afade=t=out:st=3.040:d=0.06[a]');
    expect(graph).toContain('[joinedv]scale=160:284:flags=lanczos,setsar=1[base]');
    const silent = buildFilterGraph({ srcW: 160, srcH: 284, aspect: 'source', reframe: 'native', ass: null, hasAudio: false, fps: 24, parts }).graph;
    expect(silent).toContain('[pv0][pv1]concat=n=2:v=1:a=0[joinedv]');
    expect(silent).not.toContain(':a:0');
    const args = buildClipArgs({ src: '/s.mp4', startS: 9, durS: 3.1, graph, hasAudio: true, editedAudio: true, inputs: [{ startS: 9, durS: 2 }, { startS: 1.25, durS: 1.5 }], out: '/o.mp4' });
    expect(args.join(' ')).toContain('-ss 9.000 -t 2.000 -i /s.mp4 -ss 1.250 -t 1.500 -i /s.mp4 -t 3.100 -filter_complex');
    expect(args.slice(args.indexOf('-map'))).toEqual(expect.arrayContaining(['[v]', '[a]']));
    expect(args).not.toContain('-af');
    // phần giữ lại (giây tuyệt đối, theo thứ tự phát) chia về từng đoạn
    expect(splitByParts([{ start_s: 10, end_s: 12 }, { start_s: 1, end_s: 2.5 }], [{ start: 10, end: 10.8 }, { start: 11.2, end: 12 }, { start: 1, end: 2.5 }])).toEqual(parts);
    expect(() => splitByParts([{ start_s: 10, end_s: 12 }, { start_s: 1, end_s: 2.5 }], [{ start: 1, end: 2.5 }, { start: 10, end: 12 }])).toThrow();
  });

  it.each([true, false])('ffmpeg thật: hai đoạn đảo thứ tự, có làm gọn trong đoạn 1 — độ dài bằng tổng phần giữ, có audio=%s', (audio) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multipart-'));
    try {
      const src = path.join(tmp, 'in.mp4'), out = path.join(tmp, 'out.mp4');
      makeTestVideo(src, 8, { size: '160x284', audio });
      const parts = [{ start_s: 5, end_s: 7 }, { start_s: 1, end_s: 2.5 }];
      const segments = [{ start: 5, end: 5.8 }, { start: 6.2, end: 7 }, { start: 1, end: 2.5 }];
      const durS = segmentDuration(segments);
      const graph = buildFilterGraph({ srcW: 160, srcH: 284, aspect: 'source', reframe: 'native', ass: null, hasAudio: audio, fps: 24, parts: splitByParts(parts, segments) }).graph;
      const r = spawnSync(FFMPEG!, buildClipArgs({ src, startS: 5, durS, graph, hasAudio: audio, editedAudio: true, inputs: parts.map((p) => ({ startS: p.start_s, durS: p.end_s - p.start_s })), out }), { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      const info = ffprobeJson(out);
      expect(Math.abs(Number(info.format.duration) - durS)).toBeLessThan(0.1);
      expect(info.streams.some((s: any) => s.codec_type === 'audio')).toBe(audio);
      // khung hình ở giây 2,0 của bản dựng là nguồn ở giây 1,4 (đoạn 2), không phải 6,6 hay 2,0
      const frame = (file: string, at: number) => spawnSync(FFMPEG!, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=16:28', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']).stdout;
      const diff = (a: Buffer, b: Buffer) => a.reduce((sum, n, i) => sum + Math.abs(n - b[i]!), 0) / a.length;
      const got = frame(out, 2.0);
      expect(diff(got, frame(src, 1.4))).toBeLessThan(Math.min(diff(got, frame(src, 6.6)), diff(got, frame(src, 2.0))));
      const first = frame(out, 0.4);
      expect(diff(first, frame(src, 5.4))).toBeLessThan(diff(first, frame(src, 1.4)));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('qua API: 2 đoạn không theo thời gian → bản dựng dài bằng tổng các đoạn, phụ đề theo thứ tự phát, đổi đoạn thì bản dựng cũ thành cũ', async () => {
    const s = seed(4, { seconds: 26, size: '160x284' });
    const c = (await user().post(`/api/projects/${s.projectId}/clips`, { parts: [{ start_word: 30, end_word: 39 }, { start_word: 0, end_word: 9 }] })).body.clip;
    finishCleanupFixture(env, c.id);
    await thumbsIdle(env.ctx);
    const r = await user().post(`/api/clips/${c.id}/render`, { aspect: 'source', captions_preset: LIBASS ? 'highlight' : 'none' });
    expect(r.status, r.raw).toBe(201);
    const cut = await waitFor(async () => (await user().get(`/api/clips/${c.id}`)).body.clip.latest_cut, (x) => x?.status !== 'rendering', 60_000, 'bản dựng');
    expect(cut.status, cut.error).toBe('ready');
    const info = ffprobeJson(path.join(env.root, cut.video_url.replace('/files/', '')));
    expect(Math.abs(Number(info.format.duration) - c.duration_s)).toBeLessThan(0.15);
    expect(cut.duration_s).toBeCloseTo(c.duration_s, 0);
    const srt = fs.readFileSync(path.join(env.root, cut.srt_url.replace('/files/', '')), 'utf8');
    expect(srt.indexOf('c3t1')).toBeGreaterThanOrEqual(0);
    expect(srt.indexOf('c3t1')).toBeLessThan(srt.indexOf('c0t1'));
    const lastCue = srt.trim().split('\n\n').at(-1)!;
    expect(Number(/--> 00:00:(\d+),/.exec(lastCue)![1])).toBeLessThanOrEqual(Math.ceil(c.duration_s));
    const snap = JSON.parse((env.ctx.db.prepare('SELECT edit_snapshot FROM clip_cuts WHERE id=?').get(cut.id) as { edit_snapshot: string }).edit_snapshot);
    expect(snap.parts.map((p: any) => p.start_word)).toEqual([30, 0]);
    expect((await user().get(`/api/clips/${c.id}`)).body.clip.latest_cut_stale).toBe(false);
    // đảo lại thứ tự: cùng các từ nhưng bản dựng không còn đúng
    await user().patch(`/api/clips/${c.id}`, { parts: [{ start_word: 0, end_word: 9 }, { start_word: 30, end_word: 39 }] });
    finishCleanupFixture(env, c.id);
    expect((await user().get(`/api/clips/${c.id}`)).body.clip.latest_cut_stale).toBe(true);
  }, 90_000);
});

describe('AI đề xuất clip ghép: kiểm tra phía server', () => {
  const q = (s: PlanSentence | { text: string }, from: number, n = 4) => s.text.split(' ').slice(from, from + n).join(' ');
  it('validateClipPlan: dò từng đoạn, giữ thứ tự phát, tổng độ dài theo preset, chồng nhau theo từng đoạn, caption_words nối theo thứ tự phát', () => {
    const s = seed(12);
    const t = s.transcript;
    const part = (id: number) => ({ start_id: id, end_id: id, start_quote: q(t.sentences[id]!, 0), end_quote: q(t.sentences[id]!, 6) });
    const asr = (a: number, b: number) => t.words.slice(a, b + 1).map((w) => ({ i: w.i, w: w.w }));
    const montage = { parts: [part(6), part(2)], start_id: 2, end_id: 6, title: 'Ghép', hook: 'H', score: 80, reason: 'R', caption_words: [...asr(60, 69), ...asr(20, 29)] };
    const preset = { min_s: 10, max_s: 12 }; // nới ±20%: 8–14,4 s
    const r = validateClipPlan(t, [montage, { ...montage, parts: [part(8), part(9)], caption_words: [...asr(90, 99), ...asr(80, 89)] }], { preset });
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0]!.parts!.map((p) => [p.start_word, p.end_word])).toEqual([[60, 69], [20, 29]]);
    expect(r.accepted[0]).toMatchObject({ start_word: 20, end_word: 69, start_sentence: 2, end_sentence: 6, verify: { status: 'unverified', boundary: 'word_quote' } });
    expect(r.accepted[0]!.caption_words!.map((w) => w.i).slice(9, 11)).toEqual([69, 20]);
    expect(r.accepted[1]!.caption_words).toBeNull(); // sai thứ tự phát → bỏ riêng phụ đề, giữ clip
    const bad = validateClipPlan(t, [
      { ...montage, parts: [part(1), part(2), part(3), part(4), part(5)] },
      { ...montage, parts: [part(6), { ...part(6), start_quote: q(t.sentences[6]!, 3) }] },
      { ...montage, parts: [part(6), part(2), part(9)] }, // tổng ≈ 16 s > 14,4 s
      { ...montage, parts: [part(6), { ...part(2), start_id: 99 }] },
    ], { preset });
    expect(bad.accepted).toEqual([]);
    expect(bad.rejected.map((x) => x.reason)).toEqual([expect.stringContaining('tối đa 4'), expect.stringContaining('chồng'), expect.stringContaining('tổng độ dài'), expect.stringContaining('Đoạn 2')]);
    expect(validateClipPlan(t, [montage], { preset, existing: [{ start_word: 60, end_word: 75 }] }).rejected[0]!.reason).toContain('chồng quá 60%');
    expect(validateClipPlan(t, [montage], { preset, existing: [{ start_word: 0, end_word: 69, parts: [{ start_word: 0, end_word: 9 }, { start_word: 40, end_word: 49 }] }] }).accepted).toHaveLength(1);
    expect(validateClipPlan(t, [montage], { preset, allowMulti: false }).rejected[0]!.reason).toContain('không cho ghép');
    // parts một phần tử = clip thường
    const one = validateClipPlan(t, [{ ...montage, parts: [{ ...part(3), end_id: 4, end_quote: q(t.sentences[4]!, 6) }], caption_words: undefined }], { preset });
    expect(one.accepted[0]).toMatchObject({ parts: null, start_word: 30, end_word: 49 });
  });

  it('job clip_plan: allow_multi trong payload; worker trả clip ghép → clip proposed có parts; exclude_existing gửi kèm parts cho worker', async () => {
    const s = seed(30);
    const worker = () => workerClient(env.app);
    env.ctx.config.workerMode = 'legacy';
    expect((await user().post(`/api/projects/${s.projectId}/clip-plan`, { allow_multi: 'có' })).status).toBe(400);
    const created = await user().post(`/api/projects/${s.projectId}/clip-plan`, { count: 3, duration_preset: '15_30', allow_multi: false });
    expect(created.status, created.raw).toBe(201);
    const job = (await worker().get('/api/worker/next?worker=w1')).body;
    expect(job.payload.allow_multi).toBe(false);
    const t = s.transcript;
    const part = (id: number) => ({ start_id: id, end_id: id, start_quote: q(t.sentences[id]!, 0), end_quote: q(t.sentences[id]!, 6) });
    const montage = { start_id: 2, end_id: 20, parts: [part(20), part(2), part(11)], title: 'Ghép ba', hook: 'H', score: 90, reason: 'Cùng chủ đề' };
    const off = await worker().post(`/api/worker/jobs/${job.id}/complete`, { result: { summary: 's', clips: [montage] } });
    expect(off.body.error.code).toBe('INVALID_CLIP_PLAN'); // người dùng tắt ghép đoạn
    const ok = await worker().post(`/api/worker/jobs/${job.id}/complete`, { result: { summary: 's', clips: [montage, { ...part(5), end_id: 7, end_quote: q(t.sentences[7]!, 6), title: 'Liền', hook: 'H', score: 70, reason: 'R' }] } });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.job.result).toMatchObject({ created: 1, rejected: 1 });
    // job mặc định cho phép ghép
    await user().post(`/api/projects/${s.projectId}/clip-plan`, { count: 3, duration_preset: '15_30' });
    const job2 = (await worker().get('/api/worker/next?worker=w1')).body;
    expect(job2.payload.allow_multi).toBe(true);
    const done = await worker().post(`/api/worker/jobs/${job2.id}/complete`, { result: { summary: 's', clips: [montage] } });
    expect(done.status, done.raw).toBe(200);
    const clips = (await user().get(`/api/clip-projects/${s.projectId}`)).body.clips;
    const m = clips.find((c: any) => c.parts);
    expect(m).toMatchObject({ status: 'proposed', created_by: 'agent', title: 'Ghép ba' });
    expect(m.parts.map((p: any) => p.start_sentence)).toEqual([20, 2, 11]);
    await user().post(`/api/projects/${s.projectId}/clip-plan`, { exclude_existing: true });
    const job3 = (await worker().get('/api/worker/next?worker=w1')).body;
    expect(job3.payload.existing).toEqual(expect.arrayContaining([
      { start_id: 5, end_id: 7, title: 'Liền' },
      { start_id: 2, end_id: 20, title: 'Ghép ba', parts: [{ start_id: 20, end_id: 20, start_word: 200, end_word: 209 }, { start_id: 2, end_id: 2, start_word: 20, end_word: 29 }, { start_id: 11, end_id: 11, start_word: 110, end_word: 119 }] },
    ]));
  });
});

// ---------------------------------------------------------------- worker

/** n câu × 10 giây (id = chỉ số), câu i = `s<i>w0 … s<i>w9`, từ toàn cục 10i..10i+9. */
const mkSentences = (n: number): PlanSentence[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, start: i * 11, end: i * 11 + 10, start_word: i * 10, text: Array.from({ length: 10 }, (_, k) => `s${i}w${k}`).join(' ') }));
const preset = { key: '30_60', min_s: 30, max_s: 60, ideal_min_s: 38, ideal_max_s: 55 };
const head = (s: PlanSentence) => s.text.split(' ').slice(0, 5).join(' ');
const tail = (s: PlanSentence) => s.text.split(' ').slice(-5).join(' ');
const mpart = (ss: PlanSentence[], a: number, b: number) => ({ start_id: a, end_id: b, start_quote: head(ss[a]!), end_quote: tail(ss[b]!) });

describe('worker: prompt, đọc và kiểm tra clip ghép', () => {
  it('prompt: hướng dẫn ghép bằng tiếng Việt, ví dụ JSON có cả đoạn liền mạch và clip ghép; tắt thì không nhắc parts', () => {
    const base = { contentType: 'podcast', density: 'vừa', preset, want: 6, windowIndex: 0, windowCount: 1 };
    const on = momentsSystem({ ...base, allowMulti: true });
    for (const must of ['CLIP GHÉP NHIỀU ĐOẠN', 'KHÔNG phải mặc định', 'câu hỏi và câu trả lời', 'CÙNG MỘT chủ đề', 'không ghép những nội dung không liên quan', 'THỨ TỰ PHÁT', 'TỔNG độ dài', '2–4 phần', 'khoảng 3 giây']) expect(on, must).toContain(must);
    const example = JSON.parse(on.slice(on.indexOf('{"moments"')));
    expect(example.moments[0]).toMatchObject({ start_id: 123, end_id: 131 });
    expect(example.moments[1].parts.map((p: any) => p.start_id)).toEqual([245, 210]);
    const off = momentsSystem(base);
    expect(off).not.toContain('parts');
    expect(off).toContain('Đoạn là dãy câu LIÊN TIẾP');
    expect(VERIFY_SYSTEM).toContain('--- đoạn 1 ---');
    expect(VERIFY_SYSTEM).toContain('fix: null');
  });

  it('parseMoments + checkMoment: parts theo thứ tự phát, khung bao; loại chồng nhau, quá ngắn, quá 4 đoạn, tổng ngoài khoảng', () => {
    const ss = mkSentences(40);
    const byId = new Map(ss.map((s) => [s.id, s]));
    const ms = parseMoments(JSON.stringify({ moments: [
      { parts: [mpart(ss, 20, 21), mpart(ss, 5, 6)], title: 'T', hook: 'H', score: 80, reason: 'R' },
      { parts: [mpart(ss, 3, 5)], title: 'Một', hook: 'H', score: 70, reason: 'R' },
      { parts: [{ start_id: 'x' }, mpart(ss, 1, 2)], title: 'Hỏng', score: 1 },
    ] }))!;
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ start_id: 5, end_id: 21, start_quote: head(ss[20]!) });
    expect(ms[1]).toMatchObject({ start_id: 3, end_id: 5 });
    expect(ms[1]!.parts).toBeUndefined();
    const c = checkMoment(ms[0]!, byId, preset);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.moment.parts!.map((p) => [p.start_word, p.end_word, p.boundary])).toEqual([[200, 219, 'word_quote'], [50, 69, 'word_quote']]);
    expect(c.moment).toMatchObject({ start_word: 50, end_word: 219, boundary: 'word_quote' });
    const m = (parts: object[]): Moment => ({ ...ms[0]!, parts: parts as never });
    expect(checkMoment(m([mpart(ss, 5, 6), mpart(ss, 6, 7)]), byId, preset)).toMatchObject({ ok: false, reason: expect.stringContaining('chồng') });
    expect(checkMoment(m([mpart(ss, 1, 1), mpart(ss, 3, 3), mpart(ss, 5, 5), mpart(ss, 7, 7), mpart(ss, 9, 9)]), byId, preset)).toMatchObject({ ok: false, reason: expect.stringContaining('tối đa 4') });
    expect(checkMoment(m([mpart(ss, 1, 1), mpart(ss, 3, 3)]), byId, preset)).toMatchObject({ ok: false, reason: expect.stringContaining('tổng độ dài') }); // 20 s < 24
    expect(checkMoment(m([mpart(ss, 1, 3), { start_id: 9, end_id: 9, start_quote: 's9w9', end_quote: 's9w9' }]), byId, preset)).toMatchObject({ ok: false, reason: expect.stringContaining('chỉ dài 1.0 giây') });
  });

  it('khử trùng theo từng đoạn; kiểm định hiện các đoạn theo thứ tự và không sửa điểm cắt clip ghép', () => {
    const ss = mkSentences(40);
    const byId = new Map(ss.map((s) => [s.id, s]));
    const ok = (mm: Moment) => { const c = checkMoment(mm, byId, preset); if (!c.ok) throw new Error(c.reason); return c.moment; };
    const montage = ok({ start_id: 0, end_id: 0, start_quote: '', parts: [mpart(ss, 20, 21), mpart(ss, 5, 6)], title: 'alpha', hook: 'H', score: 90, reason: 'one' });
    const single = ok({ ...mpart(ss, 20, 22), title: 'beta', hook: 'H', score: 80, reason: 'two' });
    const other = ok({ ...mpart(ss, 30, 33), title: 'gamma', hook: 'H', score: 70, reason: 'three' });
    expect(momentOverlap(montage, single)).toBeCloseTo(2 / 3); // chung 20 từ / 30 từ của clip ngắn hơn
    expect(dedupeMoments([single, montage, other]).map((x) => x.title)).toEqual(['alpha', 'gamma']);
    expect(dedupeMoments([montage, other], [{ start_id: 5, end_id: 6 }]).map((x) => x.title)).toEqual(['gamma']);
    expect(dedupeMoments([single], [{ start_id: 0, end_id: 39, parts: [{ start_id: 0, end_id: 1 }, { start_id: 22, end_id: 23 }] }])).toHaveLength(1); // chung 1/3 câu
    expect(dedupeMoments([single], [{ start_id: 0, end_id: 39, parts: [{ start_id: 0, end_id: 1 }, { start_id: 21, end_id: 23 }] }])).toHaveLength(0); // chung 2/3 câu
    const cand = { ...montage, window: 0 } as Candidate;
    const text = verifyItemText({ key: 'c1', candidate: cand }, ss);
    expect(text).toContain('CLIP GHÉP 2 đoạn');
    const body = text.slice(text.indexOf('<loi_thoai>'));
    expect(body.indexOf('--- đoạn 1 ---')).toBeLessThan(body.indexOf('[S0020'));
    expect(body.indexOf('[S0020')).toBeLessThan(body.indexOf('--- đoạn 2 ---'));
    expect(body.indexOf('--- đoạn 2 ---')).toBeLessThan(body.indexOf('[S0005'));
    expect(applyFix(cand, { start_id: 19, end_id: 23 }, ss, preset)).toBeNull();
  });

  it('runClipPlan: clip ghép đi hết luồng (kiểm định, lưới khung đoạn 1, khôi phục dấu câu nối theo thứ tự phát) và kết quả mang parts; allow_multi=false thì loại', async () => {
    const ss = mkSentences(40);
    const montageJson = JSON.stringify({ moments: [
      { parts: [mpart(ss, 20, 21), mpart(ss, 5, 6)], title: 'alpha ghép', hook: 'H', score: 90, reason: 'one' },
      { ...mpart(ss, 30, 33), title: 'gamma liền', hook: 'H', score: 70, reason: 'three' },
    ] });
    const grids: number[][] = [];
    const systems: string[] = [];
    const deps: ClipPlanDeps = {
      alive: async () => undefined,
      checkpoint: async () => undefined,
      grid: async (a, b) => { grids.push([a, b]); return null; },
      infer: async (messages) => {
        const sys = String((messages[0] as any).content);
        systems.push(sys);
        const u = (messages.find((m: any) => m.role === 'user') as any).content;
        const text = typeof u === 'string' ? u : u.map((p: any) => p.text ?? '').join('\n');
        if (sys.includes('phân loại nội dung')) return { content: '{"content_type":"podcast","information_density":"cao"}' };
        if (sys.includes('biên tập viên chọn đoạn')) return { content: montageJson };
        if (sys.includes('kiểm định')) {
          const keys = [...text.matchAll(/Ứng viên (c\d+):/g)].map((m) => m[1]);
          return { content: JSON.stringify({ results: keys.map((id) => ({ id, keep: true, standalone_score: 0.8, diagnosis: 'none', fix: { start_id: 19, end_id: 23 } })) }) };
        }
        const words = /<loi_thoai>\n([\s\S]*?)\n<\/loi_thoai>/.exec(text)![1]!.split(' ');
        return { content: JSON.stringify({ text: words.map((w, k) => (k === 0 ? w.toUpperCase() : w)).join(' ') }) };
      },
    };
    const payload: ClipPlanPayload = { source: { path: null, duration_s: 500 }, sentences: ss, windows: [{ from_id: 0, to_id: 39 }], count: 2, duration_preset: preset, existing: [] };
    const r = await runClipPlan(payload, deps);
    expect(systems.find((x) => x.includes('biên tập viên chọn đoạn'))).toContain('CLIP GHÉP NHIỀU ĐOẠN');
    const m = r.clips.find((c) => c.title === 'alpha ghép')!;
    expect(m.parts!.map((p) => [p.start_id, p.end_id, p.start_word, p.end_word])).toEqual([[20, 21, 200, 219], [5, 6, 50, 69]]);
    expect([m.start_id, m.end_id, m.start_word]).toEqual([5, 21, undefined]);
    expect(m.verify.status).toBe('kept'); // fix của kiểm định bị bỏ qua cho clip ghép
    expect(m.caption_words!.map((w) => w.i).slice(18, 22)).toEqual([218, 219, 50, 51]);
    expect(m.caption_words![0]!.w).toBe('S20W0');
    expect(grids).toContainEqual([ss[20]!.start, ss[21]!.end]); // lưới khung lấy từ đoạn phát đầu tiên
    const single = r.clips.find((c) => c.title === 'gamma liền')!;
    expect(single.parts).toBeUndefined();
    const off = await runClipPlan({ ...payload, allow_multi: false }, deps);
    expect(off.clips.map((c) => c.title)).toEqual(['gamma liền']);
    expect(off.diagnostics!.rejected[0]!.reason).toContain('không cho ghép');
  });
});
