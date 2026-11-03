// Idempotency key theo hành động của người dùng: giữ trong sessionStorage đến khi thành công, để gửi lại sau reload vẫn dùng đúng key cũ.
const K = 'av-html-idem';
const read = (): Record<string, string> => {
  try {
    return JSON.parse(window.sessionStorage.getItem(K) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
const write = (m: Record<string, string>) => {
  try {
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete m[k];
    window.sessionStorage.setItem(K, JSON.stringify(m));
  } catch {
    /* sessionStorage bị chặn: key chỉ sống trong lần gọi này */
  }
};
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/** Băm ngắn (FNV-1a) của nội dung hành động: nội dung đổi thì key mới (tránh IDEMPOTENCY_CONFLICT). */
export const hashOf = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

export function idemKey(scope: string): string {
  const m = read();
  const hit = m[scope];
  if (hit) return hit;
  const k = uuid();
  m[scope] = k;
  write(m);
  return k;
}

export function idemDone(scope: string): void {
  const m = read();
  if (!(scope in m)) return;
  delete m[scope];
  write(m);
}
