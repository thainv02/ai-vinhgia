import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openDb, runMigrations } from '../src/db/index.js';
import { backfillRefHashes } from '../src/services/refs.js';
import { PNG_BYTES, makeEnv, multipart, setupProject, userClient, writeFile, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** PNG hợp lệ theo magic bytes nhưng nội dung khác nhau theo `tag` (hash khác nhau). */
const img = (tag: string) => Buffer.concat([PNG_BYTES, Buffer.from(tag)]);

async function upload(projectId: number, files: { name: string; data: Buffer; label?: string }[]) {
  const parts: Parameters<typeof multipart>[0] = [];
  for (const f of files) {
    if (f.label) parts.push({ name: 'label', value: f.label });
    parts.push({ name: 'file', filename: f.name, data: f.data, type: 'image/png' });
  }
  const m = multipart(parts);
  const res = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/refs`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
  return { status: res.statusCode, body: JSON.parse(res.body) as any };
}

async function twoProjects() {
  const a = await setupProject(env, { scenes: 1, project: { name: 'Dự án A' } });
  const b = await setupProject(env, { scenes: 1, project: { name: 'Dự án B' } });
  return { a, b, u: userClient(env.app) };
}

describe('content_hash', () => {
  it('upload ghi content_hash = sha256 nội dung; refJson trả về trường này', async () => {
    const { a } = await twoProjects();
    const data = img('hộp');
    const r = await upload(a.project.id, [{ name: 'box.png', data, label: 'Hộp' }]);
    expect(r.status).toBe(201);
    expect(r.body[0].content_hash).toBe(sha(data));
    const detail = (await userClient(env.app).get(`/api/projects/${a.project.id}`)).body;
    expect(detail.refs[0].content_hash).toBe(sha(data));
    expect((await userClient(env.app).get(`/api/projects/${a.project.id}/refs`)).body[0].content_hash).toBe(sha(data));
  });

  it('backfill điền content_hash còn thiếu bằng cách đọc file, bỏ qua file mất; chạy lặp lại an toàn', async () => {
    const { a } = await twoProjects();
    const d1 = img('một');
    const d2 = img('hai');
    writeFile(env.root, 'refs/1/one.png', d1);
    writeFile(env.root, 'refs/1/two.png', d2);
    const ins = env.ctx.db.prepare(
      'INSERT INTO project_refs (project_id, label, file_path, order_index, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run(a.project.id, 'Một', 'refs/1/one.png', 0, env.ctx.now());
    ins.run(a.project.id, 'Hai', 'refs/1/two.png', 1, env.ctx.now());
    ins.run(a.project.id, 'Mất file', 'refs/1/gone.png', 2, env.ctx.now());
    ins.run(a.project.id, 'Ngoài refs', 'output/x.png', 3, env.ctx.now());
    writeFile(env.root, 'output/x.png', d1);
    expect(backfillRefHashes(env.ctx)).toBe(2);
    const rows = env.ctx.db.prepare('SELECT label, content_hash FROM project_refs ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { label: 'Một', content_hash: sha(d1) },
      { label: 'Hai', content_hash: sha(d2) },
      { label: 'Mất file', content_hash: null },
      { label: 'Ngoài refs', content_hash: null },
    ]);
    expect(backfillRefHashes(env.ctx)).toBe(0);
    // file xuất hiện lại → lần sau điền được
    writeFile(env.root, 'refs/1/gone.png', img('mới có'));
    expect(backfillRefHashes(env.ctx)).toBe(1);
  });

  it('khởi động app tự backfill (sau migration)', async () => {
    const { a } = await twoProjects();
    const data = img('khởi động');
    writeFile(env.root, 'refs/1/boot.png', data);
    env.ctx.db
      .prepare('INSERT INTO project_refs (project_id, label, file_path, order_index, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(a.project.id, 'Boot', 'refs/1/boot.png', env.ctx.now());
    const app2 = await env.second(); // buildApp trên cùng DB
    const row = app2.ctx.db.prepare("SELECT content_hash FROM project_refs WHERE label = 'Boot'").get() as any;
    expect(row.content_hash).toBe(sha(data));
  });

  it('migration 002 áp dụng sạch lên DB cũ đã có ảnh tham chiếu (giữ nguyên dữ liệu, hash NULL cho tới khi backfill)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-mig-'));
    try {
      const only001 = path.join(tmp, 'migs');
      fs.mkdirSync(only001);
      fs.copyFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), path.join(only001, '001_init.sql'));
      const db = openDb(path.join(tmp, 'old.db'));
      expect(runMigrations(db, only001)).toEqual(['001_init']);
      db.prepare("INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', 'a', 'b')").run();
      db.prepare("INSERT INTO project_refs (project_id, label, file_path, created_at) VALUES (1, 'Hộp', 'refs/1/a.png', 'a')").run();
      expect(runMigrations(db)).toEqual(['002_ref_library', '003_final_cuts', '004_watermark', '005_managed_workers', '006_account_identity', '007_account_quota', '008_job_reconciliations', '009_lan_planner', '010_lan_tools', '011_project_trash', '012_final_cut_feedback', '013_color_refs', '014_clips', '015_clip_captions']);
      expect(runMigrations(db)).toEqual([]);
      expect(db.prepare('SELECT label, content_hash FROM project_refs').all()).toEqual([{ label: 'Hộp', content_hash: null }]);
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_refs'").all() as { name: string }[]).map((r) => r.name);
      expect(idx).toEqual(expect.arrayContaining(['idx_project_refs_hash', 'idx_project_refs_project_hash']));
      db.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('GET /api/ref-library', () => {
  it('gom ảnh trùng nội dung ở nhiều dự án thành MỘT mục; mới nhất trước; in_project theo projectId', async () => {
    const { a, b, u } = await twoProjects();
    env.clock.advance(1000);
    const box = img('hộp');
    const stick = img('stick');
    await upload(a.project.id, [{ name: 'box.png', data: box, label: 'Hộp 3/4' }]);
    env.clock.advance(1000);
    await upload(a.project.id, [{ name: 'stick.png', data: stick, label: 'Gói stick' }]);
    env.clock.advance(1000);
    const bRefs = await upload(b.project.id, [{ name: 'hop-b.png', data: box, label: 'Hộp (B)' }]); // trùng nội dung với A, mới hơn

    const lib = (await u.get('/api/ref-library')).body;
    expect(lib).toHaveLength(2);
    // mới nhất trước: mục "box" có bản mới nhất ở dự án B (t+3000) nên đứng trước "stick" (t+2000)
    expect(lib.map((x: any) => x.content_hash)).toEqual([sha(box), sha(stick)]);
    const boxItem = lib[0];
    expect(Object.keys(boxItem).sort()).toEqual(
      ['content_hash', 'created_at', 'file_path', 'in_project', 'label', 'original_name', 'projects', 'ref_id', 'url'],
    );
    expect(boxItem).toMatchObject({
      ref_id: bRefs.body[0].id, // bản ghi mới nhất
      label: 'Hộp (B)',
      original_name: 'hop-b.png',
      file_path: bRefs.body[0].file_path,
      url: `/files/${bRefs.body[0].file_path}`,
      in_project: false, // không truyền projectId
    });
    expect(boxItem.projects).toEqual([
      { id: b.project.id, name: 'Dự án B' },
      { id: a.project.id, name: 'Dự án A' },
    ]);
    expect(lib[1].projects).toEqual([{ id: a.project.id, name: 'Dự án A' }]);

    // in_project theo dự án
    const forA = (await u.get(`/api/ref-library?projectId=${a.project.id}`)).body;
    expect(forA.map((x: any) => x.in_project)).toEqual([true, true]);
    const forB = (await u.get(`/api/ref-library?projectId=${b.project.id}`)).body;
    expect(forB.map((x: any) => [x.content_hash === sha(box), x.in_project])).toEqual([[true, true], [false, false]]);
    expect((await u.get('/api/ref-library?projectId=9999')).status).toBe(404);
    expect((await u.get('/api/ref-library?projectId=abc')).status).toBe(400);
  });

  it('lấy ref_id/file/nhãn từ bản ghi mới nhất CÒN FILE; bỏ ảnh mà mọi bản ghi đều mất file', async () => {
    const { a, b, u } = await twoProjects();
    const box = img('hộp');
    const gone = img('mất hết');
    const ra = await upload(a.project.id, [{ name: 'box.png', data: box, label: 'Hộp (A)' }, { name: 'gone.png', data: gone, label: 'Mất' }]);
    env.clock.advance(1000);
    const rb = await upload(b.project.id, [{ name: 'box.png', data: box, label: 'Hộp (B)' }, { name: 'gone.png', data: gone, label: 'Mất B' }]);
    // bản mới nhất của "box" (dự án B) mất file → rơi về bản của A
    fs.rmSync(path.join(env.root, rb.body[0].file_path));
    let lib = (await u.get('/api/ref-library')).body;
    const boxItem = lib.find((x: any) => x.content_hash === sha(box));
    expect(boxItem).toMatchObject({ ref_id: ra.body[0].id, label: 'Hộp (A)', file_path: ra.body[0].file_path });
    expect(boxItem.projects.map((p: any) => p.id).sort()).toEqual([a.project.id, b.project.id].sort());
    // "gone": mất file ở cả hai dự án → biến mất khỏi thư viện
    fs.rmSync(path.join(env.root, ra.body[1].file_path));
    fs.rmSync(path.join(env.root, rb.body[1].file_path));
    lib = (await u.get('/api/ref-library')).body;
    expect(lib.map((x: any) => x.content_hash)).toEqual([sha(box)]);
  });

  it('thư viện trống là mảng rỗng; ref chưa có hash (dữ liệu cũ) được backfill khi liệt kê', async () => {
    const { a, u } = await twoProjects();
    expect((await u.get('/api/ref-library')).body).toEqual([]);
    const data = img('cũ');
    writeFile(env.root, 'refs/1/old.png', data);
    env.ctx.db
      .prepare('INSERT INTO project_refs (project_id, label, file_path, original_name, order_index, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(a.project.id, 'Cũ', 'refs/1/old.png', 'old.png', env.ctx.now());
    const lib = (await u.get('/api/ref-library')).body;
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ label: 'Cũ', content_hash: sha(data) });
  });
});

describe('POST /api/projects/:id/refs/from-library', () => {
  async function seedLibrary() {
    const { a, b, u } = await twoProjects();
    const files = { box: img('hộp'), stick: img('stick'), cup: img('ly') };
    const r = await upload(a.project.id, [
      { name: 'Hộp 3-4.png', data: files.box, label: 'Hộp 3/4' },
      { name: 'stick.png', data: files.stick, label: 'Gói stick' },
      { name: 'cup.png', data: files.cup, label: 'Ly' },
    ]);
    return { a, b, u, files, refs: r.body as any[] };
  }
  const post = (u: ReturnType<typeof userClient>, projectId: number, body: unknown) => u.post(`/api/projects/${projectId}/refs/from-library`, body);

  it('chép file (không dùng chung đường dẫn), đúng thứ tự ref_ids, giữ nhãn nguồn hoặc labels[ref_id], nối vào cuối', async () => {
    const { a, b, u, files, refs } = await seedLibrary();
    await upload(b.project.id, [{ name: 'co-san.png', data: img('đã có sẵn trong B'), label: 'Sẵn' }]);
    const [box, stick, cup] = refs;
    const r = await post(u, b.project.id, { ref_ids: [cup.id, box.id, stick.id], labels: { [String(box.id)]: 'Hộp (đổi nhãn)' } });
    expect(r.status).toBe(201);
    expect(r.body.map((x: any) => x.label)).toEqual(['Ly', 'Hộp (đổi nhãn)', 'Gói stick']);
    expect(r.body.map((x: any) => x.order_index)).toEqual([1, 2, 3]); // sau ảnh sẵn có (order 0)
    expect(r.body.map((x: any) => x.content_hash)).toEqual([sha(files.cup), sha(files.box), sha(files.stick)]);
    for (const x of r.body) {
      expect(x.project_id).toBe(b.project.id);
      expect(x.file_path.startsWith(`refs/${b.project.id}/`)).toBe(true);
      expect(Object.keys(x).sort()).toEqual(
        ['content_hash', 'created_at', 'file_path', 'id', 'label', 'order_index', 'original_name', 'project_id', 'url'],
      );
      expect(fs.readFileSync(path.join(env.root, x.file_path)).equals(files[(x.label.startsWith('Hộp') ? 'box' : x.label === 'Ly' ? 'cup' : 'stick') as 'box'])).toBe(true);
    }
    // tên file đã làm sạch, bản gốc ở dự án A không bị đụng tới
    expect(r.body[1].file_path).toBe(`refs/${b.project.id}/Hop-3-4.png`);
    expect(r.body[1].original_name).toBe('Hộp 3-4.png');
    expect(fs.existsSync(path.join(env.root, box.file_path))).toBe(true);
    const detail = (await u.get(`/api/projects/${b.project.id}`)).body;
    expect(detail.refs.map((x: any) => x.label)).toEqual(['Sẵn', 'Ly', 'Hộp (đổi nhãn)', 'Gói stick']);

    // xóa ở dự án B không làm hỏng dự án A
    await u.del(`/api/refs/${r.body[1].id}`);
    expect(fs.existsSync(path.join(env.root, r.body[1].file_path))).toBe(false);
    expect(fs.readFileSync(path.join(env.root, box.file_path)).equals(files.box)).toBe(true);
    expect((await u.get(box.url)).status).toBe(200);
    // và ảnh vẫn còn trong thư viện (từ dự án A)
    expect((await u.get('/api/ref-library')).body.map((x: any) => x.content_hash)).toContain(sha(files.box));
    void a;
  });

  it('idempotent theo content_hash: dự án đã có ảnh cùng hash thì không chép, trả lại ref sẵn có', async () => {
    const { a, b, u, files, refs } = await seedLibrary();
    const mine = await upload(b.project.id, [{ name: 'tu-tai-len.png', data: files.box, label: 'Hộp của B' }]); // cùng nội dung với refs[0]
    const first = await post(u, b.project.id, { ref_ids: [refs[0].id, refs[1].id] });
    expect(first.status).toBe(201);
    expect(first.body[0].id).toBe(mine.body[0].id); // trả lại ảnh sẵn có, nhãn của B giữ nguyên
    expect(first.body[0].label).toBe('Hộp của B');
    expect(first.body[1].label).toBe('Gói stick');
    const count = () => (env.ctx.db.prepare('SELECT COUNT(*) AS n FROM project_refs WHERE project_id = ?').get(b.project.id) as any).n;
    expect(count()).toBe(2);
    const dir = fs.readdirSync(path.join(env.root, 'refs', String(b.project.id))).length;
    // gọi lại y hệt → không thêm bản ghi, không thêm file
    const again = await post(u, b.project.id, { ref_ids: [refs[0].id, refs[1].id] });
    expect(again.status).toBe(201);
    expect(again.body.map((x: any) => x.id)).toEqual(first.body.map((x: any) => x.id));
    expect(count()).toBe(2);
    expect(fs.readdirSync(path.join(env.root, 'refs', String(b.project.id))).length).toBe(dir);
    // trùng id trong cùng một lô → cùng một ref, chỉ một bản ghi
    const dup = await post(u, b.project.id, { ref_ids: [refs[2].id, refs[2].id] });
    expect(dup.body[0].id).toBe(dup.body[1].id);
    expect(count()).toBe(3);
    // chọn ảnh của chính dự án mình cũng là no-op
    expect((await post(u, a.project.id, { ref_ids: [refs[0].id] })).body[0].id).toBe(refs[0].id);
  });

  it('tên trùng được thêm hậu tố, không ghi đè ảnh cùng tên khác nội dung', async () => {
    const { b, u, refs } = await seedLibrary();
    await upload(b.project.id, [{ name: 'Hộp 3-4.png', data: img('khác nội dung nhưng cùng tên'), label: 'Khác' }]);
    const r = await post(u, b.project.id, { ref_ids: [refs[0].id] });
    expect(r.status).toBe(201);
    expect(r.body[0].file_path).toBe(`refs/${b.project.id}/Hop-3-4-2.png`);
    expect(fs.readFileSync(path.join(env.root, `refs/${b.project.id}/Hop-3-4.png`)).equals(img('khác nội dung nhưng cùng tên'))).toBe(true);
  });

  it('ref nguồn không tồn tại → 404 và KHÔNG thêm ảnh nào (kể cả các ảnh hợp lệ đứng trước)', async () => {
    const { b, u, refs } = await seedLibrary();
    const r = await post(u, b.project.id, { ref_ids: [refs[0].id, 987654] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect((await u.get(`/api/projects/${b.project.id}`)).body.refs).toHaveLength(0);
    expect(fs.existsSync(path.join(env.root, 'refs', String(b.project.id)))).toBe(false);
    expect((await post(u, 9999, { ref_ids: [refs[0].id] })).status).toBe(404);
  });

  it('file nguồn mất → 409 FILE_MISSING, không thêm gì; nếu dự án đã có ảnh cùng hash thì vẫn trả ref sẵn có', async () => {
    const { b, u, files, refs } = await seedLibrary();
    fs.rmSync(path.join(env.root, refs[1].file_path));
    const r = await post(u, b.project.id, { ref_ids: [refs[0].id, refs[1].id] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('FILE_MISSING');
    expect(r.body.error.message).toContain('Gói stick');
    expect((await u.get(`/api/projects/${b.project.id}`)).body.refs).toHaveLength(0); // all-or-nothing
    // B đã có ảnh cùng nội dung → không cần đọc file nguồn
    await upload(b.project.id, [{ name: 'stick-b.png', data: files.stick, label: 'Stick B' }]);
    const ok = await post(u, b.project.id, { ref_ids: [refs[1].id] });
    expect(ok.status).toBe(201);
    expect(ok.body[0].label).toBe('Stick B');
  });

  it('xác thực đầu vào: ref_ids rỗng / quá 20 / sai kiểu → 400', async () => {
    const { b, u, refs } = await seedLibrary();
    expect((await post(u, b.project.id, { ref_ids: [] })).status).toBe(400);
    expect((await post(u, b.project.id, {})).status).toBe(400);
    expect((await post(u, b.project.id, { ref_ids: Array.from({ length: 21 }, () => refs[0].id) })).status).toBe(400);
    expect((await post(u, b.project.id, { ref_ids: ['a'] })).status).toBe(400);
    expect((await post(u, b.project.id, { ref_ids: [refs[0].id], labels: { x: 5 } })).status).toBe(400);
    expect((await post(u, b.project.id, { ref_ids: Array.from({ length: 20 }, () => refs[0].id) })).status).toBe(201); // đúng 20 là được
  });

  it('phát SSE project.updated; ảnh chép từ thư viện dùng được như ảnh thường (upload_refs → payload job)', async () => {
    const { a, b, u, refs } = await seedLibrary();
    const seen: any[] = [];
    const orig = env.ctx.sse.publish.bind(env.ctx.sse);
    env.ctx.sse.publish = (e: string, d: unknown, p: number | null) => {
      if (e === 'project.updated') seen.push({ d, p });
      orig(e, d, p);
    };
    // publish chỉ chạy khi có người nghe: giả lập một người nghe
    const fakeRes: any = { writeHead() {}, write() {}, on() {}, end() {} };
    env.ctx.sse.add(fakeRes, b.project.id);
    const r = await post(u, b.project.id, { ref_ids: [refs[0].id] });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1).p).toBe(b.project.id);
    expect(seen.at(-1).d.project.id).toBe(b.project.id);
    // cảnh của B dùng ảnh vừa chép
    const w = (await import('./helpers.js')).workerClient(env.app);
    await w.post('/api/worker/scenes', { project_id: b.project.id, scenes: [{ code: 'C1', prompt: 'p', upload_refs: [r.body[0].id] }] });
    const scene = (await u.get(`/api/projects/${b.project.id}/scenes`)).body[0];
    await u.post(`/api/scenes/${scene.id}/approve`, { stage: 'storyboard' });
    const job = (await w.get('/api/worker/next')).body;
    expect(job.payload.upload_files).toEqual([r.body[0].file_path]);
    void a;
  });
});
