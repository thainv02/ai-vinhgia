import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { fmtSeconds } from '../lib/finalCut';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { Badge } from '../components/StatusBadge';
import { fmtMB, ProgressBar, StepHeader } from './parts';
import type { SceneVideo, SceneVideoLimits, ScenePlanView } from './types';

/** Kiểm tra nhanh phía trình duyệt trước khi gửi (server vẫn kiểm tra lại magic bytes, dung lượng, thời lượng bằng ffprobe). */
export function checkVideoFile(file: File, maxBytes: number): string | null {
  const okName = /\.(mp4|mov)$/i.test(file.name) || /^video\/(mp4|quicktime)$/.test(file.type);
  if (!okName) return `"${file.name}" không phải video mp4 hoặc mov.`;
  if (file.size === 0) return `"${file.name}" là file rỗng.`;
  if (file.size > maxBytes) return `"${file.name}" nặng ${fmtMB(file.size)}, vượt giới hạn ${fmtMB(maxBytes)}.`;
  return null;
}

/** Một bản video đã tải lên: trình phát nhỏ 9:16, thông tin và nút chọn bản này. */
function VideoCard({ v, busy, onSelect }: { v: SceneVideo; busy: boolean; onSelect: () => void }) {
  const now = useNow();
  return (
    <li className={`scene-video-card flex min-w-0 flex-col gap-2 rounded-lg border bg-surface p-2 ${v.selected ? 'border-ok-fg ring-1 ring-ok-fg' : 'border-line'}`}>
      <div className="mx-auto w-full max-w-[190px] overflow-hidden rounded-md bg-ink">
        {/* #t=0.5: hiện một khung hình thật thay vì khung đầu (thường đen) khi chưa phát */}
        <video src={`${v.url}#t=0.5`} controls preload="metadata" playsInline aria-label={`Video bản ${v.attempt}: ${v.file_name}`} className="aspect-[9/16] w-full object-contain" />
      </div>
      <div className="min-w-0 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="text-[13px]">Bản {v.attempt}</strong>
          {v.selected && <Badge tone="ok">Đang dùng</Badge>}
        </div>
        <p className="truncate text-muted" title={v.file_name}>
          {v.file_name}
        </p>
        <p className="text-muted">
          {v.duration_s !== null ? fmtSeconds(v.duration_s) : '—'} · {v.width && v.height ? `${v.width}×${v.height}` : '—'} · {fmtMB(v.bytes)}
          {v.has_audio === false ? ' · không có âm thanh' : ''}
        </p>
        <p className="text-muted">Tải lên {fmtRelative(v.uploaded_at, now)}</p>
      </div>
      {!v.selected && (
        <Button size="sm" loading={busy} onClick={onSelect} aria-label={`Chọn bản ${v.attempt} làm video của cảnh`}>
          Dùng bản này
        </Button>
      )}
    </li>
  );
}

/**
 * Bước 3: tải lên video Google Flow đã tạo cho cảnh. Video mới tải lên tự thành video được chọn; có thể chọn lại bản khác.
 * Tải theo luồng (trình duyệt gửi từ đĩa, server ghi thẳng xuống đĩa) với thanh tiến độ và nút hủy.
 */
export function VideoStep({ planId, scene, limits }: { planId: number; scene: ScenePlanView; limits: SceneVideoLimits }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const [up, setUp] = useState<{ name: string; loaded: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const vs = scene.videos;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['plan', planId] });
    void qc.invalidateQueries({ queryKey: ['status'] });
  };
  // rời trang giữa chừng thì hủy lượt tải
  useEffect(() => () => abortRef.current?.(), []);

  const select = useMutation({
    mutationFn: (assetId: number) => planner.selectSceneVideo(planId, scene.id, assetId),
    meta: { silent: true },
    onSuccess: (r) => {
      toast.success(`Đã chọn bản ${r.video.attempt} cho ${scene.code}`);
      refresh();
    },
  });

  const start = (file: File) => {
    const bad = checkVideoFile(file, limits.max_bytes);
    setProblem(bad);
    if (bad) return;
    const { promise, abort } = planner.uploadSceneVideo(planId, scene.id, file, (loaded, total) => setUp({ name: file.name, loaded, total }));
    abortRef.current = abort;
    setUp({ name: file.name, loaded: 0, total: file.size });
    promise
      .then((r) => {
        toast.success(`Đã tải video ${scene.code} (bản ${r.video.attempt}) và chọn làm video của cảnh`);
        refresh();
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.code === 'ABORTED')) setProblem(errorMessage(e));
      })
      .finally(() => {
        abortRef.current = null;
        setUp(null);
      });
  };

  const reason = up ? 'Đang tải lên' : vs.block;
  const pct = up && up.total > 0 ? (up.loaded / up.total) * 100 : 0;
  const verifying = !!up && up.total > 0 && up.loaded >= up.total;

  return (
    <section className="video-step bg-surface p-4" aria-label={`${scene.code}: Bước 3, tải lên video đã tạo`}>
      <StepHeader n={3} title="Tải lên video đã tạo" sub={`Video Google Flow của cảnh ${scene.code}: mp4 hoặc mov, tối đa ${fmtMB(limits.max_bytes)}, dài ${limits.min_s}–${limits.max_s} giây`} />
      <div className="video-upload-layout">
        <div className="space-y-2">
          <div
            onDragOver={(e) => {
              if (!reason) {
                e.preventDefault();
                setDragging(true);
              }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f && !reason) start(f);
            }}
            className={`video-dropzone rounded-md border border-dashed p-3 text-center ${dragging ? 'border-info-fg bg-info-bg' : 'border-line-strong bg-surface-2'}`}
          >
            <Icon name="upload" size={20} className="mx-auto text-muted" />
            <p className="mt-1 text-[13px] font-medium">Kéo video vào đây hoặc</p>
            <div className="mt-1.5">
              <Button variant="primary" size="sm" icon={<Icon name="upload" size={14} />} disabledReason={reason} onClick={() => input.current?.click()}>
                {vs.count > 0 ? 'Tải thêm một bản' : 'Chọn video để tải lên'}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted">{vs.count}/{vs.max} bản đã tải lên cho cảnh này</p>
            {reason && !up && <p className="mt-1 text-xs text-warn-fg">{reason}</p>}
          </div>
          <input
            ref={input}
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.mov"
            hidden
            aria-label={`Chọn video cho ${scene.code}`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) start(f);
            }}
          />
          {up && (
            <div className="space-y-1.5 rounded-md border border-line bg-surface-2 p-2.5" role="status">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium" title={up.name}>
                  {up.name}
                </span>
                <span className="shrink-0 text-muted">{verifying ? 'Đang kiểm tra video…' : `${Math.round(pct)}% · ${fmtMB(up.loaded)}/${fmtMB(up.total)}`}</span>
              </div>
              <ProgressBar value={verifying ? null : pct} label={`Tiến độ tải video ${scene.code}`} />
              <Button size="sm" onClick={() => abortRef.current?.()}>
                Hủy tải lên
              </Button>
            </div>
          )}
          {(problem || select.isError) && <InlineError>{problem ?? errorMessage(select.error)}</InlineError>}
          <p className="text-xs text-muted">Video mới tải lên tự thành video của cảnh để «Edit tự động». Có thể chọn lại bản khác bên cạnh.</p>
        </div>

        <div className="min-w-0">
          {vs.items.length === 0 ? (
            <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">Chưa có video nào cho {scene.code}. Tạo video trên Google Flow rồi tải lên đây.</p>
          ) : (
            <ul className="scene-video-grid">
              {vs.items.map((v) => (
                <VideoCard key={v.id} v={v} busy={select.isPending && select.variables === v.id} onSelect={() => select.mutate(v.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
