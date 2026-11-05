import { useState } from 'react';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Alert, InlineError } from '../components/States';
import { useMutation } from '@tanstack/react-query';
import { useClipEnv } from './env';
import { useClipActions } from './hooks';
import { DURATION_PRESETS, jobIsActive, planQuotaBlock } from './lib';
import { Segmented } from './Segmented';
import type { ClipProjectDetail, DurationPreset } from './types';

const AI_WAIT: Record<string, string> = { waiting: 'Đang xếp hàng chờ AI', running: 'AI đang đọc lời thoại và tìm highlight' };

/** Khối "AI đề xuất clip": số clip, độ dài, hướng tập trung, trạng thái hàng đợi AI. */
export function PlanForm({ detail, canPlan }: { detail: ClipProjectDetail; canPlan: string | null }) {
  const { scope, quota, cancelJob } = useClipEnv();
  const projectId = detail.project.id;
  const { plan, refresh } = useClipActions(projectId);
  const cancel = useMutation({ mutationFn: (id: number) => cancelJob!(id), onSuccess: refresh });
  const [expanded, setExpanded] = useState(false);
  const [count, setCount] = useState('5');
  const [preset, setPreset] = useState<DurationPreset>('30_60');
  const [focus, setFocus] = useState('');
  const [exclude, setExclude] = useState(true);
  const [allowMulti, setAllowMulti] = useState(true);
  const job = detail.plan_job;
  const active = jobIsActive(job);
  const hasClips = detail.clips.length > 0;
  const n = Number(count);
  const countOk = Number.isInteger(n) && n >= 1 && n <= 15;
  const quotaBlock = planQuotaBlock(quota);
  const reason = canPlan ?? (active ? 'AI đang đề xuất highlight, đợi xong rồi chạy lại' : !countOk ? 'Số clip từ 1 đến 15' : quotaBlock);

  const run = () => plan.mutate({ count: n, duration_preset: preset, ...(focus.trim() ? { focus: focus.trim() } : {}), exclude_existing: hasClips ? exclude : false, allow_multi: allowMulti });

  let status: React.ReactNode = null;
  if (active && job) {
    const st = job.queue?.state === 'waiting' || job.status === 'queued' ? 'waiting' : 'running';
    status = (
      <Alert tone="info" icon="clock">
        <strong>{AI_WAIT[st]}</strong>
        {st === 'waiting' && job.queue?.position ? ` (vị trí ${job.queue.position})` : ''}.
        <span className="block text-xs opacity-90">
          {job.wait_reason === 'ai_quota'
            ? 'Tài khoản AI đang hết hạn mức: việc tự thử lại sau.'
            : job.worker && (job.worker.paused || job.worker.online === false)
              ? job.worker.paused
                ? 'Hàng đợi AI đang tạm dừng: việc chạy tiếp khi chủ máy mở lại.'
                : 'Máy chủ AI chưa sẵn sàng: việc chạy khi máy chủ mở lại.'
              : st === 'waiting'
                ? 'Chỉ có một máy chủ AI, các việc chạy lần lượt.'
                : 'Video dài mất vài phút. Có thể rời trang, highlight đề xuất tự hiện khi xong.'}
        </span>
      </Alert>
    );
  } else if (job?.status === 'failed') {
    status = <InlineError>{job.error ?? 'AI đề xuất highlight không thành công. Thử lại hoặc đổi hướng tập trung.'}</InlineError>;
  } else if (job?.status === 'done' && !hasClips) {
    status = (
      <Alert tone="warn">
        AI không tìm được đoạn nào đủ tốt trong video này.{job.not_found_reason ? ` ${job.not_found_reason}` : ''} Thử đổi độ dài, bỏ hướng tập trung hoặc tự tạo clip từ lời thoại.
      </Alert>
    );
  } else if (job?.status === 'done' && job.summary) {
    status = (
      <p className="rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
        <strong className="text-fg">Lần chạy gần nhất:</strong> {job.summary}
      </p>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-3" aria-labelledby="clip-plan-h">
      {hasClips && <div className="flex items-center gap-3"><span className="mr-auto text-xs text-muted">{active ? 'AI đang tìm thêm highlight…' : `${detail.clips.length} highlight đã được đề xuất`}</span><Button size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-controls="clip-plan-options" icon={<Icon name="plus" size={14} />}>{expanded ? 'Thu gọn' : 'Đề xuất thêm highlight'}</Button></div>}
      <div id="clip-plan-options" hidden={hasClips && !expanded && !active && !plan.isError} className="space-y-3">
      <div>
        <h2 id="clip-plan-h" className="text-[15px] font-semibold">
          AI đề xuất highlight
        </h2>
        <p className="text-xs text-muted">AI đọc toàn bộ lời thoại, chọn các đoạn highlight có thể đứng một mình, rồi kiểm tra lại. Bạn xem, sửa điểm cắt, duyệt rồi mới dựng.</p>
      </div>
      <div className="grid gap-3 min-[420px]:grid-cols-[96px_minmax(0,1fr)]">
        <div>
          <label htmlFor="plan-count" className="mb-1 block text-xs font-semibold text-muted">
            Số clip
          </label>
          <input id="plan-count" type="number" min={1} max={15} step={1} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} aria-invalid={!countOk} disabled={active} />
        </div>
        <Segmented label="Độ dài mỗi clip" value={preset} options={DURATION_PRESETS} onChange={setPreset} disabled={active} />
      </div>
      <div>
        <label htmlFor="plan-focus" className="mb-1 block text-xs font-semibold text-muted">
          Muốn tập trung vào... (tuỳ chọn)
        </label>
        <textarea id="plan-focus" rows={2} maxLength={300} value={focus} onChange={(e) => setFocus(e.target.value)} disabled={active} placeholder="Vd: các đoạn giới thiệu công dụng và chốt giá" />
        <p className="mt-0.5 text-right text-[11px] text-muted">{focus.length}/300</p>
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" checked={allowMulti} onChange={(e) => setAllowMulti(e.target.checked)} disabled={active} className="mt-0.5" aria-describedby="plan-multi-hint" />
        <span className="min-w-0">
          Cho phép AI ghép nhiều đoạn
          <span id="plan-multi-hint" className="block text-xs text-muted">Nối 2–4 đoạn cùng chủ đề ở các chỗ khác nhau thành một clip khi cách đó kể rõ hơn.</span>
        </span>
      </label>
      {hasClips && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} disabled={active} />
          Loại trừ các đoạn đã có (gợi ý thêm đoạn mới)
        </label>
      )}
      {status}
      {plan.isError && <InlineError>{errorMessage(plan.error)}</InlineError>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<Icon name="star" size={14} />} loading={plan.isPending} disabledReason={reason} onClick={run}>
          {hasClips ? 'Đề xuất thêm highlight' : 'AI đề xuất highlight'}
        </Button>
        {active && job && cancelJob && (
          <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
            Hủy việc AI
          </Button>
        )}
        {scope === 'lan' && quota?.plan !== undefined && quota.plan !== null && quota.plan <= 1 && <span className="text-xs text-muted">Còn {Math.max(0, quota.plan)} lượt nhờ AI trong giờ này</span>}
      </div>
      {reason && !active && <p className="-mt-1 text-xs text-warn-fg">{reason}</p>}
      </div>
    </section>
  );
}
