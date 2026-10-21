export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Kiểm tra ảnh trước khi tải lên (server vẫn kiểm tra lại bằng magic bytes). */
export function checkImageFiles(files: FileList | File[]): { ok: File[]; errors: string[] } {
  const ok: File[] = [];
  const errors: string[] = [];
  for (const f of Array.from(files)) {
    if (!OK_TYPES.includes(f.type)) errors.push(`"${f.name}" không phải ảnh png, jpg hoặc webp`);
    else if (f.size > MAX_IMAGE_BYTES) errors.push(`"${f.name}" vượt quá 10MB`);
    else ok.push(f);
  }
  return { ok, errors };
}

export function defaultLabel(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function isFileDrag(e: { dataTransfer: DataTransfer }): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}
