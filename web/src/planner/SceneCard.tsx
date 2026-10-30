import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { fmtRelative } from '../lib/format';
import { checkImageFiles } from '../lib/refFiles';
import { toast } from '../lib/toast';
import { useNow } from '../lib/useNow';
import { planner } from './api';
import { VideoStep } from './VideoStep';
import { Btn, CodeBlock, CopyBtn, LinkBtn } from './ws-ui';
import type { Attachment, ScenePlanView, SceneVideoLimits } from './types';
import './workspace.css';

type Zoom = (src: string, title: string) => void;

/** Ảnh đính kèm theo thứ tự: mỗi ảnh một chip (số thứ tự, tên, cách prompt gọi ảnh, nút tải). */
function AttachmentChips({ items, onZoom, emptyText }: { items: Attachment[]; onZoom: Zoom; emptyText: string }) {
  if (items.length === 0) return <p className="av-muted" style={{ margin: 0, fontSize: 12.5 }}>{emptyText}</p>;
  return (
    <ol className="ws-chips" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {items.map((a) => (
        <li key={`${a.order}-${a.kind}`} className="ws-chip-wrap">
          <span className="ws-chip">
            {a.available && a.url ? (
              <button type="button" className="sq" onClick={() => onZoom(a.url!, a.label)} aria-label={`Xem lớn: ${a.label}`}>
                <img src={a.url} alt="" loading="lazy" />
              </button>
            ) : (
              <span className="sq">{a.order}</span>
            )}
            <span style={{ fontWeight: 700 }}>{a.order}</span>
            <span className="truncate" style={{ maxWidth: 220 }} title={a.file_name ?? a.label}>
              {a.prompt_label ? `${a.prompt_label} · ` : ''}
              {a.label}
            </span>
            {!a.prompt_label && a.kind !== 'ref' && <small>không đánh số trong prompt</small>}
            {a.available && a.url && (
              <a href={a.url} download={a.file_name ?? undefined} aria-label={`Tải ảnh: ${a.label}`} title="Tải ảnh">
                <Icon name="download" size={14} />
              </a>
            )}
          </span>
          {a.note && <span className="ws-chip-note">{a.note}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Tải lên ảnh storyboard: input ẩn dùng chung cho thẻ bước 1 (mở rộng và thu gọn). */
function useStoryboardUpload(planId: number, scene: ScenePlanView, maxUploads: number) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
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
  const error = problem ?? (m.isError ? errorMessage(m.error) : null);
  const element = (
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
  );
  return { pick: () => input.current?.click(), pending: m.isPending, reason, error, element };
}

export function SceneCard({ planId, scene, maxUploads, videoLimits, onZoom }: { planId: number; scene: ScenePlanView; maxUploads: number; videoLimits: SceneVideoLimits; onZoom: Zoom }) {
  const { step1, step2 } = scene;
  const s = step2.settings;
  const sb = scene.storyboard;
  const now = useNow();
  const upload = useStoryboardUpload(planId, scene, maxUploads);
  const hasVideo = scene.videos.selected_id !== null;
  const selVideo = scene.videos.items.find((v) => v.selected);
  const sbDone = !!sb && !sb.stale;
  const [focus, setFocus] = useState<1 | 2 | 3>(() => (hasVideo ? 3 : sb ? 2 : 1));
  // bước 3 luôn mở cạnh bước 2 để kéo thả video ngay
  const open3 = focus === 3 || focus === 2;

  const steps: { n: 1 | 2 | 3; label: string; done: boolean }[] = [
    { n: 1, label: 'Khung hình mở đầu', done: sbDone },
    { n: 2, label: 'Video trên Google Flow', done: hasVideo },
    { n: 3, label: 'Tải video lên', done: hasVideo },
  ];

  const storyboardButton = (
    <Btn size="sm" variant={sb ? undefined : 'primary'} icon="upload" loading={upload.pending} disabledReason={upload.reason} onClick={upload.pick}>
      {sb ? 'Đổi ảnh' : 'Chọn ảnh storyboard…'}
    </Btn>
  );

  return (
    <article className="ws-scene-panel" aria-label={`Cảnh ${scene.code}`}>
      {upload.element}
      <div className="ws-steps" role="group" aria-label={`Các bước của ${scene.code}`}>
        {steps.map((st, i) => (
          <span key={st.n} style={{ display: 'contents' }}>
            {i > 0 && <span className="ws-stp-line" aria-hidden="true" />}
            <button type="button" className={`ws-stp ${st.done ? 'done' : focus === st.n ? 'now' : 'later'}`} aria-current={focus === st.n ? 'step' : undefined} onClick={() => setFocus(st.n)}>
              <b>{st.done ? <Icon name="check" size={13} /> : st.n}</b>
              {st.label}
            </button>
          </span>
        ))}
      </div>

      {/* Bước 1 */}
      {focus === 1 ? (
        <section className="av-card ws-card now" aria-label="Bước 1: khung hình mở đầu">
          <div className="ws-card-head">
            <h3>Bước 1 · Tạo khung hình mở đầu trên ChatGPT</h3>
            <LinkBtn href="https://chatgpt.com" target="_blank" rel="noreferrer" icon="link">Mở ChatGPT</LinkBtn>
            <CopyBtn text={step1.message} label="Sao chép tin nhắn" primary />
          </div>
          <CodeBlock text={step1.message} label="Tin nhắn cho ChatGPT" />
          {step1.warnings.map((w) => <p key={w} className="ws-warn">{w}</p>)}
          {step1.attachments.length > 0 && (
            <div className="ws-col">
              <span className="ws-sub">Đính kèm theo đúng thứ tự</span>
              <AttachmentChips items={step1.attachments} onZoom={onZoom} emptyText="" />
            </div>
          )}
          <div className="ws-sbup">
            {sb && (
              <button type="button" onClick={() => onZoom(sb.url, `Storyboard ${scene.code}`)} aria-label={`Xem lớn storyboard ${scene.code}`} style={{ padding: 0, border: 0, background: 'none', cursor: 'zoom-in' }}>
                <img src={sb.url} alt={`Storyboard ${scene.code} đã tải lên`} />
              </button>
            )}
            <div className="ws-col" style={{ gap: 4 }}>
              {sb && <span style={{ fontSize: 12.5 }}>{sb.file_name} · tải lên {fmtRelative(sb.uploaded_at, now)}</span>}
              {sb?.stale && <span className="ws-warn">Prompt cảnh đã đổi sau khi bạn tải ảnh này, hãy kiểm tra lại.</span>}
              <div>{storyboardButton}</div>
              {upload.reason && <span className="av-muted" style={{ fontSize: 12 }}>{upload.reason}</span>}
            </div>
          </div>
          {upload.error && <InlineError>{upload.error}</InlineError>}
        </section>
      ) : (
        <div className="av-card ws-done">
          {sb ? (
            <button type="button" className="ws-thumb lg btn" onClick={() => onZoom(sb.url, `Storyboard ${scene.code}`)} aria-label={`Xem lớn storyboard ${scene.code}`}>
              <img src={sb.url} alt="" />
            </button>
          ) : (
            <span className="ws-thumb lg" aria-hidden="true"><Icon name="image" size={18} /></span>
          )}
          <div className="ws-done-copy">
            <strong>{sb ? 'Bước 1 xong: đã có khung hình mở đầu' : 'Bước 1: chưa có khung hình mở đầu'}</strong>
            <span title={sb?.file_name}>{sb ? `${sb.file_name} · tải lên ${fmtRelative(sb.uploaded_at, now)}` : 'Tạo ảnh trên ChatGPT rồi tải lên đây'}</span>
            {sb?.stale && <span className="warn">Prompt cảnh đã đổi sau khi tải ảnh, hãy kiểm tra lại.</span>}
            {upload.error && <span className="warn">{upload.error}</span>}
          </div>
          <Btn size="sm" onClick={() => setFocus(1)}>Xem tin nhắn ChatGPT</Btn>
          {storyboardButton}
        </div>
      )}

      {/* Bước 2 */}
      {focus === 2 ? (
        <section className="av-card ws-card now" aria-label="Bước 2: video trên Google Flow">
          <div className="ws-card-head">
            <h3>Bước 2 · Tạo video trên Google Flow</h3>
            <LinkBtn href="https://flow.google.com" target="_blank" rel="noreferrer" icon="link">Mở Google Flow</LinkBtn>
            <CopyBtn text={step2.prompt} label="Sao chép prompt" primary />
          </div>
          <CodeBlock text={step2.prompt} label="Prompt Google Flow" />
          {step2.warnings.map((w) => <p key={w} className="ws-warn">{w}</p>)}
          {step2.attachments.length > 0 && (
            <div className="ws-col">
              <span className="ws-sub">Đính kèm theo đúng thứ tự</span>
              <AttachmentChips items={step2.attachments} onZoom={onZoom} emptyText="" />
            </div>
          )}
          <div className="ws-flowrow" aria-label="Cài đặt Flow">
            <span className="ws-sub" style={{ marginRight: 4 }}>Cài đặt Flow</span>
            <span className="av-badge av-badge-neutral">{s.aspect}</span>
            <span className="av-badge av-badge-neutral">{s.duration_s} giây</span>
            <span className="av-badge av-badge-neutral">x{s.count}</span>
            <span className="av-badge av-badge-neutral">{s.resolution}</span>
            <span className="av-badge av-badge-neutral">khoảng {s.estimated_credits} credit</span>
          </div>
          <div className="ws-note warn">
            {step2.notes.length > 1 ? (
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>{step2.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            ) : (
              <span>{step2.notes[0] ?? 'Đính kèm ảnh trực tiếp vào ô prompt của Flow; chỉ tải vào thư viện dự án là chưa đủ.'}</span>
            )}
          </div>
        </section>
      ) : (
        <div className="av-card ws-done">
          <div className="ws-done-copy">
            <strong>{hasVideo ? 'Bước 2 xong: đã tạo video trên Flow' : 'Bước 2: video trên Google Flow'}</strong>
            <span>Prompt Flow · {s.duration_s} giây · {s.resolution} · {s.aspect}</span>
          </div>
          <Btn size="sm" onClick={() => setFocus(2)}>Xem prompt Flow</Btn>
        </div>
      )}

      {/* Bước 3: luôn gắn sẵn để lượt tải lên không bị hủy khi đổi bước */}
      <div hidden={!open3}>
        <VideoStep planId={planId} scene={scene} limits={videoLimits} />
      </div>
      {!open3 && (
        <div className="av-card ws-done">
          <div className="ws-done-copy">
            <strong>{selVideo ? `Bước 3 xong: đang dùng video bản ${selVideo.attempt}` : 'Bước 3: chưa có video'}</strong>
            <span>{selVideo ? `${selVideo.file_name} · ${scene.videos.count}/${scene.videos.max} bản` : 'Tải video từ Flow lên đây'}</span>
          </div>
          <Btn size="sm" onClick={() => setFocus(3)}>{selVideo ? 'Chọn lại video' : 'Tải video lên'}</Btn>
        </div>
      )}
    </article>
  );
}
