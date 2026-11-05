import { useState } from 'react';
import type { VideoGenerator } from '../api/types';
import { useVideoGenerators } from '../hooks/queries';
import { Icon } from './Icon';

const KEY = 'autovideo.videoGenerator';
export const DEFAULT_GENERATOR = 'muse';

function readChoice(): string {
  try {
    return window.localStorage.getItem(KEY) || DEFAULT_GENERATOR;
  } catch {
    return DEFAULT_GENERATOR;
  }
}

/** Lựa chọn dịch vụ tạo video, nhớ lần chọn gần nhất trên trình duyệt này. */
export function useGeneratorChoice(): [string, (id: string) => void] {
  const [value, setValue] = useState(readChoice);
  const set = (id: string) => {
    setValue(id);
    try {
      window.localStorage.setItem(KEY, id);
    } catch {
      /* chế độ riêng tư: chỉ nhớ trong phiên */
    }
  };
  return [value, set];
}

/** Dịch vụ thực sự dùng: lựa chọn đã nhớ, hoặc dịch vụ đầu tiên hợp lệ nếu lựa chọn đó không nhận đủ ảnh của cảnh. */
export function effectiveGenerator(list: VideoGenerator[], value: string, imageCount?: number): VideoGenerator | undefined {
  const ok = (g: VideoGenerator) => !generatorBlockReason(g, imageCount);
  const chosen = list.find((g) => g.id === value);
  return chosen && ok(chosen) ? chosen : list.find(ok) ?? chosen;
}

/** Lý do không chọn được dịch vụ cho một cảnh (thừa ảnh). */
export function generatorBlockReason(g: VideoGenerator, imageCount?: number): string | null {
  return imageCount !== undefined && imageCount > g.max_images ? `Cảnh cần gửi ${imageCount} ảnh, dịch vụ này nhận tối đa ${g.max_images}` : null;
}

const PROVIDER_LABEL: Record<VideoGenerator['provider'], string> = { muse: 'Muse', flow: 'Google Flow' };

interface Props {
  value: string;
  onChange: (id: string) => void;
  /** Số ảnh sẽ gửi (ảnh sản phẩm + storyboard) khi tạo cho một cảnh; bỏ trống khi duyệt nhiều cảnh. */
  imageCount?: number;
}

/** Chọn dịch vụ tạo video: Muse hoặc một model Google Flow. */
export function GeneratorPicker(props: Props) {
  const q = useVideoGenerators();
  if (q.isLoading) return <p className="text-[13px] text-muted">Đang tải danh sách dịch vụ…</p>;
  return <GeneratorOptions {...props} list={q.data?.generators ?? []} />;
}

/** Bộ chọn với danh sách có sẵn (trang LAN lấy danh sách qua `/lan/api/auto/generators`). */
export function GeneratorOptions({ value, onChange, imageCount, list, name = 'video-generator', legend = 'Dịch vụ tạo video', disabled }: Props & { list: VideoGenerator[]; name?: string; legend?: string; disabled?: boolean }) {
  if (list.length === 0) return null;
  const selected = effectiveGenerator(list, value, imageCount) ?? list[0];

  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-[13px] font-semibold">{legend}</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {list.map((g) => {
          const reason = generatorBlockReason(g, imageCount);
          const checked = g.id === selected.id;
          return (
            <label
              key={g.id}
              title={reason ?? undefined}
              className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px] ${
                reason || disabled ? `cursor-not-allowed opacity-60 ${checked ? 'border-fg' : 'border-line'}` : checked ? 'cursor-pointer border-fg bg-surface-2' : 'cursor-pointer border-line hover:bg-surface-2'
              }`}
            >
              <input type="radio" name={name} value={g.id} checked={checked} disabled={!!reason} onChange={() => onChange(g.id)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="font-semibold">{g.label}</span>
                <span className={`block text-xs ${reason ? 'text-warn-fg' : 'text-muted'}`}>{reason ?? g.note}</span>
              </span>
            </label>
          );
        })}
      </div>
      {selected.duration_s < 10 && (
        <p className="flex items-start gap-1.5 text-xs text-warn-fg">
          <Icon name="alert" size={13} className="mt-px shrink-0" />
          <span>
            {PROVIDER_LABEL[selected.provider]} chỉ tạo {selected.duration_s} giây, prompt viết cho 10 giây nên phần cuối có thể bị dồn hoặc cắt.
          </span>
        </p>
      )}
    </fieldset>
  );
}
