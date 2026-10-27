-- 011_project_trash: thùng rác 30 ngày cho dự án (xoá mềm, khôi phục được, xoá vĩnh viễn sau TRASH_RETENTION_DAYS).
-- deleted_at: NULL = đang dùng; có giá trị = nằm trong thùng rác (mọi API/file/worker đều coi như không tồn tại).
-- deleted_by: 'app' (chủ máy xoá ở app chính) | 'lan' (người tạo xoá kế hoạch từ trang LAN).
-- trash_path: thư mục thùng rác tương đối từ ROOT (output/.trash/<id>-<slug>-<mốc thời gian>), chứa output/ (= output/<slug>/ cũ) và refs/ (= refs/<id>/ cũ).
-- lan_client_hash: sha256 của cookie client `autovideo_lan_client` của trình duyệt LAN đã tạo kế hoạch (chỉ kế hoạch tạo từ giờ; kế hoạch cũ để NULL
--   và chỉ xoá được từ app chính). Không bao giờ lưu giá trị gốc của cookie.
-- Chỉ ADD COLUMN + index, không dựng lại bảng. Đã kiểm tra mọi khóa ngoại trỏ tới projects/scenes/jobs/assets (001, 003, 005, 006, 008): đều là
-- ON DELETE CASCADE hoặc SET NULL đúng ý nên DELETE FROM projects (xoá vĩnh viễn) dọn sạch, không cần dựng lại bảng nào (test project-trash.test.ts khoá điều này).
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_by TEXT CHECK (deleted_by IS NULL OR deleted_by IN ('app','lan'));
ALTER TABLE projects ADD COLUMN trash_path TEXT;
ALTER TABLE projects ADD COLUMN lan_client_hash TEXT;
CREATE INDEX idx_projects_deleted ON projects(deleted_at) WHERE deleted_at IS NOT NULL;
