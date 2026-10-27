import { useState } from 'react';
import { Button, buttonClass } from '../components/Button';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { ProgressBar } from '../planner/parts';
import { CAPTION_PRESETS, CONTENT_TYPE_LABEL, REFRAME_OPTIONS, clock, cutIsActive, cutQueueTitle, isVerticalSource, pct100, spokenDuration } from './lib';
import { Segmented } from './Segmented';
import type { CaptionPreset, Clip, ClipCut, ReframeMode, SourceVideo } from './types';

const STATUS: Record<Clip['status'], { label: string; tone: 'info' | 'ok' | 'neutral' }> = {
  proposed: { label: 'Đề xuất', tone: 'info' },
  approved: { label: 'Đã duyệt', tone: 'ok' },
  rejected: { label: 'Đã bỏ', tone: 'neutral' },
};

const DIAGNOSIS: Record<string, string> = {
  bad_start: 'đầu clip chưa ổn',
  bad_end: 'cuối clip chưa ổn',
  missing_premise: 'thiếu phần dẫn',
  missing_payoff: 'thiếu phần kết ý',
  not_fixable: 'khó cứu',
  visual_bad: 'hình ảnh không hợp',
};

function VerifyBadge({ clip }: { clip: Clip }) {
  const v = clip.verify;
  if (!v) return clip.created_by === 'user' ? <Badge tone="violet">Tự tạo</Badge> : null;
  const score = v.standalone_score !== null && v.standalone_score !== undefined ? ` (${v.standalone_score.toFixed(2).replace('.', ',')})` : '';
  if (v.status === 'kept') return <Badge tone="ok" title="AI đã xem cả lời thoại lẫn hình ảnh và thấy clip hiểu được khi đứng một mình">AI kiểm định: đạt{score}</Badge>;
  if (v.status === 'repaired') return <Badge tone="info" title="AI đã nhích điểm đầu/cuối để clip trọn ý hơn">AI đã chỉnh điểm cắt{score}</Badge>;
  return (
    <Badge tone="warn" title="Bước kiểm định bị lỗi hoặc chưa chạy: hãy tự xem clip trước khi dùng">
      Chưa kiểm định{v.diagnosis && DIAGNOSIS[v.diagnosis] ? `: ${DIAGNOSIS[v.diagnosis]}` : ''}
    </Badge>
  );
}

function CutBlock({ cut, clip, fileBase, onCancel, cancelling }: { cut: ClipCut; clip: Clip; fileBase: string; onCancel: () => void; cancelling: boolean }) {
  const reframe = REFRAME_OPTIONS.find((o) => o.value === cut.reframe?.mode)?.label;
  const caps = CAPTION_PRESETS.find((o) => o.value === cut.captions?.preset)?.label;
  if (cut.status === 'rendering') {
    const waiting = cut.queue_state === 'waiting';
    const p = pct100(cut.progress);
    return (
      <div className="space-y-1.5 rounded-md border border-line bg-surface-2 p-2.5" role="status">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info" live>
            v{cut.version}: {waiting ? 'Chờ dựng' : `${cut.stage === 'prepare' ? 'Đang chuẩn bị' : 'Đang dựng'}${p !== null && cut.stage !== 'prepare' ? ` ${Math.round(p)}%` : ''}`}
          </Badge>
          <Button size="sm" variant="danger" loading={cancelling} onClick={onCancel}>
            Hủy
          </Button>
        </div>
        {waiting ? (
          <p className="text-[13px] text-muted">
            <Icon name="clock" size={13} className="mr-1 inline" />
            {cutQueueTitle(cut)}.
            <span className="block text-xs">Có chỗ trống là tự bắt đầu, không cần làm gì thêm. Có thể rời trang, việc vẫn xếp hàng.</span>
          </p>
        ) : (
          <ProgressBar value={p} label={`Tiến độ dựng clip ${clip.code}`} />
        )}
      </div>
    );
  }
  if (cut.status === 'failed') {
    return (
      <div className="space-y-1.5">
        <Badge tone="danger">v{cut.version}: dựng lỗi</Badge>
        <InlineError>{cut.error ?? 'Dựng clip không thành công.'}</InlineError>
      </div>
    );
  }
  if (cut.status === 'cancelled') return <p className="text-[13px] text-muted">v{cut.version} đã hủy.{cut.error ? ` ${cut.error}` : ''}</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-[200px] overflow-hidden rounded-md bg-black sm:mx-0 sm:w-[170px]">
        {cut.video_url ? (
          <video src={`${cut.video_url}#t=0.1`} controls preload="metadata" playsInline aria-label={`Clip ${clip.code} bản dựng v${cut.version}`} className="aspect-[9/16] w-full object-contain" />
        ) : (
          <div className="grid aspect-[9/16] place-items-center text-xs text-white/70">Không còn file</div>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok">v{cut.version} sẵn sàng</Badge>
          <span className="text-xs text-muted">
            {cut.duration_s ? spokenDuration(cut.duration_s) : ''}
            {reframe ? ` · ${reframe}` : ''}
            {caps ? ` · ${caps}` : ''}
            {clip.cuts_count > 1 ? ` · ${clip.cuts_count} bản dựng` : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {cut.video_url && (
            <a href={cut.video_url} download={`${fileBase}_${clip.code}_v${cut.version}.mp4`} className={buttonClass('primary', 'md')}>
              <Icon name="download" /> Tải mp4
            </a>
          )}
          {cut.srt_url && (
            <a href={cut.srt_url} download={`${fileBase}_${clip.code}_v${cut.version}.srt`} className={buttonClass('secondary', 'md')}>
              <Icon name="download" /> Tải srt
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

interface Props {
  clip: Clip;
  source: SourceVideo | null;
  fileBase: string;
  selected: boolean;
  /** Lý do chưa dựng được (video gốc đã xoá, hết lượt, ...). */
  renderBlock: string | null;
  captionsStale: boolean;
  /** Máy chủ có dựng được phụ đề không (thiếu font/libass thì chỉ chọn «Không phụ đề»). */
  captionsAvailable?: { ok: boolean; reason: string | null };
  busy: { status?: boolean; render?: boolean; cancel?: boolean };
  onSelect: () => void;
  onPreview: () => void;
  onSetStatus: (s: Clip['status']) => void;
  onEditRange: () => void;
  onEditCaptions: () => void;
  onRender: (opts: { reframe_mode?: ReframeMode; captions_preset: CaptionPreset }) => void;
  onCancel: (cutId: number) => void;
}

/** Thẻ một clip: thông tin AI, xem thử đoạn, duyệt/bỏ, sửa điểm cắt, dựng 9:16, tải về, sửa phụ đề. */
export function ClipCard({ clip, source, fileBase, selected, renderBlock, captionsStale, captionsAvailable, busy, onSelect, onPreview, onSetStatus, onEditRange, onEditCaptions, onRender, onCancel }: Props) {
  const st = STATUS[clip.status];
  const cut = clip.latest_cut;
  const vertical = isVerticalSource(source);
  const [reframe, setReframe] = useState<ReframeMode>((cut?.reframe?.mode as ReframeMode | undefined) ?? 'fit');
  const noCaps = captionsAvailable?.ok === false;
  const [captionsPick, setCaptions] = useState<CaptionPreset>((cut?.captions?.preset as CaptionPreset | undefined) ?? 'highlight');
  const captions: CaptionPreset = noCaps ? 'none' : captionsPick;
  const [open, setOpen] = useState(clip.status === 'approved' && !cut);
  const rejected = clip.status === 'rejected';
  const active = cutIsActive(cut);

  return (
    <article
      aria-label={`Clip ${clip.code}`}
      className={`rounded-lg border bg-surface p-3 transition-colors ${selected ? 'border-info-fg ring-1 ring-info-fg' : 'border-line'} ${rejected ? 'opacity-70' : ''}`}
    >
      <div className="flex gap-3">
        <button type="button" onClick={onSelect} aria-label={`Chọn clip ${clip.code} để xem vùng trong lời thoại`} className="relative aspect-video w-28 shrink-0 self-start overflow-hidden rounded-md bg-surface-3 sm:w-36">
          {clip.thumb_url ? <img src={clip.thumb_url} alt="" loading="lazy" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-muted"><Icon name="film" size={20} /></span>}
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 text-[11px] font-bold leading-[18px] text-white">{clip.code}</span>
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 font-mono text-[11px] leading-[18px] text-white">{spokenDuration(clip.duration_s)}</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
            <VerifyBadge clip={clip} />
            {clip.score !== null && (
              <span className="text-xs font-semibold text-muted" title="Điểm AI chấm (0-100)">
                Điểm {Math.round(clip.score)}
              </span>
            )}
          </div>
          <h3 className="mt-1 text-[15px] font-semibold leading-snug">{clip.title || `Clip ${clip.code}`}</h3>
          {clip.hook && <p className="mt-0.5 text-[13px] italic text-fg/80">“{clip.hook}”</p>}
          <p className="mt-1 text-xs text-muted">
            {clock(clip.start_s)} → {clock(clip.end_s)}
            {clip.content_type ? ` · ${CONTENT_TYPE_LABEL[clip.content_type] ?? clip.content_type}` : ''}
            {clip.caption_edited ? ' · đã sửa phụ đề' : ''}
          </p>
        </div>
      </div>
      {clip.reason && <p className="mt-2 text-[13px] text-muted">{clip.reason}</p>}
      {clip.transcript_excerpt && (
        <details className="mt-1.5 text-[13px]">
          <summary className="text-xs font-medium text-muted">Lời thoại đầu clip</summary>
          <p className="mt-1 rounded-md bg-surface-2 p-2 leading-relaxed">{clip.transcript_excerpt}</p>
        </details>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Icon name="play" size={13} />} onClick={onPreview} disabledReason={source?.video_url ? null : 'Không còn video nguồn để xem'}>
          Xem đoạn
        </Button>
        {clip.status !== 'approved' && (
          <Button size="sm" variant="primary" icon={<Icon name="check" size={14} />} loading={busy.status} onClick={() => onSetStatus('approved')}>
            Duyệt
          </Button>
        )}
        {clip.status === 'approved' && (
          <Button size="sm" loading={busy.status} onClick={() => onSetStatus('proposed')}>
            Bỏ duyệt
          </Button>
        )}
        {!rejected ? (
          <Button size="sm" variant="danger" icon={<Icon name="x" size={14} />} loading={busy.status} onClick={() => onSetStatus('rejected')}>
            Bỏ
          </Button>
        ) : (
          <Button size="sm" loading={busy.status} onClick={() => onSetStatus('proposed')}>
            Khôi phục
          </Button>
        )}
        <Button size="sm" icon={<Icon name="edit" size={13} />} onClick={onEditRange}>
          Sửa điểm cắt
        </Button>
        {!rejected && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} icon={<Icon name="chevronDown" size={14} className={open ? 'rotate-180' : ''} />}>
            Dựng 9:16
          </Button>
        )}
      </div>

      {!rejected && (cut || open || clip.status === 'approved') && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          {cut && <CutBlock cut={cut} clip={clip} fileBase={fileBase} onCancel={() => onCancel(cut.id)} cancelling={!!busy.cancel} />}
          {captionsStale && cut?.status === 'ready' && (
            <p className="rounded-md bg-warn-bg px-2.5 py-1.5 text-xs text-warn-fg" role="status">
              Phụ đề vừa đổi nhưng bản dựng này chưa có thay đổi đó. Bấm «Dựng lại» để áp dụng.
            </p>
          )}
          {(open || !cut || cut.status !== 'ready') && !active && (
            <div className="space-y-3">
              {vertical ? (
                <p className="text-xs text-muted">Video nguồn đã là khung dọc nên giữ nguyên khung hình, không cần chọn Nền mờ hay Cắt giữa.</p>
              ) : (
                <Segmented label="Khung hình 9:16" value={reframe} options={REFRAME_OPTIONS} onChange={setReframe} />
              )}
              <Segmented label="Kiểu phụ đề" value={captions} options={noCaps ? CAPTION_PRESETS.filter((o) => o.value === 'none') : CAPTION_PRESETS} onChange={setCaptions}>
                {noCaps ? (captionsAvailable?.reason ?? 'Máy chủ chưa hỗ trợ phụ đề.') : undefined}
              </Segmented>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={cut?.status === 'ready' ? 'secondary' : 'primary'}
              icon={<Icon name={cut ? 'refresh' : 'film'} size={14} />}
              loading={busy.render}
              disabledReason={renderBlock ?? (active ? 'Clip này đang được dựng' : null)}
              onClick={() => onRender({ reframe_mode: vertical ? undefined : reframe, captions_preset: captions })}
            >
              {cut ? 'Dựng lại' : 'Dựng clip'}
            </Button>
            <Button icon={<Icon name="comment" size={14} />} onClick={onEditCaptions}>
              Sửa phụ đề
            </Button>
            {cut?.status === 'ready' && !open && (
              <button type="button" onClick={() => setOpen(true)} className="text-xs text-muted underline hover:text-fg">
                Đổi khung hình / kiểu phụ đề
              </button>
            )}
          </div>
          {renderBlock && <p className="text-xs text-warn-fg">{renderBlock}</p>}
        </div>
      )}
    </article>
  );
}
