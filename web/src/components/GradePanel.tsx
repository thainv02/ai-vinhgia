import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../api/errors';
import type { ColorRef, FinalCut, Grade, GradeMatch, GradePreview } from '../api/types';
import { fmtSeconds } from '../lib/finalCut';
import { fmtGradeValue, GRADE_FIELDS, gradeChips, gradeOf, gradesEqual, isNeutralGrade, neutralGrade, temperatureWord, type GradeKey } from '../lib/grade';
import type { RevisionApi } from '../lib/revisionApi';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { ColorMatchSection, useColorRefs } from './ColorMatchSection';
import { Icon } from './Icon';
import { InlineError } from './States';

/** Ba hàng ảnh nhỏ: Trước / Sau (cùng ba mốc thời gian). Ảnh 9:16, luôn 3 cột nên vừa cả màn hình 390px. */
function BeforeAfter({ data, stale, reference }: { data: GradePreview; stale: boolean; reference: ColorRef | null }) {
  return (
    <div className={stale ? 'opacity-60' : ''} aria-label="Ảnh xem trước trước và sau khi chỉnh màu">
      {(['before', 'after'] as const).map((k) => (
        <div key={k} className="mb-2 last:mb-0">
          <p className="mb-1 text-xs font-semibold text-muted">{k === 'before' ? 'Trước (bản sạch)' : 'Sau (thông số đang chọn)'}</p>
          <ul className="grid grid-cols-3 gap-1.5 sm:gap-2">
            {data.items.map((it) => (
              <li key={it.t} className="min-w-0">
                <img
                  src={k === 'before' ? it.before_url : it.after_url}
                  alt={`${k === 'before' ? 'Trước' : 'Sau'} khi chỉnh màu, giây ${String(it.t).replace('.', ',')}`}
                  loading="lazy"
                  className="aspect-[9/16] w-full rounded-md border border-line bg-surface-3 object-cover"
                />
                <span className="mt-0.5 block text-center text-[11px] text-muted">{fmtSeconds(it.t).replace(' giây', 's')}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {reference?.thumb_url && (
        <div className="mt-2 flex items-center gap-2.5 rounded-md bg-surface-2 p-2">
          <img src={reference.thumb_url} alt={`Ảnh mẫu ${reference.original_name ?? ''}`} className="h-20 w-[3.75rem] shrink-0 rounded border border-line object-cover" />
          <p className="min-w-0 text-xs text-muted">
            <span className="block font-semibold text-fg">Ảnh mẫu để so</span>
            <span className="block break-words">{reference.original_name}</span>
          </p>
        </div>
      )}
    </div>
  );
}

function Slider({ field, value, onChange, disabled }: { field: (typeof GRADE_FIELDS)[number]; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const id = `grade-${field.key}`;
  const changed = value !== field.neutral;
  const word = field.key === 'temperature_k' ? ` · ${temperatureWord(value)}` : '';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium">
          {field.label}
        </label>
        <span className={`text-[13px] tabular-nums ${changed ? 'font-semibold' : 'text-muted'}`}>
          {fmtGradeValue(field.key, value)}
          {word}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        disabled={disabled}
        aria-valuetext={`${fmtGradeValue(field.key, value)}${word}`}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(field.neutral)}
        className="mt-1 h-6 w-full"
      />
      <p className="text-[11px] text-muted">{field.hint}</p>
    </div>
  );
}

/**
 * Panel "Chỉnh màu" (thu gọn mặc định): mục "Màu theo ảnh mẫu" (ảnh mẫu / file LUT, chạy trước các thanh trượt), thanh trượt các thông số (mở sẵn giá trị của bản đang xem), "Mặc định", xem trước ảnh trước/sau ở 3 mốc thời gian,
 * "Tạo phiên bản" (phiên bản mới do bạn chỉnh, chỉ chạy bước chỉnh màu, không tốn AI). Component được gắn lại theo `key={fc.id}` để mở sẵn giá trị của bản đang xem.
 */
export function GradePanel({ fc, api, blockReason, onCreated }: { fc: FinalCut; api: RevisionApi; blockReason: string | null; onCreated: (created: FinalCut) => void }) {
  const current = useMemo(() => gradeOf(fc), [fc]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Grade>(current);
  const [shown, setShown] = useState<{ grade: Grade; data: GradePreview } | null>(null);
  const codeOf = new Map(fc.selection.map((s) => [s.scene_id, s.code]));
  const refs = useColorRefs(api, fc.project_id, open);

  const preview = useMutation({
    mutationFn: (g: Grade) => api.preview(fc.id, g).then((data) => ({ grade: g, data })),
    meta: { silent: true },
    onSuccess: (r) => setShown(r),
  });
  const create = useMutation({
    mutationFn: (g: Grade) => api.grade(fc.id, g),
    meta: { silent: true },
    onSuccess: (created) => {
      toast.success(`Đã tạo bản v${created.version}, đang chỉnh màu`);
      onCreated(created);
    },
  });

  const set = (key: GradeKey, v: number) => setDraft((d) => ({ ...d, [key]: v }));
  const setMatch = (m: GradeMatch | undefined) =>
    setDraft((d) => {
      const { match: _old, ...rest } = d;
      void _old;
      return m ? { ...rest, match: m } : rest;
    });
  const shownRef = shown?.grade.match ? ((refs.data?.items ?? []).find((r) => r.id === shown.grade.match!.ref_id) ?? null) : null;
  const unchanged = gradesEqual(draft, current);
  const createReason = blockReason ?? (unchanged ? 'Chưa đổi thông số nào so với bản đang xem' : null);
  const stale = !!shown && !gradesEqual(shown.grade, draft);
  const chips = gradeChips(fc);
  const busy = create.isPending;

  return (
    <section className="rounded-lg border border-line bg-surface" aria-labelledby={`gr-h-${fc.id}`}>
      <button
        type="button"
        id={`gr-h-${fc.id}`}
        aria-expanded={open}
        aria-controls={`gr-body-${fc.id}`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left sm:px-4"
      >
        <Icon name="image" size={15} className="text-muted" />
        <span className="text-[15px] font-semibold">Chỉnh màu</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{chips.length ? chips.join(' · ') : 'Chưa chỉnh · tự chỉnh bằng thanh trượt hoặc theo ảnh mẫu, không cần AI'}</span>
        <Icon name="chevronDown" size={16} className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={`gr-body-${fc.id}`} className="space-y-3 border-t border-line p-3 sm:p-4">
          <ColorMatchSection fc={fc} api={api} value={draft.match} onChange={setMatch} disabled={busy} />

          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {GRADE_FIELDS.map((f) => (
              <Slider key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} disabled={busy} />
            ))}
          </div>

          {draft.scenes?.length ? (
            <div className="rounded-md bg-surface-2 px-3 py-2 text-[13px]">
              <p className="font-medium">Chỉnh riêng từng cảnh (giữ từ bản này)</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {draft.scenes.map((s) => {
                  const parts = [s.temperature_k !== undefined ? `${temperatureWord(s.temperature_k)} ${s.temperature_k}K` : null, s.contrast !== undefined ? `Tương phản ${s.contrast.toFixed(2)}` : null, s.brightness !== undefined ? `Sáng ${fmtGradeValue('brightness', s.brightness)}` : null, s.saturation !== undefined ? `Bão hoà ${s.saturation.toFixed(2)}` : null, s.gamma !== undefined ? `Gamma ${s.gamma.toFixed(2)}` : null].filter(Boolean);
                  return (
                    <li key={s.scene_id} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface py-0.5 pl-2.5 pr-1 text-xs">
                      <span>
                        {codeOf.get(s.scene_id) ?? `#${s.scene_id}`}: {parts.join(', ')}
                      </span>
                      <button
                        type="button"
                        aria-label={`Bỏ chỉnh riêng ${codeOf.get(s.scene_id) ?? s.scene_id}`}
                        className="grid size-5 place-items-center rounded-full hover:bg-surface-3"
                        onClick={() => setDraft((d) => ({ ...d, scenes: d.scenes?.filter((x) => x.scene_id !== s.scene_id) }))}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-xs text-muted">Muốn chỉnh riêng một cảnh: viết ở ô góp ý, ví dụ «cảnh 3 tối quá».</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setDraft(neutralGrade())} disabled={busy || isNeutralGrade(draft)}>
              Mặc định
            </Button>
            <Button size="sm" icon={<Icon name="eye" size={14} />} loading={preview.isPending} disabled={busy} onClick={() => preview.mutate(draft)}>
              Xem trước
            </Button>
            {unchanged && <span className="text-xs text-muted">Đang là thông số của bản v{fc.version}.</span>}
          </div>

          {preview.isError && <InlineError>{errorMessage(preview.error)}</InlineError>}
          {shown && (
            <div>
              {stale && <p className="mb-1.5 text-xs text-warn-fg">Bạn đã đổi thông số sau lần xem trước này; bấm «Xem trước» để cập nhật ảnh «Sau».</p>}
              <BeforeAfter data={shown.data} stale={stale} reference={shownRef} />
            </div>
          )}

          {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3">
            <Button variant="primary" loading={create.isPending} disabledReason={createReason} onClick={() => create.mutate(draft)} icon={<Icon name="plus" size={14} />}>
              Tạo phiên bản
            </Button>
            <span className="text-xs text-muted">Chỉ chạy bước chỉnh màu trên bản sạch (không render, không tốn AI hay credit). Bản hiện tại được giữ.</span>
          </div>
          {blockReason && (
            <p className="flex items-start gap-1 text-xs text-warn-fg">
              <Icon name="alert" size={13} className="mt-px shrink-0" />
              <span>{blockReason}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
