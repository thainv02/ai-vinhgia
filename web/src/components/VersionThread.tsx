import type { FinalCut } from '../api/types';
import { aiQueueNote, finalStatusLabel, finalVideoUrl, isWaitingToRender, renderQueueNote } from '../lib/finalCut';
import { fmtDateTime } from '../lib/format';
import { gradeChips, isMatchChip } from '../lib/grade';
import { FINAL_STATUS } from '../lib/status';
import { buttonClass } from './Button';
import { Icon } from './Icon';
import { Badge } from './StatusBadge';

/** Một phiên bản có thuộc chuỗi góp ý / chỉnh màu không (có bản cha), hoặc là bản gốc đã có phiên bản con. */
export const hasRevisions = (list: Pick<FinalCut, 'parent_id'>[]): boolean => list.some((c) => !!c.parent_id);

function Bubble({ who, tone = 'user', children }: { who: string; tone?: 'user' | 'ai'; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg px-3 py-2 text-[13px] ${tone === 'user' ? 'bg-surface-3' : 'border border-line bg-surface-2'}`}>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{who}</p>
      {children}
    </div>
  );
}

/** Nội dung "AI trả lời" của một phiên bản theo trạng thái hiện tại. */
function AiReply({ fc, workerOnline }: { fc: FinalCut; workerOnline?: boolean }) {
  const rev = fc.revision;
  if (fc.status === 'planning') {
    const note = aiQueueNote(fc.ai_queue, workerOnline, fc.parent_id ? 'feedback' : 'cut');
    return (
      <p className={note.warn ? 'text-warn-fg' : 'text-muted'}>
        {note.title}…{note.detail ? <span className="block text-xs">{note.detail}</span> : null}
      </p>
    );
  }
  if (fc.status === 'rendering') {
    const wait = renderQueueNote(fc);
    return (
      <>
        {rev?.summary && <p className="whitespace-pre-wrap">{rev.summary}</p>}
        <p className="text-muted">{wait ? wait.title : `${finalStatusLabel(fc)}${fc.progress !== null ? ` ${Math.round(fc.progress)}%` : ''}`}</p>
      </>
    );
  }
  if (fc.status === 'failed') {
    return (
      <>
        {rev?.summary && <p className="whitespace-pre-wrap">{rev.summary}</p>}
        <p className="text-danger-fg">{fc.error ?? 'Không thành công, không rõ lý do.'}</p>
      </>
    );
  }
  const text = rev?.summary ?? fc.summary;
  return text ? <p className="whitespace-pre-wrap">{text}</p> : <p className="text-muted">Không có tóm tắt.</p>;
}

/**
 * Lịch sử phiên bản dạng chuỗi: mỗi phiên bản hiện góp ý của người dùng (bong bóng) và trả lời của AI (tóm tắt + «AI chưa làm được» màu vàng), các thông số màu
 * khác mặc định dạng chip, nút xem / tải từng bản, và «Góp ý tiếp trên bản này». Dùng chung cho app chính và trang planner LAN.
 */
export function VersionThread({
  list,
  selectedId,
  onSelect,
  onFeedbackOn,
  onRegrade,
  regradePending,
  downloadName,
  workerOnline,
}: {
  list: FinalCut[];
  selectedId: number;
  onSelect: (id: number) => void;
  /** Góp ý tiếp trên bản `id` (chọn bản đó và đưa con trỏ vào ô góp ý); `text` = nội dung gửi lại. */
  onFeedbackOn: (id: number, text?: string) => void;
  onRegrade?: (fc: FinalCut) => void;
  regradePending?: boolean;
  downloadName?: (fc: FinalCut) => string | true;
  workerOnline?: boolean;
}) {
  const asc = [...list].sort((a, b) => a.version - b.version);
  return (
    <ol className="relative space-y-3" aria-label="Lịch sử các phiên bản">
      {asc.map((fc) => {
        const sel = fc.id === selectedId;
        const info = FINAL_STATUS[fc.status];
        const chips = gradeChips(fc);
        const url = fc.status === 'ready' ? finalVideoUrl(fc) : null;
        const manual = fc.revision?.kind === 'manual';
        const label = fc.parent_id ? `Phiên bản v${fc.version} · từ v${fc.parent_version ?? '?'}` : `Phiên bản v${fc.version} · bản dựng gốc`;
        const retryGrade = fc.failed_stage === 'grade' && (fc.status === 'failed' || fc.status === 'cancelled') && !!onRegrade;
        const retryFeedback = fc.status === 'failed' && !!fc.parent_id && !!fc.feedback && fc.failed_stage !== 'grade';
        return (
          <li key={fc.id} className={`rounded-lg border p-3 ${sel ? 'border-fg' : 'border-line'} bg-surface`} aria-current={sel ? 'true' : undefined}>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span aria-hidden="true" className={`size-2 rounded-full ${fc.status === 'ready' ? 'bg-ok-fg' : fc.status === 'failed' ? 'bg-danger-fg' : fc.status === 'cancelled' ? 'bg-neutral-fg' : 'pulse-dot bg-info-fg'}`} />
              <h4 className="text-[13px] font-semibold">{label}</h4>
              <Badge tone={info.tone} live={info.live}>
                {finalStatusLabel(fc)}
                {fc.status === 'rendering' && fc.progress !== null && !isWaitingToRender(fc) ? ` ${Math.round(fc.progress)}%` : ''}
              </Badge>
              <span className="text-xs text-muted">{fmtDateTime(fc.created_at)}</span>
              {sel && <span className="rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-ink-fg">Đang xem</span>}
            </div>

            <div className="space-y-1.5">
              {fc.feedback && (
                <Bubble who="Bạn góp ý">
                  <p className="whitespace-pre-wrap">{fc.feedback}</p>
                </Bubble>
              )}
              {manual && (
                <Bubble who="Bạn chỉnh màu bằng tay">
                  <p>{fc.note || fc.revision?.summary || 'Chỉnh màu'}</p>
                </Bubble>
              )}
              {!manual && (
                <Bubble who={fc.parent_id ? 'AI trả lời' : 'AI chọn điểm cắt'} tone="ai">
                  <AiReply fc={fc} workerOnline={workerOnline} />
                </Bubble>
              )}
              {!!fc.revision?.not_done.length && (
                <div className="rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn-fg" role="note">
                  <p className="flex items-center gap-1 font-semibold">
                    <Icon name="alert" size={13} /> AI chưa làm được
                  </p>
                  <ul className="mt-0.5 list-disc pl-5">
                    {fc.revision.not_done.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {(chips.length > 0 || (fc.parent_id && fc.revision)) && (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Thông số đã đổi">
                {chips.map((c) => (
                  <li key={c} className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-xs font-medium">
                    {isMatchChip(c) && fc.color_ref?.thumb_url ? <img src={fc.color_ref.thumb_url} alt={`Ảnh mẫu ${fc.color_ref.original_name ?? ''}`} title={fc.color_ref.original_name ?? undefined} className="-ml-1 size-5 rounded-full border border-line object-cover" /> : null}
                    {c}
                  </li>
                ))}
                {fc.parent_id && fc.revision && (
                  <li className="rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-xs text-muted">{fc.revision.edl_changed ? 'Đã đổi điểm cắt (render lại)' : 'Giữ nguyên điểm cắt'}</li>
                )}
              </ul>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {!sel && (
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => onSelect(fc.id)}>
                  Xem bản này
                </button>
              )}
              {url && (
                <a href={url} download={downloadName ? downloadName(fc) : true} className={buttonClass('secondary', 'sm')}>
                  <Icon name="download" size={14} /> Tải
                </a>
              )}
              {fc.status === 'ready' && (
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => onFeedbackOn(fc.id)}>
                  <Icon name="comment" size={14} /> Góp ý tiếp trên bản này
                </button>
              )}
              {retryGrade && (
                <button type="button" disabled={regradePending} className={buttonClass('primary', 'sm')} onClick={() => onRegrade!(fc)}>
                  <Icon name="refresh" size={14} /> Thử chỉnh màu lại
                </button>
              )}
              {retryFeedback && (
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => onFeedbackOn(fc.parent_id!, fc.feedback ?? undefined)}>
                  <Icon name="refresh" size={14} /> Gửi lại góp ý
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
