-- Voice và mô tả ảnh chỉ thuộc dự án HTML; bản đã tạo giữ snapshot riêng.
ALTER TABLE html_assets ADD COLUMN description_json TEXT;
ALTER TABLE html_versions ADD COLUMN voice_json TEXT;
CREATE TABLE html_voice (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES html_assets(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','ready','failed','cancelled')),
  transcript_json TEXT,
  captions INTEGER NOT NULL DEFAULT 1 CHECK(captions IN (0,1)),
  error TEXT,
  updated_at TEXT NOT NULL
);
