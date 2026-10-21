/** Đồng hồ có thể thay thế trong test (không cần sleep để thử job mất heartbeat). */
export interface Clock {
  now(): number; // epoch ms
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: number | string = '2026-01-01T00:00:00.000Z') {
    this.t = typeof start === 'number' ? start : Date.parse(start);
  }
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  advanceMinutes(min: number): void {
    this.t += min * 60_000;
  }
}

export const toIso = (ms: number): string => new Date(ms).toISOString();
