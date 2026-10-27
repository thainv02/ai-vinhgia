import type { ColorRef, ColorRefList, FinalCut, Grade, GradePreview } from '../api/types';

/**
 * Các thao tác góp ý / chỉnh màu do nơi dùng truyền vào: trang Bản hoàn chỉnh của app chính dùng `/api/final-cuts/:id/...`, trang planner LAN dùng
 * `/lan/api/plans/:id/final-cuts/:cutId/...` (có hạn mức riêng). Nhờ vậy các khối giao diện dùng chung cho cả hai nơi.
 */
export interface ColorRefApi {
  /** Phân biệt bộ nhớ đệm giữa app chính và trang LAN. */
  scope: 'app' | 'lan';
  list(projectId: number): Promise<ColorRefList>;
  /** Tải ảnh (png/jpg/webp ≤ 15 MB) hoặc file .cube (≤ 5 MB); trùng nội dung thì trả bản đã có. */
  upload(projectId: number, file: File): Promise<ColorRef>;
  /** Chép ảnh có sẵn của dự án (ảnh tham chiếu hoặc storyboard) sang ảnh mẫu. */
  fromSource(projectId: number, src: { ref_id: number } | { asset_id: number }): Promise<ColorRef>;
  remove(projectId: number, id: number): Promise<void>;
}

export interface RevisionApi {
  /** Ảnh mẫu / LUT của dự án cho "Màu theo ảnh mẫu"; không có thì ẩn mục đó. */
  colorRefs?: ColorRefApi;
  /** Góp ý cho AI: tạo phiên bản mới (bản đang xem được giữ nguyên). */
  feedback(id: number, text: string): Promise<FinalCut>;
  /** Chỉnh màu tay: phiên bản mới chỉ chạy bước chỉnh màu (không AI). */
  grade(id: number, grade: Grade, note?: string): Promise<FinalCut>;
  /** Ảnh trước/sau ở 3 mốc thời gian. */
  preview(id: number, grade: Grade): Promise<GradePreview>;
  /** Chạy lại bước chỉnh màu của bản lỗi/hủy giữa bước chỉnh màu. */
  regrade(id: number): Promise<FinalCut>;
}
