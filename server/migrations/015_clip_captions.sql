-- Kiểu phụ đề đã lưu của clip: JSON {preset?, layout?: {left, width, bottom}} (tỉ lệ 0–1 của khung đầu ra). NULL = mặc định (highlight, căn giữa-dưới).
ALTER TABLE clips ADD COLUMN captions TEXT;
