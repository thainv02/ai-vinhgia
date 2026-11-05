export { jobIsActive } from '../../../server/src/lib/job-state.js';

export const planQuotaBlock = (quota: { plan?: number | null } | null | undefined): string | null =>
  quota?.plan != null && quota.plan <= 0 ? 'Bạn đã hết lượt xử lý AI trong giờ này, hãy thử lại sau' : null;
