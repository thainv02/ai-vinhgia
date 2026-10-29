import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { binaryCandidates, ffmpegOf, probeMedia, warmMediaBinaries, __testOverrides } from '../src/services/media.js';

/**
 * ffprobe giả chạy bằng node.exe (Windows không spawn trực tiếp .mjs):
 *  - ghi `<PROBE_DIR>/<tên file>.pid` khi bắt đầu, `.start`/`.end` có mốc thời gian để đo số tiến trình chạy chồng nhau
 *  - file có "hang" trong tên: treo mãi; còn lại: đợi PROBE_DELAY_MS rồi in JSON một luồng video.
 */
const FAKE = `
import fs from 'node:fs';
import path from 'node:path';
const abs = process.argv[process.argv.length - 1];
const base = path.join(process.env.PROBE_DIR, path.basename(abs));
fs.writeFileSync(base + '.pid', String(process.pid));
fs.appendFileSync(path.join(process.env.PROBE_DIR, 'events.log'), 'start ' + Date.now() + '\\n');
if (path.basename(abs).includes('hang')) { setInterval(() => {}, 1000); }
else setTimeout(() => {
  fs.appendFileSync(path.join(process.env.PROBE_DIR, 'events.log'), 'end ' + Date.now() + '\\n');
  process.stdout.write(JSON.stringify({ format: { duration: '2.5' }, streams: [{ codec_type: 'video', width: 640, height: 360, r_frame_rate: '30000/1001' }] }));
}, Number(process.env.PROBE_DELAY_MS ?? 0));
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor hết giờ');
    await sleep(20);
  }
}

describe('media: probeMedia bất đồng bộ', () => {
  let dir: string;
  const cfg = { ffprobePath: null };
  const media = (name: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, name);
    return p;
  };
  const pidOf = (name: string): number => Number(fs.readFileSync(path.join(dir, `${name}.pid`), 'utf8'));
  const pidReady = (name: string) => fs.existsSync(path.join(dir, `${name}.pid`)) && fs.readFileSync(path.join(dir, `${name}.pid`), 'utf8') !== '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-media-'));
    fs.writeFileSync(path.join(dir, 'fake-ffprobe.mjs'), FAKE);
    process.env.PROBE_DIR = dir;
  });
  afterAll(() => {
    delete process.env.PROBE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    __testOverrides.probe = { bin: process.execPath, prefixArgs: [path.join(dir, 'fake-ffprobe.mjs')] };
    __testOverrides.timeoutMs = undefined;
    process.env.PROBE_DELAY_MS = '0';
    fs.rmSync(path.join(dir, 'events.log'), { force: true });
  });
  afterEach(() => {
    __testOverrides.probe = null;
    __testOverrides.timeoutMs = undefined;
  });

  it('đọc đúng thông tin từ đầu ra ffprobe', async () => {
    const info = await probeMedia(cfg, media('ok1.mp4'));
    expect(info).toMatchObject({ duration_s: 2.5, width: 640, height: 360, fps_num: 30000, fps_den: 1001, has_audio: false });
  });

  it('ffprobe treo không chặn event loop: timer + HTTP vẫn phản hồi < 200ms', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ac = new AbortController();
    const hung = probeMedia(cfg, media('hang-loop.mp4'), { signal: ac.signal });
    hung.catch(() => undefined);
    try {
      await waitFor(() => pidReady('hang-loop.mp4'));
      const t0 = Date.now();
      await sleep(10);
      const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
      expect(body).toBe('ok');
      expect(Date.now() - t0).toBeLessThan(200);
    } finally {
      ac.abort();
      await hung.catch(() => undefined);
      await new Promise((r) => server.close(r));
    }
  });

  it('không bao giờ quá 2 ffprobe chạy cùng lúc', async () => {
    process.env.PROBE_DELAY_MS = '150';
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => probeMedia(cfg, media(`conc${i}.mp4`))));
    expect(results.every((r) => r?.width === 640)).toBe(true);
    let cur = 0;
    let max = 0;
    for (const line of fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n')) {
      cur += line.startsWith('start') ? 1 : -1;
      max = Math.max(max, cur);
    }
    expect(max).toBeGreaterThan(1); // có chạy song song thật
    expect(max).toBeLessThanOrEqual(2);
  });

  it('hết giờ: kill tiến trình và trả null', async () => {
    __testOverrides.timeoutMs = 300;
    const r = await probeMedia(cfg, media('hang-timeout.mp4'));
    expect(r).toBeNull();
    const pid = pidOf('hang-timeout.mp4');
    await waitFor(() => !alive(pid), 3000);
  });

  it('huỷ khi đang chạy: AbortError và tiến trình con bị kill', async () => {
    const ac = new AbortController();
    const p = probeMedia(cfg, media('hang-run.mp4'), { signal: ac.signal });
    const settled = p.then(
      () => 'resolved',
      (e: Error) => e.name,
    );
    await waitFor(() => pidReady('hang-run.mp4'));
    ac.abort();
    expect(await settled).toBe('AbortError');
    expect(alive(pidOf('hang-run.mp4'))).toBe(false);
  });

  it('huỷ khi đang xếp hàng: AbortError, không sinh tiến trình, không chiếm suất', async () => {
    const acs = [new AbortController(), new AbortController()];
    const busy = acs.map((ac, i) => probeMedia(cfg, media(`hang-busy${i}.mp4`), { signal: ac.signal }));
    busy.forEach((b) => b.catch(() => undefined));
    await waitFor(() => pidReady('hang-busy0.mp4') && pidReady('hang-busy1.mp4'));
    const q = new AbortController();
    const queued = probeMedia(cfg, media('queued.mp4'), { signal: q.signal });
    const settled = queued.then(
      () => 'resolved',
      (e: Error) => e.name,
    );
    await sleep(100);
    expect(fs.existsSync(path.join(dir, 'queued.mp4.pid'))).toBe(false);
    q.abort();
    expect(await settled).toBe('AbortError');
    // giải phóng 2 suất: probe tiếp theo phải chạy được (hàng đợi không kẹt vì mục đã huỷ)
    acs.forEach((a) => a.abort());
    await Promise.all(busy.map((b) => b.catch(() => undefined)));
    expect((await probeMedia(cfg, media('after.mp4')))?.width).toBe(640);
    expect(fs.existsSync(path.join(dir, 'queued.mp4.pid'))).toBe(false);
    for (const n of ['hang-busy0.mp4', 'hang-busy1.mp4']) expect(alive(pidOf(n))).toBe(false);
  });

  it('signal đã huỷ sẵn: AbortError ngay, không chạy ffprobe', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(probeMedia(cfg, media('pre.mp4'), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(path.join(dir, 'pre.mp4.pid'))).toBe(false);
  });

  it('file không tồn tại / binary không có → null', async () => {
    expect(await probeMedia(cfg, path.join(dir, 'nope.mp4'))).toBeNull();
    __testOverrides.probe = { bin: path.join(dir, 'khong-co-binary.exe'), prefixArgs: [] };
    expect(await probeMedia(cfg, media('nobin.mp4'))).toBeNull();
  });
});

describe('media: tìm binary', () => {
  it('không còn thư mục Shotcut trong danh sách ứng viên', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(binaryCandidates('ffmpeg', null, platform).join('|').toLowerCase()).not.toContain('shotcut');
    }
    const win = binaryCandidates('ffprobe', 'X:\\cfg\\ffprobe.exe', 'win32');
    expect(win[0]).toBe('X:\\cfg\\ffprobe.exe');
    expect(win[1]).toMatch(/bin[\\/]ffprobe\.exe$/);
    expect(win[2]).toBe('ffprobe');
    const mac = binaryCandidates('ffmpeg', null, 'darwin');
    expect(mac).toEqual(['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
  });

  it('ffmpegOf cache kể cả kết quả âm và dùng chung một lần dò', async () => {
    const cfg = { ffmpegPath: path.join(os.tmpdir(), 'autovideo-khong-co-ffmpeg-xyz'), ffprobePath: null };
    const a = ffmpegOf(cfg);
    const b = ffmpegOf(cfg);
    expect(a).toBe(b); // cùng một promise đang chạy
    await warmMediaBinaries(cfg);
    expect(ffmpegOf(cfg)).toBe(a);
  });
});
