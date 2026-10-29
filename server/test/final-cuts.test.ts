import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { maybeAutoFinalCut } from '../src/services/final-cuts.js';
import { sweepStaleJobs } from '../src/services/jobs.js';
import { FakeRenderer } from './final-helpers.js';
import { claim, claimEditPlan, edlFor, makeEnv, setupAllDone, setupProject, toStoryboardReview, toVideoReview, userClient, writeFile, type Env, type Scenario } from './helpers.js';

let env: Env;
let fake: FakeRenderer;
const SLUG = 'cacao-actiso-plus';

async function mk(opts: Parameters<typeof makeEnv>[0] = {}, renderer = new FakeRenderer()) {
  fake = renderer;
  env = await makeEnv({ finalRenderer: fake, finalRender: { progressThrottleMs: 0 }, ...opts });
}
beforeEach(async () => {
  await mk();
});
afterEach(async () => {
  fake.release();
  await env.close();
});

const idle = () => env.ctx.finalRender!.idle();
const cutsOf = async (sc: Scenario) => (await sc.user.get(`/api/projects/${sc.project.id}/final-cuts`)).body as any[];
/** Hoàn thành job edit_plan bằng EDL hợp lệ rồi chờ render xong. */
async function planAndRender(sc: Scenario, cutId?: number) {
  const job = await claimEditPlan(sc);
  const cut = (await sc.user.get(`/api/final-cuts/${cutId ?? job.payload.final_cut_id}`)).body;
  const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 'Cắt đầu cuối mỗi cảnh.' } });
  expect(r.status, r.raw).toBe(200);
  await idle();
  return { job, cut: (await sc.user.get(`/api/final-cuts/${cut.id}`)).body };
}

describe('tự kích hoạt', () => {
  it('chọn video của cảnh cuối → tạo final_cut v1 (planning, claude) + job edit_plan (không duyệt, không credit); không tạo sớm', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    const [a, b] = sc.scenes.map((s: any) => s.id);
    await toStoryboardReview(sc, a);
    await toVideoReview(sc, a);
    await sc.user.post(`/api/scenes/${a}/select-video`, {});
    expect(await cutsOf(sc)).toEqual([]); // cảnh b chưa done
    await toStoryboardReview(sc, b);
    await toVideoReview(sc, b);
    expect(await cutsOf(sc)).toEqual([]); // b mới video_review
    await sc.user.post(`/api/scenes/${b}/select-video`, {});

    const cuts = await cutsOf(sc);
    expect(cuts).toHaveLength(1);
    const c = cuts[0];
    expect(c).toMatchObject({ version: 1, status: 'planning', created_by: 'claude', renderer: null, video_path: null, video_url: null, outdated: false, edl: null, progress: null, error: null });
    expect(c.selection.map((s: any) => [s.code, s.attempt])).toEqual([['C1', 1], ['C2', 1]]);
    expect(c.selection[0]).toMatchObject({ scene_id: a, video_url: expect.stringContaining('/files/output/'), duration_s: 10 });
    const jobs = (await sc.user.get('/api/jobs?type=edit_plan')).body;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: c.job_id, type: 'edit_plan', status: 'queued', scene_id: null, scene_code: null, requires_approval: false, approved_at: null, credits_cost: 0 });
    // project summary
    const p = (await sc.user.get(`/api/projects/${sc.project.id}`)).body;
    expect(p.latest_final_cut).toEqual({ id: c.id, version: 1, status: 'planning', progress: null, stage: null, failed_stage: null, watermark_removed: false, url: null, duration_s: null, outdated: false, error: null });
    expect(p.final_cut_block).toEqual({ code: 'FINAL_CUT_ACTIVE', message: 'Đang chọn điểm cắt cho bản hoàn chỉnh v1' });
    expect((await sc.user.get('/api/projects')).body[0].latest_final_cut.version).toBe(1);
    // không tốn credit
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body).toMatchObject({ used: 30, reserved: 0 });
  });

  it('idempotent: chọn lại cùng video / gọi lại nhiều lần / hai instance cùng lúc không tạo trùng', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    expect(await cutsOf(sc)).toHaveLength(1);
    await sc.user.post(`/api/scenes/${sc.scenes[1].id}/select-video`, {});
    expect(maybeAutoFinalCut(env.ctx, sc.project.id)).toBeNull();
    const app2 = await env.second();
    const [r1, r2] = await Promise.all([Promise.resolve(maybeAutoFinalCut(env.ctx, sc.project.id)), Promise.resolve(maybeAutoFinalCut(app2.ctx, sc.project.id))]);
    expect([r1, r2]).toEqual([null, null]);
    expect(await cutsOf(sc)).toHaveLength(1);
    expect((await sc.user.get('/api/jobs?type=edit_plan')).body).toHaveLength(1);
  });

  it('hai tiến trình cùng kích hoạt khi dự án chưa có bản nào: chỉ MỘT bản được tạo (BEGIN IMMEDIATE)', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    env.ctx.db.prepare('DELETE FROM jobs WHERE type = ?').run('edit_plan');
    env.ctx.db.prepare('DELETE FROM final_cuts').run();
    const app2 = await env.second();
    const results = await Promise.all([env.ctx, app2.ctx, env.ctx, app2.ctx].map((c) => Promise.resolve().then(() => maybeAutoFinalCut(c, sc.project.id))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await cutsOf(sc)).toHaveLength(1);
  });

  it('bản failed/cancelled không chặn: hủy v1 rồi chọn lại cùng video → tạo v2', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const [c1] = await cutsOf(sc);
    expect((await sc.user.post(`/api/final-cuts/${c1.id}/cancel`, {})).body.final_cut.status).toBe('cancelled');
    await sc.user.post(`/api/scenes/${sc.scenes[0].id}/select-video`, {});
    const cuts = await cutsOf(sc);
    expect(cuts.map((c) => [c.version, c.status])).toEqual([[2, 'planning'], [1, 'cancelled']]);
  });

  it('đổi video được chọn sau khi có bản → bản cũ outdated, tự tạo bản mới cho lựa chọn mới', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await planAndRender(sc);
    expect((await cutsOf(sc))[0]).toMatchObject({ version: 1, status: 'ready', outdated: false });
    // tạo lại video lượt 2 rồi chọn nó
    await sc.user.post(`/api/scenes/${id}/comments`, { body: 'lại', action: 'regenerate_same' });
    await (await import('./helpers.js')).finish(sc, await claim(sc));
    // chưa chọn: bản v1 đã outdated? lựa chọn hiện tại vẫn là v1 nên chưa
    const sel = (await sc.user.get(`/api/scenes/${id}`)).body.assets.filter((a: any) => a.kind === 'video');
    expect((await cutsOf(sc))[0].outdated).toBe(false);
    await sc.user.post(`/api/scenes/${id}/select-video`, { asset_id: sel[1].id });
    const cuts = await cutsOf(sc);
    expect(cuts.map((c) => [c.version, c.status, c.outdated])).toEqual([[2, 'planning', false], [1, 'ready', true]]);
    const p = (await sc.user.get(`/api/projects/${sc.project.id}`)).body;
    expect(p.latest_final_cut).toMatchObject({ version: 2, status: 'planning', outdated: false });
  });
});

describe('POST /api/projects/:id/final-cuts (thủ công)', () => {
  it('SCENES_NOT_READY liệt kê mã cảnh chưa có video; FINAL_CUT_ACTIVE khi đang planning; tạo version mới kể cả khi đã có bản cũ', async () => {
    const sc = await setupProject(env, { scenes: 3 });
    const u = sc.user;
    const r = await u.post(`/api/projects/${sc.project.id}/final-cuts`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'SCENES_NOT_READY', message: 'Còn C1, C2, C3 chưa chọn video' });
    for (const s of sc.scenes.slice(0, 1)) {
      await toStoryboardReview(sc, s.id);
      await toVideoReview(sc, s.id);
      await u.post(`/api/scenes/${s.id}/select-video`, {});
    }
    expect((await u.post(`/api/projects/${sc.project.id}/final-cuts`, {})).body.error.message).toBe('Còn C2, C3 chưa chọn video');
    expect((await u.get(`/api/projects/${sc.project.id}`)).body.final_cut_block.message).toBe('Còn C2, C3 chưa chọn video');
    expect((await u.post('/api/projects/9999/final-cuts', {})).status).toBe(404);

    const sc2 = await setupAllDone(env, { scenes: 1, project: { name: 'Dự án hai' } });
    const dup = await sc2.user.post(`/api/projects/${sc2.project.id}/final-cuts`, {});
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('FINAL_CUT_ACTIVE');
    await planAndRender(sc2);
    const ok = await sc2.user.post(`/api/projects/${sc2.project.id}/final-cuts`, {});
    expect(ok.status).toBe(201);
    expect(ok.body.final_cut).toMatchObject({ version: 2, status: 'planning', created_by: 'claude', outdated: false });
    expect(ok.body.job).toMatchObject({ type: 'edit_plan', status: 'queued', id: ok.body.final_cut.job_id });
    expect((await cutsOf(sc2)).map((c) => c.version)).toEqual([2, 1]);
  });
});

describe('job edit_plan (worker)', () => {
  it('payload tính lúc claim: scenes (abs_path, thời lượng, comment có timecode chưa xử lý, lưới, kết luận), constraints, output', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    const [a] = sc.scenes.map((s: any) => s.id);
    await sc.user.post(`/api/scenes/${a}/comments`, { body: 'Chữ méo giây 3', timecode: 3.2, action: 'note' });
    await sc.user.post(`/api/scenes/${a}/comments`, { body: 'Không có mốc thời gian', action: 'note' });
    const done = await sc.user.post(`/api/scenes/${a}/comments`, { body: 'Đã xử lý', timecode: 1, action: 'note' });
    await sc.user.patch(`/api/comments/${done.body.comment.id}`, { resolved: true });
    const job = await claimEditPlan(sc);
    expect(job).toMatchObject({ type: 'edit_plan', status: 'claimed', scene_id: null, requires_approval: false });
    const p = job.payload;
    expect(Object.keys(p).sort()).toEqual(['constraints', 'final_cut_id', 'output', 'project', 'requeued', 'scenes', 'version']);
    expect(p.version).toBe(1);
    expect(p.project).toEqual({ id: sc.project.id, slug: SLUG, name: 'Cacao Actiso Plus', style_lock: '' });
    expect(p.constraints).toEqual({ aspect: '9:16', transition: 'cut', min_segment_s: 0.3, keep_scene_order: true });
    expect(p.output).toEqual({
      video_path: `output/${SLUG}/final/${SLUG}_final_v1.mp4`,
      contact_sheet_path: `output/${SLUG}/final/${SLUG}_final_v1_contact.png`,
    });
    expect(p.requeued).toBe(false);
    expect(p.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2']);
    const s1 = p.scenes[0];
    expect(Object.keys(s1).sort()).toEqual(
      ['abs_path', 'asset_id', 'attempt', 'code', 'comments', 'duration_s', 'fps', 'grid_path', 'height', 'prompt', 'scene_id', 'title', 'verdict', 'verdict_note', 'video_path', 'width'].sort(),
    );
    expect(s1).toMatchObject({
      scene_id: a,
      attempt: 1,
      video_path: `output/${SLUG}/video/C1_v1.mp4`,
      abs_path: path.join(env.root, `output/${SLUG}/video/C1_v1.mp4`),
      duration_s: 10,
      width: 720,
      height: 1280,
      grid_path: `output/${SLUG}/video/C1_v1_grid.jpg`,
      verdict: 'pass',
      verdict_note: 'ổn C1',
      title: 'Cảnh 1',
    });
    expect(s1.comments.map((c: any) => [c.body, c.timecode])).toEqual([['Chữ méo giây 3', 3.2]]);
    expect(p.scenes[1].comments).toEqual([]);
    expect(fs.existsSync(path.join(env.root, 'output', SLUG, 'final'))).toBe(true); // thư mục đầu ra được tạo sẵn
    // claim không đổi trạng thái cảnh
    expect((await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body.map((s: any) => s.status)).toEqual(['done', 'done']);
  });

  it('complete với EDL hợp lệ: job done, không credit, bản dựng → rendering → ready; event + dòng log.md + SSE', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
    const sseRes = await fetch(`${base}/api/stream?projectId=${sc.project.id}`);
    const seen: { status: string; progress: number | null }[] = [];
    let buf = '';
    const reader = sseRes.body!.getReader();
    void (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.includes('event: final_cut.updated')) {
            const d = JSON.parse(/^data: (.+)$/m.exec(block)![1]!);
            seen.push({ status: d.final_cut.status, progress: d.final_cut.progress });
          }
        }
      }
    })();
    const before = (await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body;
    let job: any;
    let cut: any;
    try {
      ({ job, cut } = await planAndRender(sc));
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      void reader.cancel();
    }

    expect((await sc.user.get(`/api/jobs/${job.id}`)).body).toMatchObject({ status: 'done', credits_cost: 0 });
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body).toEqual(before); // không tốn credit
    expect(cut).toMatchObject({
      version: 1,
      status: 'ready',
      renderer: 'ffmpeg',
      video_path: `output/${SLUG}/final/${SLUG}_final_v1.mp4`,
      video_url: `/files/output/${SLUG}/final/${SLUG}_final_v1.mp4`,
      contact_sheet_path: `output/${SLUG}/final/${SLUG}_final_v1_contact.png`,
      contact_sheet_url: `/files/output/${SLUG}/final/${SLUG}_final_v1_contact.png`,
      project_file_path: null,
      progress: 100,
      summary: 'Cắt đầu cuối mỗi cảnh.',
      error: null,
      outdated: false,
    });
    expect(cut.duration_s).toBe(18); // (9.5-0.5) × 2 (renderer giả không có ffprobe thật → tổng đoạn)
    expect(cut.finished_at).toBeTruthy();
    expect(cut.edl.scenes[0]).toMatchObject({ segments: [{ in_s: 0.5, out_s: 9.5 }], note: 'ghi chú C1' });
    expect(Object.keys(cut).sort()).toEqual(
      [
        'contact_sheet_path', 'contact_sheet_url', 'created_at', 'created_by', 'duration_s', 'edl', 'error', 'failed_stage', 'finished_at', 'id', 'job_id', 'note',
        'outdated', 'progress', 'project_file_path', 'project_id', 'raw_video_path', 'raw_video_url', 'render_ref', 'renderer', 'selection', 'selection_signature',
        'stage', 'status', 'summary', 'version', 'video_path', 'video_url', 'watermark_meta', 'watermark_removed',
      ].sort(),
    );
    // renderer nhận đúng các đoạn theo thứ tự, caption "C1 v1 #1"
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.segments.map((s) => [s.caption, s.in_s, s.out_s, path.basename(s.path)])).toEqual([
      ['C1 v1 #1', 0.5, 9.5, 'C1_v1.mp4'],
      ['C2 v1 #1', 0.5, 9.5, 'C2_v1.mp4'],
    ]);
    expect(fs.readFileSync(path.join(env.root, cut.video_path), 'utf8')).toBe('fake-final-v1');
    // event + log.md
    const events = (await sc.user.get(`/api/projects/${sc.project.id}/events`)).body.map((e: any) => e.type);
    expect(events).toEqual(expect.arrayContaining(['final_cut.created', 'final_cut.planned', 'final_cut.ready']));
    const log = fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8');
    expect(log.trimEnd().split('\n').at(-1)).toBe('| FINAL | v1 | bản dựng (ffmpeg, cắt thẳng) | Cắt đầu cuối mỗi cảnh. | Sẵn sàng |');
    expect((await sc.user.get(`/api/projects/${sc.project.id}/log.md`)).raw).toContain('| FINAL | v1 | bản dựng (ffmpeg, cắt thẳng) | Cắt đầu cuối mỗi cảnh. | Sẵn sàng |');
    // SSE (mở sau khi bản đã ở planning): rendering (tiến độ tăng dần) → ready
    expect(seen.map((s) => s.status)).toEqual(expect.arrayContaining(['rendering', 'ready']));
    expect(seen.at(-1)).toEqual({ status: 'ready', progress: 100 });
    const prog = seen.filter((s) => s.status === 'rendering' && s.progress !== null).map((s) => s.progress);
    expect(prog).toEqual([0, 25, 50, 90]);
    void reader.cancel();
  });

  it('EDL sai → 400 INVALID_EDL nêu rõ cảnh/đoạn; job vẫn claimed để sửa và gọi lại; bản vẫn planning', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    const good = edlFor(sc, cut);
    const mut = (fn: (e: any) => void) => {
      const e = JSON.parse(JSON.stringify(good));
      fn(e);
      return e;
    };
    const complete = (edl: unknown, summary: string | null = 'tóm tắt') => sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl, summary } });
    const cases: [string, any, RegExp][] = [
      ['thiếu cảnh', mut((e) => e.scenes.pop()), /cần đủ 2 cảnh \(C1, C2\), nhận được 1/],
      ['sai thứ tự', mut((e) => e.scenes.reverse()), /vị trí 1 phải là cảnh C1.*không được đổi thứ tự/],
      ['sai asset_id', mut((e) => (e.scenes[1].asset_id = 99999)), /cảnh C2 phải dùng asset_id \d+/],
      ['không có đoạn', mut((e) => (e.scenes[0].segments = [])), /cảnh C1 phải giữ lại ít nhất một đoạn/],
      ['in âm', mut((e) => (e.scenes[0].segments = [{ in_s: -1, out_s: 5 }])), /cảnh C1, đoạn 1: in_s = -1 nhỏ hơn 0/],
      ['out vượt thời lượng', mut((e) => (e.scenes[1].segments = [{ in_s: 0, out_s: 12 }])), /cảnh C2, đoạn 1: out_s = 12 vượt thời lượng video \(10 giây\)/],
      ['in vượt thời lượng', mut((e) => (e.scenes[1].segments = [{ in_s: 10.5, out_s: 11 }])), /cảnh C2, đoạn 1: in_s = 10.5 vượt thời lượng/],
      ['in >= out', mut((e) => (e.scenes[0].segments = [{ in_s: 5, out_s: 5 }])), /cảnh C1, đoạn 1: in_s \(5\) phải nhỏ hơn out_s \(5\)/],
      ['đoạn quá ngắn', mut((e) => (e.scenes[0].segments = [{ in_s: 1, out_s: 1.2 }])), /cảnh C1, đoạn 1: dài 0.2 giây, mỗi đoạn phải ≥ 0.3 giây/],
      ['chồng nhau', mut((e) => (e.scenes[0].segments = [{ in_s: 0, out_s: 5 }, { in_s: 4, out_s: 8 }])), /cảnh C1, đoạn 2: in_s = 4 chồng lên đoạn trước \(kết thúc ở 5\)/],
      ['không tăng dần', mut((e) => (e.scenes[0].segments = [{ in_s: 6, out_s: 8 }, { in_s: 1, out_s: 3 }])), /cảnh C1, đoạn 2: in_s = 1 chồng lên đoạn trước/],
      ['sai kiểu', mut((e) => (e.scenes[1].segments[0].in_s = 'abc')), /cảnh thứ 2 \(C2\), đoạn 1: trường segments\.0\.in_s|cảnh thứ 2 \(C2\), đoạn 1/],
      ['removed lỗi', mut((e) => (e.scenes[0].removed = [{ from_s: 5, to_s: 3, reason: 'x' }])), /cảnh C1, đoạn bị bỏ 1: cần 0 ≤ from_s < to_s/],
      ['không phải object', 'không phải EDL', /cấu trúc EDL/],
    ];
    for (const [name, edl, re] of cases) {
      const r = await complete(edl);
      expect(r.status, name).toBe(400);
      expect(r.body.error.code, name).toBe('INVALID_EDL');
      expect(r.body.error.message, name).toMatch(/^EDL không hợp lệ — /);
      expect(r.body.error.message, name).toMatch(re);
    }
    expect((await complete(good, null)).body.error.code).toBe('VALIDATION_ERROR'); // thiếu summary
    expect((await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { summary: 's' } })).body.error.code).toBe('INVALID_EDL'); // thiếu edl
    // job và bản dựng không bị đổi
    expect((await sc.user.get(`/api/jobs/${job.id}`)).body.status).toBe('claimed');
    expect((await sc.user.get(`/api/final-cuts/${cut.id}`)).body).toMatchObject({ status: 'planning', edl: null });
    expect(fake.calls).toHaveLength(0);
    // sửa và gọi lại → thành công; đoạn sát ranh giới (out = duration) và chạm nhau được chấp nhận
    const fixed = mut((e) => (e.scenes[0].segments = [{ in_s: 0, out_s: 4 }, { in_s: 4, out_s: 10 }]));
    expect((await complete(fixed)).status).toBe(200);
    await idle();
    const done = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(done.status).toBe('ready');
    expect(done.duration_s).toBe(10 + 9);
    expect(fake.calls[0]!.segments.map((s) => s.caption)).toEqual(['C1 v1 #1', 'C1 v1 #2', 'C2 v1 #1']);
  });

  it('EDL không ghi removed → server suy ra khoảng bị bỏ; số được làm tròn mili giây và out > duration chút ít được cắt về duration', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    const edl = { scenes: [{ scene_id: cut.selection[0].scene_id, asset_id: cut.selection[0].asset_id, segments: [{ in_s: 0.3004, out_s: 5.12345 }, { in_s: 6, out_s: 10.03 }] }] };
    const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl, summary: 'x' } });
    expect(r.status, r.raw).toBe(200);
    await idle();
    const done = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(done.edl.scenes[0]).toEqual({
      scene_id: cut.selection[0].scene_id,
      asset_id: cut.selection[0].asset_id,
      segments: [{ in_s: 0.3, out_s: 5.123 }, { in_s: 6, out_s: 10 }],
      removed: [{ from_s: 0, to_s: 0.3, reason: 'Bỏ khi chỉnh tay' }, { from_s: 5.123, to_s: 6, reason: 'Bỏ khi chỉnh tay' }],
      note: '',
    });
  });

  it('job edit_plan không nhận asset; credits_cost bị bỏ qua', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    writeFile(env.root, 'output/x.mp4', 'x');
    const bad = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 's' }, assets: [{ kind: 'video', file_path: 'output/x.mp4' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_ASSET_KIND');
    const ok = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 's' }, credits_cost: 15 });
    expect(ok.status).toBe(200);
    expect(ok.body.job.credits_cost).toBe(0);
    await idle();
    expect((await sc.user.get(`/api/projects/${sc.project.id}/ledger`)).body.totals.used).toBe(15);
  });

  it('fail job edit_plan → bản dựng failed kèm lỗi; dựng lại bằng POST được', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const f = await sc.worker.post(`/api/worker/jobs/${job.id}/fail`, { error: 'Không xem được video', code: 'OTHER' });
    expect(f.status).toBe(200);
    const [c] = await cutsOf(sc);
    expect(c).toMatchObject({ status: 'failed', error: 'Không xem được video' });
    expect(c.finished_at).toBeTruthy();
    const p = (await sc.user.get(`/api/projects/${sc.project.id}`)).body;
    expect(p.latest_final_cut).toMatchObject({ status: 'failed', error: 'Không xem được video' });
    expect(p.final_cut_block).toBeNull();
    expect((await sc.user.post(`/api/projects/${sc.project.id}/final-cuts`, {})).status).toBe(201);
  });

  it('hủy bản đang planning (qua final-cuts/cancel hoặc jobs/cancel) → job và bản cùng bị hủy; worker nhận 409 JOB_CANCELLED', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const [c] = await cutsOf(sc);
    const r = await sc.user.post(`/api/final-cuts/${c.id}/cancel`, {});
    expect(r.body.final_cut).toMatchObject({ status: 'cancelled' });
    expect((await sc.user.get(`/api/jobs/${job.id}`)).body.status).toBe('cancelled');
    for (const url of ['heartbeat', 'complete']) {
      const w = await sc.worker.post(`/api/worker/jobs/${job.id}/${url}`, {});
      expect(w.status, url).toBe(409);
      expect(w.body.error.code).toBe('JOB_CANCELLED');
    }
    expect((await sc.user.post(`/api/final-cuts/${c.id}/cancel`, {})).body.error.code).toBe('INVALID_STATE');
    // qua hàng đợi
    const created = await sc.user.post(`/api/projects/${sc.project.id}/final-cuts`, {});
    const c2 = created.body.final_cut;
    await sc.user.post(`/api/jobs/${created.body.job.id}/cancel`, {});
    expect((await sc.user.get(`/api/final-cuts/${c2.id}`)).body.status).toBe('cancelled');
    expect((await sc.user.get('/api/worker/status')).body.queue_paused).toBe(false);
  });

  it('job edit_plan mồ côi (bản không còn planning) bị hủy khi claim thay vì giao cho worker', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const [c] = await cutsOf(sc);
    env.ctx.db.prepare("UPDATE final_cuts SET status = 'failed' WHERE id = ?").run(c.id);
    expect((await sc.worker.get('/api/worker/next')).status).toBe(204);
    expect((await sc.user.get(`/api/jobs/${c.job_id}`)).body.status).toBe('cancelled');
  });

  it('mất heartbeat → job edit_plan về queued (requeued=true), không đụng cảnh', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    env.clock.advanceMinutes(6);
    expect(sweepStaleJobs(env.ctx)).toEqual([job.id]);
    expect((await sc.user.get(`/api/jobs/${job.id}`)).body).toMatchObject({ status: 'queued', requeue_count: 1 });
    expect((await cutsOf(sc))[0].status).toBe('planning');
    const again = await claimEditPlan(sc, 'w2');
    expect(again.payload.requeued).toBe(true);
    expect((await sc.user.get(`/api/projects/${sc.project.id}/scenes`)).body[0].status).toBe('done');
  });
});

describe('render', () => {
  it('lỗi render → failed kèm thông báo; không có dòng log FINAL; render lại được', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    fake.failWith = 'ffmpeg nổ';
    const { cut } = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'failed', error: 'ffmpeg nổ', renderer: 'ffmpeg' });
    expect(fs.existsSync(path.join(env.root, 'output', SLUG, 'log.md')) ? fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8') : '').not.toContain('FINAL');
    expect((await sc.user.get(`/api/projects/${sc.project.id}`)).body.latest_final_cut).toMatchObject({ status: 'failed', error: 'ffmpeg nổ' });
    fake.failWith = null;
    const r = await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, { edl: cut.edl });
    expect(r.status).toBe(201);
    await idle();
    expect((await sc.user.get(`/api/final-cuts/${r.body.final_cut.id}`)).body).toMatchObject({ status: 'ready', version: 2 });
  });

  it('thiếu file video nguồn → failed rõ ràng', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    fs.rmSync(path.join(env.root, 'output', SLUG, 'video', 'C2_v1.mp4'));
    const { cut } = await planAndRender(sc);
    expect(cut).toMatchObject({ status: 'failed' });
    expect(cut.error).toContain('Thiếu file video của cảnh C2');
    expect(fake.calls).toHaveLength(0);
  });

  it('mỗi lúc chỉ render một bản (hàng đợi trong tiến trình), kể cả giữa các dự án', async () => {
    fake.hold();
    // chuẩn bị hai dự án tới sát bước chọn video; chọn video ở cuối để hai job edit_plan nằm trong hàng đợi
    const prep = async (name: string) => {
      const sc = await setupProject(env, { scenes: 1, project: { name } });
      await toStoryboardReview(sc, sc.scenes[0].id);
      await toVideoReview(sc, sc.scenes[0].id);
      return sc;
    };
    const a = await prep('Dự án A');
    const b = await prep('Dự án B');
    await a.user.post(`/api/scenes/${a.scenes[0].id}/select-video`, {});
    await b.user.post(`/api/scenes/${b.scenes[0].id}/select-video`, {});
    const ja = await claimEditPlan(a);
    const jb = await claimEditPlan(a);
    expect(jb.id).not.toBe(ja.id);
    const ca = (await a.user.get(`/api/final-cuts/${ja.payload.final_cut_id}`)).body;
    const cb = (await b.user.get(`/api/final-cuts/${jb.payload.final_cut_id}`)).body;
    await a.worker.post(`/api/worker/jobs/${ja.id}/complete`, { result: { edl: edlFor(a, ca), summary: 'a' } });
    await b.worker.post(`/api/worker/jobs/${jb.id}/complete`, { result: { edl: edlFor(b, cb), summary: 'b' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls).toHaveLength(1); // bản thứ hai đang xếp hàng
    expect((await a.user.get(`/api/final-cuts/${ca.id}`)).body.status).toBe('rendering');
    expect((await b.user.get(`/api/final-cuts/${cb.id}`)).body).toMatchObject({ status: 'rendering', progress: null });
    fake.release();
    await idle();
    expect(fake.maxConcurrent).toBe(1);
    expect(fake.calls).toHaveLength(2);
    expect((await a.user.get(`/api/final-cuts/${ca.id}`)).body.status).toBe('ready');
    expect((await b.user.get(`/api/final-cuts/${cb.id}`)).body.status).toBe('ready');
  });

  it('hủy khi đang render: renderer nhận abort, bản cancelled và KHÔNG bị ghi đè thành ready/failed; video dở bị xóa', async () => {
    fake.hold();
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 's' } });
    await new Promise((r) => setTimeout(r, 50));
    expect((await sc.user.get(`/api/final-cuts/${cut.id}`)).body.status).toBe('rendering');
    const c = await sc.user.post(`/api/final-cuts/${cut.id}/cancel`, {});
    expect(c.body.final_cut.status).toBe('cancelled');
    await idle();
    expect(fake.aborted).toEqual([cut.id]);
    const after = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(after).toMatchObject({ status: 'cancelled', video_path: null });
    expect(fs.existsSync(path.join(env.root, `output/${SLUG}/final/${SLUG}_final_v1.mp4`))).toBe(false);
    expect((await sc.user.post(`/api/final-cuts/${cut.id}/cancel`, {})).body.error.code).toBe('INVALID_STATE');
  });

  it('khởi động lại khi đang render: bản rendering → failed "Server khởi động lại trong lúc render; bấm Render lại"', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const [c] = await cutsOf(sc);
    env.ctx.db.prepare("UPDATE final_cuts SET status = 'rendering', progress = 40 WHERE id = ?").run(c.id);
    const app2 = await env.second();
    const row = app2.ctx.db.prepare('SELECT status, error, finished_at FROM final_cuts WHERE id = ?').get(c.id) as any;
    expect(row).toMatchObject({ status: 'failed', error: 'Server khởi động lại trong lúc render; bấm Render lại' });
    expect(row.finished_at).toBeTruthy();
  });

  it('progress được throttle (mặc định ≥ 1 giây): các mốc dồn dập chỉ ghi vài lần', async () => {
    await env.close();
    await mk({ finalRender: { progressThrottleMs: 1000 } });
    const sc = await setupAllDone(env, { scenes: 1 });
    fake.progress = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const updates: (number | null)[] = [];
    const orig = env.ctx.sse.publish.bind(env.ctx.sse);
    env.ctx.sse.publish = (e: string, d: any, p: number | null) => {
      if (e === 'final_cut.updated') updates.push(d.final_cut.progress);
      orig(e, d, p);
    };
    env.ctx.sse.add({ writeHead() {}, write() {}, on() {}, end() {} } as any, sc.project.id);
    await planAndRender(sc);
    const mids = updates.filter((p) => p !== null && p > 0 && p < 100);
    expect(mids.length).toBeLessThanOrEqual(1);
    expect(updates.at(-1)).toBe(100);
  });
});

describe('render lại (người dùng chỉnh EDL)', () => {
  it('tạo version MỚI (created_by user, cùng lựa chọn video), không qua worker, không tốn credit; giữ bản cũ', async () => {
    const sc = await setupAllDone(env, { scenes: 2 });
    const { cut } = await planAndRender(sc);
    const edl2 = edlFor(sc, cut, [1, 8]);
    const before = (await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body;
    const r = await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, { edl: edl2, note: 'Cắt thêm đầu/cuối' });
    expect(r.status).toBe(201);
    const nc = r.body.final_cut;
    expect(nc).toMatchObject({ version: 2, status: 'rendering', created_by: 'user', note: 'Cắt thêm đầu/cuối', job_id: null, selection_signature: cut.selection_signature, outdated: false });
    expect(nc.selection.map((s: any) => s.asset_id)).toEqual(cut.selection.map((s: any) => s.asset_id));
    await idle();
    const done = (await sc.user.get(`/api/final-cuts/${nc.id}`)).body;
    expect(done).toMatchObject({ status: 'ready', duration_s: 14, video_path: `output/${SLUG}/final/${SLUG}_final_v2.mp4`, summary: null });
    expect((await sc.user.get(`/api/final-cuts/${cut.id}`)).body).toMatchObject({ status: 'ready', version: 1 }); // bản cũ nguyên vẹn
    expect(fs.readFileSync(path.join(env.root, cut.video_path), 'utf8')).toBe('fake-final-v1');
    expect((await sc.user.get(`/api/jobs?type=edit_plan`)).body).toHaveLength(1); // không sinh job
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body).toEqual(before);
    const log = fs.readFileSync(path.join(env.root, 'output', SLUG, 'log.md'), 'utf8').trimEnd().split('\n');
    expect(log.at(-1)).toBe('| FINAL | v2 | bản dựng (ffmpeg, cắt thẳng) | Cắt thêm đầu/cuối | Sẵn sàng |');
    expect((await cutsOf(sc)).map((c) => c.version)).toEqual([2, 1]);
  });

  it('EDL sai → 400 INVALID_EDL và KHÔNG tạo version; đang có bản rendering → 409 FINAL_CUT_ACTIVE; id không có → 404', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const { cut } = await planAndRender(sc);
    const bad = await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, { edl: { scenes: [{ scene_id: cut.selection[0].scene_id, asset_id: cut.selection[0].asset_id, segments: [{ in_s: 1, out_s: 1.1 }] }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_EDL');
    expect(bad.body.error.message).toContain('cảnh C1, đoạn 1');
    expect(await cutsOf(sc)).toHaveLength(1);
    expect((await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, {})).body.error.code).toBe('INVALID_EDL');
    expect((await sc.user.post('/api/final-cuts/9999/rerender', { edl: cut.edl })).status).toBe(404);
    fake.hold();
    const first = await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, { edl: cut.edl });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    const second = await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, { edl: cut.edl });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('FINAL_CUT_ACTIVE');
    fake.release();
    await idle();
  });

  it('render lại từ bản outdated vẫn giữ lựa chọn video cũ của bản đó (outdated=true)', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    const { cut } = await planAndRender(sc);
    await sc.user.post(`/api/scenes/${id}/comments`, { body: 'lại', action: 'regenerate_same' });
    await (await import('./helpers.js')).finish(sc, await claim(sc));
    const vids = (await sc.user.get(`/api/scenes/${id}`)).body.assets.filter((a: any) => a.kind === 'video');
    await sc.user.post(`/api/scenes/${id}/select-video`, { asset_id: vids[1].id });
    const r = await sc.user.post(`/api/final-cuts/${cut.id}/rerender`, { edl: cut.edl });
    expect(r.body.final_cut.selection[0].asset_id).toBe(vids[0].id);
    expect(r.body.final_cut.outdated).toBe(true);
    await idle();
  });
});

describe('đánh số version, không ghi đè', () => {
  it('version kế tiếp > mọi version trong DB và mọi file <slug>_final_v<n> trên đĩa (kể cả .mlt); bản cũ nguyên vẹn', async () => {
    writeFile(env.root, `output/${SLUG}/final/${SLUG}_final_v3.mp4`, 'cũ v3');
    writeFile(env.root, `output/${SLUG}/final/shotcut/${SLUG}_final_v5.mlt`, 'cũ v5');
    const sc = await setupAllDone(env, { scenes: 1 });
    const [c] = await cutsOf(sc);
    expect(c.version).toBe(6);
    const { cut } = await planAndRender(sc);
    expect(cut.video_path).toBe(`output/${SLUG}/final/${SLUG}_final_v6.mp4`);
    expect(fs.readFileSync(path.join(env.root, `output/${SLUG}/final/${SLUG}_final_v3.mp4`), 'utf8')).toBe('cũ v3');
    // bản kế tiếp lại tăng
    const r = await sc.user.post(`/api/projects/${sc.project.id}/final-cuts`, {});
    expect(r.body.final_cut.version).toBe(7);
  });

  it('đường dẫn đầu ra của version đã bị chiếm → render báo lỗi thay vì ghi đè', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    writeFile(env.root, `output/${SLUG}/final/${SLUG}_final_v1.mp4`, 'ai đó vừa tạo');
    await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl: edlFor(sc, cut), summary: 's' } });
    await idle();
    const done = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('không ghi đè');
    expect(fs.readFileSync(path.join(env.root, `output/${SLUG}/final/${SLUG}_final_v1.mp4`), 'utf8')).toBe('ai đó vừa tạo');
  });
});

/** Chèn một bản dựng Shotcut cũ (dữ liệu lịch sử, version 99) đã `ready` kèm file mp4 và .mlt thật trên đĩa, dùng cùng lựa chọn video với bản hiện có. */
async function insertLegacyShotcutCut(sc: Scenario): Promise<number> {
  const [base] = await cutsOf(sc);
  const video = `output/${SLUG}/final/${SLUG}_final_v99.mp4`;
  const mlt = `output/${SLUG}/final/shotcut/${SLUG}_final_v99.mlt`;
  writeFile(env.root, video, 'mp4 cũ');
  writeFile(env.root, mlt, '<mlt/>');
  const r = env.ctx.db
    .prepare(
      `INSERT INTO final_cuts (project_id, version, status, selection, selection_signature, edl, renderer, video_path, project_file_path, render_ref, duration_s, progress, created_by, created_at)
       VALUES (?, 99, 'ready', ?, ?, ?, 'shotcut', ?, ?, 'job-shotcut-42', 7, 100, 'claude', ?)`,
    )
    .run(sc.project.id, JSON.stringify(base.selection.map(({ scene_id, code, asset_id, attempt }: any) => ({ scene_id, code, asset_id, attempt }))), base.selection_signature, JSON.stringify(edlFor(sc, base)), video, mlt, env.ctx.now());
  return Number(r.lastInsertRowid);
}

describe('bản dựng Shotcut cũ (dữ liệu lịch sử)', () => {
  it('vẫn liệt kê, xem và tải được; giữ nguyên renderer, project_file_path, render_ref', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const id = await insertLegacyShotcutCut(sc);
    const want = {
      id,
      version: 99,
      status: 'ready',
      renderer: 'shotcut',
      project_file_path: `output/${SLUG}/final/shotcut/${SLUG}_final_v99.mlt`,
      render_ref: 'job-shotcut-42',
      video_path: `output/${SLUG}/final/${SLUG}_final_v99.mp4`,
      video_url: expect.stringContaining(`${SLUG}_final_v99.mp4`),
    };
    const one = (await sc.user.get(`/api/final-cuts/${id}`)).body;
    expect(one).toMatchObject(want);
    expect((await cutsOf(sc)).find((c) => c.id === id)).toMatchObject(want);
    const dl = await sc.user.get(one.video_url);
    expect(dl.status).toBe(200);
  });

  it('render lại bản Shotcut cũ → bản mới dựng bằng ffmpeg (không còn .mlt/render_ref); bản cũ nguyên vẹn', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const id = await insertLegacyShotcutCut(sc);
    const old = (await sc.user.get(`/api/final-cuts/${id}`)).body;
    const r = await sc.user.post(`/api/final-cuts/${id}/rerender`, { edl: old.edl });
    expect(r.status, r.raw).toBe(201);
    await idle();
    expect(fake.calls).toHaveLength(1);
    const neu = (await sc.user.get(`/api/final-cuts/${r.body.final_cut.id}`)).body;
    expect(neu).toMatchObject({ status: 'ready', renderer: 'ffmpeg', project_file_path: null, render_ref: null, version: 100 });
    expect((await sc.user.get(`/api/final-cuts/${id}`)).body).toMatchObject({ renderer: 'shotcut', render_ref: 'job-shotcut-42' });
    expect(fs.existsSync(path.join(env.root, `output/${SLUG}/final/shotcut/${SLUG}_final_v100.mlt`))).toBe(false);
  });

  it('route mở Shotcut đã bị gỡ', async () => {
    const sc = await setupAllDone(env, { scenes: 1 });
    const id = await insertLegacyShotcutCut(sc);
    expect((await sc.user.post(`/api/final-cuts/${id}/open-in-shotcut`, {})).status).toBe(404);
  });
});

describe('meta, cấu hình', () => {
  it('GET /api/meta chỉ báo ffmpeg (không còn mode/shotcut)', async () => {
    const meta = (await userClient(env.app).get('/api/meta')).body;
    expect(meta.job_types).toContain('edit_plan');
    expect(meta.final_renderer).toMatchObject({ active: 'ffmpeg', reason: 'Trình dựng được chỉ định: ffmpeg', ffmpeg: { available: expect.any(Boolean) } });
    expect(Object.keys(meta.final_renderer).sort()).toEqual(['active', 'ffmpeg', 'reason']);
  });

  it('file .env/config.env cũ còn khoá Shotcut/FINAL_RENDERER không làm hỏng loadConfig', () => {
    const cfg = loadConfig({ FINAL_RENDERER: 'shotcut', SHOTCUT_MCP_PYTHON: '/x/python', SHOTCUT_MCP_SERVER_SCRIPT: '/x/s.py', PORT: '4321' } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(4321);
    expect(Object.keys(cfg).filter((k) => /shotcut|finalRenderer/i.test(k))).toEqual([]);
  });

  it('GET /api/final-cuts/:id 404; danh sách của dự án không tồn tại 404; hủy id lạ 404', async () => {
    const u = userClient(env.app);
    expect((await u.get('/api/final-cuts/999')).status).toBe(404);
    expect((await u.get('/api/projects/999/final-cuts')).status).toBe(404);
    expect((await u.post('/api/final-cuts/999/cancel', {})).status).toBe(404);
    expect((await u.get('/api/final-cuts/abc')).status).toBe(400);
  });
});
