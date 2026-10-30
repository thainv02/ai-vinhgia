import { useSyncExternalStore } from 'react';

/** Thời điểm phát hiện tại của video nguồn, nằm ngoài state React để mỗi nhịp phát không vẽ lại cả trang. */
export interface PlayerStore {
  getTime(): number;
  isPlaying(): boolean;
  set(time: number, playing: boolean): void;
  subscribe(cb: () => void): () => void;
}

export function createPlayerStore(): PlayerStore {
  let time = 0;
  let playing = false;
  const subs = new Set<() => void>();
  return {
    getTime: () => time,
    isPlaying: () => playing,
    set(t, p) {
      if (t === time && p === playing) return;
      time = t;
      playing = p;
      for (const s of subs) s();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
}

/** Đăng ký theo một giá trị dẫn xuất (số nguyên) để chỉ vẽ lại khi giá trị đó đổi. */
export function usePlayerSelect(store: PlayerStore, select: (time: number) => number): number {
  return useSyncExternalStore(store.subscribe, () => select(store.getTime()));
}

export function usePlayerPlaying(store: PlayerStore): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isPlaying());
}
