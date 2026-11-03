-- 018/019 đã tồn tại: bảng đoạn dùng migration tiếp theo, không sửa lịch sử DB.
ALTER TABLE html_versions ADD COLUMN is_segmented INTEGER NOT NULL DEFAULT 0 CHECK(is_segmented IN (0,1));
-- Bản composition nội bộ dùng lại pipeline lint/vision/công bố; không xuất hiện trong lịch sử người dùng.
ALTER TABLE html_versions ADD COLUMN segment_owner_id INTEGER REFERENCES html_versions(id) ON DELETE CASCADE;
CREATE INDEX idx_html_versions_owner ON html_versions(segment_owner_id);
CREATE TABLE html_segments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_id INTEGER NOT NULL REFERENCES html_versions(id) ON DELETE CASCADE,
 idx INTEGER NOT NULL CHECK(idx>=1),
 start_s REAL NOT NULL CHECK(start_s>=0),
 end_s REAL NOT NULL CHECK(end_s>start_s AND end_s-start_s<=60.000001),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','composing','ready','failed')),
 job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
 segment_version_id INTEGER REFERENCES html_versions(id) ON DELETE SET NULL,
 files_dir TEXT,
 manifest_json TEXT NOT NULL DEFAULT '[]',
 variables_json TEXT NOT NULL DEFAULT '[]',
 content_hash TEXT,
 summary TEXT,
 error TEXT,
 updated_at TEXT NOT NULL,
 UNIQUE(version_id,idx)
);
CREATE TABLE html_segment_renders (
 segment_version_id INTEGER NOT NULL REFERENCES html_versions(id) ON DELETE CASCADE,
 quality TEXT NOT NULL CHECK(quality IN ('720p','1080p')),
 source_hash TEXT NOT NULL,
 video_path TEXT NOT NULL,
 video_hash TEXT NOT NULL,
 duration_s REAL NOT NULL,
 settings_json TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(segment_version_id,quality)
);
