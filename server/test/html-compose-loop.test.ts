import { describe, expect, it } from 'vitest';
import {
  HtmlComposeError, MAX_INFERS, extractJson, freshState, parseComposeResult, parseVisionIssues, runHtmlCompose,
  type CheckOut, type ChatMsg, type ComposeDeps, type ComposeResult, type ComposeState, type InferPurpose,
} from '../../worker/src/html-compose.js';
import { lintFixText, type HtmlComposePayload } from '../../worker/src/html-prompts.js';

const payload = (vision: string | null = 'vis-model'): HtmlComposePayload => ({
  project: { id: 1, name: 'Demo', brief: 'Giới thiệu sản phẩm' },
  prompt: 'Video giới thiệu',
  spec: { aspect: '9:16', duration_s: 6, fps: 30, quality: '720p' },
  base_canvas: { w: 360, h: 640 },
  policy: { compose: 'claude-sonnet-4-6', vision: vision ?? 'none' },
  assets: [],
});
const out = (tag: string) => JSON.stringify({ files: [{ path: 'index.html', content: `<html>${tag}</html>` }], summary: `s-${tag}`, variables: [] });
const OK: CheckOut = { report: { ok: true, errors: [], warnings: [], checks: ['lint'] } };
const BAD = (msg = 'lỗi lint') => ({ report: { ok: false, errors: [{ code: 'x', message: msg }], warnings: [], checks: ['lint'] } }) as CheckOut;
const FRAMES: CheckOut = { ...OK, frames: [{ t: 1, png_base64: 'AAAA' }, { t: 3, png_base64: 'BBBB' }, { t: 5, png_base64: 'CCCC' }] };

interface Rig {
  deps: ComposeDeps;
  inferCalls: { messages: ChatMsg[]; purpose: InferPurpose }[];
  checkCalls: { tag: string; capture: boolean }[];
  states: ComposeState[];
  logs: string[];
}
/** `infers`: phản hồi lần lượt (hàm/Error được ném); `checks`: kết quả lần lượt của check (hết thì lặp lại phần tử cuối). */
function rig(infers: (string | Error)[], checks: (CheckOut | ((c: ComposeResult, capture: boolean) => CheckOut))[]): Rig {
  const r: Rig = { inferCalls: [], checkCalls: [], states: [], logs: [], deps: null as never };
  let ci = 0;
  let ki = 0;
  r.deps = {
    infer: async (messages, purpose) => {
      r.inferCalls.push({ messages, purpose });
      const v = infers[Math.min(ci++, infers.length - 1)]!;
      if (v instanceof Error) throw v;
      return { content: v };
    },
    check: async (c, capture) => {
      r.checkCalls.push({ tag: c.files[0]!.content, capture });
      const v = checks[Math.min(ki++, checks.length - 1)]!;
      return typeof v === 'function' ? v(c, capture) : v;
    },
    checkpoint: async (s) => void r.states.push(structuredClone(s)),
    alive: async () => undefined,
    log: (m) => void r.logs.push(m),
  };
  return r;
}
const apiErr = (code: string) => Object.assign(new Error(code), { code });

describe('đọc JSON của model', () => {
  const body = { files: [{ path: 'index.html', content: '<p>{"a":1} } chuỗi</p>' }], summary: 'xong', variables: [{ id: 'a' }] };
  it('JSON thuần, fence ```json, lời dẫn + đuôi, BOM, dấu ngoặc trong chuỗi', () => {
    const j = JSON.stringify(body);
    for (const t of [j, `﻿${j}`, '```json\n' + j + '\n```', 'Đây là kết quả:\n```\n' + j + '\n```\nChúc bạn thành công!', `Ok. ${j} hết.`, `{"nháp": 1}\nrồi\n${j}`]) {
      expect(parseComposeResult(t).files[0]!.content).toBe(body.files[0]!.content);
    }
    expect(parseComposeResult(j).summary).toBe('xong');
  });
  it('files dạng map, bỏ "./" ở đầu đường dẫn, thiếu summary/variables → mặc định', () => {
    const r = parseComposeResult(JSON.stringify({ files: { './index.html': '<p/>', 'compositions/a.html': '<b/>' } }));
    expect(r.files.map((f) => f.path)).toEqual(['index.html', 'compositions/a.html']);
    expect(r.summary).toBe('');
    expect(r.variables).toEqual([]);
  });
  it('không hợp lệ → ném', () => {
    expect(() => parseComposeResult('không có json')).toThrow();
    expect(() => parseComposeResult('{"summary":"x"}')).toThrow(/files/);
    expect(() => parseComposeResult('{"files":[]}')).toThrow();
    expect(() => parseComposeResult('{"files":[{"path":"index.html"}]}')).toThrow();
    expect(() => extractJson('[1,2]')).toThrow();
  });
  it('nhận xét vision: bỏ low, ok:true không có high → rỗng, hỏng → rỗng', () => {
    expect(parseVisionIssues('{"ok":true,"issues":[]}')).toEqual([]);
    expect(parseVisionIssues('xin lỗi, không biết')).toEqual([]);
    expect(parseVisionIssues('{"ok":false,"issues":[{"severity":"high","time":2,"problem":"Chữ bị cắt","fix":"giảm cỡ"},{"severity":"low","problem":"nhỏ"},{"problem":"lệch"}]}').map((i) => [i.severity, i.problem])).toEqual([['high', 'Chữ bị cắt'], ['medium', 'lệch']]);
    expect(parseVisionIssues('{"ok":true,"issues":[{"severity":"medium","problem":"x"}]}')).toEqual([]);
  });
});

describe('vòng compose', () => {
  it('giữ hướng dẫn cuối lỗi dài và nhắc cách sửa xung đột transform', () => {
    const hint = 'tl.fromTo is exempt from this rule.';
    const text = lintFixText({ errors: [{ code: 'gsap_css_transform_conflict', message: `${'x'.repeat(700)} ${hint}` }], warnings: [] });
    expect(text).toContain(hint);
    expect(text).toContain('xoá transform khỏi CSS của selector đó');
    expect(text).toContain('đừng chỉ đổi giá trị transform.');
    expect(lintFixText({ errors: [{ code: 'other', message: 'lỗi khác' }], warnings: [] })).not.toContain('Với gsap_css_transform_conflict:');
  });

  it('thành công ngay lần đầu (không vision): 1 infer, 1 check không chụp', async () => {
    const r = rig([out('a')], [OK]);
    const { result, state } = await runHtmlCompose(payload(null), r.deps);
    expect(result.files[0]!.content).toBe('<html>a</html>');
    expect(r.inferCalls.map((c) => c.purpose)).toEqual(['compose']);
    expect(r.checkCalls).toEqual([{ tag: '<html>a</html>', capture: false }]);
    expect(state).toMatchObject({ stage: 'done', infers: 1, lint_fixes: 0 });
    // system prompt chứa hợp đồng: canvas gốc, gsap, biến
    const sys = String(r.inferCalls[0]!.messages[0]!.content);
    expect(sys).toContain('360×640');
    expect(sys).toContain('__hf/gsap.min.js');
    expect(sys).toContain('data-hf-var');
    expect(sys).toContain('data-composition-id="main"');
    expect(sys).toContain('KHÔNG đặt transform trong CSS hay inline style');
    expect(sys).toContain('fromTo được miễn rule này');
    expect(String(r.inferCalls[0]!.messages[1]!.content)).toContain('Giới thiệu sản phẩm');
  });

  it('lint lỗi rồi sửa: lượt sửa nhận bộ file trước + báo cáo, check lại đạt', async () => {
    const r = rig([out('a'), out('b')], [BAD('thiếu timeline'), OK]);
    const { result, state } = await runHtmlCompose(payload(null), r.deps);
    expect(result.files[0]!.content).toBe('<html>b</html>');
    expect(r.inferCalls).toHaveLength(2);
    const fix = r.inferCalls[1]!.messages;
    expect(fix.at(-2)).toMatchObject({ role: 'assistant' });
    expect(String(fix.at(-2)!.content)).toContain('<html>a</html>');
    expect(String(fix.at(-1)!.content)).toContain('thiếu timeline');
    expect(state).toMatchObject({ infers: 2, lint_fixes: 1 });
  });

  it('hết ngân sách sửa lint (2 lượt) → HTML_COMPOSE_FAILED kèm báo cáo; tổng 3 infer', async () => {
    const r = rig([out('a'), out('b'), out('c')], [BAD('mãi lỗi')]);
    const e = await runHtmlCompose(payload(null), r.deps).catch((x) => x);
    expect(e).toBeInstanceOf(HtmlComposeError);
    expect(e.code).toBe('HTML_COMPOSE_FAILED');
    expect(e.message).toContain('mãi lỗi');
    expect(e.report.errors[0].message).toBe('mãi lỗi');
    expect(r.inferCalls).toHaveLength(3);
  });

  it('JSON hỏng: xin lại (tính một lượt sửa), hỏng mãi → thất bại sau tối đa 3 infer', async () => {
    const ok = rig(['không phải json', out('a')], [OK]);
    expect((await runHtmlCompose(payload(null), ok.deps)).state).toMatchObject({ infers: 2, lint_fixes: 1 });
    expect(String(ok.inferCalls[1]!.messages.at(-1)!.content)).toContain('JSON');
    const bad = rig(['x', 'y', 'z', 'w'], [OK]);
    await expect(runHtmlCompose(payload(null), bad.deps)).rejects.toThrow(/JSON/);
    expect(bad.inferCalls).toHaveLength(3);
  });

  it('có model vision, không vấn đề: check(false) → check(true) → 1 vision infer kèm ảnh thật → kết quả; 2 infer', async () => {
    const r = rig([out('a'), '```json\n{"ok":true,"issues":[]}\n```'], [OK, FRAMES]);
    const { result, state } = await runHtmlCompose(payload(), r.deps);
    expect(result.files[0]!.content).toBe('<html>a</html>');
    expect(r.checkCalls.map((c) => c.capture)).toEqual([false, true]);
    expect(r.inferCalls.map((c) => c.purpose)).toEqual(['compose', 'vision']);
    const parts = r.inferCalls[1]!.messages[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url)).toEqual(['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB', 'data:image/png;base64,CCCC']);
    expect(state).toMatchObject({ infers: 2, vision_infers: 1, stage: 'done' });
  });

  it('vision nêu vấn đề → 1 lượt sửa → check cuối không chụp đạt: compose, vision, fix = 3 infer', async () => {
    const vision = JSON.stringify({ ok: false, issues: [{ severity: 'high', time: 3, problem: 'Chữ giá bị cắt khỏi khung', fix: 'giảm cỡ chữ' }] });
    const r = rig([out('a'), vision, out('fixed')], [OK, FRAMES, OK]);
    const { result, state } = await runHtmlCompose(payload(), r.deps);
    expect(result.files[0]!.content).toBe('<html>fixed</html>');
    expect(r.inferCalls.map((c) => c.purpose)).toEqual(['compose', 'vision', 'compose']);
    expect(String(r.inferCalls[2]!.messages.at(-1)!.content)).toContain('Chữ giá bị cắt khỏi khung');
    expect(r.checkCalls).toEqual([
      { tag: '<html>a</html>', capture: false },
      { tag: '<html>a</html>', capture: true },
      { tag: '<html>fixed</html>', capture: false },
    ]);
    expect(state).toMatchObject({ infers: 3, vision_infers: 1, lint_fixes: 0 });
  });

  it('lượt sửa vision làm hỏng lint và hết ngân sách → dùng lại bộ file đã đạt trước đó (tối đa 5 infer)', async () => {
    const vision = '{"ok":false,"issues":[{"severity":"high","problem":"trống"}]}';
    const r = rig([out('a'), vision, out('broken1'), out('broken2'), out('broken3')], [
      (c, cap) => (cap ? FRAMES : c.files[0]!.content.includes('broken') ? BAD('hỏng') : OK),
    ]);
    // check(false) trên 'a' đạt; check(true) → FRAMES; các bộ 'broken*' không đạt
    const { result, state } = await runHtmlCompose(payload(), r.deps);
    expect(result.files[0]!.content).toBe('<html>a</html>');
    expect(state.infers).toBe(5);
    expect(r.logs.join('\n')).toContain('dùng lại bản đã đạt');
  });

  it('vision: model từ chối (AI_INVALID_REQUEST) hoặc không có khung (thiếu trình duyệt) → bỏ vision, vẫn thành công', async () => {
    const a = rig([out('a'), apiErr('AI_INVALID_REQUEST')], [OK, FRAMES]);
    expect((await runHtmlCompose(payload(), a.deps)).state).toMatchObject({ stage: 'done', infers: 1 });
    const b = rig([out('a')], [OK, { report: { ok: true, errors: [], warnings: [{ code: 'CAPTURE_SKIPPED_NO_BROWSER', message: 'Chưa cài bộ dựng' }], checks: [] } }]);
    const rb = await runHtmlCompose(payload(), b.deps);
    expect(rb.state.infers).toBe(1);
    expect(b.inferCalls).toHaveLength(1);
    expect(b.logs.join('\n')).toContain('Chưa cài bộ dựng');
  });

  it('AI_UNAVAILABLE được ném nguyên (runner xếp job chờ)', async () => {
    const r = rig([apiErr('AI_UNAVAILABLE')], [OK]);
    await expect(runHtmlCompose(payload(null), r.deps)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('trần 6 infer: resume với 5 infer đã dùng → chỉ còn đúng 1 lượt rồi thất bại', async () => {
    const st: ComposeState = { ...freshState(), stage: 'compose', infers: 5 };
    const r = rig(['hỏng'], [OK]);
    const e = await runHtmlCompose(payload(null), r.deps, st).catch((x) => x);
    expect(e).toBeInstanceOf(HtmlComposeError);
    expect(e.message).toContain(`${MAX_INFERS}`);
    expect(r.inferCalls).toHaveLength(1);
  });

  it('mọi kịch bản xấu nhất không vượt 6 infer và 2 lượt sửa lint', async () => {
    const vision = '{"ok":false,"issues":[{"severity":"high","problem":"trống"}]}';
    for (const [infers, checks] of [
      [['x', 'x', 'x', 'x', 'x', 'x', 'x'], [BAD()]],
      [[out('a'), vision, out('b'), out('c'), out('d'), out('e'), out('f')], [(c: ComposeResult, cap: boolean) => (cap ? FRAMES : c.files[0]!.content === '<html>a</html>' ? OK : BAD())]],
      [[out('a'), out('b'), out('c'), out('d')], [BAD()]],
    ] as [string[], (CheckOut | ((c: ComposeResult, cap: boolean) => CheckOut))[]][]) {
      const r = rig(infers, checks);
      await runHtmlCompose(payload(), r.deps).catch(() => undefined);
      expect(r.inferCalls.length).toBeLessThanOrEqual(MAX_INFERS);
      expect(r.states.at(-1)?.lint_fixes ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it('checkpoint sau mỗi infer thành công; resume tiếp từ trạng thái đã lưu mà không gọi lại infer cũ', async () => {
    const first = rig([out('a'), apiErr('AI_UNAVAILABLE')], [BAD('lỗi một'), OK]);
    await expect(runHtmlCompose(payload(null), first.deps)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    const saved = first.states.at(-1)!;
    expect(saved).toMatchObject({ stage: 'lint', infers: 1, lint_fixes: 0 });
    expect(saved.candidate!.files[0]!.content).toBe('<html>a</html>');
    // mỗi infer thành công đều có checkpoint (sau compose)
    expect(first.states.length).toBeGreaterThanOrEqual(1);

    const second = rig([out('b')], [BAD('lỗi một'), OK]);
    const { result, state } = await runHtmlCompose(payload(null), second.deps, JSON.parse(JSON.stringify(saved)));
    expect(second.inferCalls).toHaveLength(1); // chỉ lượt sửa; compose đầu KHÔNG gọi lại
    expect(second.inferCalls[0]!.purpose).toBe('compose');
    expect(String(second.inferCalls[0]!.messages.at(-1)!.content)).toContain('lỗi một');
    expect(result.files[0]!.content).toBe('<html>b</html>');
    expect(state.infers).toBe(2);
  });

  it('resume sau vision: không gọi lại vision (đã tính), chỉ sửa', async () => {
    const vision = '{"ok":false,"issues":[{"severity":"high","problem":"chữ tràn"}]}';
    const first = rig([out('a'), vision, apiErr('AI_UNAVAILABLE')], [OK, FRAMES]);
    await expect(runHtmlCompose(payload(), first.deps)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    const saved = first.states.at(-1)!;
    expect(saved).toMatchObject({ stage: 'vision_fix', infers: 2, vision_infers: 1 });
    const second = rig([out('fixed')], [OK]);
    const { result } = await runHtmlCompose(payload(), second.deps, saved);
    expect(second.inferCalls.map((c) => c.purpose)).toEqual(['compose']);
    expect(second.checkCalls.every((c) => !c.capture)).toBe(true);
    expect(result.files[0]!.content).toBe('<html>fixed</html>');
  });

  it('server từ chối /complete (400): tính một lượt sửa lint nếu còn ngân sách; hết → thất bại', async () => {
    const first = rig([out('a')], [OK]);
    const done = await runHtmlCompose(payload(null), first.deps);
    const second = rig([out('b')], [OK]);
    const fixed = await runHtmlCompose(payload(null), second.deps, done.state, { rejection: { errors: [{ code: 'security_fetch', message: 'cấm fetch' }], warnings: [] } });
    expect(String(second.inferCalls[0]!.messages.at(-1)!.content)).toContain('cấm fetch');
    expect(fixed.result.files[0]!.content).toBe('<html>b</html>');
    expect(fixed.state.lint_fixes).toBe(1);
    // ngân sách: đã dùng 2 lượt sửa → bị từ chối nữa thì thất bại, không gọi infer
    const spent = { ...fixed.state, lint_fixes: 2 };
    const third = rig([out('c')], [OK]);
    await expect(runHtmlCompose(payload(null), third.deps, spent, { rejection: { errors: [{ code: 'x', message: 'lại lỗi' }], warnings: [] } })).rejects.toBeInstanceOf(HtmlComposeError);
    expect(third.inferCalls).toHaveLength(0);
  });
});
