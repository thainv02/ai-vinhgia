import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/errors';
import { Button, buttonClass } from '../components/Button';
import { Icon } from '../components/Icon';
import { Alert, InlineError } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { ProgressBar } from '../planner/parts';
import { toast } from '../lib/toast';
import { clipLimits, useClipEnv } from './env';
import { useClipActions, useClipStatus } from './hooks';
import { clock, fmtBytes, pct100, spokenDuration } from './lib';
import type { SourceVideo } from './types';

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

/** Đọc thời lượng từ metadata của file (nhanh, không tải cả file); null nếu trình duyệt không đọc được định dạng. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (d: number | null) => {
      window.clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(d);
    };
    const timer = window.setTimeout(() => done(null), 5000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

/** Bước 1: tải video dài lên (có thanh %, hủy được, nêu rõ giới hạn). */
export function UploadCard({ projectId, disabledReason, onUploaded }: { projectId: number; disabledReason?: string | null; onUploaded: () => void }) {
  const { api, scope } = useClipEnv();
  const server = useClipStatus().data;
  const fallback = clipLimits(scope);
  const limits = server ? { bytes: server.max_bytes, seconds: server.max_s, label: `${fmtBytes(server.max_bytes)} và ${spokenDuration(server.max_s)}` } : fallback;
  const input = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const [up, setUp] = useState<{ name: string; loaded: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => abortRef.current?.(), []);

  const reason = up ? 'Đang tải lên' : server && !server.stt.configured ? 'Máy chủ chưa cấu hình dịch vụ nhận dạng lời nói, hãy báo chủ máy' : (disabledReason ?? null);

  const start = async (file: File) => {
    const bad = !VIDEO_EXT.test(file.name) && !file.type.startsWith('video/') ? `"${file.name}" không phải file video (mp4, mov, mkv, webm).` : file.size === 0 ? `"${file.name}" là file rỗng.` : file.size > limits.bytes ? `"${file.name}" nặng ${fmtBytes(file.size)}, vượt giới hạn ${fmtBytes(limits.bytes)}.` : null;
    setProblem(bad);
    if (bad) return;
    setUp({ name: file.name, loaded: 0, total: file.size });
    const dur = await probeDuration(file);
    if (dur !== null && dur > limits.seconds) {
      setUp(null);
      setProblem(`Video dài ${spokenDuration(dur)}, vượt giới hạn ${spokenDuration(limits.seconds)}. Hãy cắt bớt hoặc chia nhỏ video trước khi tải lên.`);
      return;
    }
    const { promise, abort } = api.uploadSource(projectId, file, (loaded, total) => setUp({ name: file.name, loaded, total }));
    abortRef.current = abort;
    promise
      .then(() => {
        toast.success('Đã tải lên. Hệ thống đang nhận dạng lời nói.');
        onUploaded();
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.code === 'ABORTED')) setProblem(errorMessage(e));
        onUploaded();
      })
      .finally(() => {
        abortRef.current = null;
        setUp(null);
      });
  };

  const pct = up && up.total > 0 ? (up.loaded / up.total) * 100 : 0;
  const verifying = !!up && up.total > 0 && up.loaded >= up.total;
  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby="clip-upload-h">
      <h2 id="clip-upload-h" className="text-[15px] font-semibold">
        Tải video dài lên
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        mp4, mov, mkv hoặc webm, tối đa <strong className="text-fg">{limits.label}</strong>. Video cần có tiếng nói (livestream, podcast, phỏng vấn, hướng dẫn...).
        {scope === 'lan' ? ` Trên trang này video gốc tự xoá sau ${server?.retention_days ?? 7} ngày; lời thoại, bản xem thử và clip đã dựng được giữ lại.` : ''}
      </p>
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
          if (f && !reason) void start(f);
        }}
        className={`mt-3 rounded-md border border-dashed p-5 text-center ${dragging ? 'border-info-fg bg-info-bg' : 'border-line-strong bg-surface-2'}`}
      >
        <Icon name="upload" size={22} className="mx-auto text-muted" />
        <p className="mt-1 text-[13px] font-medium">Kéo video vào đây hoặc</p>
        <div className="mt-2">
          <Button variant="primary" icon={<Icon name="upload" size={14} />} disabledReason={reason} onClick={() => input.current?.click()}>
            Chọn video
          </Button>
        </div>
        {reason && !up && <p className="mt-2 text-xs text-warn-fg">{reason}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
        hidden
        aria-label="Chọn video dài cần cắt clip"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void start(f);
        }}
      />
      {up && (
        <div className="mt-3 space-y-1.5 rounded-md border border-line bg-surface-2 p-2.5" role="status">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-medium" title={up.name}>
              {up.name}
            </span>
            <span className="shrink-0 text-muted">{verifying ? 'Đang kiểm tra video...' : up.loaded === 0 ? 'Đang chuẩn bị...' : `${Math.round(pct)}% · ${fmtBytes(up.loaded)}/${fmtBytes(up.total)}`}</span>
          </div>
          <ProgressBar value={verifying || up.loaded === 0 ? null : pct} label="Tiến độ tải video lên" />
          <Button size="sm" onClick={() => abortRef.current?.()}>
            Hủy tải lên
          </Button>
        </div>
      )}
      {problem && (
        <div className="mt-3">
          <InlineError>{problem}</InlineError>
        </div>
      )}
    </section>
  );
}

/** Thông tin video nguồn và trạng thái nhận dạng lời nói. */
export function SourceInfo({ projectId, source, hasClips }: { projectId: number; source: SourceVideo; hasClips: boolean }) {
  const { api } = useClipEnv();
  const { transcribe, cancelSource } = useClipActions(projectId);
  const running = source.status === 'transcribing' || source.status === 'uploaded';
  const p = pct100(source.progress);
  const waiting = source.queue?.state === 'waiting';
  const redo = () => transcribe.mutate(source.id);

  return (
    <section aria-label="Video nguồn" className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="min-w-0 max-w-full truncate text-[13px] font-semibold" title={source.original_name}>
          {source.original_name}
        </h2>
        <span className="text-xs text-muted">
          {source.duration_s ? clock(source.duration_s) : ''}
          {source.width && source.height ? ` · ${source.width}×${source.height}` : ''} · {fmtBytes(source.bytes)}
          {source.word_count ? ` · ${source.word_count.toLocaleString('vi-VN')} từ` : ''}
        </span>
      </div>
      {running && (
        <div className="space-y-1.5" role="status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info" live>
              {waiting ? `Chờ nhận dạng${source.queue.position ? ` (vị trí ${source.queue.position})` : ''}` : `Đang nhận dạng lời nói${p !== null ? ` ~${Math.round(p)}%` : ''}`}
            </Badge>
            <Button size="sm" variant="danger" loading={cancelSource.isPending} onClick={() => cancelSource.mutate(source.id)}>
              Hủy
            </Button>
          </div>
          {waiting ? (
            <p className="text-xs text-muted">Dịch vụ nhận dạng xử lý lần lượt từng video. Tới lượt là tự chạy, có thể rời trang.</p>
          ) : (
            <>
              <ProgressBar value={p} label="Tiến độ nhận dạng lời nói (ước tính)" />
              <p className="text-xs text-muted">Đây là ước tính theo thời lượng video (dịch vụ không báo % thật), khoảng 20 giây video mỗi giây xử lý. Có thể rời trang.</p>
            </>
          )}
        </div>
      )}
      {(source.status === 'failed' || source.status === 'cancelled') && (
        <div className="space-y-2">
          {source.status === 'failed' ? <InlineError>{source.error ?? 'Nhận dạng lời nói không thành công.'}</InlineError> : <p className="text-[13px] text-muted">Đã hủy nhận dạng. Video vẫn được giữ.</p>}
          <Button icon={<Icon name="refresh" size={14} />} loading={transcribe.isPending} onClick={() => transcribe.mutate(source.id)}>
            Nhận dạng lại
          </Button>
        </div>
      )}
      {source.status === 'transcribed' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">Đã có lời thoại</Badge>
            {source.speech_ratio !== null && <span className="text-xs text-muted">Lời nói chiếm {Math.round(source.speech_ratio * 100)}% thời lượng</span>}
          </div>
          {source.speech_ratio !== null && source.speech_ratio < 0.3 && (
            <Alert tone="warn">
              <strong>Video ít lời.</strong> Chỉ có khoảng {Math.round(source.speech_ratio * 100)}% là tiếng nói nên AI chọn đoạn theo lời thoại sẽ cho kết quả kém. Chế độ chọn theo hình ảnh chưa có ở phiên bản này.
            </Alert>
          )}
          {source.source_deleted && (
            <Alert tone="info" icon="clock">
              Video gốc đã bị xoá sau thời hạn lưu. Vẫn xem được bản xem thử, lời thoại và các clip đã dựng; không dựng thêm clip mới được.
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <a href={api.transcriptUrl(source.id, 'srt')} download className={buttonClass('secondary', 'sm')}>
              <Icon name="download" size={13} /> Lời thoại .srt
            </a>
            <a href={api.transcriptUrl(source.id, 'txt')} download className={buttonClass('secondary', 'sm')}>
              <Icon name="download" size={13} /> Lời thoại .txt
            </a>
            {!source.source_deleted && !hasClips && (
              <Button size="sm" icon={<Icon name="refresh" size={13} />} onClick={redo} loading={transcribe.isPending} title="Chỉ chạy lại khi đã đổi tên riêng/thuật ngữ trong Cài đặt">
                Nhận dạng lại
              </Button>
            )}
          </div>
          {hasClips && <p className="text-xs text-muted">Đã có clip nên không nhận dạng lại được (điểm cắt gắn với lời thoại hiện tại). Muốn nhận dạng lại, hãy tạo dự án mới.</p>}
        </div>
      )}
    </section>
  );
}
