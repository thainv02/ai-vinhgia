import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import type { ProjectDetail, Ref } from '../api/types';
import { useAddRefsFromLibrary, useDeleteRef, useRelabelRef, useReorderRefs, useUploadRefs } from '../hooks/mutations';
import { useScenes } from '../hooks/queries';
import { useDragReorder } from '../hooks/useDragReorder';
import { checkImageFiles, defaultLabel, isFileDrag } from '../lib/refFiles';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';
import { LibraryPickerDialog } from './LibraryPickerDialog';
import { ConfirmDialog } from './Modal';

function RefRow({
  r,
  index,
  count,
  usedBy,
  dragProps,
  dragging,
  dropTarget,
  onRelabel,
  onMove,
  onDelete,
}: {
  r: Ref;
  index: number;
  count: number;
  usedBy: string[];
  dragProps: object;
  dragging: boolean;
  dropTarget: boolean;
  onRelabel: (label: string) => void;
  onMove: (to: number) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(r.label);
  useEffect(() => setValue(r.label), [r.label]);
  const commit = () => {
    const v = value.trim();
    if (!v) setValue(r.label);
    else if (v !== r.label) onRelabel(v);
  };
  return (
    <li {...dragProps} className={`flex items-center gap-2 rounded-lg border bg-surface p-2 ${dropTarget ? 'border-fg' : 'border-line'} ${dragging ? 'opacity-50' : ''}`}>
      <span className="cursor-grab text-muted max-sm:hidden" aria-hidden="true">
        <Icon name="grip" size={16} />
      </span>
      <span className="w-5 text-center text-xs font-semibold text-muted">{index + 1}</span>
      <img src={r.url} alt={r.label} className="size-14 shrink-0 rounded-md border border-line object-cover" />
      <div className="min-w-0 flex-1">
        <label className="sr-only" htmlFor={`rm-label-${r.id}`}>
          Nhãn ảnh {index + 1}
        </label>
        <input
          id={`rm-label-${r.id}`}
          className="max-w-md"
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setValue(r.label);
          }}
        />
        <p className="mt-0.5 truncate text-[11px] text-muted" title={usedBy.length ? `Cảnh đang dùng: ${usedBy.join(', ')}` : undefined}>
          {r.original_name} · {usedBy.length ? `dùng ở ${usedBy.join(', ')}` : 'chưa cảnh nào dùng'}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <button type="button" aria-label={`Đưa ảnh ${r.label} lên trên`} disabled={index === 0} onClick={() => onMove(index - 1)} className="rounded p-1.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30">
          <Icon name="chevronDown" size={16} className="rotate-180" />
        </button>
        <button type="button" aria-label={`Đưa ảnh ${r.label} xuống dưới`} disabled={index === count - 1} onClick={() => onMove(index + 1)} className="rounded p-1.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30">
          <Icon name="chevronDown" size={16} />
        </button>
        <button type="button" aria-label={`Xóa ảnh ${r.label}`} onClick={onDelete} className="rounded p-1.5 text-muted hover:bg-danger-bg hover:text-danger-fg">
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  );
}

/** Quản lý ảnh tham chiếu của dự án đã tạo: thêm (tải lên / thư viện), sửa nhãn, đổi thứ tự, xóa. */
export function RefManager({ project }: { project: ProjectDetail }) {
  const refs = project.refs;
  const scenes = useScenes(project.id);
  const upload = useUploadRefs();
  const fromLibrary = useAddRefsFromLibrary({ silent: true });
  const reorder = useReorderRefs();
  const relabel = useRelabelRef();
  const del = useDeleteRef();
  const inputRef = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [fileDrag, setFileDrag] = useState(false);
  const [target, setTarget] = useState<Ref | null>(null);

  const usedBy = (refId: number) => (scenes.data ?? []).filter((s) => s.upload_refs.includes(refId)).map((s) => s.code);

  const addFiles = (files: FileList | File[]) => {
    const { ok, errors } = checkImageFiles(files);
    setProblems(errors);
    if (ok.length === 0) return;
    upload.mutate(
      { projectId: project.id, items: ok.map((f) => ({ file: f, label: defaultLabel(f.name) })) },
      { onSuccess: (created) => toast.success(`Đã tải lên ${created.length} ảnh`) },
    );
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= refs.length || from === to) return;
    const ids = refs.map((r) => r.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    reorder.mutate({ projectId: project.id, ids });
  };
  const { drag, over, bind } = useDragReorder(move, reorder.isPending);

  const target_codes = target ? usedBy(target.id) : [];

  return (
    <div
      className={`space-y-2 rounded-lg ${fileDrag ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface' : ''}`}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setFileDrag(true);
      }}
      onDragLeave={() => setFileDrag(false)}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setFileDrag(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={upload.isPending} icon={<Icon name="upload" size={14} />} onClick={() => inputRef.current?.click()}>
          Tải ảnh lên
        </Button>
        <Button
          size="sm"
          icon={<Icon name="image" size={14} />}
          onClick={() => {
            fromLibrary.reset();
            setLibraryOpen(true);
          }}
        >
          Thêm từ thư viện
        </Button>
        <span className="text-xs text-muted">Kéo thả ảnh vào đây cũng được. Thứ tự ảnh là thứ tự tải lên khi tạo video.</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-[13px] text-danger-fg">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {refs.length === 0 ? (
        <p className="rounded-md bg-surface-2 px-3 py-4 text-center text-[13px] text-muted">
          Dự án chưa có ảnh tham chiếu. Thêm ảnh sản phẩm để AI biết hình dạng sản phẩm khi viết prompt và để worker tải lên khi tạo video.
        </p>
      ) : (
        <ol className="space-y-2" aria-label="Ảnh tham chiếu của dự án">
          {refs.map((r, i) => (
            <RefRow
              key={r.id}
              r={r}
              index={i}
              count={refs.length}
              usedBy={usedBy(r.id)}
              dragProps={bind(i)}
              dragging={drag === i}
              dropTarget={over === i && drag !== null && drag !== i}
              onRelabel={(label) => relabel.mutate({ projectId: project.id, refId: r.id, label })}
              onMove={(to) => move(i, to)}
              onDelete={() => {
                del.reset();
                setTarget(r);
              }}
            />
          ))}
        </ol>
      )}
      {refs.length > 0 && <p className="text-xs text-muted">Ảnh thêm sau khi AI đã phân tích chỉ được cảnh dùng khi cảnh đó gán ảnh (lần phân tích lại).</p>}

      <LibraryPickerDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        projectId={project.id}
        pending={fromLibrary.isPending}
        error={fromLibrary.isError ? errorMessage(fromLibrary.error) : null}
        onConfirm={(chosen) =>
          fromLibrary.mutate(
            { projectId: project.id, refIds: chosen.map((c) => c.ref_id) },
            {
              onSuccess: (added) => {
                toast.success(`Đã thêm ${added.length} ảnh từ thư viện`);
                setLibraryOpen(false);
              },
            },
          )
        }
      />

      <ConfirmDialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={target ? `Xóa ảnh «${target.label}»?` : 'Xóa ảnh?'}
        confirmLabel="Xóa ảnh"
        danger
        pending={del.isPending}
        error={del.isError ? errorMessage(del.error) : null}
        onConfirm={() => target && del.mutate({ projectId: project.id, refId: target.id }, { onSuccess: () => setTarget(null) })}
      >
        {target_codes.length > 0 ? (
          <p>
            Ảnh này đang được <strong>{target_codes.join(', ')}</strong> dùng làm ảnh tải lên khi tạo video. Xóa sẽ gỡ ảnh khỏi {target_codes.length === 1 ? 'cảnh đó' : `${target_codes.length} cảnh đó`} (prompt không đổi). Storyboard và video đã tạo không bị ảnh hưởng.
          </p>
        ) : (
          <p>Chưa có cảnh nào dùng ảnh này.</p>
        )}
        <p className="text-[13px] text-muted">Chỉ xóa bản của dự án này. Ảnh cùng nội dung ở dự án khác và trong thư viện của chúng vẫn còn.</p>
      </ConfirmDialog>
    </div>
  );
}
