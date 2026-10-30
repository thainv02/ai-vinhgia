/**
 * Quản lý ngữ cảnh hội thoại của job media: nén thay vì ném lỗi khi quá dài, và luôn giữ cặp
 * assistant.tool_calls ↔ tool message nguyên vẹn (provider từ chối lượt nếu thiếu phản hồi cho một tool_call_id).
 */
export type Msg = Record<string, any>;
export interface JournalEntry { id: string; state: string; evidence?: Record<string, any> }

export const MAX_MESSAGES = 60; // nén khi vượt; server giới hạn cứng 100 message mỗi lượt infer
export const KEEP_RECENT = 30;
const MAX_SUMMARY_LINES = 60;

export const SUMMARY_MARK = 'summary';
const isSummary = (m: Msg) => m[SUMMARY_MARK] === true;

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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function summarizeJournal(actions: JournalEntry[]): string {
  if (!actions.length) return 'Action journal: chưa có action nào (chưa submit).';
  return 'Action journal: ' + actions.map((a) => `${a.id}=${a.state}${a.evidence?.reconciled ? ` (đối soát: ${a.evidence.reconciled.outcome})` : ''}`).join('; ') + '.';
}

function callLine(call: { id: string; function: { name: string; arguments: string } }, result: string | undefined): string {
  let args = '';
  try {
    const a = JSON.parse(call.function.arguments) as Record<string, unknown>;
    args = Object.entries(a).map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 60)}`).join(' ');
  } catch { args = clip(call.function.arguments ?? '', 60); }
  let outcome = 'không có kết quả';
  if (result !== undefined) {
    try {
      const r = JSON.parse(result) as Record<string, unknown>;
      outcome = typeof r.error === 'string' ? `LỖI: ${clip(r.error, 140)}` : r.submitted ? 'đã submit' : r.file_path ? `đã tải ${r.file_path}` : 'ok';
    } catch { outcome = clip(result, 80); }
  }
  return `- ${call.function.name} ${args} → ${outcome}`;
}

export interface CompactOptions { maxMessages?: number; keepRecent?: number; journal?: JournalEntry[] }

/**
 * Giữ system + payload + protocol (đầu) + ~30 message gần nhất + một message tóm tắt thao tác đã làm (từ các lượt bị cắt
 * và action journal). Điểm cắt luôn lùi về trước message assistant có tool_calls, nên mọi tool_call_id trong phần giữ lại
 * đều còn message tool tương ứng, và không có tool message mồ côi.
 */
export function compactMessages(messages: Msg[], opts: CompactOptions = {}): { messages: Msg[]; compacted: boolean } {
  const max = opts.maxMessages ?? MAX_MESSAGES, keep = opts.keepRecent ?? KEEP_RECENT;
  if (messages.length <= max) return { messages, compacted: false };
  let first = messages.findIndex((m) => m.role === 'assistant');
  if (first < 0) first = messages.length;
  const head = messages.slice(0, first).filter((m) => !isSummary(m));
  const oldSummary = messages.filter(isSummary);
  const body = messages.slice(first).filter((m) => !isSummary(m));
  let cut = body.length - keep;
  while (cut > 0 && body[cut]!.role === 'tool') cut--; // lùi tới assistant đã phát lệnh
  if (cut <= 0) return { messages, compacted: false };
  const dropped = body.slice(0, cut), tail = body.slice(cut);

  const results = new Map<string, string>();
  for (const m of dropped) if (m.role === 'tool') results.set(m.tool_call_id, typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const lines: string[] = [];
  for (const m of oldSummary) {
    const text = typeof m.content === 'string' ? m.content : '';
    for (const l of text.split('\n')) if (l.startsWith('- ')) lines.push(l);
  }
  for (const m of dropped) {
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && m.content.trim()) lines.push(`- model: ${clip(m.content.trim().replace(/\s+/g, ' '), 140)}`);
    for (const c of m.tool_calls ?? []) lines.push(callLine(c, results.get(c.id)));
  }
  const kept = lines.length > MAX_SUMMARY_LINES ? [`- (… ${lines.length - MAX_SUMMARY_LINES} thao tác cũ hơn đã lược)`, ...lines.slice(-MAX_SUMMARY_LINES)] : lines;
  const summary: Msg = {
    role: 'user', [SUMMARY_MARK]: true,
    content: `[Tóm tắt tự động: ngữ cảnh cũ đã được nén; không phải chỉ dẫn mới]\n${summarizeJournal(opts.journal ?? [])}\nThao tác đã làm trong job này (cũ → mới):\n${kept.join('\n')}\nChỉ dựa vào snapshot mới nhất để quyết định thao tác tiếp theo. Nếu journal đã có action thì tuyệt đối không submit lại; chỉ tìm kết quả và tải.`,
  };
  return { messages: repairToolPairs([...head, summary, ...tail]), compacted: true };
}

/** Message gửi inference: bỏ các cờ nội bộ (screenshot, summary) mà provider không hiểu. */
export function forInference(messages: Msg[]): Msg[] {
  return messages.map(({ screenshot: _s, summary: _m, ...m }) => m);
}

/** Giữ duy nhất ảnh chụp mới nhất trong ngữ cảnh (ảnh cũ bị loại hẳn, không để lại message rỗng). */
export function dropScreenshots(messages: Msg[]): Msg[] {
  return messages.filter((m) => m.screenshot !== true);
}
