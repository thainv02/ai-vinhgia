/**
 * Ngữ cảnh hội thoại của job AI: luôn giữ cặp assistant.tool_calls ↔ tool message nguyên vẹn (provider từ chối lượt nếu thiếu
 * phản hồi cho một tool_call_id). Job hiện không dùng tool, nhưng checkpoint cũ vẫn có thể chứa tool_calls.
 */
export type Msg = Record<string, any>;

/** Danh sách vấn đề ghép cặp (rỗng = hợp lệ). Dùng cho test và kiểm tra trước khi gửi. */
export function toolPairProblems(messages: Msg[]): string[] {
  const problems: string[] = [];
  const issued = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    for (const c of m.tool_calls ?? []) {
      issued.add(c.id);
      // phản hồi phải nằm liền sau (cho phép nhiều tool message nối tiếp)
      let found = false;
      for (let j = i + 1; j < messages.length && messages[j]!.role === 'tool'; j++) if (messages[j]!.tool_call_id === c.id) found = true;
      if (!found) problems.push(`tool_call ${c.id} thiếu message tool liền sau`);
    }
  });
  for (const m of messages) if (m.role === 'tool' && !issued.has(m.tool_call_id)) problems.push(`tool message ${m.tool_call_id} mồ côi (không có assistant.tool_calls tương ứng)`);
  return problems;
}

/**
 * Sửa checkpoint bị gián đoạn: bổ sung message tool lỗi cho tool_call chưa có phản hồi (worker chết giữa lượt) và bỏ
 * message tool mồ côi. Không đoán kết quả thao tác đã chạy: nội dung ghi rõ "không rõ", model phải snapshot lại.
 */
export function repairToolPairs(messages: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') continue; // tool mồ côi (không ngay sau assistant có tool_calls tương ứng) bị loại
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const calls = m.tool_calls as { id: string }[];
    const following = new Map<string, Msg>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') { following.set(messages[j]!.tool_call_id, messages[j]!); j++; }
    for (const c of calls) {
      out.push(following.get(c.id) ?? { role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: 'Kết quả thao tác này không được ghi lại (worker bị gián đoạn). Có thể đã chạy hoặc chưa; chụp snapshot mới và kiểm tra action journal trước khi làm tiếp.' }) });
    }
    i = j - 1;
  }
  return out;
}

/** Message gửi inference: bỏ các cờ nội bộ (screenshot, summary) mà provider không hiểu. */
export function forInference(messages: Msg[]): Msg[] {
  return messages.map(({ screenshot: _s, summary: _m, ...m }) => m);
}
