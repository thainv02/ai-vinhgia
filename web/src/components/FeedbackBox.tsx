import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import type { FinalCut } from '../api/types';
import { appendSuggestion, FEEDBACK_MAX_CHARS, FEEDBACK_SUGGESTIONS } from '../lib/grade';
import type { RevisionApi } from '../lib/revisionApi';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';
import { InlineError } from './States';

/**
 * Khối "Góp ý cho AI" dưới video của bản `ready`: người dùng viết góp ý (vd "màu ấm hơn, tương phản cao hơn", "giữ đoạn cắt kéo ở C1"), AI tạo PHIÊN BẢN MỚI,
 * bản đang xem được giữ nguyên. `intent` (mỗi lần đổi `nonce`): đưa con trỏ vào ô nhập, và đặt sẵn nội dung nếu có `text` (gửi lại góp ý bị lỗi).
 */
export function FeedbackBox({
  fc,
  api,
  blockReason,
  onCreated,
  intent,
}: {
  fc: FinalCut;
  api: RevisionApi;
  /** Lý do chưa gửi được (null = được): đang có bản khác chạy, còn logo, hết hạn mức, hàng đợi đầy... */
  blockReason: string | null;
  onCreated: (created: FinalCut) => void;
  intent?: { nonce: number; text?: string };
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);
  const send = useMutation({
    mutationFn: (t: string) => api.feedback(fc.id, t),
    meta: { silent: true },
    onSuccess: (created) => {
      setText('');
      toast.success(`Đã gửi góp ý, AI đang tạo bản v${created.version}`);
      onCreated(created);
    },
  });
  useEffect(() => {
    if (!intent?.nonce) return;
    if (intent.text !== undefined) setText(intent.text);
    box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ref.current?.focus({ preventScroll: true });
  }, [intent?.nonce, intent?.text]);

  const trimmed = text.trim();
  const reason = blockReason ?? (trimmed ? null : 'Nhập góp ý trước');
  const submit = () => {
    if (!reason && !send.isPending) send.mutate(trimmed);
  };
  return (
    <section ref={box} className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby={`fb-h-${fc.id}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Icon name="comment" size={15} className="text-muted" />
        <h3 id={`fb-h-${fc.id}`} className="text-[15px] font-semibold">
          Góp ý cho AI
        </h3>
        <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold text-muted">trên bản v{fc.version}</span>
      </div>
      <p className="mb-2 text-[13px] text-muted">Nói điều bạn muốn đổi, ví dụ «màu ấm hơn, tương phản cao hơn» hoặc «giữ đoạn cắt kéo ở C1». AI tạo phiên bản mới, bản hiện tại được giữ.</p>
      <label htmlFor={`fb-text-${fc.id}`} className="sr-only">
        Góp ý cho AI
      </label>
      <textarea
        id={`fb-text-${fc.id}`}
        ref={ref}
        rows={3}
        maxLength={FEEDBACK_MAX_CHARS}
        value={text}
        disabled={send.isPending}
        placeholder="Ví dụ: màu ấm hơn một chút, cảnh 3 tối quá, bỏ bớt đoạn cuối của C2…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="min-h-[84px] text-[14px]"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Gợi ý nhanh">
          {FEEDBACK_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={send.isPending}
              onClick={() => {
                setText((t) => appendSuggestion(t, s));
                ref.current?.focus({ preventScroll: true });
              }}
              className="inline-flex min-h-8 items-center rounded-full border border-line-strong bg-surface px-2.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              + {s}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted" aria-live="polite">
          {text.length}/{FEEDBACK_MAX_CHARS}
        </span>
      </div>
      {send.isError && (
        <div className="mt-2">
          <InlineError>{errorMessage(send.error)}</InlineError>
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button variant="primary" icon={<Icon name="send" size={14} />} loading={send.isPending} disabledReason={reason} onClick={submit}>
          Gửi góp ý cho AI
        </Button>
        <span className="text-xs text-muted">Chỉ đổi màu thì xong sau vài giây, không tốn credit Flow.</span>
      </div>
      {blockReason && (
        <p className="mt-1.5 flex items-start gap-1 text-xs text-warn-fg">
          <Icon name="alert" size={13} className="mt-px shrink-0" />
          <span>{blockReason}</span>
        </p>
      )}
    </section>
  );
}
