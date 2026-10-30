-- 013_color_refs: ảnh mẫu / file LUT cho "màu theo ảnh mẫu" của bản hoàn chỉnh (Grade.match, xem services/color-match.ts).
-- Bảng MỚI, không đụng bảng cũ (không dựng lại bảng, không cần tắt khoá ngoại):
--   project_id  → projects(id) ON DELETE CASCADE (xoá vĩnh viễn dự án dọn luôn các dòng; file nằm trong output/<slug>/ nên đã đi theo thư mục dự án vào/ra thùng rác).
--   kind        'image' (jpg/png/webp, có thumb_path) | 'lut' (file .cube đã được server ĐỌC CHẶT và GHI LẠI chuẩn hoá; không lưu file gốc).
--   file_path / thumb_path: tương đối từ ROOT, output/<slug>/final/color-refs/<hash16>.<đuôi> và <hash16>_thumb.jpg (đặt tên theo nội dung nên không ghi đè).
--   content_hash: sha256 nội dung (ảnh: byte gốc; LUT: bản chuẩn hoá). UNIQUE theo dự án: tải trùng thì dùng lại dòng cũ.
--   width/height (ảnh), lut_size (LUT: cạnh N của LUT_3D_SIZE).
-- Grade.match.ref_id của final_cuts.grade (JSON) trỏ tới id ở đây; không có khoá ngoại (JSON), việc xoá bị chặn ở tầng ứng dụng khi còn bản dựng dùng.
CREATE TABLE color_refs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('image','lut')),
  file_path       TEXT    NOT NULL,
  thumb_path      TEXT,
  original_name   TEXT,
  content_hash    TEXT    NOT NULL,
  width           INTEGER,
  height          INTEGER,
  lut_size        INTEGER,
  created_by_name TEXT,
  created_at      TEXT    NOT NULL,
  UNIQUE (project_id, content_hash)
);
CREATE INDEX idx_color_refs_project ON color_refs(project_id, id);
