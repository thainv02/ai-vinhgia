-- 002_ref_library: thư viện ảnh tham chiếu dùng lại giữa các dự án.
-- content_hash = sha256 (hex) nội dung file ảnh; điền cho dữ liệu cũ lúc khởi động app (backfillRefHashes).
-- Không UNIQUE: cùng một ảnh có thể nằm ở nhiều dự án (mỗi dự án giữ BẢN CHÉP file riêng).
ALTER TABLE project_refs ADD COLUMN content_hash TEXT;
CREATE INDEX idx_project_refs_hash ON project_refs(content_hash);
CREATE INDEX idx_project_refs_project_hash ON project_refs(project_id, content_hash);
