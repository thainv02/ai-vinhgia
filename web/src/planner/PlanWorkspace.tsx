import { useEffect, useRef, useState } from 'react';
import { Button, buttonClass } from '../components/Button';
import { Icon } from '../components/Icon';
import { SceneCard } from './SceneCard';
import { CopyButton, TextBlock } from './parts';
import { planner } from './api';
import type { PlanDetail } from './types';

type Zoom = (src: string, title: string) => void;

export function PlanWorkspace({ detail: d, onZoom, onFinal }: { detail: PlanDetail; onZoom: Zoom; onFinal: () => void }) {
  const [picked, setPicked] = useState(() => (d.scenes.find((s) => s.videos.selected_id === null) ?? d.scenes[0])?.id);
  const index = Math.max(0, d.scenes.findIndex((s) => s.id === picked));
  const current = d.scenes[index];
  const complete = d.scenes.filter((s) => s.videos.selected_id !== null).length;
  const done = complete === d.scenes.length;
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const button = nav?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!nav || !button) return;
    const row = button.getBoundingClientRect(), box = nav.getBoundingClientRect();
    if (row.left < box.left || row.right > box.right) nav.scrollLeft += row.left - box.left - 8;
    if (row.top < box.top || row.bottom > box.bottom) nav.scrollTop += row.top - box.top - 8;
  }, [current?.id]);
  if (!current) return null;

  return <div className="plan-workspace">
    <aside className="scene-sidebar" aria-label="Danh sách cảnh">
      <div className="scene-sidebar-heading"><div><h2>Các cảnh trong video</h2><p>Chọn một cảnh để làm việc</p></div><span className="scene-count">{d.scenes.length}</span></div>
      <nav ref={navRef} aria-label="Chọn cảnh" className="scene-nav">
        {d.scenes.map((s) => {
          const selected = current.id === s.id;
          const video = s.videos.items.find((v) => v.selected);
          return <button type="button" key={s.id} className={`scene-nav-item ${selected ? 'is-selected' : ''}`} aria-pressed={selected} aria-controls={`scene-workspace-${s.id}`} onClick={() => setPicked(s.id)}>
            <span className="scene-nav-thumb" aria-hidden="true">
              {s.storyboard ? <img src={s.storyboard.url} alt="" loading="lazy" /> : video ? <video src={`${video.url}#t=0.5`} muted playsInline preload="metadata" /> : <Icon name="image" size={20} />}
            </span>
            <span className="scene-nav-copy"><span className="scene-nav-code">CẢNH {s.code}</span><strong>{s.title || s.code}</strong><span className={`scene-nav-state ${s.videos.selected_id !== null ? 'is-complete' : ''}`}><span className="state-dot" />{s.videos.selected_id !== null ? 'Đã có video' : s.storyboard ? 'Đã có storyboard' : 'Chưa có storyboard'}</span></span>
            <Icon name="chevronRight" size={14} className="scene-nav-arrow" />
          </button>;
        })}
      </nav>
      <div className="scene-sidebar-footer">
        <div className="flex items-center justify-between text-xs"><strong>Video đã sẵn sàng</strong><span>{complete}/{d.scenes.length}</span></div>
        <div className="scene-progress" role="progressbar" aria-label="Cảnh đã chọn video" aria-valuenow={complete} aria-valuemin={0} aria-valuemax={d.scenes.length}><span style={{ width: `${complete / d.scenes.length * 100}%` }} /></div>
        <p>{done ? 'Đủ video để dựng bản hoàn chỉnh.' : 'Tải video cho từng cảnh để ghép thành một bản hoàn chỉnh.'}</p>
        <Button className="w-full" icon={<Icon name={done ? 'play' : 'film'} size={14} />} onClick={onFinal}>{d.final.latest?.status === 'ready' ? 'Xem bản hoàn chỉnh' : 'Đến bước dựng video'}</Button>
      </div>
    </aside>

    <div className="min-w-0">
      <div className="scene-workspace-toolbar"><p>CHI TIẾT CẢNH <span>{index + 1} / {d.scenes.length}</span></p><div className="flex items-center gap-1"><Button size="sm" variant="ghost" aria-label="Cảnh trước" disabled={index === 0} onClick={() => setPicked(d.scenes[index - 1].id)} icon={<Icon name="chevronLeft" size={17} />} /><Button size="sm" variant="ghost" aria-label="Cảnh tiếp theo" disabled={index === d.scenes.length - 1} onClick={() => setPicked(d.scenes[index + 1].id)} icon={<Icon name="chevronRight" size={17} />} /></div></div>
      {/* Keep panels mounted so changing scenes does not cancel uploads or lose progress. */}
      {d.scenes.map((s) => <div id={`scene-workspace-${s.id}`} key={s.id} hidden={s.id !== current.id}>
        <SceneCard planId={d.plan.id} scene={s} maxUploads={d.limits.max_storyboard_uploads_per_scene} videoLimits={d.limits.scene_video} onZoom={onZoom} />
      </div>)}
    </div>
  </div>;
}

export function ProjectAssets({ detail: d, onZoom }: { detail: PlanDetail; onZoom: Zoom }) {
  return <div className="project-assets">
    <div className="project-document-grid">
      <section className="document-card"><div className="document-heading"><span className="stat-icon"><Icon name="comment" size={19} /></span><div><h2>Yêu cầu kịch bản</h2><p>Ý tưởng và nội dung gốc của dự án</p></div><CopyButton text={d.plan.brief} /></div><p className="brief-text">{d.plan.brief || 'Chưa có yêu cầu kịch bản.'}</p></section>
      <section className="document-card"><div className="document-heading"><span className="stat-icon"><Icon name="link" size={19} /></span><div><h2>Khóa nhất quán</h2><p>Giữ hình ảnh đồng nhất giữa các cảnh</p></div></div>{d.plan.style_lock.trim() ? <TextBlock title="Quy tắc dùng chung" text={d.plan.style_lock} /> : <div className="document-empty"><Icon name="link" size={25} /><p>Chưa có quy tắc nhất quán</p><span>Bạn có thể bổ sung khi sửa yêu cầu kịch bản.</span></div>}</section>
    </div>
    <section className="document-card"><div className="document-heading"><span className="stat-icon"><Icon name="image" size={19} /></span><div><h2>Thư viện tham chiếu <span className="text-muted">({d.refs.length})</span></h2><p>Ảnh gốc dùng để tạo storyboard và video</p></div>{d.refs.length > 0 && <a href={planner.refsZipUrl(d.plan.id)} download className={buttonClass('secondary', 'sm')}><Icon name="download" size={14} />Tải tất cả (.zip)</a>}</div>
      {d.refs.length > 0 ? <ul className="project-ref-grid">{d.refs.map((r, i) => <li key={r.id}>
        <button type="button" onClick={() => onZoom(r.url, r.label)} aria-label={`Xem lớn: ${r.label}`} className="project-ref-image"><img src={r.url} alt={r.label} loading="lazy" /><span>{i + 1}</span><span className="ref-zoom"><Icon name="eye" size={18} /></span></button>
        <div className="flex items-center gap-2 pt-2"><p className="min-w-0 flex-1 truncate text-xs font-medium" title={r.label}>{r.label}</p><a href={r.url} download={r.file_name} aria-label={`Tải ảnh ${i + 1}`} className="ref-download"><Icon name="download" size={15} /></a></div>
      </li>)}</ul> : <p className="document-empty">Dự án chưa có ảnh tham chiếu.</p>}
    </section>
  </div>;
}
