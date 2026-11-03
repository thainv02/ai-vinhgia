-- Video HTML theo voice: hỗ trợ tối đa 10 phút, giữ thời lượng lẻ của audio.
-- Không có bảng con tham chiếu html_project_meta; khóa ngoại projects giữ nguyên.
CREATE TABLE html_project_meta_new (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  aspect TEXT NOT NULL CHECK(aspect IN ('9:16','1:1','16:9')),
  duration_s REAL NOT NULL CHECK(duration_s >= 1 AND duration_s <= 600),
  quality TEXT NOT NULL CHECK(quality IN ('720p','1080p')),
  template_id TEXT,
  model_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
INSERT INTO html_project_meta_new SELECT project_id,aspect,duration_s,quality,template_id,model_json,created_at FROM html_project_meta;
DROP TABLE html_project_meta;
ALTER TABLE html_project_meta_new RENAME TO html_project_meta;
