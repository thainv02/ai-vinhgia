import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locateQuote, resolveBoundaries } from '../src/lib/clip-boundaries.js';
import { displayWords } from '../src/services/clips/captions.js';
import { parseSilenceLines, thresholdFromLevels, detectPauses } from '../src/services/clips/pauses.js';
import { buildTranscript, normalizePauses, snapBounds } from '../src/services/clips/transcript.js';
import { validateClipPlan } from '../src/services/clips/plan.js';
import { applyFix, inferParsed, runClipPlan, type ClipPlanDeps } from '../../worker/src/clip-plan.js';
import { makeEnv } from './helpers.js';
import { run } from '../src/services/final-render/ffmpeg-renderer.js';
import path from 'node:path';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/clips-e2e/${name}.json`, import.meta.url), 'utf8'));
const raw = fixture('stt-verbose');
const pauses = fixture('pauses');
const real = () => buildTranscript(raw, { pauses });
const sentenceData = (t = real()) => t.sentences.map((s) => ({ ...s, words: t.words.slice(s.start_word, s.end_word + 1) }));
const offer = (t = real()) => {
  const start = t.words.findIndex((w) => w.w === 'riêng');
  const end = t.words.findIndex((w, i) => i > start && w.w === 'ạ');
  const start_id = t.sentences.find((s) => s.start_word <= start && s.end_word >= start)!.id;
  const end_id = t.sentences.find((s) => s.start_word <= end && s.end_word >= end)!.id;
  return { start_id, end_id, start_word: start, end_word: end, start_quote: t.words.slice(start, start + 6).map((w) => w.w).join(' '), end_quote: t.words.slice(end - 5, end + 1).map((w) => w.w).join(' ') };
};
const deps = (infer: ClipPlanDeps['infer']): ClipPlanDeps => ({ infer, alive: async () => {}, checkpoint: async () => {}, grid: async () => null, sleep: async () => {} });

describe('regression: transcript 102 giây mà STT trả mốc từ liền nhau', () => {
  it('chia câu mịn bằng khoảng lặng thật, phủ đủ từ đúng thứ tự, không theo segment STT 20s', () => {
    const t = real();
    expect(t.sentences).toHaveLength(21);
    expect(t.sentences.flatMap((s) => t.words.slice(s.start_word, s.end_word + 1))).toEqual(t.words);
    for (const s of t.sentences) {
      expect(s.end - s.start).toBeLessThanOrEqual(12);
      expect(s.end_word - s.start_word + 1).toBeLessThanOrEqual(30);
    }
    expect(t.sentences[0]!.text).toContain('chào mừng');
    expect(t.sentences[1]!.text).toMatch(/^hôm nay/);
    expect(t.words.some((w, i) => w.end < raw.words[i].end)).toBe(true);
    expect(buildTranscript(raw, { pauses: [] }).sentences.every((s) => s.end - s.start <= 12)).toBe(true);
  });
  it.each([false, true])('dò câu trích giữa câu; hỗ trợ transcript cũ và mới (pauses=%s)', (withPauses) => {
    const t = withPauses ? real() : buildTranscript(raw); const q = offer(t); const data = sentenceData(t);
    const r = resolveBoundaries(data, { ...q, start_quote: q.start_quote.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase() });
    expect(r).toMatchObject({ start_word: q.start_word, end_word: q.end_word, boundary: 'word_quote' });
    const out = validateClipPlan(t, [q], { preset: { min_s: 15, max_s: 30 } });
    expect(out.rejected).toEqual([]);
    expect(out.accepted[0]).toMatchObject({ start_word: q.start_word, end_word: q.end_word, verify: { boundary: 'word_quote' } });
    expect(out.accepted[0]).toMatchObject(snapBounds(t, q.start_word, q.end_word));
    expect(q.start_word).toBeGreaterThan(t.sentences[q.start_id]!.start_word);
  });
  it('server chặn chỉ số từ bịa / ngoài cửa sổ / không khớp trích dẫn', () => {
    const t = real(); const q = offer(t);
    for (const bad of [{ ...q, start_word: 0 }, { ...q, start_word: q.start_word + 1 }, { ...q, end_word: 9999 }]) {
      expect(validateClipPlan(t, [bad], {}).accepted).toEqual([]);
    }
    const fallback = resolveBoundaries(sentenceData(t), { start_id: q.start_id, end_id: q.end_id, start_quote: 'đoạn trích hoàn toàn bịa', end_quote: 'kết thúc bịa đặt' });
    expect(fallback).toMatchObject({ boundary: 'sentence_fallback', start_word: t.sentences[q.start_id]!.start_word, end_word: t.sentences[q.end_id]!.end_word });
  });
  it('dò theo THỨ TỰ từ, cho phép một lỗi; không nhận cùng túi từ bị đảo', () => {
    const s = [{ id: 0, start: 0, end: 6, start_word: 0, text: 'một hai ba bốn năm sáu' }];
    expect(locateQuote(s, 0, 'một hai lỗi bốn năm', 'start')?.i).toBe(0);
    expect(locateQuote(s, 0, 'năm bốn ba hai một', 'start')).toBeNull();
    expect(locateQuote(s, 3, 'một hai ba bốn', 'start')).toBeNull();
  });
  it('không viết hoa ở ranh giới chia do giới hạn độ dài; viết hoa sau dấu chấm/khoảng ngừng mạnh', () => {
    const t = buildTranscript({ text: '', segments: [{ start: 0, end: 1, text: '' }, { start: 1, end: 2, text: '' }], words: [
      { word: 'hai', start: 0, end: 1 }, { word: 'mươi', start: 1, end: 2 }, { word: 'đồng.', start: 2, end: 3 }, { word: 'mua', start: 3, end: 4 }, { word: 'ngay', start: 4.7, end: 5 },
    ] });
    expect(displayWords(t, 0, 4, null).map((w) => w.w)).toEqual(['Hai', 'mươi', 'đồng.', 'Mua', 'Ngay']);
  });
  it('fix sửa ngay trong cùng ID câu, rồi kiểm định và khôi phục đúng phần được chọn', async () => {
    const t = real(); const q = offer(t); const data = sentenceData(t);
    const a = t.sentences[q.start_id]!;
    const candidate = { ...q, start_word: a.start_word, start_quote: a.text.split(' ').slice(0, 5).join(' '), title: 'Ưu đãi', hook: 'Giá tốt', score: 90, reason: 'chốt đơn', window: 0 };
    const fixed = applyFix(candidate, q, data, { min_s: 15, max_s: 30 });
    expect(fixed).toMatchObject({ start_word: q.start_word, end_word: q.end_word });
    const kinds: string[] = []; let verifies = 0; let restored = '';
    const result = await runClipPlan({ source: { path: null, duration_s: t.duration_s }, sentences: data, windows: [], count: 1, existing: [], duration_preset: { key: '15_30', min_s: 15, max_s: 30, ideal_min_s: 18, ideal_max_s: 28 } }, deps(async (messages) => {
      const sys = String((messages[0] as any).content);
      if (sys.includes('phân loại')) { kinds.push('type'); return { content: '{"content_type":"livestream_ban_hang"}' }; }
      if (sys.includes('biên tập viên')) { kinds.push('moments'); return { content: JSON.stringify({ moments: [candidate] }) }; }
      if (sys.includes('kiểm định')) { kinds.push('verify'); verifies++; return { content: JSON.stringify({ results: [{ id: 'c1', keep: verifies > 1, diagnosis: verifies > 1 ? 'none' : 'bad_start', standalone_score: 0.9, fix: verifies === 1 ? q : null }] }) }; }
      kinds.push('restore'); restored = /<loi_thoai>\n([\s\S]*?)\n<\/loi_thoai>/.exec(String((messages[1] as any).content))![1]!;
      return { content: JSON.stringify({ text: restored[0]!.toUpperCase() + restored.slice(1) + '.' }) };
    }));
    expect(kinds).toEqual(['type', 'moments', 'verify', 'verify', 'restore']);
    expect(restored).toBe(t.words.slice(q.start_word, q.end_word + 1).map((w) => w.w).join(' '));
    expect(result.clips[0]).toMatchObject({ start_word: q.start_word, end_word: q.end_word, verify: { status: 'repaired', boundary: 'word_quote' } });
    expect(result.diagnostics).toMatchObject({ proposed: 1, rejected: [] });
    expect(validateClipPlan(t, result.clips, { preset: { min_s: 15, max_s: 30 } }).accepted).toHaveLength(1);
  });
});

describe('khoảng lặng: hiệu chỉnh theo audio và hủy', () => {
  it('ngưỡng RMS tự điều chỉnh, kẹp an toàn; parse/gộp các khoảng lặng', () => {
    expect(thresholdFromLevels(Array(10).fill(-30))).toBeNull();
    expect(thresholdFromLevels([...Array(20).fill(-85), ...Array(80).fill(-15)])?.threshold_db).toBe(-55);
    expect(thresholdFromLevels([...Array(20).fill(-45), ...Array(80).fill(-20)])?.threshold_db).toBe(-36.2);
    expect(parseSilenceLines(['lavfi.silence_start=1', 'lavfi.silence_end=1.4', 'lavfi.silence_start=2', 'lavfi.silence_end=2.1'])).toEqual([{ start: 1, end: 1.4 }]);
    expect(normalizePauses([{ start: -4, end: -1 }, { start: 1, end: 2 }, { start: 1.5, end: 3 }])).toEqual([{ start: 1, end: 3 }]);
  });
  it('chạy ffmpeg thật trên media tạm, không gọi STT; nhận biết abort', async () => {
    const env = await makeEnv();
    try {
      const file = path.join(env.root, 'silence.mp4');
      const bin = env.ctx.config.ffmpegPath ?? 'ffmpeg';
      await run(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,0.5\\,1.5)+between(t\\,2.2\\,3.2)\\,0.2*sin(2*PI*440*t)\\,0):s=16000:d=4.2', '-c:a', 'aac', file], new AbortController().signal);
      const r = await detectPauses(bin, file, new AbortController().signal);
      expect(r?.info.threshold_db).toBeTypeOf('number');
      expect(r?.pauses.some((p) => Math.abs(p.start - 1.5) < 0.1 && Math.abs(p.end - 2.2) < 0.1)).toBe(true);
      const abort = new AbortController(); abort.abort();
      await expect(detectPauses(bin, file, abort.signal)).rejects.toThrow();
    } finally { await env.close(); }
  });
});

describe('thử lại inference có giới hạn, giữ quy tắc lease/quota', () => {
  it('timeout/mạng lỗi hai lần rồi thành công; thông báo chẩn đoán', async () => {
    let calls = 0;
    const d = deps(async () => { if (++calls < 3) throw new DOMException('timed out', 'TimeoutError'); return { content: '{"ok":true}' }; });
    expect(await inferParsed(d, [], ['text'], (s) => JSON.parse(s), {})).toEqual({ ok: true });
    expect(calls).toBe(3);
  });
  it('hết hai lượt thử lại thì ném lỗi; không thử lại khi lease/quota hoặc request sai', async () => {
    for (const code of ['LEASE_LOST', 'AI_UNAVAILABLE', 'AI_INVALID_REQUEST', 'JOB_CANCELLED']) {
      let calls = 0;
      const d = deps(async () => { calls++; throw Object.assign(new Error('timeout'), { code }); });
      await expect(inferParsed(d, [], ['text'], () => null, {})).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
    let calls = 0;
    await expect(inferParsed(deps(async () => { calls++; throw new TypeError('fetch failed'); }), [], ['text'], () => null, {})).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });
  it('worker bị dừng trong lúc backoff thì không gọi inference tiếp', async () => {
    let calls = 0; let stopped = false;
    const d = deps(async () => { calls++; throw new TypeError('fetch failed'); });
    d.sleep = async () => { stopped = true; };
    d.alive = async () => { if (stopped) throw Object.assign(new Error('stopped'), { code: 'LEASE_LOST' }); };
    await expect(inferParsed(d, [], ['text'], () => null, {})).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(calls).toBe(1);
  });
});
