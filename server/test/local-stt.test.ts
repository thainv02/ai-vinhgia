import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { segmentWords, toVerbose } from '../src/services/clips/local-stt-words.js';
import { downloadSttModel, STT_MODEL, sttModelDir, sttModelStatus } from '../src/services/clips/stt-model.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';

describe('ghép token gipformer thành từ', () => {
  it('token có dấu cách đầu mở từ mới; mảnh sau dính vào từ trước; chữ thường, viết hoa đầu câu; mốc cộng offset đoạn; p = exp(trung bình log p)', () => {
    const seg = { offset: 10, duration: 3, tokens: [' LẠI', ' ĐƯỢC', ' PH', 'Ẩ', 'Y'], timestamps: [0, 0.4, 1, 1.1, 1.3], logProbs: [0, Math.log(0.5), 0, 0, 0] };
    expect(segmentWords(seg)).toEqual([
      { w: 'lại', start: 10, end: 10.4, p: 1 },
      { w: 'được', start: 10.4, end: 11, p: 0.5 },
      { w: 'phẩy', start: 11, end: 12.2, p: 1 }, // từ cuối đoạn: tới cuối đoạn nhưng kẹp tối đa 1,2 giây
    ]);
    const v = toVerbose([seg, { offset: 12.5, duration: 1, tokens: [' TIẾP'], timestamps: [0.1] }, { offset: 20, duration: 1, tokens: [' MỚI'], timestamps: [0] }], { duration: 30, model: 'm', elapsedMs: 5 });
    // 12,6 cách cuối từ trước (12,2) < 0,8 giây → cùng câu (chữ thường); 20 cách xa → câu mới (viết hoa)
    expect(v.words.map((w) => w.word)).toEqual(['Lại', 'được', 'phẩy', 'tiếp', 'Mới']);
    expect(v.segments).toEqual([
      { id: 0, start: 10, end: 12.2, text: 'Lại được phẩy' },
      { id: 1, start: 12.6, end: 13.5, text: 'tiếp' },
      { id: 2, start: 20, end: 21, text: 'Mới' },
    ]);
    expect(v).toMatchObject({ language: 'vi', duration: 30, model: 'm', elapsed_ms: 5, text: 'Lại được phẩy tiếp Mới' });
  });

  it('đoạn không có chữ bị bỏ; từ luôn có thời lượng dương', () => {
    const v = toVerbose([{ offset: 0, duration: 1, tokens: [], timestamps: [] }, { offset: 5, duration: 0.01, tokens: [' A', ' B'], timestamps: [0, 0] }], { duration: 6, model: 'm', elapsedMs: 0 });
    expect(v.segments).toHaveLength(1);
    for (const w of v.words) expect(w.end).toBeGreaterThan(w.start);
  });
});

describe('cấu hình nhận dạng lời nói', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });
  it('mặc định nhận dạng trên máy; STT_URL hoặc STT_PROVIDER ghi đè; STT_MODELS_DIR / STT_THREADS', () => {
    expect(loadConfig({} as never).sttProvider).toBe('local');
    expect(loadConfig({ STT_URL: 'http://stt/v1/audio/transcriptions' } as never).sttProvider).toBe('omnix');
    expect(loadConfig({ STT_PROVIDER: 'none' } as never).sttProvider).toBe('none');
    const c = loadConfig({ STT_MODELS_DIR: path.join(os.tmpdir(), 'm'), STT_THREADS: '2' } as never);
    expect([c.sttModelsDir, c.sttThreads]).toEqual([path.join(os.tmpdir(), 'm'), 2]);
    expect(loadConfig({ STT_PROVIDER: 'local' } as never).sttProvider).toBe('local');
    expect(loadConfig({} as never).sttThreads).toBeGreaterThanOrEqual(1);
  });
});

describe('model nhận dạng trên máy', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-stt-model-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('chưa cài khi thiếu file, sai kích thước hoặc chưa có model.json (chưa kiểm hash)', () => {
    expect(sttModelStatus(dir)).toMatchObject({ installed: false, missing: STT_MODEL.files.map((f) => f.name) });
    const md = sttModelDir(dir);
    fs.mkdirSync(md, { recursive: true });
    for (const f of STT_MODEL.files) fs.writeFileSync(path.join(md, f.name), Buffer.alloc(f.name === 'tokens.txt' ? 1 : 0));
    expect(sttModelStatus(dir).installed).toBe(false);
  });

  it('tải về sai nội dung → lỗi rõ ràng, không để lại .part, không ghi model.json; HTTP lỗi cũng vậy', async () => {
    const wrong = (async () => new Response('khong phai model')) as unknown as typeof fetch;
    await expect(downloadSttModel(dir, { fetchImpl: wrong })).rejects.toThrow(/không đúng/);
    const left = fs.readdirSync(sttModelDir(dir));
    expect(left.filter((f) => f.endsWith('.part') || f === 'model.json')).toEqual([]);
    const notFound = (async () => new Response('x', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadSttModel(dir, { fetchImpl: notFound })).rejects.toThrow(/HTTP 404/);
    expect(sttModelStatus(dir).installed).toBe(false);
  });
});

describe('bản desktop khi chưa có model', () => {
  let L: LanEnv;
  let models: string;
  beforeEach(async () => {
    models = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-stt-none-'));
    L = await makeLanEnv({ config: { sttProvider: 'local', sttModelsDir: models } });
  });
  afterEach(async () => {
    await L.close();
    fs.rmSync(models, { recursive: true, force: true });
  });

  it('clip-status báo chưa sẵn sàng kèm lý do; Cài đặt cho biết model chưa cài, dung lượng, số luồng', async () => {
    const c = L.client({ host: '127.0.0.1:8790', origin: 'http://127.0.0.1:8790', ip: '127.0.0.1' });
    const st = (await c.get('/lan/api/clip-status')).body;
    expect(st.stt).toMatchObject({ configured: true, ready: false });
    expect(st.stt.reason).toMatch(/Chưa có model nhận dạng lời nói.*Cài đặt/);
    const s = (await c.get('/lan/api/settings/stt')).body;
    expect(s).toMatchObject({ provider: 'local', installed: false, download: null, model: { id: STT_MODEL.id } });
    expect(s.model.total_bytes).toBeGreaterThan(70_000_000);
    expect(s.threads).toBeGreaterThanOrEqual(1);
  });
});
