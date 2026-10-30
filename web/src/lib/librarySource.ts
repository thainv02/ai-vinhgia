import { api } from '../api/client';
import type { LibraryEntry, LibrarySource } from '../components/LibraryPickerDialog';

/** Thư viện ảnh của app chính: ảnh của mọi dự án. (Trang LAN có nguồn riêng, chỉ ảnh của kế hoạch LAN.) */
export const mainLibrarySource: LibrarySource = {
  key: 'ref-library',
  load: (projectId?: number): Promise<LibraryEntry[]> => api.refLibrary(projectId),
};
