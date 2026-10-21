import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCENE_STATUSES } from '../src/db/types.js';
import { ALLOWED_TRANSITIONS, isTransitionAllowed, transition } from '../src/services/transition.js';
import {
  bareScenario,
  claim,
  finish,
  makeEnv,
  scene,
  setupProject,
  toStoryboardReview,
  toVideoReview,
  type Env,
  type Scenario,
} from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

describe('transition()', () => {
  it('bảng chuyển hợp lệ khớp isTransitionAllowed, mọi cặp ngoài bảng bị từ chối INVALID_TRANSITION', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    for (const from of SCENE_STATUSES) {
      for (const to of SCENE_STATUSES) {
        const expected = from !== to && (to === 'cancelled' || ALLOWED_TRANSITIONS[from].includes(to));
        expect(isTransitionAllowed(from, to), `${from} → ${to}`).toBe(expected);
        env.ctx.db.prepare('UPDATE scenes SET status = ? WHERE id = ?').run(from, id);
        if (expected) {
          expect(transition(env.ctx, id, to, 'test').status).toBe(to);
        } else {
          expect(() => transition(env.ctx, id, to, 'test')).toThrowError(/Không thể chuyển/);
          try {
            transition(env.ctx, id, to, 'test');
          } catch (e: any) {
            expect(e.code).toBe('INVALID_TRANSITION');
            expect(e.status).toBe(409);
          }
          // trạng thái không bị đổi khi bị từ chối
          const row = env.ctx.db.prepare('SELECT status FROM scenes WHERE id = ?').get(id) as { status: string };
          expect(row.status).toBe(from);
        }
      }
    }
  });

  it('opts.force bỏ qua bảng chuyển nhưng vẫn ghi event', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    expect(() => transition(env.ctx, id, 'done', 'x')).toThrow();
    transition(env.ctx, id, 'done', 'Nhập dữ liệu cũ', { force: true });
    const ev = env.ctx.db.prepare("SELECT message FROM events WHERE scene_id = ? AND type = 'scene.status' ORDER BY id DESC").get(id) as {
      message: string;
    };
    expect(ev.message).toBe('C1: awaiting_approval → done (Nhập dữ liệu cũ)');
  });

  it('ghi event scene.status theo đúng định dạng và cập nhật updated_at', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    env.clock.advance(60_000);
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    const events = (await sc.user.get(`/api/projects/${sc.project.id}/events?sceneId=${id}`)).body;
    expect(events.map((e: any) => e.message)).toContain('C1: awaiting_approval → storyboard_queued (người dùng duyệt prompt, tạo storyboard)');
    const s = await scene(sc, id);
    expect(s.updated_at).toBe('2026-01-01T00:01:00.000Z');
  });
});

describe('đi hết máy trạng thái qua HTTP', () => {
  it('nhập kịch bản → phân tích → storyboard → video → chọn → done', async () => {
    const sc = bareScenario(env); // chưa có dự án: đi từ brief
    const u = sc.user;
    const w = sc.worker;
    const created = (await u.post('/api/projects', { name: 'Dự án mới', brief: 'Làm quảng cáo sinh tố', style_lock: 'Ánh sáng ấm' })).body;
    expect(created.status).toBe('draft');
    expect(created.slug).toBe('du-an-moi');

    // gửi brief → job analyze_brief, project analyzing
    const sub = await u.post(`/api/projects/${created.id}/brief`, {});
    expect(sub.status).toBe(201);
    expect(sub.body.job.type).toBe('analyze_brief');
    expect(sub.body.job.requires_approval).toBe(false);
    expect(sub.body.project.status).toBe('analyzing');
    // không gửi trùng khi đang phân tích
    const dup = await u.post(`/api/projects/${created.id}/brief`, {});
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('JOB_ACTIVE');

    const job = await claim(sc);
    expect(job.type).toBe('analyze_brief');
    expect(job.payload.project.brief).toBe('Làm quảng cáo sinh tố');
    expect(job.payload.rules_file).toBe('video-production-rules.md');
    // chưa có cảnh → complete bị từ chối
    const early = await w.post(`/api/worker/jobs/${job.id}/complete`, { result: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NO_SCENES');

    const up = await w.post('/api/worker/scenes', {
      project_id: created.id,
      scenes: [
        { code: 'C1', title: 'Mở đầu', prompt: 'P1', first_frame_desc: 'F1', upload_refs: [], use_prev_storyboard: false },
        { code: 'C2', title: 'Giữa', prompt: 'P2', first_frame_desc: 'F2', upload_refs: [], use_prev_storyboard: true },
      ],
    });
    expect(up.status).toBe(200);
    expect(up.body.created).toEqual(['C1', 'C2']);
    expect(up.body.scenes.map((s: any) => s.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
    expect(up.body.scenes[0].prompt_version).toBe(1);
    const done = await w.post(`/api/worker/jobs/${job.id}/complete`, { result: { scenes: 2 } });
    expect(done.status).toBe(200);
    expect((await u.get(`/api/projects/${created.id}`)).body.status).toBe('active');

    const c1 = up.body.scenes[0].id;
    // storyboard
    const a1 = await u.post(`/api/scenes/${c1}/approve`, { stage: 'storyboard' });
    expect(a1.body.scene.status).toBe('storyboard_queued');
    expect(a1.body.job).toMatchObject({ type: 'storyboard', status: 'queued', requires_approval: true });
    expect(a1.body.job.approved_at).toBeTruthy();
    const sj = await claim(sc);
    expect(sj.type).toBe('storyboard');
    expect(sj.payload.output.storyboard_path).toBe('output/du-an-moi/storyboard/C1_storyboard.png');
    expect((await scene(sc, c1)).status).toBe('storyboard_running');
    expect((await w.post(`/api/worker/jobs/${sj.id}/heartbeat`, {})).body.status).toBe('running');
    expect((await finish(sc, sj)).status).toBe(200);
    const afterSb = await scene(sc, c1);
    expect(afterSb.status).toBe('storyboard_review');
    expect(afterSb.storyboard.file_path).toBe('output/du-an-moi/storyboard/C1_storyboard.png');
    expect(afterSb.storyboard.url).toBe('/files/output/du-an-moi/storyboard/C1_storyboard.png');

    // video
    const a2 = await u.post(`/api/scenes/${c1}/approve`, { stage: 'video' });
    expect(a2.status).toBe(200);
    expect(a2.body.scene.status).toBe('video_queued');
    const vj = await claim(sc);
    expect(vj.type).toBe('video');
    expect(vj.payload.attempt).toBe(1);
    expect(vj.payload.credits_expected).toBe(15);
    expect(vj.payload.upload_files).toEqual(['output/du-an-moi/storyboard/C1_storyboard.png']);
    expect(vj.payload.settings).toEqual({ aspect: '9:16', duration_s: 10, count: 1, resolution: '720p' });
    expect((await scene(sc, c1)).status).toBe('video_running');
    expect((await finish(sc, vj, { verdict: 'fix_in_edit', verdict_note: 'chữ bị méo' })).status).toBe(200);
    const sv = await scene(sc, c1);
    expect(sv.status).toBe('video_review');
    expect(sv.video.verdict).toBe('fix_in_edit');
    expect(sv.video.verdict_note).toBe('chữ bị méo');
    expect(sv.grid.kind).toBe('grid');
    expect(sv.attempts_used).toBe(1);

    // chọn video → done
    const sel = await u.post(`/api/scenes/${c1}/select-video`, {});
    expect(sel.body.scene.status).toBe('done');
    expect(sel.body.scene.selected_video_id).toBe(sv.video.id);

    // credit: đã dùng 15
    const budget = (await u.get(`/api/projects/${created.id}/budget`)).body;
    expect(budget).toMatchObject({ used: 15, reserved: 0, credit_per_video: 15, max_attempts: 2 });
    expect(budget.scenes[0]).toEqual({ scene_id: c1, code: 'C1', attempts_used: 1, max_attempts: 2 });

    // toàn bộ đường đi đã được ghi trong events
    const msgs = (await u.get(`/api/projects/${created.id}/events?sceneId=${c1}&limit=100`)).body.map((e: any) => e.message).reverse();
    const trans = msgs.filter((m: string) => m.includes('→')).map((m: string) => m.replace(/ \(.*$/, ''));
    expect(trans).toEqual([
      'C1: draft → prompt_ready',
      'C1: prompt_ready → awaiting_approval',
      'C1: awaiting_approval → storyboard_queued',
      'C1: storyboard_queued → storyboard_running',
      'C1: storyboard_running → storyboard_review',
      'C1: storyboard_review → video_queued',
      'C1: video_queued → video_running',
      'C1: video_running → video_review',
      'C1: video_review → done',
    ]);
  });

  it('thao tác sai trạng thái bị từ chối (409 INVALID_STATE / JOB_ACTIVE), trạng thái giữ nguyên', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    const u = sc.user;
    const bad = async (p: Promise<any>, code: string) => {
      const r = await p;
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe(code);
      return r;
    };
    // awaiting_approval: chưa có storyboard
    await bad(u.post(`/api/scenes/${id}/approve`, { stage: 'video' }), 'INVALID_STATE');
    await bad(u.post(`/api/scenes/${id}/select-video`, {}), 'INVALID_STATE');
    await bad(u.post(`/api/scenes/${id}/reset`, {}), 'INVALID_STATE');
    expect((await scene(sc, id)).status).toBe('awaiting_approval');

    // đang chờ storyboard: duyệt lần 2 → JOB_ACTIVE; sửa prompt/comment revise không được
    await u.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    await bad(u.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' }), 'JOB_ACTIVE');
    await bad(u.post(`/api/scenes/${id}/approve`, { stage: 'video' }), 'JOB_ACTIVE');
    await bad(u.post(`/api/scenes/${id}/comments`, { body: 'sửa đi', action: 'revise_and_regenerate' }), 'JOB_ACTIVE');
    await bad(u.patch(`/api/scenes/${id}/prompt`, { prompt: 'x' }), 'INVALID_STATE');
    expect((await scene(sc, id)).status).toBe('storyboard_queued');
    // không có comment nào được lưu khi hành động bị từ chối
    expect((await scene(sc, id)).comments).toHaveLength(0);

    // job đã xong không hủy được
    const j = await claim(sc);
    await finish(sc, j);
    await bad(u.post(`/api/jobs/${j.id}/cancel`, {}), 'INVALID_STATE');
    // video_review chưa có → select-video khi storyboard_review sai
    await bad(u.post(`/api/scenes/${id}/select-video`, {}), 'INVALID_STATE');
    expect((await scene(sc, id)).status).toBe('storyboard_review');
  });
});

describe('comment và tạo lại', () => {
  async function toVideoReviewScene(): Promise<{ sc: Scenario; id: number }> {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await toVideoReview(sc, id);
    return { sc, id };
  }

  it('revise_and_regenerate tạo job revise_prompt (KHÔNG tạo video); xong thì chờ duyệt với version prompt mới', async () => {
    const { sc, id } = await toVideoReviewScene();
    const before = await scene(sc, id);
    expect(before.status).toBe('video_review');
    const c = await sc.user.post(`/api/scenes/${id}/comments`, {
      body: 'Thêm kéo cắt gói ở giây 1',
      timecode: 1.5,
      action: 'revise_and_regenerate',
      asset_id: before.video.id,
    });
    expect(c.status).toBe(201);
    expect(c.body.comment).toMatchObject({ author: 'user', action: 'revise_and_regenerate', timecode: 1.5, resolved: false, asset_id: before.video.id });
    expect(c.body.job).toMatchObject({ type: 'revise_prompt', status: 'queued', requires_approval: false });
    expect(c.body.scene.status).toBe('needs_revision');
    // không có job video nào đang hoạt động, credit không bị đặt trước
    const jobs = (await sc.user.get(`/api/jobs?projectId=${sc.project.id}&status=queued,claimed,running`)).body;
    expect(jobs.map((j: any) => j.type)).toEqual(['revise_prompt']);
    expect((await sc.user.get(`/api/projects/${sc.project.id}/budget`)).body.reserved).toBe(0);

    const rj = await claim(sc);
    expect(rj.type).toBe('revise_prompt');
    expect(rj.payload.scene).toMatchObject({ code: 'C1', prompt: before.prompt, version: 1 });
    expect(rj.payload.comments).toHaveLength(1);
    expect(rj.payload.comments[0].body).toBe('Thêm kéo cắt gói ở giây 1');
    // scene vẫn needs_revision khi claim
    expect((await scene(sc, id)).status).toBe('needs_revision');

    expect((await finish(sc, rj)).status).toBe(200);
    const after = await scene(sc, id);
    expect(after.status).toBe('awaiting_approval');
    expect(after.prompt).toBe(before.prompt + '\nThêm: kéo cắt gói.');
    expect(after.prompt_versions).toHaveLength(2);
    expect(after.prompt_versions[1]).toMatchObject({ version: 2, created_by: 'claude', reason: 'Theo comment của người dùng' });
    expect(after.comments[0].resolved).toBe(true);
    expect(after.open_comments).toBe(0);
    // video cũ được giữ, chưa có job video mới
    expect(after.assets.filter((a: any) => a.kind === 'video')).toHaveLength(1);
    expect((await sc.user.get(`/api/jobs?projectId=${sc.project.id}&type=video&status=queued,claimed,running`)).body).toHaveLength(0);

    // chỉ sau khi duyệt (tốn credit) mới tạo video, và attempt = 2
    const a = await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    expect(a.status).toBe(200);
    const vj = await claim(sc);
    expect(vj.payload.attempt).toBe(2);
    expect(vj.payload.output.video_path).toBe('output/cacao-actiso-plus/video/C1_v2.mp4');
    await finish(sc, vj);
    const fin = await scene(sc, id);
    expect(fin.assets.filter((x: any) => x.kind === 'video').map((x: any) => x.attempt)).toEqual([1, 2]);
    expect(fin.attempts_used).toBe(2);
  });

  it('regenerate_same đi qua kiểm tra approveVideo (credit/lượt)', async () => {
    const { sc, id } = await toVideoReviewScene();
    const ok = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'Tạo lại y nguyên', action: 'regenerate_same' });
    expect(ok.status).toBe(201);
    expect(ok.body.job.type).toBe('video');
    expect(ok.body.scene.status).toBe('video_queued');
    const vj = await claim(sc);
    await finish(sc, vj);
    // đã dùng 2/2 lượt → lần thứ ba bị từ chối và comment không được lưu
    const no = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'Lại nữa', action: 'regenerate_same' });
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('ATTEMPTS_EXCEEDED');
    expect(no.body.error.message).toBe('Cảnh C1 đã dùng 2/2 lượt');
    const s = await scene(sc, id);
    expect(s.comments.map((c: any) => c.body)).toEqual(['Tạo lại y nguyên']);
    expect(s.status).toBe('video_review');
  });

  it('regenerate_storyboard tạo job storyboard mới (lượt 2 có hậu tố _v2) và giữ storyboard cũ', async () => {
    const { sc, id } = await toVideoReviewScene();
    const r = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'Làm lại storyboard', action: 'regenerate_storyboard' });
    expect(r.status).toBe(201);
    expect(r.body.job.type).toBe('storyboard');
    expect(r.body.scene.status).toBe('storyboard_queued');
    const j = await claim(sc);
    expect(j.payload.attempt).toBe(2);
    expect(j.payload.output.storyboard_path).toBe('output/cacao-actiso-plus/storyboard/C1_storyboard_v2.png');
    await finish(sc, j);
    const s = await scene(sc, id);
    expect(s.status).toBe('storyboard_review');
    expect(s.assets.filter((a: any) => a.kind === 'storyboard')).toHaveLength(2);
    expect(s.storyboard.attempt).toBe(2);
    // video tiếp theo dùng storyboard mới nhất ở cuối upload_files
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'video' });
    const vj = await claim(sc);
    expect(vj.payload.upload_files.at(-1)).toBe('output/cacao-actiso-plus/storyboard/C1_storyboard_v2.png');
    expect(vj.payload.storyboard_path).toBe('output/cacao-actiso-plus/storyboard/C1_storyboard_v2.png');
  });

  it('note không đổi trạng thái; comment của Claude không có tác dụng phụ; resolved đổi được', async () => {
    const { sc, id } = await toVideoReviewScene();
    const n = await sc.user.post(`/api/scenes/${id}/comments`, { body: 'Ghi chú thôi', timecode: 3, action: 'note' });
    expect(n.body.job).toBeNull();
    expect(n.body.scene.status).toBe('video_review');
    const wc = await sc.worker.post('/api/worker/comments', { scene_id: id, body: 'Claude trả lời', action: 'revise_and_regenerate' });
    expect(wc.status).toBe(201);
    expect(wc.body.comment).toMatchObject({ author: 'claude', action: 'note' });
    expect((await scene(sc, id)).status).toBe('video_review');
    const p = await sc.user.patch(`/api/comments/${n.body.comment.id}`, { resolved: true });
    expect(p.body.resolved).toBe(true);
    expect((await scene(sc, id)).open_comments).toBe(1);
  });

  it('timecode âm / body rỗng / asset của cảnh khác bị từ chối 400', async () => {
    const { sc, id } = await toVideoReviewScene();
    expect((await sc.user.post(`/api/scenes/${id}/comments`, { body: '   ' })).status).toBe(400);
    expect((await sc.user.post(`/api/scenes/${id}/comments`, { body: 'x', timecode: -1 })).status).toBe(400);
    expect((await sc.user.post(`/api/scenes/${id}/comments`, { body: 'x', asset_id: 99999 })).status).toBe(404);
  });
});

describe('prompt, verdict, chọn video', () => {
  it('người dùng sửa prompt → version mới created_by=user; verdict đổi được và ghi log.md', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await toStoryboardReview(sc, id);
    await toVideoReview(sc, id, { verdict: 'pass', verdict_note: 'ok' });
    const p = await sc.user.patch(`/api/scenes/${id}/prompt`, { prompt: 'Prompt đã sửa tay', reason: 'Thêm chi tiết' });
    expect(p.status).toBe(200);
    expect(p.body.scene.prompt).toBe('Prompt đã sửa tay');
    expect(p.body.scene.prompt_version).toBe(2);
    const s = await scene(sc, id);
    expect(s.prompt_versions.map((v: any) => [v.version, v.created_by, v.reason])).toEqual([
      [1, 'claude', 'Bản đầu tiên do AI viết khi phân tích kịch bản'],
      [2, 'user', 'Thêm chi tiết'],
    ]);
    // không có thay đổi → không sinh version mới
    await sc.user.patch(`/api/scenes/${id}/prompt`, { prompt: 'Prompt đã sửa tay' });
    expect((await scene(sc, id)).prompt_versions).toHaveLength(2);

    const vid = s.video.id;
    const v = await sc.user.post(`/api/assets/${vid}/verdict`, { verdict: 'redo', verdict_note: 'Cần làm lại' });
    expect(v.status).toBe(200);
    expect(v.body.asset).toMatchObject({ verdict: 'redo', verdict_note: 'Cần làm lại' });
    expect((await sc.user.post(`/api/assets/${vid}/verdict`, { verdict: 'bad' })).status).toBe(400);
    const grid = s.grid.id;
    expect((await sc.user.post(`/api/assets/${grid}/verdict`, { verdict: 'pass' })).status).toBe(400);
    const log = fs.readFileSync(path.join(env.root, 'output', 'cacao-actiso-plus', 'log.md'), 'utf8');
    expect(log).toContain('| C1 | 1 | video (kết luận của người dùng) | Cần làm lại | Tạo lại |');
  });

  it('chọn video: video_review → done; ở done đổi được video được chọn; asset ngoài cảnh bị từ chối', async () => {
    const sc = await setupProject(env, { scenes: 2 });
    const [a, b] = sc.scenes.map((s: any) => s.id);
    await toStoryboardReview(sc, a);
    await toVideoReview(sc, a);
    const r = await sc.user.post(`/api/scenes/${a}/comments`, { body: 'tạo lại', action: 'regenerate_same' });
    expect(r.status).toBe(201);
    const j = await claim(sc);
    await finish(sc, j);
    const s = await scene(sc, a);
    const [v1, v2] = s.assets.filter((x: any) => x.kind === 'video');
    expect((await sc.user.post(`/api/scenes/${a}/select-video`, { asset_id: v1.id })).body.scene).toMatchObject({ status: 'done', selected_video_id: v1.id });
    expect((await sc.user.post(`/api/scenes/${a}/select-video`, { asset_id: v2.id })).body.scene).toMatchObject({ status: 'done', selected_video_id: v2.id });
    expect((await scene(sc, a)).video.id).toBe(v2.id);
    // asset của cảnh khác / storyboard
    await toStoryboardReview(sc, b);
    const sbA = s.assets.find((x: any) => x.kind === 'storyboard');
    expect((await sc.user.post(`/api/scenes/${a}/select-video`, { asset_id: sbA.id })).status).toBe(400);
  });
});

describe('thử lại sau lỗi / REQUIRE_PROMPT_APPROVAL', () => {
  it('failed → duyệt lại storyboard; failed → reset → awaiting_approval', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const id = sc.scenes[0].id;
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    const j = await claim(sc);
    const f = await sc.worker.post(`/api/worker/jobs/${j.id}/fail`, { error: 'Giao diện lạ', code: 'OTHER' });
    expect(f.status).toBe(200);
    let s = await scene(sc, id);
    expect(s.status).toBe('failed');
    expect(s.jobs[0]).toMatchObject({ status: 'failed', error: 'Giao diện lạ', error_code: 'OTHER' });
    // OTHER không tạm dừng hàng đợi
    expect((await sc.user.get('/api/worker/status')).body.queue_paused).toBe(false);
    expect((await sc.user.post(`/api/scenes/${id}/reset`, {})).body.scene.status).toBe('awaiting_approval');
    await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' });
    const j2 = await claim(sc);
    await sc.worker.post(`/api/worker/jobs/${j2.id}/fail`, { error: 'lại lỗi' });
    s = await scene(sc, id);
    expect(s.status).toBe('failed');
    // failed → duyệt lại thẳng
    expect((await sc.user.post(`/api/scenes/${id}/approve`, { stage: 'storyboard' })).body.scene.status).toBe('storyboard_queued');
  });

  it('REQUIRE_PROMPT_APPROVAL=false: cảnh mới tự vào storyboard_queued kèm job storyboard', async () => {
    await env.close();
    env = await makeEnv({ config: { requirePromptApproval: false } });
    const sc = await setupProject(env, { scenes: 2 });
    expect(sc.scenes.map((s: any) => s.status)).toEqual(['storyboard_queued', 'storyboard_queued']);
    const jobs = (await sc.user.get(`/api/jobs?projectId=${sc.project.id}`)).body;
    expect(jobs.map((j: any) => j.type)).toEqual(['storyboard', 'storyboard']);
    const j = await claim(sc);
    expect(j.type).toBe('storyboard');
  });
});
