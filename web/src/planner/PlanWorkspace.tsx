import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { SceneCard } from './SceneCard';
import { Btn, CopyBtn, CodeBlock, LinkBtn } from './ws-ui';
import { planner } from './api';
import type { PlanDetail } from './types';
import './workspace.css';

type Zoom = (src: string, title: string) => void;

// Cảnh đang chọn của từng kế hoạch: giữ khi chuyển tab hoặc rời rồi quay lại trong phiên.
const pickedByPlan = new Map<number, number>();

export function PlanWorkspace({ detail: d, onZoom, onFinal }: { detail: PlanDetail; onZoom: Zoom; onFinal: () => void }) {
  const planId = d.plan.id;
  const [picked, setPickedState] = useState<number | undefined>(() => {
    const saved = pickedByPlan.get(planId);
    if (saved !== undefined && d.scenes.some((s) => s.id === saved)) return saved;
    return (d.scenes.find((s) => s.videos.selected_id === null) ?? d.scenes[0])?.id;
  });
  const setPicked = (id: number) => {
    pickedByPlan.set(planId, id);
    setPickedState(id);
  };
  const index = Math.max(0, d.scenes.findIndex((s) => s.id === picked));
  const current = d.scenes[index];
  const complete = d.scenes.filter((s) => s.videos.selected_id !== null).length;
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    const item = rail?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!rail || !item) return;
    const row = item.getBoundingClientRect(), box = rail.getBoundingClientRect();
    if (row.top < box.top || row.bottom > box.bottom) rail.scrollTop += row.top - box.top - 8;
  }, [current?.id]);
  if (!current) return null;
  const prev = d.scenes[index - 1], next = d.scenes[index + 1];

  return (
    <div className="ws-scenes">
      <nav ref={railRef} className="ws-rail" aria-label="Danh sách cảnh">
        <span className="ws-rail-label">CÁC CẢNH</span>
        {d.scenes.map((s) => {
          const selected = current.id === s.id;
          const video = s.videos.items.find((v) => v.selected);
          const hasVideo = s.videos.selected_id !== null;
          return (
            <button type="button" key={s.id} className={`av-list-item ${selected ? 'on' : ''}`} aria-current={selected} aria-controls={`scene-workspace-${s.id}`} onClick={() => setPicked(s.id)}>
              <span className="ws-thumb" aria-hidden="true">
                {s.storyboard ? <img src={s.storyboard.url} alt="" loading="lazy" /> : video ? <video src={`${video.url}#t=0.5`} muted playsInline preload="metadata" /> : s.code}
              </span>
              <span className="ws-scene-copy">
                <strong title={s.title}>{s.code} · {s.title || `Cảnh ${s.code}`}</strong>
                <span className="ws-pips">
                  <span className="ws-pip"><i className={s.storyboard ? (s.storyboard.stale ? 'now' : 'ok') : ''} />Khung hình</span>
                  <span className="ws-pip"><i className={hasVideo ? 'ok' : s.storyboard ? 'now' : ''} />Video</span>
                </span>
              </span>
            </button>
          );
        })}
        <div className="ws-rail-foot">
          <Btn size="sm" variant={complete === d.scenes.length ? 'primary' : undefined} icon={complete === d.scenes.length ? 'play' : 'film'} onClick={onFinal}>
            {d.final.latest?.status === 'ready' ? 'Xem bản hoàn chỉnh' : `Bản hoàn chỉnh (${complete}/${d.scenes.length})`}
          </Btn>
        </div>
      </nav>

      <section className="ws-detail" aria-label="Chi tiết cảnh">
        <div className="ws-detail-head">
          <h2>{current.code} · {current.title || `Cảnh ${current.code}`}</h2>
          <Btn size="sm" aria-label="Cảnh trước" disabled={!prev} onClick={() => prev && setPicked(prev.id)}>‹ {prev?.code ?? ''}</Btn>
          <Btn size="sm" aria-label="Cảnh sau" disabled={!next} onClick={() => next && setPicked(next.id)}>{next?.code ?? ''} ›</Btn>
        </div>
        {/* Giữ mọi cảnh được gắn sẵn để đổi cảnh không hủy lượt tải lên hay mất tiến độ. */}
        {d.scenes.map((s) => (
          <div id={`scene-workspace-${s.id}`} key={s.id} hidden={s.id !== current.id}>
            <SceneCard planId={planId} scene={s} maxUploads={d.limits.max_storyboard_uploads_per_scene} videoLimits={d.limits.scene_video} onZoom={onZoom} />
          </div>
        ))}
      </section>
    </div>
  );
}

/** Tab "Ảnh tham chiếu": lưới ảnh gốc, bấm để xem lớn. */
export function RefsTab({ detail: d, onZoom }: { detail: PlanDetail; onZoom: Zoom }) {
  return (
    <div className="ws-pad">
      {d.refs.length === 0 ? (
        <p className="av-muted" style={{ margin: 0 }}>Dự án chưa có ảnh tham chiếu.</p>
      ) : (
        <>
          <div><LinkBtn href={planner.refsZipUrl(d.plan.id)} download icon="download">Tải tất cả (.zip)</LinkBtn></div>
          <ul className="ws-refs">
            {d.refs.map((r, i) => (
              <li key={r.id} className="ws-ref">
                <button type="button" onClick={() => onZoom(r.url, r.label)} aria-label={`Xem lớn: ${r.label}`}>
                  <img src={r.url} alt={r.label} loading="lazy" />
                  <span>{i + 1}</span>
                </button>
                <div className="ws-ref-foot">
                  <p title={r.label}>{r.label}</p>
                  <a href={r.url} download={r.file_name} aria-label={`Tải ảnh ${i + 1}`}><Icon name="download" size={15} /></a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Tab "Yêu cầu": yêu cầu kịch bản và khóa nhất quán nguyên văn. */
export function BriefTab({ detail: d }: { detail: PlanDetail }) {
  return (
    <div className="ws-pad" style={{ maxWidth: 920 }}>
      <section className="av-card ws-brief">
        <div className="ws-card-head"><h3>Yêu cầu kịch bản</h3><CopyBtn text={d.plan.brief} /></div>
        <p className="ws-brief-text">{d.plan.brief || 'Chưa có yêu cầu kịch bản.'}</p>
      </section>
      {d.plan.style_lock.trim() && (
        <section className="av-card ws-brief">
          <div className="ws-card-head"><h3>Khóa nhất quán</h3><CopyBtn text={d.plan.style_lock} /></div>
          <CodeBlock text={d.plan.style_lock} label="Khóa nhất quán" />
        </section>
      )}
    </div>
  );
}
