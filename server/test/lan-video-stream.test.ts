import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE } from './final-helpers.js';
import { makeLanEnv, type LanClient, type LanEnv } from './helpers-lan.js';
import { makeLanPlan, type LanPlanFixture } from './helpers-lan-plan.js';
import { clip } from './helpers-video.js';

/**
 * Bằng chứng "stream xuống đĩa, không đọc cả file vào RAM": listener LAN THẬT trên cổng tạm (127.0.0.1), client gửi thân multipart từng đoạn.
 * Nếu server gom cả file vào bộ nhớ (toBuffer) thì file tạm không thể lớn dần trên đĩa trước khi client gửi xong.
 */
const run = FFMPEG && FFPROBE ? describe : describe.skip;

let L: LanEnv;
let c: LanClient;
let fx: LanPlanFixture;
let port: number;
const host = () => `127.0.0.1:${port}`;

beforeEach(async () => {
  L = await makeLanEnv();
  c = L.client();
  await c.login();
  fx = await makeLanPlan(L, c, 1);
  await L.lan.listen({ port: 0, host: '127.0.0.1' });
  port = (L.lan.server.address() as AddressInfo).port;
});
afterEach(async () => {
  await L.close();
});

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('hết thời gian chờ điều kiện');
    await new Promise((r) => setTimeout(r, 15));
  }
};

interface Sent {
  /** Số byte file đã ghi vào socket tại mỗi lần dừng. */
  status: number;
  body: any;
}

/** POST multipart tới listener thật: gửi `file` thành `chunks` đoạn, gọi `between(i)` sau mỗi đoạn (client giữ nguyên kết nối). */
function postParts(urlPath: string, file: Buffer, chunks: number, between: (i: number) => Promise<void>, o: { name?: string; lie?: boolean } = {}): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const boundary = '----stream' + Math.random().toString(16).slice(2);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${o.name ?? 'live.mp4'}"\r\nContent-Type: video/mp4\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const headers: Record<string, string> = { host: host(), origin: `http://${host()}`, cookie: c.cookie!, 'content-type': `multipart/form-data; boundary=${boundary}` };
    if (!o.lie) headers['content-length'] = String(head.length + file.length + tail.length);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let body: any = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* giữ nguyên */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    void (async () => {
      req.write(head);
      const size = Math.ceil(file.length / chunks);
      for (let i = 0; i < chunks; i++) {
        req.write(file.subarray(i * size, Math.min(file.length, (i + 1) * size)));
        await between(i);
      }
      req.end(tail);
    })().catch(reject);
  });
}

const tmpFiles = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('.lan-upload-')).map((f) => path.join(dir, f)) : []);

run('upload video qua socket thật', () => {
  it('video cảnh: file tạm LỚN DẦN trên đĩa trước khi client gửi xong (ghi theo luồng), rồi hoàn tất như upload thường', async () => {
    const file = clip(30, { size: '640x360' }); // vài trăm KB: đủ chia nhiều đoạn
    expect(file.length).toBeGreaterThan(200_000);
    const dir = path.join(L.env.root, 'output', fx.slug, 'video');
    const sizes: number[] = [];
    const res = await postParts(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, file, 4, async (i) => {
      if (i === 3) return; // đoạn cuối: không chờ (server chỉ xong khi nhận hết)
      // sau mỗi đoạn (chưa phải cuối) file tạm phải đã có ≥ (phần đã gửi − đệm) byte trên đĩa
      const sentSoFar = Math.ceil(file.length / 4) * (i + 1);
      await waitFor(() => tmpFiles(dir).some((f) => fs.statSync(f).size >= sentSoFar * 0.5));
      sizes.push(Math.max(...tmpFiles(dir).map((f) => fs.statSync(f).size)));
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(sizes).toHaveLength(3);
    expect(sizes[0]).toBeGreaterThan(0);
    expect(sizes[2]!).toBeGreaterThan(sizes[0]!); // đang lớn dần giữa chừng
    expect(sizes[2]!).toBeLessThan(file.length); // và chưa đủ file lúc chưa nhận hết
    expect(tmpFiles(dir)).toEqual([]);
    expect(fs.readFileSync(path.join(L.env.root, res.body.video.url.replace('/lan/files/', ''))).equals(file)).toBe(true);
  });

  it('client nói dối Content-Length / gửi vượt giới hạn: server cắt ngay khi đếm byte (413), không nhận hết, không để lại file tạm', async () => {
    L.env.ctx.config.lanVideoMaxBytes = 256 * 1024;
    const dir = path.join(L.env.root, 'output', fx.slug, 'video');
    const file = Buffer.concat([clip(3).subarray(0, 4096), Buffer.alloc(3 * 1024 * 1024, 9)]); // 3 MB ≫ 256 KB
    const lied = await postParts(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, file, 12, async () => undefined, { lie: true });
    expect([lied.status, lied.body.error?.code]).toEqual([413, 'FILE_TOO_LARGE']);
    const honest = await postParts(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, file, 12, async () => undefined);
    expect([honest.status, honest.body.error?.code]).toEqual([413, 'FILE_TOO_LARGE']);
    await waitFor(() => tmpFiles(dir).length === 0);
    expect((L.env.ctx.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE kind = 'video'").get() as { n: number }).n).toBe(0);
    // sau lỗi, upload hợp lệ nhỏ vẫn chạy bình thường (listener không bị kẹt)
    L.env.ctx.config.lanVideoMaxBytes = 200 * 1024 * 1024;
    const ok = await postParts(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, clip(2), 2, async () => undefined);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('video chỉ nhận ftyp: chunk đầu sai → 415 ngay (không ghi hết file vào đĩa)', async () => {
    const dir = path.join(L.env.root, 'output', fx.slug, 'video');
    const junk = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const r = await postParts(`/lan/api/plans/${fx.plan.id}/scenes/${fx.scenes[0]!.id}/video`, junk, 8, async () => undefined);
    expect([r.status, r.body.error?.code]).toEqual([415, 'UNSUPPORTED_FILE_TYPE']);
    await waitFor(() => tmpFiles(dir).length === 0);
  });
});
