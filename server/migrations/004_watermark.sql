-- 004_watermark: bản dựng hoàn chỉnh phải qua tool xoá logo Veo trước khi `ready`.
-- Chỉ ALTER ... ADD COLUMN (không dựng lại bảng). Các bản `ready` có sẵn (render trước thay đổi này) nhận
-- watermark_removed = 0 / raw_video_path = NULL; endpoint POST /api/final-cuts/:id/clean xử lý chúng.
ALTER TABLE final_cuts ADD COLUMN stage TEXT CHECK (stage IS NULL OR stage IN ('render','clean'));
ALTER TABLE final_cuts ADD COLUMN raw_video_path TEXT;                -- bản render còn logo: <slug>_final_v<n>_raw.mp4
ALTER TABLE final_cuts ADD COLUMN failed_stage TEXT CHECK (failed_stage IS NULL OR failed_stage IN ('render','clean'));
ALTER TABLE final_cuts ADD COLUMN watermark_removed INTEGER NOT NULL DEFAULT 0 CHECK (watermark_removed IN (0,1));
ALTER TABLE final_cuts ADD COLUMN watermark_meta TEXT;                -- JSON stdout của tool (tùy chọn)
