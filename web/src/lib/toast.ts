import { useSyncExternalStore } from 'react';

export type ToastKind = 'error' | 'success' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function push(kind: ToastKind, message: string, ttl: number) {
  const id = nextId++;
  items = [...items, { id, kind, message }].slice(-4);
  emit();
  window.setTimeout(() => dismiss(id), ttl);
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  error: (m: string) => push('error', m, 9000),
  success: (m: string) => push('success', m, 4000),
  info: (m: string) => push('info', m, 5000),
};

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
  );
}
