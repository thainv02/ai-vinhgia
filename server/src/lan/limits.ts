import type { FastifyReply } from 'fastify';
import { AppError } from '../lib/errors.js';
import { SlidingWindowLimiter } from './rate-limit.js';

/** Số luồng tải video đồng thời: mỗi IP và toàn listener (mỗi luồng chỉ ghi xuống đĩa, nhưng không để một máy chiếm hết băng thông/đĩa). */
export const LAN_UPLOAD_CONCURRENCY = { perIp: 2, global: 4 } as const;

/**
 * Cổng giới hạn số lượt tải đang diễn ra. `acquire` trả hàm nhả (gọi trong finally) hoặc null khi đã đủ.
 * Đếm cả các lượt đang tải vào hạn mức giờ (`inflight(ip)`) nên hai request song song không lách được giới hạn theo giờ.
 */
export class UploadGate {
  private readonly perIp = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perIpMax: number = LAN_UPLOAD_CONCURRENCY.perIp,
    private readonly globalMax: number = LAN_UPLOAD_CONCURRENCY.global,
  ) {}

  inflight(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  acquire(ip: string): (() => void) | null {
    if (this.inflight(ip) >= this.perIpMax || this.total >= this.globalMax) return null;
    this.perIp.set(ip, this.inflight(ip) + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.inflight(ip) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
      this.total--;
    };
  }
}

export const uploadBusy = (): AppError =>
  new AppError('UPLOAD_BUSY', 'Đang có quá nhiều video được tải lên cùng lúc, hãy thử lại sau ít phút', 429, { retry_after_s: 30 });

/** Giới hạn tốc độ theo IP (spec §1 của planner và §C của dựng bản hoàn chỉnh/xoá logo). */
export const LAN_RATE = {
  loginFailures: { max: 10, windowMs: 15 * 60_000 },
  analyze: { max: 6, windowMs: 60 * 60_000 },
  createPlan: { max: 20, windowMs: 60 * 60_000 },
  uploadFiles: { max: 60, windowMs: 60 * 60_000 },
  /** Video cảnh tải lên (bước 3): 30 lần/giờ. */
  uploadVideo: { max: 30, windowMs: 60 * 60_000 },
  /** Tạo bản hoàn chỉnh và render lại bằng EDL người dùng sửa: 6 lần/giờ (dùng chung một hạn mức). */
  createFinal: { max: 6, windowMs: 60 * 60_000 },
  /** Xoá logo: việc công cụ mới, thử lại việc công cụ và xoá logo lại một bản dựng (`/clean`): 6 lần/giờ (dùng chung). */
  removeLogo: { max: 6, windowMs: 60 * 60_000 },
  /** Góp ý cho AI trên một bản hoàn chỉnh: 20 lần/giờ. */
  feedback: { max: 20, windowMs: 60 * 60_000 },
  /** Chỉnh màu tay tạo phiên bản mới (và thử chỉnh màu lại): 30 lần/giờ. */
  grade: { max: 30, windowMs: 60 * 60_000 },
  /** Ảnh xem trước chỉnh màu: 60 lần/giờ. */
  gradePreview: { max: 60, windowMs: 60 * 60_000 },
  /** Tải ảnh mẫu / file LUT cho "Màu theo ảnh mẫu" (cả chép từ ảnh có sẵn của kế hoạch): 20 lần/giờ. Tính lượt thành công; tải trùng nội dung không tính. */
  colorRef: { max: 20, windowMs: 60 * 60_000 },
  /** Xoá kế hoạch (DELETE /lan/api/plans/:id): 10 lần/giờ/IP, tính mọi yêu cầu tới được bước kiểm tra quyền (kể cả bị từ chối). */
  deletePlan: { max: 10, windowMs: 60 * 60_000 },
  /** Cắt clip từ video dài: tạo dự án 10/giờ, tải video nguồn (và nhận dạng lại) 3/giờ, AI chọn đoạn 6/giờ, dựng clip 30/giờ, sửa (duyệt, điểm cắt, phụ đề, tên) 120/giờ. */
  clipProject: { max: 10, windowMs: 60 * 60_000 },
  clipSource: { max: 3, windowMs: 60 * 60_000 },
  clipPlan: { max: 6, windowMs: 60 * 60_000 },
  clipRender: { max: 30, windowMs: 60 * 60_000 },
  clipEdit: { max: 120, windowMs: 60 * 60_000 },
} as const;

export interface LanLimiters {
  loginFails: SlidingWindowLimiter;
  analyze: SlidingWindowLimiter;
  createPlan: SlidingWindowLimiter;
  uploadFiles: SlidingWindowLimiter;
  uploadVideo: SlidingWindowLimiter;
  createFinal: SlidingWindowLimiter;
  removeLogo: SlidingWindowLimiter;
  feedback: SlidingWindowLimiter;
  grade: SlidingWindowLimiter;
  gradePreview: SlidingWindowLimiter;
  colorRef: SlidingWindowLimiter;
  deletePlan: SlidingWindowLimiter;
  clipProject: SlidingWindowLimiter;
  clipSource: SlidingWindowLimiter;
  clipPlan: SlidingWindowLimiter;
  clipRender: SlidingWindowLimiter;
  clipEdit: SlidingWindowLimiter;
  gate: UploadGate;
  /** Tải video nguồn cắt clip: tối đa 1 lượt đồng thời mỗi IP (2 toàn listener). */
  clipGate: UploadGate;
}

export function makeLimiters(now: () => number): LanLimiters {
  const lim = (r: { max: number; windowMs: number }) => new SlidingWindowLimiter(r.max, r.windowMs, now);
  return {
    loginFails: lim(LAN_RATE.loginFailures),
    analyze: lim(LAN_RATE.analyze),
    createPlan: lim(LAN_RATE.createPlan),
    uploadFiles: lim(LAN_RATE.uploadFiles),
    uploadVideo: lim(LAN_RATE.uploadVideo),
    createFinal: lim(LAN_RATE.createFinal),
    removeLogo: lim(LAN_RATE.removeLogo),
    feedback: lim(LAN_RATE.feedback),
    grade: lim(LAN_RATE.grade),
    gradePreview: lim(LAN_RATE.gradePreview),
    colorRef: lim(LAN_RATE.colorRef),
    deletePlan: lim(LAN_RATE.deletePlan),
    clipProject: lim(LAN_RATE.clipProject),
    clipSource: lim(LAN_RATE.clipSource),
    clipPlan: lim(LAN_RATE.clipPlan),
    clipRender: lim(LAN_RATE.clipRender),
    clipEdit: lim(LAN_RATE.clipEdit),
    gate: new UploadGate(),
    clipGate: new UploadGate(1, 2),
  };
}

/** 429 RATE_LIMITED kèm Retry-After (giây) và thông báo "thử lại sau N giây/phút". */
export function tooMany(reply: FastifyReply, what: string, retryAfterMs: number): AppError {
  const secs = Math.ceil(retryAfterMs / 1000);
  reply.header('Retry-After', String(secs));
  return new AppError('RATE_LIMITED', `${what} Thử lại sau ${secs < 90 ? `${secs} giây` : `${Math.ceil(secs / 60)} phút`}.`, 429, { retry_after_s: secs });
}

/** Như `beginUpload` nhưng cho video nguồn cắt clip: cổng riêng (1 lượt đồng thời mỗi IP). */
export function beginClipUpload(reply: FastifyReply, limiters: LanLimiters, ip: string, what: string): () => void {
  const lim = limiters.clipSource.check(ip, limiters.clipGate.inflight(ip) + 1);
  if (!lim.allowed) throw tooMany(reply, what, lim.retryAfterMs);
  const release = limiters.clipGate.acquire(ip);
  if (!release) {
    reply.header('Retry-After', '30');
    throw uploadBusy();
  }
  return release;
}

/** Kiểm tra hạn mức giờ (tính cả các lượt đang tải dở của IP này) và cổng đồng thời; trả hàm nhả cổng. Không ghi nhận lượt (ghi sau khi thành công). */
export function beginUpload(reply: FastifyReply, limiters: LanLimiters, limiter: SlidingWindowLimiter, ip: string, what: string): () => void {
  const lim = limiter.check(ip, limiters.gate.inflight(ip) + 1);
  if (!lim.allowed) throw tooMany(reply, what, lim.retryAfterMs);
  const release = limiters.gate.acquire(ip);
  if (!release) {
    reply.header('Retry-After', '30');
    throw uploadBusy();
  }
  return release;
}
