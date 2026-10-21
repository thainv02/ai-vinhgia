const dtFull = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'medium' });
const pad = (n: number) => String(n).padStart(2, '0');

export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Dạng gọn: 19/10 16:58 */
export function fmtDateTime(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTimeLong(iso: string | null | undefined): string {
  const t = parseTime(iso);
  return t === null ? '—' : dtFull.format(t);
}

export function fmtDateTimeYear(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "vừa xong", "3 phút trước", "2 giờ trước", "5 ngày trước" */
export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  return `${d} ngày trước`;
}

/** Thời lượng dạng m:ss hoặc h:mm:ss từ số giây. */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Thời gian đã chạy tính từ một mốc ISO. */
export function fmtElapsed(fromIso: string | null | undefined, now: number): string {
  const t = parseTime(fromIso);
  if (t === null) return '—';
  return fmtDuration((now - t) / 1000);
}

/** Mốc thời gian video: m:ss.d */
export function fmtTimecode(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const d = Math.floor((safe * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

export function fmtCredits(n: number): string {
  return `${n} credit`;
}

export function fmtSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function pct(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (part / total) * 100)) : 0;
}
