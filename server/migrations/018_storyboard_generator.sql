-- 018_storyboard_generator: dịch vụ tạo ảnh storyboard của dự án ('muse' | 'flow-image'), xem server/src/services/generators.ts.
-- Ảnh 'flow-image' (Google Flow/Gemini) được server xoá logo khi worker nộp kết quả.
ALTER TABLE projects ADD COLUMN storyboard_generator TEXT NOT NULL DEFAULT 'muse';
