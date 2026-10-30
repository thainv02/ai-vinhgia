import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG_BYTES, userClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan } from './helpers-lan-plan.js';
import { LAN_RATE } from '../src/lan/routes.js';
import { purgeExpiredTrash } from '../src/services/trash.js';

let L: LanEnv;
let a: LanClient;
let b: LanClient;
beforeEach(async () => {
  L = await makeLanEnv();
  a = L.client({ ip: '192.168.1.10' });
  b = L.client({ ip: '192.168.1.11' });
  await a.login();
  await b.login();
});
afterEach(async () => {
  await L.close();
});

const db = () => L.env.ctx.db;
const plans = async (c: LanClient) => (await c.get('/lan/api/plans')).body as any[];
const proj = (id: number) => db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;

describe('xoá kế hoạch từ trang LAN (chỉ trình duyệt đã tạo)', () => {
  it('can_delete theo cookie client: người tạo true; người khác, trình duyệt không cookie và kế hoạch cũ false; băm không bị lộ', async () => {
    const mine = await makeLanPlan(L, a, 2, 'Của A');
    const hash = proj(mine.plan.id).lan_client_hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.cookie).toMatch(/autovideo_lan_client=/);
    const old = await makeLanPlan(L, a, 1, 'Cũ');
    db().prepare('UPDATE projects SET lan_client_hash = NULL WHERE id = ?').run(old.plan.id);

    const la = await plans(a);
    expect(la.find((p) => p.id === mine.plan.id)).toMatchObject({ can_delete: true, delete_block: null });
    expect(la.find((p) => p.id === old.plan.id).can_delete).toBe(false);
    expect((await plans(b)).every((p) => p.can_delete === false)).toBe(true);
    expect((await a.get(`/lan/api/plans/${mine.plan.id}`)).body.plan.can_delete).toBe(true);
    expect((await b.get(`/lan/api/plans/${mine.plan.id}`)).body.plan.can_delete).toBe(false);
    expect(JSON.stringify(la)).not.toContain(hash);
    // cookie giả (đúng hình dạng nhưng khác giá trị) cũng không có quyền
    const fake = L.client({ ip: '192.168.1.12', cookie: `autovideo_lan_client=${'A'.repeat(43)}` });
    await fake.login();
    expect((await plans(fake)).every((p) => p.can_delete === false)).toBe(true);
  });

  it('403 với người khác / kế hoạch cũ / không cookie (không đổi gì); người tạo xoá được → biến mất ở LAN, nằm trong thùng rác (deleted_by=lan) và chủ máy khôi phục được', async () => {
    const mine = await makeLanPlan(L, a, 2, 'Của A');
    const up = await a.upload(`/lan/api/plans/${mine.plan.id}/refs`, [{ name: 'hop.png', data: PNG_BYTES, label: 'Hộp' }]);
    expect(up.status, up.raw).toBe(201);
    const refUrl = up.body[0].url as string;
    expect((await a.get(refUrl)).status).toBe(200);
    const old = await makeLanPlan(L, a, 1, 'Cũ');
    db().prepare('UPDATE projects SET lan_client_hash = NULL WHERE id = ?').run(old.plan.id);

    for (const c of [b, L.client({ ip: '192.168.1.13' })]) {
      if (!c.cookie) await c.login();
      const r = await c.del(`/lan/api/plans/${mine.plan.id}`);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('NOT_PLAN_OWNER');
      expect(r.body.error.message).toMatch(/nhờ chủ máy xoá/);
    }
    expect((await a.del(`/lan/api/plans/${old.plan.id}`)).status).toBe(403); // kế hoạch cũ: kể cả người từng tạo
    expect(proj(mine.plan.id).deleted_at).toBeNull();

    const ok = await a.del(`/lan/api/plans/${mine.plan.id}`);
    expect(ok.status, ok.raw).toBe(200);
    expect(proj(mine.plan.id)).toMatchObject({ deleted_by: 'lan' });
    expect((await a.get(`/lan/api/plans/${mine.plan.id}`)).status).toBe(404);
    expect((await plans(a)).map((p) => p.id)).toEqual([old.plan.id]);
    expect((await a.get(refUrl)).status).toBe(404); // /lan/files
    expect((await a.get('/lan/api/ref-library')).body.map((r: any) => r.label)).toEqual([]);
    expect((await a.del(`/lan/api/plans/${mine.plan.id}`)).status).toBe(404);
    expect((await a.get(`/lan/api/plans/${mine.plan.id}/plan.md`)).status).toBe(404);
    expect((await a.get(`/lan/api/plans/${mine.plan.id}/final-cuts`)).status).toBe(404);
    expect((await userClient(L.env.app).get('/api/lan')).body.plan_count).toBe(1);

    // LAN không có khôi phục hay xoá vĩnh viễn
    expect((await a.post(`/lan/api/trash/${mine.plan.id}/restore`)).status).toBe(404);
    expect((await a.del(`/lan/api/trash/${mine.plan.id}`)).status).toBe(404);
    // chủ máy thấy trong thùng rác, khôi phục: kế hoạch hiện lại trên LAN cho đúng người tạo
    const u = userClient(L.env.app);
    const trash = (await u.get('/api/trash')).body;
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: mine.plan.id, deleted_by: 'lan', source: 'lan', created_by_name: 'Lan' });
    expect((await u.post(`/api/trash/${mine.plan.id}/restore`)).status).toBe(200);
    expect((await plans(a)).find((p) => p.id === mine.plan.id).can_delete).toBe(true);
    expect((await a.get(refUrl)).status).toBe(200);
    expect(purgeExpiredTrash(L.env.ctx).purged).toEqual([]);
  });

  it('bị chặn khi kế hoạch đang dựng bản hoàn chỉnh hoặc đang tải video lên (409); job phân tích đang xếp hàng thì bị hủy', async () => {
    const p = await makeLanPlan(L, a, 1, 'Đang dựng');
    db().prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at) VALUES (?, 1, 'rendering', 's', 'claude', ?)").run(p.plan.id, L.env.ctx.now());
    const r = await a.del(`/lan/api/plans/${p.plan.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Bản hoàn chỉnh v1/);
    expect((await plans(a)).find((x) => x.id === p.plan.id).delete_block).toMatch(/render/);
    db().prepare("UPDATE final_cuts SET status = 'ready'").run();
    const done = L.env.ctx.beginProjectUpload(p.plan.id);
    expect((await a.del(`/lan/api/plans/${p.plan.id}`)).status).toBe(409);
    done();

    const q = await a.post('/lan/api/plans', { name: 'Chờ phân tích', created_by_name: 'Lan', brief: 'Quảng cáo', style_lock: '' });
    const qid = q.body.plan.id;
    expect((await a.post(`/lan/api/plans/${qid}/analyze`, {})).status).toBe(201);
    expect((await a.del(`/lan/api/plans/${qid}`)).status).toBe(200);
    expect(db().prepare('SELECT status FROM jobs WHERE project_id = ?').get(qid)).toEqual({ status: 'cancelled' });
  });

  it('giới hạn 10 lần/giờ/IP (tính cả lần bị từ chối); sang giờ mới dùng lại được', async () => {
    const p = await makeLanPlan(L, a, 1, 'Của A');
    for (let i = 0; i < LAN_RATE.deletePlan.max; i++) expect((await b.del(`/lan/api/plans/${p.plan.id}`)).status).toBe(403);
    const limited = await b.del(`/lan/api/plans/${p.plan.id}`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await a.del(`/lan/api/plans/${p.plan.id}`)).status).toBe(200); // IP khác không bị ảnh hưởng
    L.env.clock.advance(61 * 60_000);
    expect((await b.del(`/lan/api/plans/${p.plan.id}`)).status).toBe(404);
  });
});
