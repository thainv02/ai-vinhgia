import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYZE_INSTRUCTION } from '../../worker/src/runner.js';
import { normalizeSceneCodes } from '../src/services/scenes.js';
import { makeEnv, userClient, workerClient, type Env } from './helpers.js';

const codes = (list: (string | [string, number])[]) => normalizeSceneCodes(list.map((c) => (typeof c === 'string' ? { code: c } : { code: c[0], order_index: c[1] })));

describe('normalizeSceneCodes (dự án LAN)', () => {
  it('mã đúng dạng giữ nguyên', () => {
    expect(codes(['C1', 'C2', 'C3'])).toEqual(['C1', 'C2', 'C3']);
  });

  it('chuẩn hóa các dạng AI hay đặt về C<số>: scene_01, Scene 1, scene-2, S3, 03, 4, c05, clip 6', () => {
    expect(codes(['scene_01', 'Scene 2', 'scene-3', 'S4', '05', '6', 'c07', 'clip 8', 'C009'])).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);
  });

  it('giữ nguyên khoảng trống số thứ tự (AI bỏ C2) và thứ tự đầu vào', () => {
    expect(codes(['C1', 'C3', 'C10'])).toEqual(['C1', 'C3', 'C10']);
    expect(codes(['scene_03', 'scene_01'])).toEqual(['C3', 'C1']);
  });

  it('không đọc được số hoặc trùng số sau chuẩn hóa → đánh số lại C1..Cn theo order_index (hòa thì theo vị trí), không bao giờ trùng mã', () => {
    expect(codes(['intro', 'C2', 'outro'])).toEqual(['C1', 'C2', 'C3']);
    expect(codes(['scene_01', 'scene-1', 'C1'])).toEqual(['C1', 'C2', 'C3']);
    expect(codes([['x', 2], ['y', 0], ['z', 1]])).toEqual(['C3', 'C1', 'C2']);
    expect(codes([['intro', 5], ['mid', 5], ['end', 1]])).toEqual(['C2', 'C3', 'C1']);
    for (const bad of ['C0', 'C1000', 'C1a', '', '   ', 'Cảnh', '-1']) expect(codes([bad, 'C2']), bad).toEqual(['C1', 'C2']);
  });

  it('kết quả luôn có dạng C<số nguyên dương> và duy nhất, với đầu vào bất kỳ', () => {
    const inputs = [['a', 'b', 'c', 'd'], ['1', '01', '001'], ['scene_9', 'scene_09'], ['S1', 'S2', 'zzz'], ['C1', 'C1']];
    for (const input of inputs) {
      const out = codes(input);
      expect(out.every((c) => /^C[1-9]\d{0,2}$/.test(c))).toBe(true);
      expect(new Set(out).size).toBe(out.length);
    }
  });
});

describe('upsertScenes theo nguồn dự án', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  const scenes = (...codesIn: string[]) => codesIn.map((code, i) => ({ code, order_index: i, title: `T${i}`, prompt: `Style: p${i}`, first_frame_desc: '', upload_refs: [], use_prev_storyboard: false }));
  const lanProject = () => {
    const now = env.ctx.now();
    const info = env.ctx.db.prepare("INSERT INTO projects (slug, name, source, created_by_name, created_at, updated_at) VALUES ('lan-p', 'LAN', 'lan', 'Lan', ?, ?)").run(now, now);
    return Number(info.lastInsertRowid);
  };

  it('dự án LAN: scene_01/scene_02 → C1/C2, ghi event và trả `renamed`', async () => {
    const id = lanProject();
    const r = await workerClient(env.app).post('/api/worker/scenes', { project_id: id, scenes: scenes('scene_01', 'scene_02') });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.created).toEqual(['C1', 'C2']);
    expect(r.body.renamed).toEqual([{ from: 'scene_01', to: 'C1' }, { from: 'scene_02', to: 'C2' }]);
    expect(r.body.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2']);
    const ev = env.ctx.db.prepare("SELECT message FROM events WHERE type = 'scene.codes_normalized'").all() as { message: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toContain('scene_01 → C1');
  });

  it('dự án LAN: lần phân tích lại với mã khác dạng vẫn cập nhật đúng cảnh cũ (không tạo bản trùng)', async () => {
    const id = lanProject();
    const w = workerClient(env.app);
    await w.post('/api/worker/scenes', { project_id: id, scenes: scenes('C1', 'C2') });
    const r = await w.post('/api/worker/scenes', { project_id: id, scenes: scenes('scene_01', 'scene_02') });
    expect(r.body.created).toEqual([]);
    expect(r.body.updated).toEqual(['C1', 'C2']);
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?').get(id)).toEqual({ n: 2 });
  });

  it('dự án LAN: mã trùng sau chuẩn hóa được đánh số lại thay vì bị từ chối; mã không hợp lệ theo schema vẫn 400', async () => {
    const id = lanProject();
    const w = workerClient(env.app);
    const r = await w.post('/api/worker/scenes', { project_id: id, scenes: scenes('scene_01', 'scene-1', 'intro') });
    expect(r.status).toBe(200);
    expect(r.body.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2', 'C3']);
    expect((await w.post('/api/worker/scenes', { project_id: id, scenes: scenes('mã có dấu cách') })).status).toBe(400);
  });

  it('dự án app (source=app): mã cảnh giữ nguyên như trước, kể cả scene_01', async () => {
    const p = (await userClient(env.app).post('/api/projects', { name: 'Dự án thường', brief: 'b' })).body;
    const r = await workerClient(env.app).post('/api/worker/scenes', { project_id: p.id, scenes: scenes('scene_01', 'intro') });
    expect(r.status).toBe(200);
    expect(r.body.created).toEqual(['scene_01', 'intro']);
    expect(r.body.renamed).toBeUndefined();
    expect(r.body.pruned).toBeUndefined();
  });

  it('dự án app không bao giờ bỏ cảnh khi cập nhật (chỉ LAN mới thay kế hoạch)', async () => {
    const p = (await userClient(env.app).post('/api/projects', { name: 'Dự án thường', brief: 'b' })).body;
    const w = workerClient(env.app);
    await w.post('/api/worker/scenes', { project_id: p.id, scenes: scenes('C1', 'C2', 'C3') });
    const r = await w.post('/api/worker/scenes', { project_id: p.id, scenes: scenes('C1') });
    expect(r.body.scenes.map((s: any) => s.code)).toEqual(['C1', 'C2', 'C3']);
  });
});

describe('chỉ dẫn analyze của managed worker', () => {
  it('yêu cầu mã cảnh C1, C2, … và nói rõ không dùng scene_01', () => {
    expect(ANALYZE_INSTRUCTION).toMatch(/code PHẢI là C1, C2, C3/);
    expect(ANALYZE_INSTRUCTION).toMatch(/không dùng scene_01/);
    expect(ANALYZE_INSTRUCTION).toMatch(/khối prompt bắt đầu bằng "Style:"/);
    expect(ANALYZE_INSTRUCTION).toContain('Mỗi clip 9:16, 10 giây, x1');
  });
});
