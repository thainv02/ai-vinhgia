import { useSyncExternalStore } from 'react';

// Một bộ đếm 1 giây dùng chung cho mọi thành phần cần "thời gian đã chạy".
const subs = new Set<() => void>();
let timer: number | null = null;
let now = Date.now();

function subscribe(cb: () => void) {
  subs.add(cb);
  if (timer === null) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const s of subs) s();
    }, 1000);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
