import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VideoGenerator } from '../api/types';
import { errorMessage } from '../api/errors';
import { Button, Spinner } from '../components/Button';
import { effectiveGenerator, generatorBlockReason } from '../components/GeneratorPicker';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { fmtRelative } from '../lib/format';
import type { Tone } from '../lib/status';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import type { AutoScene } from './types';

/** Nhãn trạng thái cảnh theo cách người dùng Autovideo làm (không dùng từ "duyệt" của app chính). */
const STATUS: Record<string, { label: string; tone: Tone; live?: boolean }> = {
  awaiting_approval: { label: 'Chưa có storyboard', tone: 'neutral' },
  storyboard_queued: { label: 'Chờ tạo storyboard', tone: 'info', live: true },
  storyboard_running: { label: 'Đang tạo storyboard', tone: 'info', live: true },
  storyboard_review: { label: 'Đã có storyboard', tone: 'violet' },
  video_queued: { label: 'Chờ tạo video', tone: 'info', live: true },
  video_running: { label: 'Đang tạo video', tone: 'info', live: true },
  video_review: { label: 'Chọn video', tone: 'warn' },
  done: { label: 'Đã chọn video', tone: 'ok' },
  failed: { label: 'Lỗi', tone: 'danger' },
};

const LOGO: Record<string, string> = { removed: 'đã xoá logo', none: 'không có logo', failed: 'còn logo', skipped: 'còn logo' };

type Zoom = (src: string, title: string) => void;

/**
 * Một cảnh của dự án Autovideo: storyboard (tạo / tạo lại), prompt (xem, sửa), video (tạo bằng dịch vụ đang chọn, xem các lượt, chọn bản dùng
 * cho bản hoàn chỉnh), việc đang chờ/chạy (hủy được khi còn chờ) và lỗi gần nhất.
 */
export function AutoSceneCard({ projectId, scene: s, generators, generator, onZoom }: { projectId: number; scene: AutoScene; generators: VideoGenerator[]; generator: string; onZoom: Zoom }) {
  const qc = useQueryClient();
  const now = useNow();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['auto', projectId] });
    void qc.invalidateQueries({ queryKey: ['status'] });
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.prompt);
  const [shownId, setShownId] = useState<number | null>(null);

  const gen = effectiveGenerator(generators, generator, s.image_count);
  const genBlock = gen ? generatorBlockReason(gen, s.image_count) : 'Chưa tải được danh sách dịch vụ';

  const storyboard = useMutation({
    mutationFn: () => planner.autoStoryboard(projectId, s.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`${s.code}: đã gửi tạo storyboard`);
      refresh();
    },
  });
  const video = useMutation({
    mutationFn: () => planner.autoVideo(projectId, s.id, gen!.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`${s.code}: đã gửi tạo video bằng ${gen!.label}`);
      refresh();
    },
  });
  const select = useMutation({
    mutationFn: (assetId: number) => planner.autoSelect(projectId, s.id, assetId),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`${s.code}: đã chọn video`);
      setShownId(null);
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => planner.autoCancel(projectId, s.id),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`${s.code}: đã hủy việc đang chờ`);
      refresh();
    },
  });
  const savePrompt = useMutation({
    mutationFn: () => planner.autoPrompt(projectId, s.id, draft.trim()),
    meta: { silent: true },
    onSuccess: () => {
      toast.success(`${s.code}: đã lưu prompt`);
      setEditing(false);
      refresh();
    },
  });
  const err = [storyboard, video, select, cancel].find((m) => m.isError)?.error;

  const st = STATUS[s.status] ?? { label: s.status_label, tone: 'neutral' as Tone };
  const job = s.job;
  const busy = storyboard.isPending || video.isPending || cancel.isPending;
  const shown = s.videos.find((v) => v.id === shownId) ?? s.videos.find((v) => v.selected) ?? s.videos[s.videos.length - 1];
  const attemptsLeft = s.max_attempts - s.attempts_used;
  const videoReason = busy ? 'Đang gửi' : (s.blocks.video ?? genBlock);

  return (
    <article className="rounded-xl border border-line bg-surface" aria-labelledby={`auto-scene-${s.id}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h3 id={`auto-scene-${s.id}`} className="text-[15px] font-semibold">
          {s.code} <span className="font-normal text-muted">· {s.title}</span>
        </h3>
        <Badge tone={st.tone} live={st.live}>
          {st.label}
        </Badge>
        {job && (
          <span className="flex items-center gap-2 text-xs text-muted">
            {job.state === 'running' && <Spinner size={12} />}
            {job.state === 'queued'
              ? `${job.type === 'video' ? 'Video' : 'Storyboard'} đang xếp hàng${job.position ? ` (vị trí ${job.position})` : ''} · ${job.generator}`
              : `Đang tạo ${job.type === 'video' ? 'video' : 'storyboard'} bằng ${job.generator} · bắt đầu ${fmtRelative(job.started_at, now)}${job.type === 'video' ? ' · thường 2–4 phút' : ' · thường 1–2 phút'}`}
            {job.can_cancel && (
              <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Hủy
              </Button>
            )}
          </span>
        )}
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[180px_minmax(0,1fr)_260px]">
        {/* storyboard */}
        <section aria-label={`${s.code}: storyboard`} className="max-w-[240px] space-y-2 lg:max-w-none">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Storyboard</h4>
          {s.storyboard ? (
            <button type="button" onClick={() => onZoom(s.storyboard!.url, `${s.code} · storyboard lượt ${s.storyboard!.attempt}`)} className="block w-full overflow-hidden rounded-md border border-line bg-surface-2" aria-label={`Xem lớn storyboard ${s.code}`}>
              <img src={s.storyboard.url} alt={`Storyboard ${s.code}`} loading="lazy" className="aspect-[9/16] w-full object-cover" />
            </button>
          ) : (
            <div className="grid aspect-[9/16] place-items-center rounded-md border border-dashed border-line bg-surface-2 text-muted">
              {job?.type === 'storyboard' ? <Spinner size={18} /> : <Icon name="image" size={22} />}
            </div>
          )}
          {s.storyboard && (
            <p className="text-xs text-muted">
              Lượt {s.storyboard.attempt}
              {s.storyboard.logo && ` · ${LOGO[s.storyboard.logo] ?? s.storyboard.logo}`}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            icon={<Icon name={s.storyboard ? 'refresh' : 'image'} size={14} />}
            loading={storyboard.isPending}
            disabledReason={busy ? 'Đang gửi' : s.blocks.storyboard}
            onClick={() => storyboard.mutate()}
          >
            {s.storyboard ? 'Tạo lại storyboard' : 'Tạo storyboard'}
          </Button>
        </section>

        {/* prompt */}
        <section aria-label={`${s.code}: prompt`} className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Prompt</h4>
            {!editing && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                icon={<Icon name="edit" size={13} />}
                disabledReason={s.blocks.prompt}
                onClick={() => {
                  setDraft(s.prompt);
                  setEditing(true);
                }}
              >
                Sửa
              </Button>
            )}
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={savePrompt.isPending} aria-label={`Prompt ${s.code}`} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" loading={savePrompt.isPending} disabledReason={!draft.trim() ? 'Prompt không được rỗng' : draft.trim() === s.prompt ? 'Chưa sửa gì' : null} onClick={() => savePrompt.mutate()}>
                  Lưu prompt
                </Button>
                <Button size="sm" variant="ghost" disabled={savePrompt.isPending} onClick={() => setEditing(false)}>
                  Hủy
                </Button>
                <span className="text-xs text-muted">Lưu xong bấm tạo lại storyboard hoặc video để dùng prompt mới.</span>
              </div>
              {savePrompt.isError && <InlineError>{errorMessage(savePrompt.error)}</InlineError>}
            </div>
          ) : (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-sans text-[13px] leading-relaxed">{s.prompt || 'Chưa có prompt.'}</pre>
          )}
          {(s.refs.length > 0 || s.use_prev_storyboard) && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Gửi kèm:</span>
              {s.refs.map((r) => (
                <button key={r.id} type="button" onClick={() => onZoom(r.url, r.label)} title={r.label} className="size-9 overflow-hidden rounded border border-line">
                  <img src={r.url} alt={r.label} loading="lazy" className="size-full object-cover" />
                </button>
              ))}
              <span>+ storyboard{s.use_prev_storyboard ? ' (storyboard tạo theo cảnh đầu)' : ''}</span>
            </div>
          )}
        </section>

        {/* video */}
        <section aria-label={`${s.code}: video`} className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Video</h4>
          {shown ? (
            <video key={shown.id} src={shown.url} controls preload="metadata" playsInline className="aspect-[9/16] max-h-[420px] w-full rounded-md bg-black object-contain" />
          ) : (
            <div className="grid aspect-[9/16] max-h-[420px] place-items-center rounded-md border border-dashed border-line bg-surface-2 text-muted">
              {job?.type === 'video' ? <Spinner size={18} /> : <Icon name="film" size={22} />}
            </div>
          )}
          {s.videos.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Các lượt video của ${s.code}`}>
              {s.videos.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setShownId(v.id)}
                  aria-pressed={v.id === shown?.id}
                  title={v.generator ?? undefined}
                  className={`rounded-md border px-2 py-0.5 text-xs ${v.id === shown?.id ? 'border-fg bg-surface-2 font-semibold' : 'border-line text-muted hover:text-fg'}`}
                >
                  Lượt {v.attempt}
                  {v.selected && ' ✓'}
                </button>
              ))}
            </div>
          )}
          {shown && (
            <p className="text-xs text-muted">
              {shown.generator ?? 'Video'}
              {shown.duration_s ? ` · ${shown.duration_s.toFixed(1).replace('.', ',')} giây` : ''}
              {shown.grid_url && (
                <>
                  {' · '}
                  <button type="button" className="underline hover:text-fg" onClick={() => onZoom(shown.grid_url!, `${s.code} · khung hình lượt ${shown.attempt}`)}>
                    xem khung hình
                  </button>
                </>
              )}
            </p>
          )}
          {shown && !shown.selected && (
            <Button size="sm" variant="primary" className="w-full" icon={<Icon name="check" size={14} />} loading={select.isPending} disabledReason={s.blocks.select} onClick={() => select.mutate(shown.id)}>
              Dùng video lượt {shown.attempt}
            </Button>
          )}
          <Button
            size="sm"
            className="w-full"
            icon={<Icon name={s.videos.length ? 'refresh' : 'film'} size={14} />}
            loading={video.isPending}
            disabledReason={videoReason}
            onClick={() => video.mutate()}
          >
            {s.videos.length ? 'Tạo lại video' : 'Tạo video'}
          </Button>
          <p className="text-xs text-muted">
            {gen ? `${gen.label}${gen.flow_credits ? ` · ${gen.flow_credits} credit` : ''}` : ''} · còn {Math.max(0, attemptsLeft)}/{s.max_attempts} lượt
          </p>
        </section>
      </div>

      {(s.error || err) && (
        <div className="border-t border-line px-4 py-3">
          <InlineError>{err ? errorMessage(err) : s.error}</InlineError>
        </div>
      )}
    </article>
  );
}
