import type { ServerResponse } from 'node:http';

interface Subscriber {
  res: ServerResponse;
  projectId: number | null;
  ping: NodeJS.Timeout;
}

export const SSE_PING_MS = 15_000;

/** Trung tâm phát Server-Sent Events. projectId null (ở người nghe) = nhận tất cả dự án. */
export class SseHub {
  private subs = new Set<Subscriber>();

  get size(): number {
    return this.subs.size;
  }

  /** Gắn một response đã hijack; ghi header SSE và các sự kiện khởi tạo. */
  add(res: ServerResponse, projectId: number | null, initial: { event: string; data: unknown }[] = []): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n: connected\n\n');
    const sub: Subscriber = {
      res,
      projectId,
      ping: setInterval(() => {
        this.write(sub, ': ping\n\n');
      }, SSE_PING_MS),
    };
    sub.ping.unref();
    this.subs.add(sub);
    const drop = () => {
      clearInterval(sub.ping);
      this.subs.delete(sub);
    };
    res.on('close', drop);
    res.on('error', drop);
    for (const ev of initial) this.write(sub, frame(ev.event, ev.data));
  }

  /** Phát sự kiện. projectId null = sự kiện toàn cục (gửi cho mọi người nghe). */
  publish(event: string, data: unknown, projectId: number | null): void {
    if (this.subs.size === 0) return;
    const text = frame(event, data);
    for (const sub of this.subs) {
      if (sub.projectId === null || projectId === null || sub.projectId === projectId) this.write(sub, text);
    }
  }

  closeAll(): void {
    for (const sub of this.subs) {
      clearInterval(sub.ping);
      try {
        sub.res.end();
      } catch {
        /* bỏ qua */
      }
    }
    this.subs.clear();
  }

  private write(sub: Subscriber, text: string): void {
    try {
      sub.res.write(text);
    } catch {
      clearInterval(sub.ping);
      this.subs.delete(sub);
    }
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
