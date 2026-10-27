import { createContext, useContext, type ReactNode } from 'react';
import type { ClipApi } from './api';

/** Hạn mức còn lại của chính người gọi trong giờ này (chỉ trang LAN). Khóa lấy từ `/lan/api/status` → `remaining`. */
export interface ClipQuota {
  project?: number | null;
  source?: number | null;
  plan?: number | null;
  render?: number | null;
  edit?: number | null;
  /** Có bất kỳ số liệu nào không. */
  known: boolean;
}

export interface ClipEnv {
  api: ClipApi;
  scope: 'app' | 'lan';
  quota: ClipQuota | null;
  /** Làm mới hạn mức sau mỗi thao tác tốn lượt. */
  refreshQuota?: () => void;
  /** Hủy việc AI đang chọn clip (chỉ app chính có route này). */
  cancelJob?: (jobId: number) => Promise<unknown>;
  /** Chuyển dự án vào thùng rác (app: cần gõ lại tên; LAN: chỉ người tạo). */
  deleteProject?: (id: number, confirmName: string) => Promise<unknown>;
}

const Ctx = createContext<ClipEnv | null>(null);

export function ClipEnvProvider({ value, children }: { value: ClipEnv; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useClipEnv(): ClipEnv {
  const v = useContext(Ctx);
  if (!v) throw new Error('ClipEnvProvider chưa được bọc');
  return v;
}

/** Giới hạn tải lên hiển thị cho người dùng (mặc định của server: CLIP_SOURCE_MAX_* và LAN_CLIP_SOURCE_MAX_*). */
export function clipLimits(scope: 'app' | 'lan'): { bytes: number; seconds: number; label: string } {
  return scope === 'lan' ? { bytes: 2 * 1024 ** 3, seconds: 10800, label: '2 GB và 3 giờ' } : { bytes: 4 * 1024 ** 3, seconds: 10800, label: '4 GB và 3 giờ' };
}
