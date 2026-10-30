import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { fmtSeconds } from '../lib/finalCut';
import { fmtRelative } from '../lib/format';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { fmtMB, ProgressBar } from './parts';
import { Btn } from './ws-ui';
import type { SceneVideo, SceneVideoLimits, ScenePlanView } from './types';

/** Kiểm tra nhanh phía trình duyệt trước khi gửi (server vẫn kiểm tra lại magic bytes, dung lượng, thời lượng bằng ffprobe). */
export function checkVideoFile(file: File, maxBytes: number): string | null {
  const okName = /\.(mp4|mov)$/i.test(file.name) || /^video\/(mp4|quicktime)$/.test(file.type);
  if (!okName) return `"${file.name}" không phải video mp4 hoặc mov.`;
  if (file.size === 0) return `"${file.name}" là file rỗng.`;
  if (file.size > maxBytes) return `"${file.name}" nặng ${fmtMB(file.size)}, vượt giới hạn ${fmtMB(maxBytes)}.`;
  return null;
}

/** Một bản video đã tải lên: trình phát nhỏ 9:16, thông tin và nút chọn lại. */
function VideoCard({ v, busy, onSelect }: { v: SceneVideo; busy: boolean; onSelect: () => void }) {
  const now = useNow();
  return (
    <li className={`ws-vid ${v.selected ? 'sel' : ''}`}>
      {/* #t=0.5: hiện một khung hình thật thay vì khung đầu (thường đen) khi chưa phát */}
      <video src={`${v.url}#t=0.5`} controls preload="metadata" playsInline aria-label={`Video bản ${v.attempt}: ${v.file_name}`} />
      <div className="ws-vid-meta">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong>Bản {v.attempt}</strong>
          {v.selected && <span className="av-badge av-badge-ok">Đang dùng</span>}
        </div>
        <p title={v.file_name}>{v.file_name}</p>
        <p>
          {v.duration_s !== null ? fmtSeconds(v.duration_s) : '—'} · {v.width && v.height ? `${v.width}×${v.height}` : '—'} · {fmtMB(v.bytes)}
          {v.has_audio === false ? ' · không có âm thanh' : ''}
        </p>
        <p>Tải lên {fmtRelative(v.uploaded_at, now)}</p>
      </div>
      {!v.selected && (
        <Btn size="sm" loading={busy} onClick={onSelect} aria-label={`Chọn bản ${v.attempt} làm video của cảnh`}>
          Chọn lại bản này
        </Btn>
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
    <section className="av-card ws-card now" aria-label={`${scene.code}: Bước 3, tải lên video đã tạo`}>
      <div className="ws-card-head">
        <h3>Bước 3 · Tải video đã tạo lên</h3>
        <span className="av-muted" style={{ fontSize: 12 }}>{vs.count}/{vs.max} bản</span>
      </div>
      <div className="ws-upload">
        <div className="ws-col">
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
            className={`av-drop ${dragging ? 'over' : ''}`}
          >
            <Icon name="upload" size={22} className="av-muted" />
            <span className="ws-drop-title">Kéo video từ thư mục Tải xuống vào đây</span>
            <span className="av-muted" style={{ fontSize: 12 }}>mp4 hoặc mov, {limits.min_s}–{limits.max_s} giây, tối đa {fmtMB(limits.max_bytes)}</span>
            <Btn size="sm" icon="upload" disabledReason={reason} onClick={() => input.current?.click()}>
              {vs.count > 0 ? 'Chọn thêm một bản…' : 'Chọn file…'}
            </Btn>
            {reason && !up && <span style={{ fontSize: 12, color: 'var(--warn-fg)' }}>{reason}</span>}
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
            <div className="ws-progress" role="status">
              <div className="ws-progress-row">
                <span title={up.name}>{up.name}</span>
                <span className="av-muted">{verifying ? 'Đang kiểm tra video…' : `${Math.round(pct)}% · ${fmtMB(up.loaded)}/${fmtMB(up.total)}`}</span>
              </div>
              <ProgressBar value={verifying ? null : pct} label={`Tiến độ tải video ${scene.code}`} />
              <Btn size="sm" onClick={() => abortRef.current?.()}>Hủy tải lên</Btn>
            </div>
          )}
          {(problem || select.isError) && <InlineError>{problem ?? errorMessage(select.error)}</InlineError>}
        </div>

        <div className="min-w-0">
          {vs.items.length > 0 && (
            <ul className="ws-vids">
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
