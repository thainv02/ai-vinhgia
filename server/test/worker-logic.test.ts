import { describe, expect, it } from 'vitest';
import { comparePrompt, evaluateUploads, evaluateVideoSettings, normalizePrompt, parseChip, parseCredits, precheckError, type ComposerSnapshot, type OptionState } from '../../worker/src/precheck.js';
import { KEEP_RECENT, MAX_MESSAGES, compactMessages, dropScreenshots, forInference, repairToolPairs, toolPairProblems, type Msg } from '../../worker/src/conversation.js';
import { ONE_ACTION_ERROR, runToolCalls } from '../../worker/src/turns.js';
import { definitions, tools } from '../../worker/src/tools.js';
import { gridStarts } from '../../worker/src/runner.js';

describe('edit_plan: mốc lưới khung hình', () => {
  it('video Flow 10,005–10,03 giây (âm thanh dài hơn hình) không sinh lưới đuôi rỗng ở giây 10', () => {
    expect(gridStarts(10.005)).toEqual([0, 5]);
    expect(gridStarts(10.027)).toEqual([0, 5]);
    expect(gridStarts(10)).toEqual([0, 5]);
  });
  it('đuôi đủ dài vẫn có lưới; video rất ngắn vẫn có ít nhất một lưới', () => {
    expect(gridStarts(12)).toEqual([0, 5, 10]);
    expect(gridStarts(10.6)).toEqual([0, 5, 10]);
    expect(gridStarts(0.3)).toEqual([0]);
    expect(gridStarts(4)).toEqual([0]);
  });
});

const WANT = { aspect: '9:16', duration_s: 10, count: 1, resolution: '720p' };
const opt = (category: OptionState['category'], value: string | number, selected: boolean | null): OptionState => ({ category, value, text: String(value), selected });
const snap = (over: Partial<ComposerSnapshot> = {}): ComposerSnapshot => ({
  chips: ['Video · 720p · 10s · x1'],
  options: [opt('aspect', '16:9', false), opt('aspect', '9:16', true)],
  prompt: { found: true, ambiguous: false, text: 'p', candidates: 1 },
  text: 'Generating will use 15 credits',
  ...over,
});

describe('F2 precheck: chip, credit, prompt, upload (hàm thuần)', () => {
  it('đọc chip thật `Video · 720p · 8s · x1` và các biến thể "10 s"/"10 giây"', () => {
    expect(parseChip('Video · 720p · 8s · x1')).toMatchObject({ resolution: 720, duration: 8, count: 1 });
    expect(parseChip('Video · 9:16 · 720p · 10 s · x2')).toMatchObject({ resolution: 720, duration: 10, count: 2, aspect: '9:16' });
    expect(parseChip('Video · 720p · 10 giây · x1')).toMatchObject({ duration: 10 });
    expect(parseChip('Video · 720p')).toBeNull();
  });
  it('dòng credit: will use N credits và biến thể; nhiều mức khác nhau là mơ hồ', () => {
    expect(parseCredits('Generating will use 15 credits')).toEqual([15]);
    expect(parseCredits('Sẽ dùng 15 credit cho lượt này')).toEqual([15]);
    expect(parseCredits('15 credits will be used')).toEqual([15]);
    expect(parseCredits('You have 1200 credits left')).toEqual([]);
    expect(parseCredits('will use 15 credits ... costs 20 credits')).toEqual([15, 20]);
  });
  it('khớp tất cả → không có vấn đề', () => {
    expect(evaluateVideoSettings(snap(), WANT, 15)).toEqual([]);
    // "10 s"/"10 giây" cũng đạt
    expect(evaluateVideoSettings(snap({ chips: ['Video · 720p · 10 giây · x1'] }), WANT, 15)).toEqual([]);
  });
  it('từng mục sai → đúng tên mục trong lỗi (aspect_ratio, duration, count, resolution, credits)', () => {
    const items = (s: ComposerSnapshot, credits = 15) => evaluateVideoSettings(s, WANT, credits).map((i) => i.item);
    expect(items(snap({ chips: ['Video · 720p · 8s · x1'] }))).toEqual(['duration']);
    expect(items(snap({ chips: ['Video · 720p · 10s · x2'] }))).toEqual(['count']);
    expect(items(snap({ chips: ['Video · 1080p · 10s · x1'] }))).toEqual(['resolution']);
    expect(items(snap({ options: [opt('aspect', '16:9', true), opt('aspect', '9:16', false)] }))).toEqual(['aspect_ratio']);
    expect(items(snap(), 20)).toEqual(['credits']);
    expect(items(snap({ text: 'không có dòng credit' }))).toEqual(['credits']);
    expect(items(snap({ text: 'will use 15 credits; will use 20 credits' }))).toEqual(['credits']);
  });
  it('fail-safe: chỉ liệt kê "10s" trong popover không chứng minh đang chọn 10s', () => {
    // không có chip, các nút không có trạng thái → không xác minh được
    const s = snap({ chips: [], options: [opt('duration', 4, null), opt('duration', 8, null), opt('duration', 10, null), opt('aspect', '9:16', null), opt('aspect', '16:9', null), opt('count', 1, null), opt('resolution', 720, null)] });
    expect(evaluateVideoSettings(s, WANT, 15).map((i) => i.item)).toEqual(['aspect_ratio', 'duration']); // count/resolution chỉ có một nhãn: là giá trị đang hiển thị
    const multi = snap({ chips: [], options: [opt('count', 1, null), opt('count', 2, null), opt('resolution', 720, null), opt('resolution', 1080, null), opt('duration', 10, true), opt('aspect', '9:16', true)] });
    expect(evaluateVideoSettings(multi, WANT, 15).map((i) => i.item)).toEqual(['count', 'resolution']);
    // nhãn đơn lẻ (không có lựa chọn thay thế) được chấp nhận
    expect(evaluateVideoSettings(snap({ chips: [], options: [opt('aspect', '9:16', null), opt('duration', 10, true), opt('count', 1, true), opt('resolution', 720, true)] }), WANT, 15)).toEqual([]);
    // chip mâu thuẫn với trạng thái chọn
    expect(evaluateVideoSettings(snap({ chips: ['Video · 720p · 10s · x1'], options: [opt('duration', 8, true), opt('duration', 10, false), opt('aspect', '9:16', true)] }), WANT, 15).map((i) => i.item)).toEqual(['duration']);
    // thiếu credits_expected trong payload
    expect(evaluateVideoSettings(snap(), WANT, undefined).map((i) => i.item)).toEqual(['credits']);
  });
  it('prompt: so sánh sau khi chuẩn hóa khoảng trắng và dấu typographic; khác nội dung thì từ chối', () => {
    expect(comparePrompt('Style:  warm\n kitchen. Shot 1', 'Style: warm kitchen. Shot 1')).toBeNull();
    expect(comparePrompt('He said “hi” – ok…', 'He said "hi" - ok...')).toBeNull();
    expect(normalizePrompt('a​b  c')).toBe('ab c');
    expect(comparePrompt('Style: warm kitchen. Shot 2', 'Style: warm kitchen. Shot 1')?.item).toBe('prompt');
    expect(comparePrompt('', 'x')?.detail).toMatch(/trống/);
    expect(comparePrompt('x', '')?.item).toBe('prompt');
  });
  it('upload: đủ, đúng thứ tự, không chứa output của job', () => {
    const exp = ['refs/1/a.png', 'refs/1/b.png', 'output/p/storyboard/C1.png'];
    expect(evaluateUploads(exp, exp, ['output/p/video/C1_v1.mp4'])).toEqual([]);
    expect(evaluateUploads([], exp, []).map((i) => i.detail).join()).toMatch(/0\/3/);
    expect(evaluateUploads(exp.slice(0, 2), exp, []).map((i) => i.detail).join()).toMatch(/còn thiếu: output\/p\/storyboard\/C1\.png/);
    expect(evaluateUploads([exp[1]!, exp[0]!, exp[2]!], exp, [])).toHaveLength(1);
    expect(evaluateUploads([...exp, 'refs/1/a.png'], exp, [])).toHaveLength(1);
    expect(evaluateUploads(['output/p/video/C1_v1.mp4'], ['refs/1/a.png'], ['output/p/video/C1_v1.mp4']).length).toBeGreaterThan(0);
    expect(evaluateUploads([], ['output/p/video/C1_v1.mp4'], ['./output/p/video/C1_v1.mp4']).map((i) => i.detail).join()).toMatch(/output của chính job/);
  });
  it('lỗi trả cho model bắt đầu bằng PRECHECK_FAILED: <mục>', () => {
    expect(precheckError([{ item: 'credits', detail: 'x' }, { item: 'prompt', detail: 'y' }]).message).toMatch(/^PRECHECK_FAILED: credits, prompt\. credits: x; prompt: y/);
  });
});

const call = (id: string, name = 'browser_click', args: object = { ref: 1 }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const turn = (i: number): Msg[] => [
  { role: 'assistant', content: null, tool_calls: [call(`c${i}`, 'browser_click', { ref: i })] },
  { role: 'tool', tool_call_id: `c${i}`, content: JSON.stringify(i % 7 === 0 ? { error: `lỗi ${i}` } : { ok: true }) },
  { role: 'user', screenshot: true, content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] },
];
const base = (): Msg[] => [{ role: 'system', content: 's' }, { role: 'user', content: 'payload' }, { role: 'user', content: 'protocol' }];

describe('F5 nén ngữ cảnh thay vì giới hạn cứng 90 message', () => {
  it('không nén khi chưa vượt ngưỡng', () => {
    const m = [...base(), ...turn(1)];
    expect(compactMessages(m).compacted).toBe(false);
  });
  it('vượt ngưỡng: giữ system+payload+protocol, ~30 message gần nhất và bản tóm tắt từ journal + tool đã gọi; không tool_call_id mồ côi', () => {
    let m = base();
    for (let i = 1; i <= 40; i++) m.push(...turn(i));
    expect(m.length).toBeGreaterThan(MAX_MESSAGES);
    const journal = [{ id: 'media-31', state: 'submitted', evidence: {} }];
    const r = compactMessages(m, { journal });
    expect(r.compacted).toBe(true);
    const out = r.messages;
    expect(out.slice(0, 3).map((x) => x.content)).toEqual(['s', 'payload', 'protocol']);
    expect(out[3]).toMatchObject({ role: 'user', summary: true });
    const summary = String(out[3]!.content);
    expect(summary).toContain('media-31=submitted');
    expect(summary).toMatch(/browser_click ref=1 → ok/);
    expect(summary).toMatch(/LỖI: lỗi 7/);
    expect(summary).toMatch(/không submit lại/);
    expect(out.length).toBeLessThanOrEqual(3 + 1 + KEEP_RECENT + 3);
    expect(out.length).toBeLessThan(MAX_MESSAGES);
    expect(toolPairProblems(out)).toEqual([]);
    // các message cuối được giữ nguyên
    expect(out.at(-1)).toEqual(m.at(-1));
  });
  it('điểm cắt không bao giờ làm mồ côi tool message (kể cả nhiều tool trong một lượt)', () => {
    for (let n = 28; n <= 45; n++) {
      let m = base();
      for (let i = 1; i <= n; i++) {
        if (i % 3 === 0) {
          m.push({ role: 'assistant', content: null, tool_calls: [call(`a${i}`), call(`b${i}`), call(`c${i}`)] },
            { role: 'tool', tool_call_id: `a${i}`, content: '{"ok":true}' },
            { role: 'tool', tool_call_id: `b${i}`, content: JSON.stringify({ error: ONE_ACTION_ERROR }) },
            { role: 'tool', tool_call_id: `c${i}`, content: JSON.stringify({ error: ONE_ACTION_ERROR }) });
        } else m.push(...turn(i));
      }
      const out = compactMessages(m, { maxMessages: 40, keepRecent: 11 }).messages;
      expect(toolPairProblems(out), `n=${n}`).toEqual([]);
    }
  });
  it('nén lặp lại: tóm tắt cũ được gộp (không nhân đôi), lịch sử không phình', () => {
    let m = base();
    let sizes: number[] = [];
    for (let i = 1; i <= 150; i++) {
      m = dropScreenshots(m);
      m.push(...turn(i));
      m = compactMessages(m, { maxMessages: 40, keepRecent: 12, journal: [{ id: 'media-1', state: 'submitted' }] }).messages;
      sizes.push(m.length);
    }
    expect(Math.max(...sizes)).toBeLessThan(60);
    expect(m.filter((x) => x.summary).length).toBe(1);
    expect(toolPairProblems(m)).toEqual([]);
    const text = String(m.find((x) => x.summary)!.content);
    expect(text.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(61);
  });
  it('forInference bỏ cờ nội bộ; dropScreenshots chỉ giữ ảnh mới nhất khi gọi lại sau mỗi lượt', () => {
    const m = [...base(), ...turn(1), { role: 'user', summary: true, content: 'sum' }];
    expect(forInference(m).every((x) => !('screenshot' in x) && !('summary' in x))).toBe(true);
    expect(dropScreenshots([...turn(1), ...turn(2)]).filter((x) => x.screenshot).length).toBe(0);
  });
  it('resume: bổ sung message tool lỗi cho tool_call chưa có phản hồi và bỏ tool mồ côi', () => {
    const broken: Msg[] = [...base(), { role: 'assistant', content: null, tool_calls: [call('x1'), call('x2')] }, { role: 'tool', tool_call_id: 'x1', content: '{}' }, { role: 'tool', tool_call_id: 'ghost', content: '{}' }];
    expect(toolPairProblems(broken).length).toBeGreaterThan(0);
    const fixed = repairToolPairs(broken);
    expect(toolPairProblems(fixed)).toEqual([]);
    expect(fixed.filter((x) => x.role === 'tool').map((x) => x.tool_call_id)).toEqual(['x1', 'x2']);
    expect(String(fixed.at(-1)!.content)).toMatch(/không được ghi lại/);
  });
  it('tool browser_wait có trong định nghĩa với seconds 5..60', () => {
    const wait = definitions.find(([n]) => n === 'browser_wait')!;
    expect(wait[2]).toEqual({ seconds: { type: 'integer', minimum: 5, maximum: 60 } });
    expect(tools.some((t) => t.function.name === 'browser_wait')).toBe(true);
  });
});

describe('F6 nhiều tool call một lượt', () => {
  it('chạy call đầu, mọi call còn lại nhận message tool lỗi "chỉ một thao tác mỗi lượt"; không ném lỗi', async () => {
    const ran: string[] = [];
    const calls = [call('1', 'browser_snapshot', {}), call('2', 'browser_submit', { ref: 3 }), call('3', 'browser_click', { ref: 4 })];
    const out = await runToolCalls(calls, async (name) => { ran.push(name); return { ok: true, image: 'data:image/jpeg;base64,x' }; });
    expect(ran).toEqual(['browser_snapshot']); // submit KHÔNG chạy
    expect(out.messages.map((m) => m.tool_call_id)).toEqual(['1', '2', '3']);
    expect(JSON.parse(out.messages[0]!.content)).toEqual({ ok: true });
    for (const m of out.messages.slice(1)) expect(JSON.parse(m.content).error).toBe(ONE_ACTION_ERROR);
    expect(out.image).toBe('data:image/jpeg;base64,x');
    // ghép với assistant message → cặp hợp lệ
    expect(toolPairProblems([{ role: 'assistant', content: null, tool_calls: calls }, ...out.messages])).toEqual([]);
  });
  it('lỗi tool trả về cho model; LOGIN_REQUIRED/CAPTCHA vẫn ném để job dừng đúng quy trình', async () => {
    const out = await runToolCalls([call('1')], async () => { throw new Error('PRECHECK_FAILED: credits'); });
    expect(JSON.parse(out.messages[0]!.content).error).toMatch(/PRECHECK_FAILED/);
    await expect(runToolCalls([call('1')], async () => { throw new Error('LOGIN_REQUIRED: x'); })).rejects.toThrow(/LOGIN_REQUIRED/);
    const bad = await runToolCalls([{ id: 'z', function: { name: 'rm_rf', arguments: '{}' } }, call('q')], async () => ({}));
    expect(JSON.parse(bad.messages[0]!.content).error).toMatch(/không được phép/);
    const badArgs = await runToolCalls([{ id: 'z', function: { name: 'browser_click', arguments: 'not json' } }], async () => ({}));
    expect(badArgs.messages).toHaveLength(1);
  });
});
