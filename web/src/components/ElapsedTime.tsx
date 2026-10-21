import { fmtElapsed } from '../lib/format';
import { useNow } from '../lib/useNow';

/** Thời gian đã chạy, tự nhảy mỗi giây. */
export function ElapsedTime({ since, className }: { since: string | null | undefined; className?: string }) {
  const now = useNow();
  return <span className={className}>{fmtElapsed(since, now)}</span>;
}
