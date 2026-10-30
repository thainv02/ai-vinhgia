import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SttCancelled, SttError, extractResult, fetchJobResult, sttJobUrl, toVerbose, transcribeAudio, type SttCallOptions } from '../src/services/clips/stt-client.js';
import { startFakeStt, type FakeStt } from './helpers-clips.js';

let fake: FakeStt;
let dir: string;
let audio: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-client-'));
  audio = path.join(dir, 'a.mp3');
  fs.writeFileSync(audio, Buffer.from('ID3-fake-audio'));
  fake = await startFakeStt();
});
afterEach(() => {
  fake.steps.length = 0;
  fake.fallback = 'ok';
  fake.calls.length = 0;
  fake.polls.length = 0;
  fake.jobHasWords = true;
  fake.pollRunning = 0;
});
afterAll(async () => {
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleeps: number[] = [];
const opts = (over: Partial<SttCallOptions> = {}): SttCallOptions => ({
  url: fake.url,
  tenantId: 's-omnix-studio',
  signal: new AbortController().signal,
  timeoutMs: 20_000,
  maxRetries: 3,
  retryDelaysMs: [10_000, 30_000, 90_000],
  pollMs: 1,
  sleep: async (ms) => void sleeps.push(ms),
  ...over,
});

describe('stt-client: gọi dịch vụ nhận dạng lời nói', () => {
  it('thành công: gửi X-Tenant-ID, prompt CHỈ khi có tên riêng; lưu X-Job-Id ngay khi có header', async () => {
    const ids: string[] = [];
    const out = await transcribeAudio(audio, 'Cacao, Actiso', opts({ onJobId: (id) => ids.push(id) }));
    expect(out.result.words.length).toBe(fake.words.length);
    expect(out.result.model).toBe('gipformer1.5-68M-rnnt');
    expect(ids).toEqual([out.jobId]);
    expect(fake.calls[0]).toMatchObject({ prompt: 'Cacao, Actiso', tenant: 's-omnix-studio' });
    await transcribeAudio(audio, null, opts());
    expect(fake.calls[1]!.prompt).toBeNull();
    await transcribeAudio(audio, '   ', opts());
    expect(fake.calls[2]!.prompt).toBeNull();
  });

  it('lỗi retryable (503 no_capacity) → thử lại với backoff 10 s / 30 s / 90 s rồi thành công', async () => {
    sleeps.length = 0;
    fake.steps.push('busy', 'busy', 'busy');
    const retries: number[] = [];
    const out = await transcribeAudio(audio, null, opts({ onRetry: (r) => retries.push(r.delayMs) }));
    expect(out.result.words.length).toBeGreaterThan(0);
    expect(sleeps).toEqual([10_000, 30_000, 90_000]);
    expect(retries).toEqual([10_000, 30_000, 90_000]);
    expect(fake.calls.length).toBe(4);
  });

  it('hết số lần thử → lỗi tiếng Việt, không retryable', async () => {
    sleeps.length = 0;
    fake.fallback = 'busy';
    const err = (await transcribeAudio(audio, null, opts({ maxRetries: 2 })).catch((e) => e)) as SttError;
    expect(err).toBeInstanceOf(SttError);
    expect(err.code).toBe('STT_UNAVAILABLE');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/Dịch vụ nhận dạng lời nói/);
    expect(fake.calls.length).toBe(3);
  });

  it('lỗi không retryable (400) → thất bại ngay với STT_REJECTED, không thử lại', async () => {
    fake.steps.push('bad');
    const err = (await transcribeAudio(audio, null, opts()).catch((e) => e)) as SttError;
    expect(err.code).toBe('STT_REJECTED');
    expect(err.message).toContain('unsupported audio');
    expect(fake.calls.length).toBe(1);
  });

  it('504 transcription_timeout kèm details.job_id → poll GET /v1/stt/jobs/{id} (header X-Tenant-ID) tới khi xong', async () => {
    fake.steps.push('timeout504');
    fake.pollRunning = 2;
    const out = await transcribeAudio(audio, null, opts());
    expect(out.result.words.length).toBe(fake.words.length);
    expect(fake.calls.length).toBe(1); // KHÔNG gửi lại file
    expect(fake.polls.length).toBe(3);
    expect(fake.polls.every((p) => p.tenant === 's-omnix-studio')).toBe(true);
    expect(out.jobId).toBe(fake.polls[0]!.id);
  });

  it('đứt kết nối TRƯỚC khi có header → thử lại gửi file', async () => {
    fake.steps.push('drop');
    const out = await transcribeAudio(audio, null, opts());
    expect(out.result.words.length).toBeGreaterThan(0);
    expect(fake.calls.length).toBe(2);
  });

  it('đứt kết nối SAU khi có X-Job-Id → hỏi kết quả theo job id, không gửi lại file', async () => {
    fake.steps.push('dropAfterHeaders');
    const out = await transcribeAudio(audio, null, opts());
    expect(out.result.words.length).toBe(fake.words.length);
    expect(fake.calls.length).toBe(1);
    expect(fake.polls.length).toBeGreaterThanOrEqual(1);
  });

  it('poll trả kết quả KHÔNG có words (đúng như dịch vụ thật) → STT_JOB_NO_WORDS (lỗi tạm) → gửi lại file để có mốc từng từ', async () => {
    fake.steps.push('timeout504');
    fake.jobHasWords = false;
    const out = await transcribeAudio(audio, null, opts());
    expect(out.result.words.length).toBe(fake.words.length);
    expect(fake.calls.length).toBe(2);
  });

  it('audio không có lời: text rỗng, không lỗi', async () => {
    fake.steps.push('empty');
    const out = await transcribeAudio(audio, null, opts());
    expect(out.result.text).toBe('');
    expect(out.result.words).toEqual([]);
  });

  it('hủy (abort) → SttCancelled, kể cả khi đang chờ backoff', async () => {
    const ctl = new AbortController();
    fake.fallback = 'busy';
    const p = transcribeAudio(audio, null, opts({ signal: ctl.signal, sleep: async () => ctl.abort() }));
    await expect(p).rejects.toBeInstanceOf(SttCancelled);
  });

  it('fetchJobResult: lấy lại theo job id đã có (khôi phục sau khi khởi động lại); job lạ → STT_JOB_LOST', async () => {
    const first = await transcribeAudio(audio, null, opts());
    const again = await fetchJobResult(first.jobId!, opts());
    expect(again.result.words.length).toBe(fake.words.length);
    const err = (await fetchJobResult('khong-co', opts()).catch((e) => e)) as SttError;
    expect(err.code).toBe('STT_JOB_LOST');
  });
});

describe('stt-client: đọc phản hồi lỏng', () => {
  const verbose = { text: 'a b', duration: 1, segments: [{ id: 0, start: 0, end: 1, text: 'a b' }], words: [{ word: 'a', start: 0, end: 0.5 }] };
  it('extractResult nhận bản trần và bản bọc; không nhận phản hồi trạng thái', () => {
    expect(extractResult(verbose)).toBeTruthy();
    expect(extractResult({ status: 'done', result: verbose })).toBeTruthy();
    expect(extractResult({ state: 'ok', data: { response: verbose } })).toBeTruthy();
    expect(extractResult({ state: 'running', job_id: 'x' })).toBeNull();
    expect(extractResult(null)).toBeNull();
    expect(extractResult('x')).toBeNull();
  });
  it('toVerbose bỏ phần tử hỏng, ép số, nhận duration_seconds', () => {
    const v = toVerbose({ text: 'x', duration_seconds: 3.5, words: [{ word: ' a ', start: '1', end: 2 }, { word: '', start: 0, end: 1 }, 5, { word: 'b', start: 1, end: 2, probability: 0.5 }], segments: [{ id: 0, start: 0, end: 1, text: ' t ' }, null] });
    expect(v.duration).toBe(3.5);
    expect(v.words.map((w) => w.word)).toEqual(['a', 'b']);
    expect(v.words[0]!.start).toBe(0); // chuỗi không phải số → 0
    expect(v.segments).toEqual([{ id: 0, start: 0, end: 1, text: 't' }]);
  });
  it('URL job suy ra từ URL transcriptions', () => {
    expect(sttJobUrl('http://10.0.3.214:18085/v1/audio/transcriptions', 'a b')).toBe('http://10.0.3.214:18085/v1/stt/jobs/a%20b');
  });
});
