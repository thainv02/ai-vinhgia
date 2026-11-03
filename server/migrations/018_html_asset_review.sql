-- Quét ảnh lỗi chờ nhãn người dùng; nhận dạng voice có mã lượt riêng chống kết quả cũ ghi đè.
ALTER TABLE html_assets ADD COLUMN scan_error_code TEXT;
ALTER TABLE html_assets ADD COLUMN manual_label TEXT;
ALTER TABLE html_assets ADD COLUMN label_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(label_confirmed IN (0,1));
ALTER TABLE html_voice ADD COLUMN request_id TEXT;
