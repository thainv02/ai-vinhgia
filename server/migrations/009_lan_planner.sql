-- 009_lan_planner: dự án do người dùng trong mạng LAN tạo qua trang "prompt planner" (chỉ lập kế hoạch prompt, không sản xuất).
-- source = 'app' (tạo từ app chính, mặc định cho mọi dự án cũ) | 'lan' (tạo từ listener LAN).
-- created_by_name: tên người tạo do chính người dùng LAN tự nhập (không phải danh tính đã xác thực); NULL với dự án 'app'.
-- Chỉ ADD COLUMN + index, không dựng lại bảng, không sửa migration cũ.
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','lan'));
ALTER TABLE projects ADD COLUMN created_by_name TEXT;
CREATE INDEX idx_projects_source ON projects(source, id);
