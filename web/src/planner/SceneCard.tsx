import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { buttonClass, Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { fmtRelative } from '../lib/format';
import { checkImageFiles } from '../lib/refFiles';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { Chip, TextBlock, WorkspaceTabs } from './parts';
import { VideoStep } from './VideoStep';
import type { Attachment, ScenePlanView, SceneVideoLimits } from './types';

/** Danh sách ảnh đính kèm theo thứ tự: ảnh nhỏ, số thứ tự, nhãn, cách prompt gọi ảnh, nút tải từng ảnh. */
function AttachmentList({ items, onZoom, emptyText }: { items: Attachment[]; onZoom: (src: string, title: string) => void; emptyText: string }) {
  if (items.length === 0) return <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-muted">{emptyText}</p>;
  return (
    <ol className="space-y-1.5">
      {items.map((a) => (
        <li key={`${a.order}-${a.kind}`} className="flex items-center gap-2.5 rounded-md border border-line bg-surface p-1.5">
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-ink-fg">
            {a.order}
          </span>
          {a.available && a.url ? (
            <button type="button" onClick={() => onZoom(a.url!, a.label)} aria-label={`Xem lớn: ${a.label}`} className="shrink-0 rounded-md focus-visible:outline-offset-1">
              <img src={a.url} alt="" className="size-12 rounded-md border border-line object-cover" loading="lazy" />
            </button>
          ) : (
            <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-md border border-dashed border-line-strong bg-surface-2 text-muted">
              <Icon name="image" size={18} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 text-[13px] font-semibold">
              <span className="truncate" title={a.label}>{a.label}</span>
              {a.prompt_label && <span className="rounded bg-surface-3 px-1.5 text-[11px] font-semibold text-muted">{a.prompt_label}</span>}
              {!a.prompt_label && a.kind !== 'ref' && <span className="rounded bg-surface-3 px-1.5 text-[11px] font-semibold text-muted">không đánh số trong prompt</span>}
            </div>
            <p className="truncate text-[11px] text-muted" title={a.file_name ?? undefined}>{a.file_name ?? 'Chưa có file'}</p>
            {a.note && <p className="mt-0.5 text-[11.5px] text-warn-fg">{a.note}</p>}
          </div>
          {a.available && a.url && (
            <a href={a.url} download={a.file_name ?? undefined} className={buttonClass('ghost', 'sm', 'shrink-0')} aria-label={`Tải ảnh: ${a.label}`}>
              <Icon name="download" size={14} />
              <span className="max-sm:sr-only">Tải</span>
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Tải lên ảnh storyboard bạn vừa tạo ở bước 1: lưu cho cảnh này (bước 2) và cho các cảnh sau nếu cần. */
function StoryboardUpload({ planId, scene, maxUploads, onZoom }: { planId: number; scene: ScenePlanView; maxUploads: number; onZoom: (src: string, title: string) => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const now = useNow();
  const [problem, setProblem] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (file: File) => planner.uploadStoryboard(planId, scene.id, file),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`Đã tải storyboard ${scene.code}`);
      void qc.invalidateQueries({ queryKey: ['plan', planId] });
    },
  });
  const reason = scene.upload_block ?? (scene.storyboard_uploads >= maxUploads ? `Đã tải tối đa ${maxUploads} lần cho cảnh này` : null);
  const sb = scene.storyboard;

  return (
    <div className="rounded-md border border-line bg-surface-2 p-3">
      <h4 className="text-[13px] font-semibold">Tải lên storyboard đã tạo</h4>
      <p className="mt-0.5 text-xs text-muted">Sau khi ChatGPT tạo xong, tải ảnh về rồi tải lên đây. Ảnh được dùng cho bước tạo video{scene.code === 'C1' ? ' và giữ cùng bối cảnh ở các cảnh sau' : ''}.</p>
      {sb && (
        <div className="mt-2 flex items-center gap-2.5">
          <button type="button" onClick={() => onZoom(sb.url, `Storyboard ${scene.code}`)} aria-label={`Xem lớn storyboard ${scene.code}`} className="shrink-0 rounded-md">
            <img src={sb.url} alt={`Storyboard ${scene.code} đã tải lên`} className="h-20 w-[45px] rounded-md border border-line object-cover" />
          </button>
          <div className="min-w-0 text-xs">
            <p className="font-semibold text-ok-fg">Đã tải lên {fmtRelative(sb.uploaded_at, now)}</p>
            <p className="truncate text-muted">{sb.file_name}</p>
            {sb.stale && <p className="mt-0.5 text-warn-fg">Prompt cảnh đã đổi sau khi bạn tải ảnh này, hãy kiểm tra lại.</p>}
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Icon name="upload" size={14} />} loading={m.isPending} disabledReason={reason} onClick={() => input.current?.click()}>
          {sb ? 'Tải lại ảnh khác' : 'Chọn ảnh storyboard'}
        </Button>
        {reason && <span className="text-xs text-muted">{reason}</span>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        aria-label={`Chọn ảnh storyboard cho ${scene.code}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const { ok, errors } = checkImageFiles([f]);
          setProblem(errors[0] ?? null);
          if (ok[0]) m.mutate(ok[0]);
        }}
      />
      {(problem || m.isError) && (
        <div className="mt-2">
          <InlineError>{problem ?? errorMessage(m.error)}</InlineError>
        </div>
      )}
    </div>
  );
}

export function SceneCard({ planId, scene, maxUploads, videoLimits, onZoom }: { planId: number; scene: ScenePlanView; maxUploads: number; videoLimits: SceneVideoLimits; onZoom: (src: string, title: string) => void }) {
  const { step1, step2 } = scene;
  const s = step2.settings;
  const [step, setStep] = useState(() => scene.videos.selected_id !== null ? 'upload' : scene.storyboard ? 'flow' : 'storyboard');
  const steps = [
    { value: 'storyboard', label: '1. Storyboard', icon: 'image' as const, done: !!scene.storyboard && !scene.storyboard.stale },
    { value: 'flow', label: '2. Prompt video', icon: 'film' as const },
    { value: 'upload', label: '3. Video đầu ra', icon: 'upload' as const, done: scene.videos.selected_id !== null },
  ];
  const tabsId = `scene-step-${scene.id}`;
  return (
    <article className="scene-card" aria-labelledby={`scene-${scene.id}`}>
      <header className="scene-heading">
        <span className="scene-code">{scene.code}</span>
        <div className="min-w-0 flex-1"><h2 id={`scene-${scene.id}`}>{scene.title || `Cảnh ${scene.code}`}</h2><p>{scene.use_prev_storyboard ? 'Giữ cùng bối cảnh với storyboard cảnh đầu' : 'Tạo storyboard, viết prompt và quản lý video của cảnh'}</p></div>
        <span className={`scene-completion ${scene.videos.selected_id !== null ? 'is-complete' : ''}`}><Icon name={scene.videos.selected_id !== null ? 'check' : 'clock'} size={13} />{scene.videos.selected_id !== null ? 'Đã có video' : 'Đang thực hiện'}</span>
      </header>
      <WorkspaceTabs id={tabsId} label={`Các bước của ${scene.code}`} items={steps} value={step} onChange={setStep} />

      <section id={`${tabsId}-panel-storyboard`} role="tabpanel" aria-labelledby={`${tabsId}-tab-storyboard`} hidden={step !== 'storyboard'} className="scene-step-panel" tabIndex={0}>
        <div className="step-intro"><div><h3>Tạo khung hình mở đầu</h3><p>Dùng tin nhắn và ảnh tham chiếu bên dưới để tạo storyboard trên ChatGPT.</p></div><a href="https://chatgpt.com" target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}><Icon name="link" size={14} />Mở ChatGPT</a></div>
        <div className="scene-step-grid">
          <div className="min-w-0"><TextBlock title="Tin nhắn cho ChatGPT" text={step1.message} copyLabel="Sao chép tin nhắn" hint="Đính kèm ảnh đúng thứ tự rồi dán nguyên văn tin nhắn vào cuộc trò chuyện mới." />{step1.warnings.map((w) => <p key={w} className="scene-warning">{w}</p>)}</div>
          <div className="space-y-5 min-w-0"><div><h4 className="section-label">Ảnh đính kèm <span>Theo thứ tự</span></h4><AttachmentList items={step1.attachments} onZoom={onZoom} emptyText="Cảnh này không cần đính kèm ảnh." /></div><StoryboardUpload planId={planId} scene={scene} maxUploads={maxUploads} onZoom={onZoom} /></div>
        </div>
      </section>

      <section id={`${tabsId}-panel-flow`} role="tabpanel" aria-labelledby={`${tabsId}-tab-flow`} hidden={step !== 'flow'} className="scene-step-panel" tabIndex={0}>
        <div className="step-intro"><div><h3>Tạo video trên Google Flow</h3><p>Sao chép prompt, đính kèm đủ ảnh và kiểm tra cài đặt trước khi tạo.</p></div><a href="https://flow.google.com" target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}><Icon name="link" size={14} />Mở Google Flow</a></div>
        <div className="scene-step-grid">
          <div className="min-w-0"><TextBlock title="Prompt Google Flow" text={step2.prompt} copyLabel="Sao chép prompt" />{step2.warnings.map((w) => <p key={w} className="scene-warning">{w}</p>)}{step2.notes.length > 0 && <details className="flow-instructions"><summary><Icon name="alert" size={14} />Lưu ý trước khi tạo video <Icon name="chevronDown" size={14} /></summary><ul className="list-disc space-y-2 pl-5">{step2.notes.map((n) => <li key={n}>{n}</li>)}</ul></details>}</div>
          <div className="min-w-0 space-y-5"><div className="flow-settings"><h4 className="section-label">Cài đặt video</h4><div className="flex flex-wrap gap-2" aria-label="Cài đặt Flow"><Chip>{s.aspect}</Chip><Chip>{s.duration_s} giây</Chip><Chip>x{s.count}</Chip><Chip>{s.resolution}</Chip><Chip tone="spend">Ước tính {s.estimated_credits} credit</Chip></div></div><div><h4 className="section-label">Ảnh đính kèm <span>Theo thứ tự</span></h4><AttachmentList items={step2.attachments} onZoom={onZoom} emptyText="Không có ảnh để đính kèm." /></div><p className="scene-tip"><Icon name="image" size={16} /><span>Đính kèm ảnh trực tiếp vào ô prompt của Flow. Chỉ tải vào thư viện dự án là chưa đủ.</span></p></div>
        </div>
      </section>

      <div id={`${tabsId}-panel-upload`} role="tabpanel" aria-labelledby={`${tabsId}-tab-upload`} hidden={step !== 'upload'} tabIndex={0} className="scene-video-panel"><VideoStep planId={planId} scene={scene} limits={videoLimits} /></div>
    </article>
  );
}
