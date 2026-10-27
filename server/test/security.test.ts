import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JPG_BYTES, PNG_BYTES, client, makeEnv, multipart, setupProject, userClient, writeFile, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.close();
});

describe('Host / Origin', () => {
  it('từ chối Host không phải localhost/127.0.0.1', async () => {
    for (const host of ['evil.com', 'evil.com:8787', '192.168.1.5:8787', 'localhost.evil.com', '127.0.0.1.evil.com:8787']) {
      const r = await userClient(env.app).get('/api/projects', { host });
      expect(r.status, host).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_HOST');
    }
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787']) {
      expect((await userClient(env.app).get('/api/projects', { host })).status, host).toBe(200);
    }
  });

  it('request ghi có Origin lạ bị chặn; Origin cho phép / không có Origin thì qua; request đọc không bị chặn bởi Origin', async () => {
    const u = userClient(env.app);
    for (const origin of ['http://evil.com', 'https://localhost:5173', 'http://localhost:9999', 'null', 'http://localhost:5173.evil.com']) {
      const r = await u.post('/api/projects', { name: 'X' }, { origin });
      expect(r.status, origin).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_ORIGIN');
    }
    expect((await u.patch('/api/projects/1', { name: 'x' }, { origin: 'http://evil.com' })).status).toBe(403);
    expect((await u.del('/api/refs/1', undefined, { origin: 'http://evil.com' })).status).toBe(403);
    expect((await u.get('/api/projects')).body).toEqual([]);
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'http://127.0.0.1:8787']) {
      expect((await u.post('/api/projects', { name: 'OK ' + origin }, { origin })).status, origin).toBe(201);
    }
    expect((await u.post('/api/projects', { name: 'Không Origin' })).status).toBe(201);
    expect((await u.get('/api/projects', { origin: 'http://evil.com' })).status).toBe(200);
    // không dự án nào được tạo từ request bị chặn
    expect((await u.get('/api/projects')).body.map((p: any) => p.name)).not.toContain('X');
  });

  it('worker API cũng chịu kiểm tra Origin cho request ghi', async () => {
    const r = await client(env.app, { authorization: 'Bearer test-worker-token' }).post('/api/worker/scenes', {}, { origin: 'http://evil.com' });
    expect(r.status).toBe(403);
  });

  it('EXTRA_ALLOWED_ORIGINS mở thêm origin', async () => {
    await env.close();
    env = await makeEnv({ config: { extraAllowedOrigins: ['http://localhost:5174'] } });
    expect((await userClient(env.app).post('/api/projects', { name: 'A' }, { origin: 'http://localhost:5174' })).status).toBe(201);
  });

  it('thân JSON hỏng → 400 INVALID_JSON; Content-Type lạ → 415; thân rỗng với content-type json được coi là {}', async () => {
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: '{không phải json',
      headers: { host: 'localhost', 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe('INVALID_JSON');
    const text = await env.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: 'name=x',
      headers: { host: 'localhost', 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
    expect(JSON.parse(text.body).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const empty = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { host: 'localhost', 'content-type': 'application/json' } });
    expect(empty.statusCode).toBe(400); // {} thiếu name
    expect(JSON.parse(empty.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('lỗi 404 và validation có đúng định dạng { error: { code, message } } bằng tiếng Việt', async () => {
    const u = userClient(env.app);
    const nf = await u.get('/api/khong-co');
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn' } });
    const nf2 = await u.get('/api/projects/999');
    expect(nf2.body.error).toEqual({ code: 'NOT_FOUND', message: 'Không tìm thấy dự án' });
    const bad = await u.post('/api/projects', { name: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.message).toContain('tên dự án không được rỗng');
    expect((await u.get('/api/projects/abc')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await u.get('/api/projects/-1')).status).toBe(400);
  });
});

describe('upload ảnh tham chiếu', () => {
  async function upload(projectId: number, parts: Parameters<typeof multipart>[0]) {
    const m = multipart(parts);
    const res = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/refs`, payload: m.payload, headers: { ...m.headers, host: 'localhost' } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  const file = (filename: string, data: Buffer, name = 'file') => ({ name, filename, data, type: 'image/png' });

  it('nhận png/jpg/webp theo magic bytes; lưu vào refs/<id>/ với tên đã làm sạch; label mặc định từ tên file', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
    const r = await upload(sc.project.id, [file('Hộp 3/4 mặt trước!.png'.replace('/', '-'), PNG_BYTES), file('anh.jpeg', JPG_BYTES), file('x.webp', webp)]);
    expect(r.status).toBe(201);
    expect(r.body.map((x: any) => x.file_path)).toEqual([`refs/${sc.project.id}/Hop-3-4-mat-truoc.png`, `refs/${sc.project.id}/anh.jpg`, `refs/${sc.project.id}/x.webp`]);
    expect(r.body[0]).toMatchObject({ label: 'Hộp 3-4 mặt trước!', order_index: 0, url: `/files/refs/${sc.project.id}/Hop-3-4-mat-truoc.png` });
    expect(r.body.map((x: any) => x.order_index)).toEqual([0, 1, 2]);
    for (const x of r.body) expect(fs.existsSync(path.join(env.root, x.file_path))).toBe(true);
    // trùng tên → thêm hậu tố
    const again = await upload(sc.project.id, [file('anh.jpg', JPG_BYTES)]);
    expect(again.body[0].file_path).toBe(`refs/${sc.project.id}/anh-2.jpg`);
    expect(again.body[0].order_index).toBe(3);
    // đuôi file lừa (png thật nhưng đặt tên .jpg) được lưu theo loại thật
    const lie = await upload(sc.project.id, [file('lie.jpg', PNG_BYTES)]);
    expect(lie.body[0].file_path).toBe(`refs/${sc.project.id}/lie.png`);
  });

  it('từ chối file không phải ảnh (kể cả đặt tên .png), file rỗng', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    for (const [name, data] of [
      ['fake.png', Buffer.from('<?php echo 1;')],
      ['doc.pdf', Buffer.from('%PDF-1.4 ...')],
      ['anim.gif', Buffer.from('GIF89a......')],
      ['svg.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['empty.png', Buffer.alloc(0)],
    ] as const) {
      const r = await upload(sc.project.id, [file(name, data)]);
      expect(r.status, name).toBe(415);
      expect(r.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    }
    expect(fs.existsSync(path.join(env.root, 'refs', String(sc.project.id)))).toBe(false);
    expect((await userClient(env.app).get(`/api/projects/${sc.project.id}`)).body.refs).toHaveLength(0);
  });

  it('từ chối file > 10MB (413 FILE_TOO_LARGE); đúng 10MB thì nhận', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const r = await upload(sc.project.id, [file('big.png', big)]);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
    const exactly = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024 - PNG_BYTES.length)]);
    expect((await upload(sc.project.id, [file('ok.png', exactly)])).status).toBe(201);
    expect(fs.existsSync(path.join(env.root, 'refs', String(sc.project.id), 'big.png'))).toBe(false);
  });

  it('từ chối tên file có `..` hoặc dấu phân cách đường dẫn; không file nào được ghi', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    for (const name of ['../evil.png', '..\\evil.png', '../../etc/passwd.png', 'a/../b.png', '/abs/evil.png', 'sub/dir.png', '..']) {
      const r = await upload(sc.project.id, [file(name, PNG_BYTES)]);
      expect(r.status, name).toBe(400);
      expect(r.body.error.code).toBe('INVALID_FILENAME');
    }
    expect(fs.existsSync(path.join(env.root, 'evil.png'))).toBe(false);
    expect(fs.existsSync(path.join(env.root, 'refs', String(sc.project.id)))).toBe(false);
    // `..` nằm trong tên (không phải thành phần đường dẫn) được làm sạch
    const ok = await upload(sc.project.id, [file('a..b.png', PNG_BYTES)]);
    expect(ok.status).toBe(201);
    expect(ok.body[0].file_path).toBe(`refs/${sc.project.id}/a.b.png`);
  });

  it('lô nhiều file: một file hỏng thì không file nào được lưu (tất-cả-hoặc-không)', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const r = await upload(sc.project.id, [file('good.png', PNG_BYTES), file('bad.png', Buffer.from('không phải ảnh'))]);
    expect(r.status).toBe(415);
    expect((await userClient(env.app).get(`/api/projects/${sc.project.id}`)).body.refs).toHaveLength(0);
  });

  it('thiếu file / không phải multipart / dự án không tồn tại', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    expect((await upload(sc.project.id, [{ name: 'label', value: 'x' }])).body.error.code).toBe('NO_FILE');
    const r = await userClient(env.app).post(`/api/projects/${sc.project.id}/refs`, {});
    expect(r.status).toBe(400);
    expect((await upload(9999, [file('a.png', PNG_BYTES)])).status).toBe(404);
  });

  it('đổi nhãn, sắp xếp lại, xóa ảnh (xóa cả file và gỡ khỏi upload_refs của cảnh)', async () => {
    const sc = await setupProject(env, { scenes: 1 });
    const r = await upload(sc.project.id, [file('a.png', PNG_BYTES), file('b.png', PNG_BYTES), file('c.png', PNG_BYTES)]);
    const [a, b, c] = r.body;
    const u = userClient(env.app);
    expect((await u.patch(`/api/refs/${a.id}`, { label: 'Hộp' })).body.label).toBe('Hộp');
    const re = await u.patch('/api/refs/reorder', { project_id: sc.project.id, ids: [c.id, a.id, b.id] });
    expect(re.body.map((x: any) => [x.id, x.order_index])).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]]);
    expect((await u.patch('/api/refs/reorder', { project_id: sc.project.id, ids: [c.id, a.id] })).body.error.code).toBe('INVALID_REFS');
    expect((await u.patch('/api/refs/reorder', { project_id: sc.project.id, ids: [c.id, a.id, a.id] })).status).toBe(400);
    await sc.worker.post('/api/worker/scenes', { project_id: sc.project.id, scenes: [{ code: 'C1', prompt: 'p', upload_refs: [a.id, b.id] }] });
    expect((await u.del(`/api/refs/${a.id}`)).body).toEqual({ ok: true });
    expect(fs.existsSync(path.join(env.root, a.file_path))).toBe(false);
    expect(fs.existsSync(path.join(env.root, b.file_path))).toBe(true);
    expect((await u.get(`/api/projects/${sc.project.id}/scenes`)).body[0].upload_refs).toEqual([b.id]);
    expect((await u.del(`/api/refs/${a.id}`)).status).toBe(404);
  });
});

describe('phục vụ file tĩnh /files', () => {
  it('Range request trả 206 với Content-Range; không Range trả 200 + Accept-Ranges', async () => {
    const data = Buffer.from('0123456789abcdefghij');
    writeFile(env.root, 'output/demo/video/C1_v1.mp4', data);
    const u = userClient(env.app);
    const full = await env.app.inject({ method: 'GET', url: '/files/output/demo/video/C1_v1.mp4', headers: { host: 'localhost' } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['x-content-type-options']).toBe('nosniff');
    const part = await env.app.inject({ method: 'GET', url: '/files/output/demo/video/C1_v1.mp4', headers: { host: 'localhost', range: 'bytes=5-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 5-9/20');
    expect(part.body).toBe('56789');
    const tail = await env.app.inject({ method: 'GET', url: '/files/output/demo/video/C1_v1.mp4', headers: { host: 'localhost', range: 'bytes=15-' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.body).toBe('fghij');
    const bad = await env.app.inject({ method: 'GET', url: '/files/output/demo/video/C1_v1.mp4', headers: { host: 'localhost', range: 'bytes=100-200' } });
    expect(bad.statusCode).toBe(416);
    expect((await u.get('/files/output/demo/video/khong-co.mp4')).status).toBe(404);
  });

  it('chỉ cho prefix output/ và refs/; chặn `..`, mã hóa %2e%2e, đường dẫn tuyệt đối, backslash', async () => {
    writeFile(env.root, 'output/a.txt', 'ok');
    writeFile(env.root, 'refs/1/a.png', PNG_BYTES);
    writeFile(env.root, 'secret.txt', 'bí mật');
    writeFile(env.root, 'data/app.db', 'db');
    const get = async (url: string) => (await env.app.inject({ method: 'GET', url, headers: { host: 'localhost' } })).statusCode;
    expect(await get('/files/output/a.txt')).toBe(200);
    expect(await get('/files/refs/1/a.png')).toBe(200);
    for (const url of [
      '/files/secret.txt',
      '/files/data/app.db',
      '/files/output/../secret.txt',
      '/files/output/%2e%2e/secret.txt',
      '/files/%2e%2e/%2e%2e/etc/passwd',
      '/files/output/..%2fsecret.txt',
      '/files//etc/passwd',
      '/files/%2Fetc/passwd',
      '/files/output%5C..%5Csecret.txt',
      '/files/outputx/a.txt',
      '/files/output',
      '/files/',
    ]) {
      const code = await get(url);
      expect([400, 404], url).toContain(code);
    }
  });

  it('symlink trong output/ trỏ ra ngoài bị chặn', async () => {
    writeFile(env.root, 'secret.txt', 'bí mật');
    fs.mkdirSync(path.join(env.root, 'output'), { recursive: true });
    fs.symlinkSync(path.join(env.root, 'secret.txt'), path.join(env.root, 'output', 'link.txt'));
    fs.symlinkSync(env.root, path.join(env.root, 'output', 'dirlink'));
    const get = async (url: string) => (await env.app.inject({ method: 'GET', url, headers: { host: 'localhost' } })).statusCode;
    expect(await get('/files/output/link.txt')).toBe(404);
    expect(await get('/files/output/dirlink/secret.txt')).toBe(404);
  });

  it('/files cũng chịu kiểm tra Host', async () => {
    writeFile(env.root, 'output/a.txt', 'ok');
    const r = await env.app.inject({ method: 'GET', url: '/files/output/a.txt', headers: { host: 'evil.com' } });
    expect(r.statusCode).toBe(403);
  });
});
