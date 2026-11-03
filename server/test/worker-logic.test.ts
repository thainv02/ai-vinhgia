import { describe, expect, it } from 'vitest';
import { forInference, repairToolPairs, toolPairProblems, type Msg } from '../../worker/src/conversation.js';
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

describe('ngữ cảnh hội thoại', () => {
  const call = (id: string) => ({ id, type: 'function', function: { name: 'x', arguments: '{}' } });
  const base = (): Msg[] => [{ role: 'system', content: 's' }, { role: 'user', content: 'payload' }];

  it('forInference bỏ cờ nội bộ', () => {
    const m: Msg[] = [...base(), { role: 'user', screenshot: true, content: 'img' }, { role: 'user', summary: true, content: 'sum' }];
    expect(forInference(m).every((x) => !('screenshot' in x) && !('summary' in x))).toBe(true);
  });
  it('checkpoint cũ: bổ sung message tool lỗi cho tool_call chưa có phản hồi và bỏ tool mồ côi', () => {
    const broken: Msg[] = [...base(), { role: 'assistant', content: null, tool_calls: [call('x1'), call('x2')] }, { role: 'tool', tool_call_id: 'x1', content: '{}' }, { role: 'tool', tool_call_id: 'ghost', content: '{}' }];
    expect(toolPairProblems(broken).length).toBeGreaterThan(0);
    const fixed = repairToolPairs(broken);
    expect(toolPairProblems(fixed)).toEqual([]);
    expect(fixed.filter((x) => x.role === 'tool').map((x) => x.tool_call_id)).toEqual(['x1', 'x2']);
    expect(String(fixed.at(-1)!.content)).toMatch(/không được ghi lại/);
  });
});
