import { useEffect, useRef, useState } from 'react';
import type { LibraryRef } from '../api/types';
import { useDragReorder } from '../hooks/useDragReorder';
import { checkImageFiles, defaultLabel, isFileDrag } from '../lib/refFiles';
import { Button } from './Button';
import { Icon } from './Icon';
import { LibraryPickerDialog } from './LibraryPickerDialog';

interface ItemBase {
  key: string;
  url: string;
  label: string;
}
/** Ảnh vừa chọn từ máy, sẽ được tải lên khi tạo dự án. */
export interface UploadItem extends ItemBase {
  kind: 'upload';
  file: File;
}
/** Ảnh chọn từ thư viện, sẽ được chép vào dự án khi tạo dự án. */
export interface LibraryItem extends ItemBase {
  kind: 'library';
  refId: number;
  projects: string[];
}
export type RefItem = UploadItem | LibraryItem;

let seq = 0;

/**
 * Chọn ảnh tham chiếu cho dự án mới: kéo thả hoặc chọn từ máy, hoặc "Chọn từ thư viện" (ảnh của các dự án trước).
 * Mọi ảnh nằm chung một danh sách: đổi nhãn, kéo đổi thứ tự (hoặc nút lên/xuống), xóa.
 */
export function RefUploader({ items, onChange, disabled }: { items: RefItem[]; onChange: (items: RefItem[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Thu hồi URL xem trước khi rời trang.
  useEffect(
    () => () =>
      itemsRef.current.forEach((i) => {
        if (i.kind === 'upload') URL.revokeObjectURL(i.url);
      }),
    [],
  );

  const addFiles = (files: FileList | File[]) => {
    const { ok, errors } = checkImageFiles(files);
    setProblems(errors);
    if (ok.length) {
      const next: UploadItem[] = ok.map((f) => ({ key: `u${++seq}`, kind: 'upload', file: f, url: URL.createObjectURL(f), label: defaultLabel(f.name) }));
      onChange([...items, ...next]);
    }
  };

  const addLibrary = (refs: LibraryRef[]) => {
    const next: LibraryItem[] = refs.map((r) => ({
      key: `l${++seq}`,
      kind: 'library',
      refId: r.ref_id,
      url: r.url,
      label: r.label,
      projects: r.projects.map((p) => p.name),
    }));
    onChange([...items, ...next]);
    setLibraryOpen(false);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const copy = [...items];
    const [it] = copy.splice(from, 1);
    copy.splice(to, 0, it!);
    onChange(copy);
  };
  const { drag, over, bind } = useDragReorder(move, disabled);

  const remove = (key: string) => {
    const it = items.find((i) => i.key === key);
    if (it?.kind === 'upload') URL.revokeObjectURL(it.url);
    onChange(items.filter((i) => i.key !== key));
  };

  return (
    <div
      onDragOver={(e) => {
        if (disabled || !isFileDrag(e)) return;
        e.preventDefault();
        setFileDrag(true);
      }}
      onDragLeave={() => setFileDrag(false)}
      onDrop={(e) => {
        if (disabled || !isFileDrag(e)) return;
        e.preventDefault();
        setFileDrag(false);
        addFiles(e.dataTransfer.files);
      }}
      className="space-y-2"
    >
      <div className={`rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors ${fileDrag ? 'border-fg bg-surface-3' : 'border-line-strong bg-surface-2'}`}>
        <Icon name="upload" size={20} className="mx-auto text-muted" />
        <p className="mt-1 text-sm font-medium">Kéo thả ảnh vào đây, hoặc chọn từ máy / thư viện</p>
        <p className="text-xs text-muted">png, jpg, webp, tối đa 10MB mỗi ảnh. Thứ tự ảnh là thứ tự tải lên khi tạo video.</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button disabled={disabled} icon={<Icon name="upload" size={14} />} onClick={() => inputRef.current?.click()}>
            Tải ảnh từ máy
          </Button>
          <Button disabled={disabled} icon={<Icon name="image" size={14} />} onClick={() => setLibraryOpen(true)}>
            Chọn từ thư viện
          </Button>
        </div>
      </div>
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
      {problems.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-[13px] text-danger-fg">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ol className="space-y-2">
          {items.map((it, i) => (
            <li
              key={it.key}
              {...bind(i)}
              className={`flex items-center gap-2 rounded-lg border bg-surface p-2 ${over === i && drag !== null && drag !== i ? 'border-fg' : 'border-line'} ${drag === i ? 'opacity-50' : ''}`}
            >
              <span className="cursor-grab text-muted max-sm:hidden" aria-hidden="true">
                <Icon name="grip" size={16} />
              </span>
              <span className="w-5 text-center text-xs font-semibold text-muted">{i + 1}</span>
              <img src={it.url} alt="" className="size-14 shrink-0 rounded-md border border-line object-cover" />
              <div className="min-w-0 flex-1">
                <label className="sr-only" htmlFor={`ref-label-${it.key}`}>
                  Nhãn ảnh {i + 1}
                </label>
                <input
                  id={`ref-label-${it.key}`}
                  value={it.label}
                  maxLength={100}
                  placeholder="Nhãn ảnh (vd: Hộp 3/4)"
                  disabled={disabled}
                  onChange={(e) => onChange(items.map((x) => (x.key === it.key ? { ...x, label: e.target.value } : x)))}
                />
                <p className="mt-0.5 truncate text-[11px] text-muted">
                  {it.kind === 'upload' ? `${it.file.name} · ${(it.file.size / 1024).toFixed(0)} KB` : `Từ thư viện${it.projects.length ? ` · đã dùng ở: ${it.projects.join(', ')}` : ''}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <button type="button" aria-label="Đưa lên trên" disabled={disabled || i === 0} onClick={() => move(i, i - 1)} className="rounded p-1.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30">
                  <Icon name="chevronDown" size={16} className="rotate-180" />
                </button>
                <button type="button" aria-label="Đưa xuống dưới" disabled={disabled || i === items.length - 1} onClick={() => move(i, i + 1)} className="rounded p-1.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30">
                  <Icon name="chevronDown" size={16} />
                </button>
                <button type="button" aria-label="Xóa ảnh" disabled={disabled} onClick={() => remove(it.key)} className="rounded p-1.5 text-muted hover:bg-danger-bg hover:text-danger-fg">
                  <Icon name="x" size={16} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <LibraryPickerDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        disabledRefIds={items.filter((i): i is LibraryItem => i.kind === 'library').map((i) => i.refId)}
        onConfirm={addLibrary}
      />
    </div>
  );
}
