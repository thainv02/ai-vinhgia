-- migrate:foreign-keys-off
-- 012_final_cut_feedback: góp ý cho AI sau "Edit tự động" + chỉnh màu (grade) tạo PHIÊN BẢN MỚI của bản dựng hoàn chỉnh.
-- Thêm cột: parent_id (bản đang xem lúc góp ý/chỉnh màu), feedback (góp ý của người dùng), grade (JSON thông số màu đã áp, NULL = trung tính),
-- revision (JSON {kind:'ai'|'manual', edl_changed, summary, not_done}), base_path (bản sạch CHƯA chỉnh màu, chỉ có khi grade không trung tính).
-- Đổi CHECK: stage / failed_stage thêm 'grade'. SQLite không ALTER được CHECK nên dựng lại bảng final_cuts theo quy trình 12 bước
-- (runner tắt foreign_keys trước khi mở transaction và chạy PRAGMA foreign_key_check trước khi commit, xem db/index.ts).
-- Giữ nguyên dữ liệu, id (kể cả bộ đếm AUTOINCREMENT), index; INSERT ... SELECT theo TÊN cột (không dùng SELECT *).
-- Job `edit_plan` dùng lại cho góp ý (phân biệt bằng payload.revision) nên KHÔNG đụng bảng jobs.

CREATE TABLE final_cuts_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning','rendering','ready','failed','cancelled')),
  selection           TEXT    NOT NULL DEFAULT '[]',   -- JSON [{scene_id, code, asset_id, attempt}] theo thứ tự cảnh
  selection_signature TEXT    NOT NULL,                -- sha256 của (scene_id, asset_id) theo thứ tự cảnh
  edl                 TEXT,                            -- JSON {scenes:[{scene_id, asset_id, segments, removed, note}]}
  renderer            TEXT    CHECK (renderer IS NULL OR renderer IN ('shotcut','ffmpeg')),
  video_path          TEXT,                            -- bản giao (đã chỉnh màu nếu có): output/<slug>/final/<slug>_final_v<n>.mp4
  project_file_path   TEXT,                            -- .mlt (chỉ khi dựng bằng Shotcut)
  contact_sheet_path  TEXT,
  duration_s          REAL,
  job_id              INTEGER REFERENCES jobs(id) ON DELETE SET NULL,   -- job edit_plan
  render_ref          TEXT,                            -- job_id render của Shotcut MCP
  progress            REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  created_by          TEXT    NOT NULL CHECK (created_by IN ('claude','user','agent')),
  note                TEXT,
  summary             TEXT,
  error               TEXT,
  ext_key             TEXT,
  created_at          TEXT    NOT NULL,
  finished_at         TEXT,
  stage               TEXT    CHECK (stage IS NULL OR stage IN ('render','clean','grade')),
  raw_video_path      TEXT,
  failed_stage        TEXT    CHECK (failed_stage IS NULL OR failed_stage IN ('render','clean','grade')),
  watermark_removed   INTEGER NOT NULL DEFAULT 0 CHECK (watermark_removed IN (0,1)),
  watermark_meta      TEXT,
  provider            TEXT,
  model               TEXT,
  account_id          INTEGER,
  parent_id           INTEGER REFERENCES final_cuts(id) ON DELETE SET NULL,   -- bản đã được góp ý / chỉnh màu để tạo ra bản này
  feedback            TEXT,                            -- góp ý của người dùng cho AI (dữ liệu, không phải lệnh)
  grade               TEXT,                            -- JSON Grade đã áp; NULL = chưa chỉnh màu (trung tính)
  revision            TEXT,                            -- JSON {kind, edl_changed, summary, not_done}
  base_path           TEXT,                            -- bản sạch (đã xoá logo) CHƯA chỉnh màu: <slug>_final_v<n>_base.mp4
  UNIQUE (project_id, version)
);

INSERT INTO final_cuts_new (
  id, project_id, version, status, selection, selection_signature, edl, renderer, video_path, project_file_path, contact_sheet_path,
  duration_s, job_id, render_ref, progress, created_by, note, summary, error, ext_key, created_at, finished_at,
  stage, raw_video_path, failed_stage, watermark_removed, watermark_meta, provider, model, account_id
)
SELECT
  id, project_id, version, status, selection, selection_signature, edl, renderer, video_path, project_file_path, contact_sheet_path,
  duration_s, job_id, render_ref, progress, created_by, note, summary, error, ext_key, created_at, finished_at,
  stage, raw_video_path, failed_stage, watermark_removed, watermark_meta, provider, model, account_id
FROM final_cuts;

-- Giữ bộ đếm AUTOINCREMENT (không để id đã dùng bị cấp lại)
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'final_cuts_new', seq FROM sqlite_sequence
  WHERE name = 'final_cuts' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'final_cuts_new');
UPDATE sqlite_sequence
  SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'final_cuts'), 0))
  WHERE name = 'final_cuts_new';

DROP TABLE final_cuts;
ALTER TABLE final_cuts_new RENAME TO final_cuts;

CREATE INDEX idx_final_cuts_project ON final_cuts(project_id, id);
CREATE INDEX idx_final_cuts_status ON final_cuts(status);
CREATE INDEX idx_final_cuts_job ON final_cuts(job_id);
CREATE UNIQUE INDEX uq_final_cuts_ext_key ON final_cuts(ext_key);
CREATE INDEX idx_final_cuts_parent ON final_cuts(parent_id);
