-- 010_lan_tools: công cụ độc lập cho người dùng trong mạng LAN (hiện có "Xoá logo Veo" cho video tải lên bất kỳ).
-- Mỗi việc là một dòng lan_tool_jobs; file nằm trong output/lan-tools/<id>/ (input.<ext>, clean.mp4). Việc chạy qua CÙNG hàng đợi render
-- một-việc-một-lúc với bản dựng hoàn chỉnh. Chủ sở hữu là trình duyệt: cookie ẩn danh `autovideo_lan_client`, DB chỉ lưu SHA-256 của giá trị.
-- `expired`: quá 7 ngày, file đã xoá. Server khởi động lại giữa lúc queued/processing → failed (giữ input để thử lại).
-- Chỉ tạo bảng và index mới; không đụng bảng/migration cũ (dự án 'app' không thay đổi).
CREATE TABLE lan_tool_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('remove_logo')),
  status          TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','processing','ready','failed','cancelled','expired')),
  progress        REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  input_path      TEXT,                              -- tương đối từ ROOT: output/lan-tools/<id>/input.<ext>
  output_path     TEXT,                              -- output/lan-tools/<id>/clean.mp4 (chỉ khi ready)
  original_name   TEXT    NOT NULL DEFAULT '',       -- tên file người dùng chọn (đã làm sạch, chỉ để hiển thị/đặt tên tải về)
  client_id_hash  TEXT    NOT NULL,                  -- sha256 hex của cookie client; không bao giờ lưu giá trị gốc
  created_by_name TEXT,                              -- tên do người dùng tự nhập (không xác thực), tùy chọn
  error           TEXT,
  meta            TEXT    NOT NULL DEFAULT '{}',     -- JSON: ffprobe của input/output, thông tin tool
  created_at      TEXT    NOT NULL,
  finished_at     TEXT
);
CREATE INDEX idx_lan_tool_jobs_client ON lan_tool_jobs(client_id_hash, id);
CREATE INDEX idx_lan_tool_jobs_status ON lan_tool_jobs(status, id);
