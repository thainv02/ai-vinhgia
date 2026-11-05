-- 019_lan_autovideo: chế độ của dự án LAN. 'plan' = kế hoạch prompt (người dùng tự tạo ảnh/video rồi tải lên, như trước);
-- 'auto' = tab Autovideo (người dùng LAN bấm tạo storyboard/video, worker nền tạo qua Muse2API/Flow2API). Dự án 'app' luôn 'plan'.
ALTER TABLE projects ADD COLUMN lan_mode TEXT NOT NULL DEFAULT 'plan';
