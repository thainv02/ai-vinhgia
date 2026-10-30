import { isToolName, toolArgs } from './tools.js';

export interface ToolCall { id: string; type?: string; function: { name: string; arguments: string } }
export interface ToolOutcome { messages: { role: 'tool'; tool_call_id: string; content: string }[]; image?: string }

export const ONE_ACTION_ERROR = 'Chỉ một thao tác mỗi lượt: lệnh này KHÔNG được chạy. Xem kết quả của lệnh đầu tiên rồi gọi lại từng lệnh một.';

/**
 * Chạy các tool call của một lượt model. Chỉ lệnh đầu tiên được chạy; mọi lệnh còn lại nhận message tool lỗi
 * (mỗi tool_call_id đều có phản hồi, nếu không API provider từ chối lượt kế). Không ném lỗi chỉ vì model gọi song song.
 * LOGIN_REQUIRED/CAPTCHA vẫn ném để job dừng đúng quy trình.
 */
export async function runToolCalls(calls: ToolCall[], run: (name: string, args: Record<string, any>) => Promise<any>): Promise<ToolOutcome> {
  const messages: ToolOutcome['messages'] = [];
  let image: string | undefined;
  for (const [i, call] of calls.entries()) {
    if (i > 0) { messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: ONE_ACTION_ERROR }) }); continue; }
    let output: any;
    try {
      const args = toolArgs.parse(JSON.parse(call.function.arguments));
      if (!isToolName(call.function.name)) throw new Error('Công cụ không được phép');
      output = await run(call.function.name, args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Tool failed';
      if (/LOGIN_REQUIRED|CAPTCHA/.test(msg)) throw e;
      output = { error: msg.slice(0, 700) };
    }
    if (output && typeof output === 'object' && 'image' in output) { image = output.image; delete output.image; }
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output ?? { ok: true }) });
  }
  return { messages, image };
}
