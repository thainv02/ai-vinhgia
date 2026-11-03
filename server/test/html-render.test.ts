import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { captureForVision, recoverHtmlRenders, setHtmlEngine, setHtmlRevealer, type HtmlEngine } from '../src/services/html/render.js';
import { FFMPEG, FFPROBE, makeTestVideo } from './final-helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';

/**
 * Hàng đợi/dựng MP4 Video HTML với ENGINE GIẢ (`setHtmlEngine`): không trình duyệt thật. Video "dựng" là file mp4 thật tạo sẵn bằng ffmpeg
 * (cần ffmpeg/ffprobe cho đường ready/verify; không có thì các test đó bỏ qua).
 */
const P = '/lan/api/html-projects';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avhtml-rt-'));
const GOOD = path.join(tmp, 'good.mp4'); // 720x1280, 30 fps, 1 s, không audio
const BAD_SIZE = path.join(tmp, 'bad-size.mp4');
const BAD_DUR = path.join(tmp, 'bad-dur.mp4');
const WITH_AUDIO = path.join(tmp, 'audio.mp4');
beforeAll(() => {
  if (!FFMPEG || !FFPROBE) return;
  makeTestVideo(GOOD, 1, { audio: false, size: '720x1280', fps: 30 });
  makeTestVideo(BAD_SIZE, 1, { audio: false, size: '160x284', fps: 30 });
  makeTestVideo(BAD_DUR, 2, { audio: false, size: '720x1280', fps: 30 });
  makeTestVideo(WITH_AUDIO, 1, { audio: true, size: '720x1280', fps: 30 });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const haveMedia = !!FFMPEG && !!FFPROBE;

/** Engine giả: ghi nhận lượt chạy, giữ cổng, mô phỏng tiến trình thoát chậm khi hủy. */
class FakeEngine implements HtmlEngine {
  browser = true;
  hold = false;
  source = GOOD;
  lingerMs = 0;
  running = 0;
  maxRunning = 0;
  log: string[] = [];
  materialized: { mode: string }[] = [];
  captured: number[][] = [];
  private gates = new Map<number, () => void>();
  private open = false;
  browserPath(): string {
    if (!this.browser) throw new AppError('HTML_RENDERER_MISSING', 'Chưa cài bộ dựng Video HTML (Cài đặt > Bộ dựng Video HTML)', 409);
    return 'fake-browser';
  }
  async materialize(versionDir: string, workDir: string, o: { mode: 'render' | 'capture' | 'preview' }): Promise<void> {
    this.materialized.push({ mode: o.mode });
    fs.copyFileSync(path.join(versionDir, 'index.html'), path.join(workDir, 'index.html'));
  }
  async runRender(_ctx: unknown, o: Parameters<HtmlEngine['runRender']>[1]): Promise<{ warnings: string[] }> {
    const id = Number(path.basename(path.dirname(o.outPath)));
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    this.log.push(`start:${id}`);
    try {
      o.onProgress(10, 'capture');
      if (this.hold && !this.open) {
        await new Promise<void>((resolve, reject) => {
          this.gates.set(id, resolve);
          o.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), this.lingerMs), { once: true });
        });
      }
      if (o.signal.aborted) throw new Error('aborted');
      fs.copyFileSync(this.source, o.outPath);
      return { warnings: [] };
    } finally {
      this.running--;
      this.log.push(`end:${id}`);
    }
  }
  async captureFrames(_ctx: unknown, o: Parameters<HtmlEngine['captureFrames']>[1]): Promise<Buffer[]> {
    this.log.push('capture');
    this.captured.push(o.times);
    return o.times.map(() => Buffer.from('png'));
  }
  release(id?: number): void {
    if (id === undefined) {
      this.open = true;
      for (const g of this.gates.values()) g();
      this.gates.clear();
    } else this.gates.get(id)?.();
  }
  reset(): void {
    this.open = false;
    this.hold = false;
  }
}

let L: LanEnv;
let c: LanClient;
let eng: FakeEngine;
let seq = 0;
const key = () => `rk-${Date.now()}-${++seq}-abcdef`;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await tick(5);
  }
}
async function setup(concurrency = 1) {
  eng = new FakeEngine();
  setHtmlEngine(eng);
  L = await makeLanEnv({ config: { renderConcurrency: concurrency }, app: { finalRender: { progressThrottleMs: 0, queueNotifyMs: 0 } } });
  c = L.client();
}
afterEach(async () => {
  eng?.release();
  await L?.env.ctx.finalRender?.idle();
  setHtmlEngine(null);
  setHtmlRevealer(null);
  await L?.close();
});
const db = () => L.env.ctx.db;
const rf = () => L.env.ctx.finalRender!;
const row = (id: number) => db().prepare('SELECT * FROM html_renders WHERE id = ?').get(id) as any;

/** Dự án + n phiên bản `ready` (ghi thẳng DB + file). Trả { p, versions:[số] }. */
async function mkProject(n = 1, over: Record<string, unknown> = {}, html = '<!doctype html><html><body><div data-composition-id="main"></div></body></html>') {
  const r = await c.post(P, { name: 'Video thử', brief: 'b', aspect: '9:16', duration_s: 1, quality: '720p', template: null, model: {}, ...over });
  expect(r.status, r.raw).toBe(201);
  const p = r.body;
  for (let i = 1; i <= n; i++) {
    const rel = `output/${p.slug}/html/versions/v${i}`;
    fs.mkdirSync(path.join(L.env.root, rel), { recursive: true });
    fs.writeFileSync(path.join(L.env.root, rel, 'index.html'), html);
    db()
      .prepare("INSERT INTO html_versions (project_id, version, status, files_dir, content_hash, created_by, created_at, published_at) VALUES (?, ?, 'ready', ?, ?, 'ai', ?, ?)")
      .run(p.id, i, rel, `hash${i}`, new Date().toISOString(), new Date().toISOString());
  }
  return p as { id: number; slug: string };
}
const render = (pid: number, v: number, quality = '720p', k = key()) => c.post(`${P}/${pid}/versions/${v}/renders`, { quality, idempotency_key: k });
const startedCount = () => eng.log.filter((l) => l.startsWith('start:')).length;

describe('hàng đợi: concurrency và ưu tiên', () => {
  it.skipIf(!haveMedia)('3 đoạn + voice: đúng 1 audio, đúng tổng; cache không dựng lại và hash hỏng phải dựng lại',async()=>{
    await setup(1);const p=await mkProject(4,{duration_s:3}),root=db().prepare('SELECT * FROM html_versions WHERE project_id=? AND version=1').get(p.id) as any;
    fs.mkdirSync(path.join(L.env.root,root.files_dir,'assets/u'),{recursive:true});fs.copyFileSync(WITH_AUDIO,path.join(L.env.root,root.files_dir,'assets/u/1.mp4'));
    db().prepare('UPDATE html_versions SET is_segmented=1,voice_json=? WHERE id=?').run(JSON.stringify({asset_id:1,path:'assets/u/1.mp4',duration_s:3}),root.id);
    for(let idx=1;idx<=3;idx++){
      const child=db().prepare('SELECT * FROM html_versions WHERE project_id=? AND version=?').get(p.id,idx+1) as any;
      db().prepare('UPDATE html_versions SET segment_owner_id=? WHERE id=?').run(root.id,child.id);
      db().prepare("INSERT INTO html_segments(version_id,idx,start_s,end_s,status,segment_version_id,files_dir,content_hash,updated_at) VALUES(?,?,?,?,'ready',?,?,?,'x')").run(root.id,idx,idx-1,idx,child.id,child.files_dir,child.content_hash);
    }
    const one=await render(p.id,1);await rf().idle();expect(row(one.body.id)).toMatchObject({status:'ready'});expect(startedCount()).toBe(3);
    expect(JSON.parse(row(one.body.id).settings_json).output.duration_s).toBeCloseTo(3,1);
    const two=await render(p.id,1);await rf().idle();expect(row(two.body.id)).toMatchObject({status:'ready'});expect(startedCount()).toBe(3);
    const cache=db().prepare('SELECT video_path FROM html_segment_renders ORDER BY segment_version_id').all() as any[];expect(cache).toHaveLength(3);
    fs.appendFileSync(path.join(L.env.root,cache[1].video_path),'changed');
    const three=await render(p.id,1);await rf().idle();expect(row(three.body.id)).toMatchObject({status:'ready'});expect(startedCount()).toBe(4);
  },30000);
  for (const conc of [1, 2]) {
    it(`RENDER_CONCURRENCY=${conc}: nhiều bản dựng không bao giờ vượt ${conc}, đều xong ready`, async () => {
      await setup(conc);
      eng.hold = true;
      const p = await mkProject(4);
      const ids: number[] = [];
      for (let v = 1; v <= 4; v++) {
        const r = await render(p.id, v);
        expect(r.status, r.raw).toBe(201);
        ids.push(r.body.id);
      }
      await waitFor(() => startedCount() === conc);
      await tick(60);
      expect(startedCount()).toBe(conc);
      expect(eng.running).toBe(conc);
      // trạng thái hàng đợi trong view
      const views = (await c.get(`${P}/${p.id}/renders`)).body;
      expect(views.filter((x: any) => x.queue?.state === 'running')).toHaveLength(conc);
      expect(views.filter((x: any) => x.queue?.state === 'waiting').map((x: any) => x.queue.position).sort()).toEqual(Array.from({ length: 4 - conc }, (_, i) => i + 1));
      eng.release();
      await rf().idle();
      expect(eng.maxRunning).toBeLessThanOrEqual(conc);
      if (haveMedia) for (const id of ids) expect(row(id), JSON.stringify(row(id))).toMatchObject({ status: 'ready', progress: 100 });
    });
  }

  it('việc của app vẫn đứng trước việc LAN; html-capture/html dùng chung slot', async () => {
    await setup(1);
    const order: string[] = [];
    const gate: { release?: () => void } = {};
    rf().enqueueHtmlTask('html', 'blocker', true, () => new Promise<void>((r) => (gate.release = r)));
    rf().enqueueHtmlTask('html', 'lan-1', true, async () => void order.push('lan-1'));
    rf().enqueueHtmlTask('html-capture', 'app-1', false, async () => void order.push('app-1'));
    rf().enqueueTool(99, async () => void order.push('tool'));
    expect(rf().queueInfo('html', 'lan-1')).toMatchObject({ state: 'waiting', position: 2 });
    expect(rf().queueInfo('html-capture', 'app-1')).toMatchObject({ state: 'waiting', position: 1 });
    expect(rf().summary()).toMatchObject({ running_count: 1, waiting_count: 3, concurrency: 1 });
    expect(rf().lanLoad()).toBe(3);
    gate.release!();
    await rf().idle();
    expect(order).toEqual(['app-1', 'lan-1', 'tool']);
  });
});

describe('hủy', () => {
  it('hủy bản đang chờ: bỏ khỏi hàng, không chạy; hủy bản đang chạy: slot chỉ nhả sau khi run settle', async () => {
    await setup(1);
    eng.hold = true;
    eng.lingerMs = 150;
    const p = await mkProject(2);
    const a = (await render(p.id, 1)).body;
    const b = (await render(p.id, 2)).body;
    await waitFor(() => eng.log.includes(`start:${a.id}`));
    expect(b.status).toBe('queued');
    // hủy bản đang chạy a: b chưa được bắt đầu cho tới khi a thoát
    const ca = await c.post(`${P}/${p.id}/renders/${a.id}/cancel`, {});
    expect(ca.body).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED' });
    await tick(50);
    expect(eng.log).not.toContain(`start:${b.id}`);
    await waitFor(() => eng.log.includes(`end:${a.id}`));
    await waitFor(() => eng.log.includes(`start:${b.id}`));
    expect(eng.log.indexOf(`end:${a.id}`)).toBeLessThan(eng.log.indexOf(`start:${b.id}`));
    expect(row(a.id).status).toBe('cancelled'); // run đã dừng không ghi đè trạng thái
    expect(fs.existsSync(path.join(L.env.root, 'output', p.slug, 'html', 'renders', String(a.id)))).toBe(false);
    // hủy bản đang chờ: thêm c vào hàng rồi hủy
    const p2 = await mkProject(1, { name: 'Thứ hai' });
    const cq = (await render(p2.id, 1)).body;
    expect((await c.post(`${P}/${p2.id}/renders/${cq.id}/cancel`, {})).body.status).toBe('cancelled');
    eng.release();
    await rf().idle();
    expect(eng.log).not.toContain(`start:${cq.id}`);
    expect((await c.post(`${P}/${p2.id}/renders/${cq.id}/cancel`, {})).status).toBe(409);
  });
});

describe('tạo bản dựng: idempotency, ràng buộc, lỗi', () => {
  it('idempotent theo khoá; khoá cũ khác chất lượng → 409; đang active cùng chất lượng → 409 HTML_RENDER_ACTIVE', async () => {
    await setup(1);
    eng.hold = true;
    const p = await mkProject(1);
    const k = key();
    const r1 = await render(p.id, 1, '720p', k);
    expect(r1.status).toBe(201);
    const r2 = await render(p.id, 1, '720p', k);
    expect([r2.status, r2.body.id]).toEqual([200, r1.body.id]);
    expect((await render(p.id, 1, '1080p', k)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const act = await render(p.id, 1, '720p');
    expect([act.status, act.body.error.code]).toEqual([409, 'HTML_RENDER_ACTIVE']);
    expect((db().prepare('SELECT COUNT(*) AS n FROM html_renders').get() as any).n).toBe(1);
    // chất lượng khác thì được
    expect((await render(p.id, 1, '1080p')).status).toBe(201);
    eng.release();
  });

  it('thiếu trình duyệt → 409 HTML_RENDERER_MISSING, không tạo dòng', async () => {
    await setup(1);
    eng.browser = false;
    const p = await mkProject(1);
    const r = await render(p.id, 1);
    expect([r.status, r.body.error.code]).toEqual([409, 'HTML_RENDERER_MISSING']);
    expect((db().prepare('SELECT COUNT(*) AS n FROM html_renders').get() as any).n).toBe(0);
  });

  it('phiên bản chưa ready → 409; phiên bản/dự án khác loại → 404; body sai → 400', async () => {
    await setup(1);
    const p = await mkProject(1);
    db().prepare("UPDATE html_versions SET status = 'composing', files_dir = NULL WHERE project_id = ?").run(p.id);
    const r = await render(p.id, 1);
    expect([r.status, r.body.error.code]).toEqual([409, 'VERSION_NOT_READY']);
    expect((await render(p.id, 7)).status).toBe(404);
    expect((await c.post(`${P}/${p.id}/versions/1/renders`, { quality: '4k', idempotency_key: key() })).status).toBe(400);
    expect((await c.get(`${P}/9999/renders`)).status).toBe(404);
  });

});

describe.skipIf(!haveMedia)('kiểm tra video và kết quả', () => {
  it('thành công: ready + video.mp4 + poster, view có url/duration/bytes; version view có renders', async () => {
    await setup(1);
    const p = await mkProject(1);
    const id = (await render(p.id, 1)).body.id;
    await rf().idle();
    const v = (await c.get(`${P}/${p.id}/renders/${id}`)).body;
    expect(v).toMatchObject({ status: 'ready', quality: '720p', version: 1, width: 720, height: 1280, queue: null, error: null, progress: 100 });
    expect(v.video_url).toBe(`${P}/${p.id}/renders/${id}/video`);
    expect(v.poster_url).toBe(`${P}/${p.id}/renders/${id}/poster`);
    expect(v.bytes).toBeGreaterThan(1000);
    expect(v.duration_s).toBeCloseTo(1, 0);
    const dir = path.join(L.env.root, 'output', p.slug, 'html', 'renders', String(id));
    expect(fs.readdirSync(dir).sort()).toEqual(['poster.jpg', 'video.mp4']);
    expect(eng.materialized[0]).toEqual({ mode: 'render' });
    const ver = (await c.get(`${P}/${p.id}/versions/1`)).body;
    expect(ver.renders).toHaveLength(1);
    expect(ver.renders[0]).toMatchObject({ id, status: 'ready' });
  });

  it('sai kích thước / sai thời lượng / audio không khớp → failed HTML_RENDER_VERIFY_FAILED, không còn video.mp4', async () => {
    await setup(1);
    const p = await mkProject(1);
    const cases: [string, RegExp][] = [
      [BAD_SIZE, /kích thước/],
      [BAD_DUR, /thời lượng/],
      [WITH_AUDIO, /âm thanh/], // HTML không có audio mà MP4 có
    ];
    for (const [src, re] of cases) {
      eng.source = src;
      const id = (await render(p.id, 1)).body.id;
      await rf().idle();
      const r = row(id);
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'failed', error_code: 'HTML_RENDER_VERIFY_FAILED', video_path: null });
      expect(r.error).toMatch(re);
      expect(fs.existsSync(path.join(L.env.root, 'output', p.slug, 'html', 'renders', String(id)))).toBe(false);
    }
  });

  it('composition có <audio> mà MP4 không có audio → verify failed; có audio → ready', async () => {
    await setup(1);
    const p = await mkProject(1, {}, '<!doctype html><html><body><audio src="assets/u/1.mp3" data-start="0"></audio></body></html>');
    let id = (await render(p.id, 1)).body.id;
    await rf().idle();
    expect(row(id).error_code).toBe('HTML_RENDER_VERIFY_FAILED');
    eng.source = WITH_AUDIO;
    id = (await render(p.id, 1)).body.id;
    await rf().idle();
    expect(row(id).status).toBe('ready');
  });

  it('engine lỗi → failed HTML_RENDER_FAILED (thông báo tiếng Việt); retry tạo dòng mới và thành công, không ghi đè dòng cũ', async () => {
    await setup(1);
    const p = await mkProject(1);
    const orig = eng.runRender.bind(eng);
    eng.runRender = async () => {
      throw new Error('browser crashed');
    };
    const id = (await render(p.id, 1)).body.id;
    await rf().idle();
    expect(row(id)).toMatchObject({ status: 'failed', error_code: 'HTML_RENDER_FAILED' });
    expect(row(id).error).toContain('Dựng video thất bại');
    eng.runRender = orig;
    const k = key();
    const rt = await c.post(`${P}/${p.id}/renders/${id}/retry`, { idempotency_key: k });
    expect(rt.status, rt.raw).toBe(201);
    expect(rt.body.id).not.toBe(id);
    expect((await c.post(`${P}/${p.id}/renders/${id}/retry`, { idempotency_key: k })).body.id).toBe(rt.body.id); // idempotent
    await rf().idle();
    expect(row(rt.body.id).status).toBe('ready');
    expect(row(id).status).toBe('failed');
    expect((await c.post(`${P}/${p.id}/renders/${rt.body.id}/retry`, { idempotency_key: key() })).status).toBe(409); // ready không retry
  });

  it('video/poster: Range 206, tải xuống đặt tên, 404 khi chưa ready, reveal gọi hàm mở thư mục với đường dẫn do server dựng', async () => {
    await setup(1);
    const p = await mkProject(1);
    const id = (await render(p.id, 1)).body.id;
    await rf().idle();
    const u = `${P}/${p.id}/renders/${id}`;
    const full = await c.get(`${u}/video`);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toContain('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-disposition']).toBeUndefined();
    const part = await c.get(`${u}/video`, { range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(part.headers['content-length']).toBe('100');
    const dl = await c.get(`${u}/video?download=1`);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="video-thu-v1-720p.mp4"');
    const poster = await c.get(`${u}/poster`);
    expect([poster.status, poster.headers['content-type']]).toEqual([200, 'image/jpeg']);
    const seen: string[] = [];
    setHtmlRevealer((abs) => void seen.push(abs));
    expect((await c.post(`${u}/reveal`, {})).body).toEqual({ ok: true });
    expect(seen).toEqual([path.join(L.env.root, 'output', p.slug, 'html', 'renders', String(id), 'video.mp4')]);
    // bản dựng của dự án khác → 404
    const p2 = await mkProject(1, { name: 'Dự án khác' });
    expect((await c.get(`${P}/${p2.id}/renders/${id}/video`)).status).toBe(404);
    // chưa ready → 404
    db().prepare("UPDATE html_renders SET status = 'failed' WHERE id = ?").run(id);
    expect((await c.get(`${u}/video`)).status).toBe(404);
    expect((await c.post(`${u}/reveal`, {})).status).toBe(404);
  });
});

describe('khởi động lại và xoá dự án', () => {
  it('recoverHtmlRenders: queued/rendering → failed "Bị gián đoạn", dọn thư mục dở; ready không đụng', async () => {
    await setup(1);
    const p = await mkProject(3);
    const ins = db().prepare("INSERT INTO html_renders (version_id, idempotency_key, quality, status, created_at) VALUES (?, ?, ?, ?, ?)");
    const mk = (v: number, q: string, st: string) => Number(ins.run(v, key(), q, st, new Date().toISOString()).lastInsertRowid);
    const vid = (n: number) => (db().prepare('SELECT id FROM html_versions WHERE project_id = ? AND version = ?').get(p.id, n) as any).id;
    const a = mk(vid(1), '720p', 'rendering');
    const b = mk(vid(2), '720p', 'queued');
    const r = mk(vid(3), '720p', 'ready');
    const dir = path.join(L.env.root, 'output', p.slug, 'html', 'renders', String(a));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.video.tmp.mp4'), 'x');
    expect(recoverHtmlRenders(L.env.ctx)).toBe(2);
    for (const id of [a, b]) expect(row(id)).toMatchObject({ status: 'failed', error: 'Bị gián đoạn do ứng dụng tắt', error_code: 'HTML_RENDER_FAILED' });
    expect(row(r).status).toBe('ready');
    expect(fs.existsSync(dir)).toBe(false);
    // render lỗi do gián đoạn thử lại được
    expect((await c.post(`${P}/${p.id}/renders/${a}/retry`, { idempotency_key: key() })).status).toBe(201);
  });

  it('xoá dự án bị chặn khi đang dựng; sau khi hủy, xoá chờ tiến trình dừng hẳn rồi thành công', async () => {
    await setup(1);
    eng.hold = true;
    eng.lingerMs = 200;
    const p = await mkProject(1);
    const id = (await render(p.id, 1)).body.id;
    await waitFor(() => eng.running === 1);
    const blocked = await c.del(`${P}/${p.id}`);
    expect([blocked.status, blocked.body.error.code]).toEqual([409, 'PROJECT_BUSY']);
    await c.post(`${P}/${p.id}/renders/${id}/cancel`, {});
    const t0 = Date.now();
    const del = await c.del(`${P}/${p.id}`);
    expect(del.status, del.raw).toBe(200);
    expect(eng.log).toContain(`end:${id}`); // xoá chỉ xảy ra khi run đã settle
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});

describe('captureForVision', () => {
  it('đi qua scheduler (chờ slot khi render đang chạy), materialize mode capture, trả PNG theo times; abort khi đang chờ → reject', async () => {
    await setup(1);
    eng.hold = true;
    const p = await mkProject(1);
    const stage = path.join(L.env.root, 'output', p.slug, 'html', 'staging', '1-1');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'index.html'), '<html></html>');
    const id = (await render(p.id, 1)).body.id;
    await waitFor(() => eng.running === 1);
    const ac = new AbortController();
    const cap = captureForVision(L.env.ctx, { projectId: p.id, aspect: '9:16', durationS: 1, stagingDir: stage, times: [0.2, 0.5], signal: ac.signal });
    await tick(60);
    expect(eng.captured).toHaveLength(0); // chưa có slot
    expect(rf().summary().waiting_count).toBe(1);
    eng.release(id);
    const frames = await cap;
    expect(frames).toHaveLength(2);
    expect(eng.captured).toEqual([[0.2, 0.5]]);
    expect(eng.materialized.map((m) => m.mode)).toEqual(['render', 'capture']);
    // abort khi đang chờ
    eng.reset();
    eng.hold = true;
    const p2 = await mkProject(1, { name: 'Dự án hai' });
    await render(p2.id, 1);
    await waitFor(() => eng.running === 1);
    const ac2 = new AbortController();
    const cap2 = captureForVision(L.env.ctx, { projectId: p.id, aspect: '9:16', durationS: 1, stagingDir: stage, times: [0.3], signal: ac2.signal });
    await tick(30);
    ac2.abort();
    await expect(cap2).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(rf().summary().waiting_count).toBe(0);
    eng.release();
  });
});
