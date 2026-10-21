import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export class McpToolError extends Error {
  constructor(
    public readonly tool: string,
    message: string,
  ) {
    super(`Shotcut MCP ${tool}: ${message}`);
    this.name = 'McpToolError';
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client MCP tối giản qua stdio: JSON-RPC mỗi dòng một message
 * (initialize → notifications/initialized → tools/call). Đủ cho Shotcut MCP.
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = '';
  private closed = false;
  private failure: Error | null = null;

  private constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.on('error', (err) => this.fail(new Error(`Không chạy được Shotcut MCP (${command}): ${err.message}`)));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`Shotcut MCP thoát đột ngột (mã ${code ?? signal}): ${this.stderrTail.trim().slice(-300)}`));
    });
    // EPIPE khi ghi vào tiến trình đã chết
    this.child.stdin.on('error', () => undefined);
  }

  static start(opts: { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }): McpClient {
    return new McpClient(opts.command, opts.args, { ...process.env, ...opts.env }, opts.cwd);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // dòng không phải JSON (log) → bỏ qua
    }
    if (typeof msg.id !== 'number') return; // notification từ server
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`MCP lỗi: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} quá thời gian (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize(timeoutMs = 30_000): Promise<void> {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'autovideo', version: '1' } }, timeoutMs);
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  /** Gọi tool; trả về JSON đã parse từ content[0].text (hoặc chuỗi nếu không phải JSON). `isError` → McpToolError. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    const result = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (result?.isError) throw new McpToolError(name, text.slice(0, 600) || 'lỗi không rõ');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Đã đóng kết nối MCP'));
    try {
      this.child.stdin.end();
    } catch {
      /* đã đóng */
    }
    this.child.kill('SIGTERM');
    setTimeout(() => this.child.kill('SIGKILL'), 3000).unref();
  }
}
