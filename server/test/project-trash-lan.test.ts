import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG_BYTES, userClient } from './helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan } from './helpers-lan-plan.js';

let L: LanEnv;
let a: LanClient;
beforeEach(async () => {
  L = await makeLanEnv();
  a = L.client({ ip: '192.168.1.10' });
});
afterEach(async () => {
  await L.close();
});

const db = () => L.env.ctx.db;
const plans = async (c: LanClient) => (await c.get('/lan/api/plans')).body as any[];
const proj = (id: number) => db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;

describe('xoá kế hoạch từ giao diện', () => {
  it('bị chặn khi kế hoạch đang dựng bản hoàn chỉnh hoặc đang tải video lên (409); job phân tích đang xếp hàng không chặn xoá', async () => {
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
    expect(db().prepare('SELECT id FROM projects WHERE id = ?').get(qid)).toBeUndefined(); // xoá vĩnh viễn (job đi theo)
  });

  it('trang LAN: file trong dự án bị chương trình khác giữ (Windows) → 409 FILE_IN_USE, dự án giữ nguyên; đóng file rồi xoá được', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    const p = await makeLanPlan(L, a, 1, 'Đang mở video');
    const dir = path.join(L.env.root, 'output', proj(p.plan.id).slug);
    const holder = await holdFileOpen(path.join(dir, 'dang-mo.mp4'));
    try {
      const r = await a.del(`/lan/api/plans/${p.plan.id}`);
      expect(r.status, r.raw).toBe(409);
      expect(r.body.error).toMatchObject({ code: 'FILE_IN_USE' });
      expect(r.body.error.message).toMatch(/đang được mở.*đóng/);
      expect(proj(p.plan.id).deleted_at).toBeNull();
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      await holder.release();
    }
    expect((await a.del(`/lan/api/plans/${p.plan.id}`)).status).toBe(200);
  });

});

/**
 * Giữ một file mở bằng tiến trình khác KHÔNG chia sẻ quyền xoá (như ffmpeg hay trình xem video trên Windows): đổi tên/xoá thư mục chứa nó sẽ lỗi.
 * Chờ tới khi khoá có hiệu lực (đổi tên thư mục thất bại) rồi mới trả về.
 */
async function holdFileOpen(file: string): Promise<{ release: () => Promise<void> }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'video');
  const ps = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('open'); [Console]::In.ReadLine() | Out-Null; $f.Close()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d) => String(d).includes('open') && resolve());
    child.once('exit', () => reject(new Error('powershell thoát trước khi mở file')));
  });
  return {
    release: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin!.end('\n');
      }),
  };
}

describe('xoá trên bản desktop (một người dùng, không có thùng rác)', () => {
  let D: LanEnv;
  let c: LanClient;
  beforeEach(async () => {
    D = await makeLanEnv({ config: { trashRetentionDays: 0 } });
    c = D.client({ host: '127.0.0.1:8790', origin: 'http://127.0.0.1:8790', ip: '127.0.0.1' });
  });
  afterEach(async () => {
    await D.close();
  });
  const row = (id: number) => D.env.ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;

  it('mọi kế hoạch đều xoá được (kể cả kế hoạch cũ không có cookie người tạo); xoá là xoá vĩnh viễn: mất dòng trong DB, thư mục output/refs và không để lại gì trong thùng rác', async () => {
    const p = await makeLanPlan(D, c, 2, 'Kế hoạch desktop');
    const up = await c.upload(`/lan/api/plans/${p.plan.id}/refs`, [{ name: 'hop.png', data: PNG_BYTES, label: 'Hộp' }]);
    expect(up.status, up.raw).toBe(201);
    D.env.ctx.db.prepare('UPDATE projects SET lan_client_hash = NULL WHERE id = ?').run(p.plan.id);
    const other = D.client({ host: '127.0.0.1:8790', origin: 'http://127.0.0.1:8790', ip: '127.0.0.1' }); // không có cookie người tạo
    expect((await other.get('/lan/api/plans')).body.find((x: any) => x.id === p.plan.id)).toMatchObject({ can_delete: true, delete_block: null });
    const { slug } = row(p.plan.id);
    const outDir = path.join(D.env.root, 'output', slug);
    const refsDir = path.join(D.env.root, 'refs', String(p.plan.id));
    expect(fs.existsSync(refsDir)).toBe(true);

    const r = await other.del(`/lan/api/plans/${p.plan.id}`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ ok: true, purged: true, restorable_days: 0 });
    expect(row(p.plan.id)).toBeUndefined();
    expect(fs.existsSync(outDir)).toBe(false);
    expect(fs.existsSync(refsDir)).toBe(false);
    const trash = path.join(D.env.root, 'output', '.trash');
    expect(fs.existsSync(trash) ? fs.readdirSync(trash) : []).toEqual([]);
    expect((await userClient(D.env.app).get('/api/trash')).body).toEqual([]);
    expect((await c.get('/lan/api/plans')).body).toEqual([]);
  });

  it('dự án đang bận vẫn bị chặn 409 PROJECT_BUSY, không đụng file', async () => {
    const p = await makeLanPlan(D, c, 1, 'Đang dựng');
    D.env.ctx.db.prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at) VALUES (?, 1, 'rendering', 's', 'claude', ?)").run(p.plan.id, D.env.ctx.now());
    const r = await c.del(`/lan/api/plans/${p.plan.id}`);
    expect([r.status, r.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
    expect(row(p.plan.id).deleted_at).toBeNull();
  });
});
