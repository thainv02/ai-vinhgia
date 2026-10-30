import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import type { ColorRef, ColorRefList, FinalCut, GradeMatch } from '../api/types';
import { MATCH_DEFAULT_STRENGTH, newMatch } from '../lib/grade';
import { isFileDrag } from '../lib/refFiles';
import type { RevisionApi } from '../lib/revisionApi';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { Icon } from './Icon';
import { InlineError } from './States';

/** Giới hạn ở server: ảnh ≤ 15 MB (png/jpg/webp), file LUT .cube ≤ 5 MB. Server vẫn kiểm tra lại bằng magic bytes. */
export const COLOR_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const COLOR_LUT_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Kiểm tra file trước khi tải lên; trả thông báo lỗi hoặc null. `accept`: loại cho phép ở ô đang dùng. */
export function checkColorFile(f: File, accept: 'image' | 'lut' | 'any'): string | null {
  const isLut = /\.cube$/i.test(f.name);
  if (isLut) {
    if (accept === 'image') return `«${f.name}» là file LUT; hãy dùng mục «Tải file LUT (.cube)» bên dưới`;
    return f.size > COLOR_LUT_MAX_BYTES ? `«${f.name}» vượt quá 5MB` : null;
  }
  if (accept === 'lut') return `«${f.name}» không phải file .cube`;
  if (!IMAGE_TYPES.includes(f.type)) return `«${f.name}» không phải ảnh png, jpg hoặc webp`;
  return f.size > COLOR_IMAGE_MAX_BYTES ? `«${f.name}» vượt quá 15MB` : null;
}

/** Danh sách ảnh mẫu / LUT và ảnh có sẵn của dự án (dùng chung khoá bộ nhớ đệm giữa GradePanel và mục chọn). */
export function useColorRefs(api: RevisionApi, projectId: number, enabled = true) {
  const refsApi = api.colorRefs;
  return useQuery<ColorRefList>({
    queryKey: ['color-refs', refsApi?.scope ?? 'none', projectId],
    queryFn: () => refsApi!.list(projectId),
    enabled: !!refsApi && enabled,
    staleTime: 20_000,
  });
}

const refName = (r: ColorRef): string => r.original_name || `#${r.id}`;

function Thumb({ r, selected, onPick, onRemove, disabled }: { r: ColorRef; selected: boolean; onPick: () => void; onRemove: () => void; disabled: boolean }) {
  return (
    <li className="relative min-w-0">
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? 'Đang dùng' : 'Dùng'} ảnh mẫu ${refName(r)}`}
        title={refName(r)}
        disabled={disabled}
        onClick={onPick}
        className={`block w-full overflow-hidden rounded-md border-2 bg-surface-3 text-left transition-colors ${selected ? 'border-fg' : 'border-line hover:border-line-strong'}`}
      >
        <img src={r.thumb_url ?? ''} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover" />
        <span className="block truncate px-1.5 py-1 text-[11px] text-muted">{refName(r)}</span>
      </button>
      {selected && (
        <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 grid size-5 place-items-center rounded-full bg-ink text-ink-fg">
          <Icon name="check" size={12} />
        </span>
      )}
      {r.used_by.length === 0 && !disabled ? (
        <button type="button" aria-label={`Xoá ảnh mẫu ${refName(r)}`} title="Xoá khỏi dự án" onClick={onRemove} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-surface/90 text-muted shadow-sm hover:bg-danger-bg hover:text-danger-fg">
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </li>
  );
}

/**
 * Mục "Màu theo ảnh mẫu" trong panel Chỉnh màu (dùng chung cho app chính và trang LAN): chọn/tải ảnh mẫu (kéo thả, dán, chọn file, hoặc chép từ ảnh của dự án),
 * lưới ảnh đã tải, cường độ, chế độ (chỉ tông màu / cả độ sáng), khớp riêng từng cảnh, và mục phụ «Tải file LUT (.cube)». Chỉ sửa bản nháp `value`;
 * việc xem trước / tạo phiên bản do GradePanel làm. Màu theo ảnh mẫu chạy TRƯỚC các thanh trượt bên dưới nên vẫn chỉnh thêm được.
 */
export function ColorMatchSection({ fc, api, value, onChange, disabled }: { fc: FinalCut; api: RevisionApi; value: GradeMatch | undefined; onChange: (m: GradeMatch | undefined) => void; disabled: boolean }) {
  const refsApi = api.colorRefs;
  const qc = useQueryClient();
  const q = useColorRefs(api, fc.project_id);
  const inputRef = useRef<HTMLInputElement>(null);
  const lutInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [lutOpen, setLutOpen] = useState(value?.kind === 'lut');

  const items = q.data?.items ?? [];
  const images = items.filter((r) => r.kind === 'image');
  const luts = items.filter((r) => r.kind === 'lut');
  const selected = value ? items.find((r) => r.id === value.ref_id) : undefined;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['color-refs', refsApi?.scope ?? 'none', fc.project_id] });

  const upload = useMutation({
    mutationFn: (file: File) => refsApi!.upload(fc.project_id, file),
    meta: { silent: true },
    onSuccess: (ref) => {
      refresh();
      onChange(newMatch(ref.kind, ref.id, value));
      toast.success(ref.kind === 'lut' ? 'Đã tải file LUT và chọn dùng' : 'Đã tải ảnh mẫu và chọn dùng');
    },
  });
  const fromSource = useMutation({
    mutationFn: (src: { ref_id: number } | { asset_id: number }) => refsApi!.fromSource(fc.project_id, src),
    meta: { silent: true },
    onSuccess: (ref) => {
      refresh();
      onChange(newMatch('image', ref.id, value));
      setSourcesOpen(false);
      toast.success('Đã chọn ảnh làm ảnh mẫu');
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => refsApi!.remove(fc.project_id, id).then(() => id),
    meta: { silent: true },
    onSuccess: (id) => {
      refresh();
      if (value?.ref_id === id) onChange(undefined);
    },
  });
  const busy = disabled || upload.isPending || fromSource.isPending || remove.isPending;

  const addFiles = (files: FileList | File[], accept: 'image' | 'lut' | 'any') => {
    const f = Array.from(files)[0];
    if (!f) return;
    const err = checkColorFile(f, accept);
    setProblems(err ? [err] : []);
    if (!err) upload.mutate(f);
  };

  // Dán ảnh (Ctrl/Cmd+V) khi panel đang mở và con trỏ không ở trong ô nhập chữ (không giành mất thao tác dán vào ô góp ý)
  useEffect(() => {
    if (!refsApi) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith('image/'));
      if (!f || busy) return;
      e.preventDefault();
      addFiles([f], 'image');
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  if (!refsApi) return null;
  const pct = Math.round((value?.strength ?? MATCH_DEFAULT_STRENGTH) * 100);
  const set = (patch: Partial<GradeMatch>) => value && onChange({ ...value, ...patch });
  const mutationError = upload.error ?? fromSource.error ?? remove.error;
  const sources = q.data?.sources;
  const hasSources = !!sources && (sources.refs.length > 0 || sources.assets.length > 0);

  return (
    <section className="rounded-md border border-line bg-surface-2 p-3" aria-labelledby={`cm-h-${fc.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="image" size={15} className="text-muted" />
        <h4 id={`cm-h-${fc.id}`} className="text-[14px] font-semibold">
          Màu theo ảnh mẫu
        </h4>
        {value && <span className="rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-ink-fg">Đang bật</span>}
        {value && (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => onChange(undefined)}>
            Bỏ ảnh mẫu
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted">Chọn một ảnh có màu bạn thích, video sẽ được kéo về tông màu đó (tính toán cố định, không dùng AI). Chạy trước các thanh trượt bên dưới nên vẫn chỉnh thêm «ấm hơn», «tương phản»… được.</p>

      {/* tải ảnh: kéo thả / chọn file / dán */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Tải ảnh mẫu: kéo thả ảnh vào đây, bấm để chọn file, hoặc dán ảnh bằng Ctrl hoặc Cmd cộng V"
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !busy) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          if (busy || !isFileDrag(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (busy || !isFileDrag(e)) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files, 'image');
        }}
        className={`mt-2 cursor-pointer rounded-md border-2 border-dashed px-3 py-3 text-center transition-colors focus-visible:outline-2 ${dragging ? 'border-fg bg-surface-3' : 'border-line-strong bg-surface'} ${busy ? 'opacity-60' : ''}`}
      >
        <Icon name="upload" size={18} className="mx-auto text-muted" />
        <p className="mt-0.5 text-[13px] font-medium">{upload.isPending ? 'Đang tải lên…' : 'Kéo thả ảnh mẫu vào đây, bấm để chọn file, hoặc dán ảnh (Ctrl/Cmd+V)'}</p>
        <p className="text-[11px] text-muted">png, jpg, webp, tối đa 15MB</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files, 'image');
          e.target.value = '';
        }}
      />

      {hasSources && (
        <div className="mt-2">
          <button type="button" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((v) => !v)} className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium underline-offset-2 hover:underline">
            <Icon name="chevronDown" size={14} className={`transition-transform ${sourcesOpen ? 'rotate-180' : ''}`} />
            Chọn từ ảnh của dự án
          </button>
          {sourcesOpen && (
            <ul className="mt-1.5 grid grid-cols-4 gap-1.5 sm:grid-cols-6" aria-label="Ảnh có sẵn của dự án">
              {sources!.refs.map((r) => (
                <li key={`r${r.id}`}>
                  <button type="button" disabled={busy} title={`Ảnh tham chiếu: ${r.label}`} aria-label={`Dùng ảnh tham chiếu ${r.label} làm ảnh mẫu`} onClick={() => fromSource.mutate({ ref_id: r.id })} className="block w-full overflow-hidden rounded-md border border-line bg-surface-3 hover:border-fg disabled:opacity-50">
                    <img src={r.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                    <span className="block truncate px-1 py-0.5 text-[10px] text-muted">{r.label}</span>
                  </button>
                </li>
              ))}
              {sources!.assets.map((a) => (
                <li key={`a${a.id}`}>
                  <button type="button" disabled={busy} title={`Storyboard ${a.scene_code}`} aria-label={`Dùng storyboard ${a.scene_code} làm ảnh mẫu`} onClick={() => fromSource.mutate({ asset_id: a.id })} className="block w-full overflow-hidden rounded-md border border-line bg-surface-3 hover:border-fg disabled:opacity-50">
                    <img src={a.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                    <span className="block truncate px-1 py-0.5 text-[10px] text-muted">Storyboard {a.scene_code}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="mt-1.5 space-y-0.5 text-[13px] text-danger-fg">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {mutationError && (
        <div className="mt-1.5">
          <InlineError>{errorMessage(mutationError)}</InlineError>
        </div>
      )}
      {q.isError && (
        <div className="mt-1.5">
          <InlineError>{errorMessage(q.error)}</InlineError>
        </div>
      )}

      {images.length > 0 && (
        <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label="Ảnh mẫu đã tải lên">
          {images.map((r) => (
            <Thumb
              key={r.id}
              r={r}
              selected={value?.kind === 'image' && value.ref_id === r.id}
              disabled={busy}
              onPick={() => (value?.kind === 'image' && value.ref_id === r.id ? onChange(undefined) : onChange(newMatch('image', r.id, value)))}
              onRemove={() => remove.mutate(r.id)}
            />
          ))}
        </ul>
      )}
      {q.isSuccess && images.length === 0 && luts.length === 0 && <p className="mt-2 text-xs text-muted">Chưa có ảnh mẫu nào. Tải một ảnh lên để bắt đầu.</p>}

      {value && selected && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div className="flex items-center gap-2.5">
            {selected.thumb_url ? <img src={selected.thumb_url} alt="" className="h-14 w-10 shrink-0 rounded border border-line object-cover" /> : <span className="grid h-14 w-10 shrink-0 place-items-center rounded border border-line bg-surface-3 text-[10px] font-semibold text-muted">LUT</span>}
            <p className="min-w-0 text-[13px]">
              <span className="font-medium">Đang dùng: </span>
              <span className="break-words">{refName(selected)}</span>
              {selected.kind === 'lut' && selected.lut_size ? <span className="text-muted"> ({selected.lut_size}³)</span> : null}
            </p>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={`cm-strength-${fc.id}`} className="text-[13px] font-medium">
                Cường độ
              </label>
              <span className="text-[13px] font-semibold tabular-nums">{pct}%</span>
            </div>
            <input
              id={`cm-strength-${fc.id}`}
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              disabled={busy}
              aria-valuetext={`${pct} phần trăm`}
              onChange={(e) => set({ strength: Number(e.target.value) / 100 })}
              onDoubleClick={() => set({ strength: MATCH_DEFAULT_STRENGTH })}
              className="mt-1 h-6 w-full"
            />
            <p className="text-[11px] text-muted">Trái: giữ màu gốc · phải: giống hẳn ảnh mẫu (bấm đúp để về 70%)</p>
          </div>

          {value.kind === 'image' && (
            <>
              <fieldset className="space-y-1" disabled={busy}>
                <legend className="text-[13px] font-medium">Lấy gì từ ảnh mẫu</legend>
                {(
                  [
                    ['color', 'Chỉ lấy tông màu (giữ độ sáng)'],
                    ['full', 'Giống cả độ sáng, tương phản'],
                  ] as const
                ).map(([m, label]) => (
                  <label key={m} className="flex min-h-8 cursor-pointer items-center gap-2 text-[13px]">
                    <input type="radio" name={`cm-mode-${fc.id}`} checked={value.mode === m} onChange={() => set({ mode: m })} className="size-4" />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="flex min-h-8 cursor-pointer items-start gap-2 text-[13px]">
                <input type="checkbox" checked={value.per_scene} disabled={busy} onChange={(e) => set({ per_scene: e.target.checked })} className="mt-0.5 size-4" />
                <span>
                  Khớp riêng từng cảnh (đồng đều tông giữa các cảnh)
                  <span className="block text-[11px] text-muted">Mỗi cảnh một bảng màu riêng nên các cảnh khác tông cũng về cùng một tông. Lâu hơn một chút.</span>
                </span>
              </label>
            </>
          )}
        </div>
      )}

      {/* mục phụ: file LUT của thương hiệu */}
      <div className="mt-3 border-t border-line pt-2">
        <button type="button" aria-expanded={lutOpen} onClick={() => setLutOpen((v) => !v)} className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium underline-offset-2 hover:underline">
          <Icon name="chevronDown" size={14} className={`transition-transform ${lutOpen ? 'rotate-180' : ''}`} />
          Tải file LUT (.cube)
          {luts.length > 0 && <span className="rounded-md bg-surface-3 px-1.5 text-[11px] text-muted">{luts.length}</span>}
        </button>
        {lutOpen && (
          <div className="mt-1.5 space-y-2">
            <p className="text-xs text-muted">Dùng look có sẵn của thương hiệu: file LUT 3D (.cube, tối đa 5MB, cỡ 2–65). Server đọc lại và lưu bản chuẩn hoá, không dùng file gốc. Cường độ ở trên cũng áp dụng cho LUT.</p>
            <Button size="sm" icon={<Icon name="upload" size={14} />} disabled={busy} loading={upload.isPending && !!upload.variables && /\.cube$/i.test(upload.variables.name)} onClick={() => lutInputRef.current?.click()}>
              Chọn file .cube
            </Button>
            <input
              ref={lutInputRef}
              type="file"
              accept=".cube,text/plain"
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files, 'lut');
                e.target.value = '';
              }}
            />
            {luts.length > 0 && (
              <ul className="space-y-1" aria-label="File LUT đã tải lên">
                {luts.map((r) => {
                  const on = value?.kind === 'lut' && value.ref_id === r.id;
                  return (
                    <li key={r.id} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${on ? 'border-fg bg-surface' : 'border-line bg-surface'}`}>
                      <button type="button" aria-pressed={on} disabled={busy} onClick={() => (on ? onChange(undefined) : onChange(newMatch('lut', r.id, value)))} className="min-w-0 flex-1 truncate py-1 text-left text-[13px]">
                        {on && <Icon name="check" size={12} className="mr-1 inline" />}
                        {refName(r)}
                        {r.lut_size ? <span className="text-muted"> · {r.lut_size}³</span> : null}
                      </button>
                      {r.used_by.length === 0 && (
                        <button type="button" aria-label={`Xoá file LUT ${refName(r)}`} disabled={busy} onClick={() => remove.mutate(r.id)} className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-danger-bg hover:text-danger-fg">
                          <Icon name="x" size={13} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
