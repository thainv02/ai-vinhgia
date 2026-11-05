import { useState, type ReactNode } from 'react';
import { Button, buttonClass } from '../components/Button';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { ProgressBar } from '../planner/parts';
import { CAPTION_PRESETS, CONTENT_TYPE_LABEL, REFRAME_OPTIONS, clipParts, clock, cutIsActive, cutQueueTitle, isVerticalSource, jobIsActive, pct100, spanLabel, spokenDuration } from './lib';
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
  const score = clip.score !== null ? `${Math.round(clip.score)}/100 · ` : '';
  const detail = `Điểm lựa chọn: ${clip.score ?? 'chưa chấm'}/100. Kiểm định độc lập: ${v.standalone_score?.toFixed(2) ?? 'chưa chấm'}. ${v.diagnosis ? DIAGNOSIS[v.diagnosis] ?? v.diagnosis : ''}`;
  if (v.status === 'kept') return <Badge tone="ok" title={detail}>{score}Đạt</Badge>;
  if (v.status === 'repaired') return <Badge tone="info" title={detail}>{score}Đã chỉnh điểm cắt</Badge>;
  return <Badge tone="warn" title={detail}>{score}Chưa kiểm định</Badge>;
}

function CutBlock({ cut, clip, fileBase, onCancel, cancelling }: { cut: ClipCut; clip: Clip; fileBase: string; onCancel: () => void; cancelling: boolean }) {
  const [preview, setPreview] = useState(false);
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
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><Badge tone="ok">v{cut.version} sẵn sàng</Badge><span className="text-xs text-muted">{spokenDuration(cut.duration_s ?? 0)}{reframe ? ` · ${reframe}` : ''}{caps ? ` · ${caps}` : ''}</span></div>
    <div className="flex flex-wrap gap-2">
      {cut.video_url && <a href={cut.video_url} download={`${fileBase}_${clip.code}_v${cut.version}.mp4`} className={buttonClass('primary', 'sm')}><Icon name="download" size={14} />Tải mp4</a>}
      {cut.srt_url && <a href={cut.srt_url} download={`${fileBase}_${clip.code}_v${cut.version}.srt`} className={buttonClass('secondary', 'sm')}>Tải srt</a>}
    </div>
    {cut.video_url && <details onToggle={(e) => setPreview(e.currentTarget.open)} className="text-xs text-muted"><summary className="cursor-pointer">Xem bản dựng v{cut.version}</summary>{preview && <video src={cut.video_url} controls preload="metadata" playsInline aria-label={`Clip ${clip.code} bản dựng v${cut.version}`} className="mt-2 max-h-80 w-full rounded-md bg-black object-contain" />}</details>}
  </div>;
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
  timeline: ReactNode;
  onApproveRender: (opts: { reframe_mode?: ReframeMode; captions_preset: CaptionPreset }) => void;

  onCancel: (cutId: number) => void;
}

/** Thẻ một clip: thông tin AI, xem thử đoạn, duyệt/bỏ, sửa điểm cắt, dựng 9:16, tải về, sửa phụ đề. */
export function ClipCard({ clip, source, fileBase, selected, renderBlock, captionsStale, captionsAvailable, busy, onSelect, onPreview, onSetStatus, onEditRange, onEditCaptions, timeline, onApproveRender, onCancel }: Props) {
  const st = STATUS[clip.status];
  const cut = clip.latest_cut;
  const vertical = isVerticalSource(source);
  const [reframe, setReframe] = useState<ReframeMode>((cut?.reframe?.mode as ReframeMode | undefined) ?? 'fit');
  const noCaps = captionsAvailable?.ok === false;
  const [captionsPick, setCaptions] = useState<CaptionPreset>((cut?.captions?.preset as CaptionPreset | undefined) ?? 'highlight');
  const captions: CaptionPreset = noCaps ? 'none' : captionsPick;
  const [open, setOpen] = useState(false);
  const [cleanupSeen, setCleanupSeen] = useState(false);
  const rejected = clip.status === 'rejected';
  const active = cutIsActive(cut);
  const parts = clipParts(clip);
  const multi = parts.length > 1;

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
            {!clip.verify && clip.score !== null && <Badge tone="neutral" title="Điểm lựa chọn AI (0–100)">{Math.round(clip.score)}/100</Badge>}
            {multi && <Badge tone="violet" title="Clip nối nhiều đoạn của video dài, phát theo thứ tự bên dưới"><Icon name="link" size={11} />Ghép {parts.length} đoạn</Badge>}
          </div>
          <h3 className="mt-1 text-[15px] font-semibold leading-snug">{clip.title || `Clip ${clip.code}`}</h3>
          {clip.hook && <p className="mt-0.5 text-[13px] italic text-fg/80">“{clip.hook}”</p>}
          {multi && (
            <ol className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted" aria-label={`Các đoạn của ${clip.code} theo thứ tự phát`}>
              {parts.map((p, k) => (
                <li key={k} className="whitespace-nowrap">
                  <span className="font-semibold text-fg/80">Đoạn {k + 1}</span> · <span className="font-mono tabular-nums">{spanLabel(p.start_s, p.end_s)}</span>
                </li>
              ))}
            </ol>
          )}
          {(!multi || clip.content_type || clip.caption_edited) && (
            <p className="mt-1 text-xs text-muted">
              {[
                multi ? null : `${clock(clip.start_s)} → ${clock(clip.end_s)}`,
                clip.content_type ? CONTENT_TYPE_LABEL[clip.content_type] ?? clip.content_type : null,
                clip.caption_edited ? 'đã sửa phụ đề' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>
      {(clip.reason || clip.transcript_excerpt) && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Lý do chọn & lời thoại</summary>{clip.reason && <p className="mt-2 leading-relaxed">{clip.reason}</p>}{clip.transcript_excerpt && <p className="mt-2 rounded-md bg-surface-2 p-2 leading-relaxed">{clip.transcript_excerpt}</p>}</details>}
      <details className="group/cleanup mt-2.5 rounded-lg border border-line bg-surface-2 text-xs open:bg-surface-2" aria-label={`Làm gọn ${clip.code}`} onToggle={(e) => { if (e.currentTarget.open) setCleanupSeen(true); }}>
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-3 [&::-webkit-details-marker]:hidden">
          <Icon name="scissors" size={13} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            Làm gọn lời nói: {clip.cleanup?.selected_ids.length ? <>bỏ <strong className="font-semibold">{clip.cleanup.selected_ids.length} chỗ</strong> · −{Math.max(0, clip.duration_s - (clip.edited_duration_s ?? clip.duration_s)).toFixed(2).replace('.', ',')} s</> : 'không có chỗ cần bỏ'}
          </span>
          <span className="font-semibold">Xem / sửa</span>
          <Icon name="chevronDown" size={13} className="transition-transform group-open/cleanup:rotate-180" />
        </summary>
        {cleanupSeen && <div className="p-1.5 pt-0">{timeline}</div>}
      </details>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Icon name="play" size={12} />} onClick={onPreview} disabledReason={source?.video_url ? null : 'Không còn video nguồn để xem'} aria-label={`Xem clip ${clip.code}`}><span className="max-[420px]:sr-only">Xem</span></Button>
        {!rejected && <Button size="sm" icon={<Icon name="scissors" size={13} />} onClick={onEditRange}>Sửa điểm cắt</Button>}
        {rejected ? <Button size="sm" loading={busy.status} onClick={() => onSetStatus('proposed')}>Khôi phục clip</Button> : <Button size="sm" variant={cut?.status === 'ready' && !captionsStale ? 'secondary' : 'primary'} icon={<Icon name="film" size={14} />} loading={busy.status || busy.render} disabledReason={renderBlock ?? (active ? 'Clip này đang được dựng' : null)} onClick={() => onApproveRender({ reframe_mode: vertical ? undefined : reframe, captions_preset: captions })}>{clip.status !== 'approved' ? 'Duyệt & dựng' : cut ? 'Dựng lại' : 'Dựng clip'}</Button>}
        <details className="relative ml-auto" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}>
          <summary className={`${buttonClass('ghost', 'sm')} list-none cursor-pointer [&::-webkit-details-marker]:hidden`} aria-label={`Thao tác khác cho clip ${clip.code}`}><span className="max-[480px]:hidden">Thêm</span> <Icon name="chevronDown" size={13} /></summary>
          <div className="absolute right-0 top-full z-30 mt-1 grid w-52 gap-1 rounded-lg border border-line bg-surface p-1.5 shadow-lg" onClick={(e) => { if ((e.target as HTMLElement).closest('button')) e.currentTarget.parentElement!.removeAttribute('open'); }}>
            {rejected && <Button size="sm" variant="ghost" className="justify-start" onClick={onEditRange}>Sửa điểm cắt</Button>}
            <Button size="sm" variant="ghost" className="justify-start" onClick={onEditCaptions}>Sửa phụ đề</Button>
            {!rejected && <Button size="sm" variant="ghost" className="justify-start" onClick={() => setOpen((o) => !o)}>{open ? 'Ẩn tùy chọn dựng' : 'Tùy chọn dựng'}</Button>}
            {!rejected && <Button size="sm" variant="ghost" className="justify-start" loading={busy.status} onClick={() => onSetStatus(clip.status === 'approved' ? 'proposed' : 'approved')}>{clip.status === 'approved' ? 'Bỏ duyệt' : 'Chỉ duyệt, chưa dựng'}</Button>}
            {!rejected && <><hr className="my-0.5 border-line" /><Button size="sm" variant="ghost" className="justify-start text-danger-fg hover:bg-danger-bg" loading={busy.status} onClick={() => onSetStatus('rejected')}>Bỏ clip</Button></>}
          </div>
        </details>
      </div>
      {jobIsActive(clip.cleanup_job) && <p className="mt-2 text-xs text-info-fg" role="status">AI đang chờ / phân tích làm gọn lời nói…</p>}
      {!rejected && (cut || open) && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          {cut && (cut.status !== 'ready' || !captionsStale) && <CutBlock cut={cut} clip={clip} fileBase={fileBase} onCancel={() => onCancel(cut.id)} cancelling={!!busy.cancel} />}
          {captionsStale && cut?.status === 'ready' && (
            <p className="rounded-md bg-warn-bg px-2.5 py-1.5 text-xs text-warn-fg" role="status">
              Nội dung hoặc phụ đề vừa đổi nhưng bản dựng này chưa có thay đổi đó. Bấm «Dựng lại» để áp dụng.
            </p>
          )}
          {open && !active && (
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
          {renderBlock && <p className="text-xs text-warn-fg">{renderBlock}</p>}
        </div>
      )}
    </article>
  );
}
