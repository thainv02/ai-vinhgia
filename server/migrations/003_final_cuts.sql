-- migrate:foreign-keys-off
-- 003_final_cuts: bản dựng hoàn chỉnh (final_cuts) + job type `edit_plan`.
-- Bảng jobs có CHECK(type IN (...)) từ 001 nên phải dựng lại bảng (SQLite không ALTER được CHECK).
-- Runner tắt foreign_keys trước khi mở transaction và chạy PRAGMA foreign_key_check trước khi commit (xem db/index.ts).
-- Giữ nguyên dữ liệu, id (kể cả bộ đếm AUTOINCREMENT), index và các khóa ngoại tới jobs(id) của assets / credit_ledger.

CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id         INTEGER REFERENCES scenes(id) ON DELETE CASCADE,   -- NULL với analyze_brief / edit_plan
  type             TEXT    NOT NULL CHECK (type IN ('analyze_brief','storyboard','video','revise_prompt','edit_plan')),
  status           TEXT    NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','claimed','running','done','failed','cancelled')),
  payload          TEXT    NOT NULL DEFAULT '{}',
  result           TEXT,
  error            TEXT,
  error_code       TEXT,
  claimed_by       TEXT,
  claimed_at       TEXT,
  heartbeat_at     TEXT,
  created_at       TEXT    NOT NULL,
  finished_at      TEXT,
  credits_cost     INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0,1)),
  approved_at      TEXT,
  requeue_count    INTEGER NOT NULL DEFAULT 0,
  last_requeued_at TEXT
);

INSERT INTO jobs_new (id, project_id, scene_id, type, status, payload, result, error, error_code, claimed_by, claimed_at,
                      heartbeat_at, created_at, finished_at, credits_cost, requires_approval, approved_at, requeue_count, last_requeued_at)
SELECT id, project_id, scene_id, type, status, payload, result, error, error_code, claimed_by, claimed_at,
       heartbeat_at, created_at, finished_at, credits_cost, requires_approval, approved_at, requeue_count, last_requeued_at
FROM jobs;

-- Giữ bộ đếm AUTOINCREMENT (không để id đã dùng bị cấp lại)
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'jobs_new', seq FROM sqlite_sequence
  WHERE name = 'jobs' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'jobs_new');
UPDATE sqlite_sequence
  SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'jobs'), 0))
  WHERE name = 'jobs_new';

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_status ON jobs(status, id);
CREATE INDEX idx_jobs_project ON jobs(project_id, id);
CREATE INDEX idx_jobs_scene ON jobs(scene_id, status);
CREATE INDEX idx_jobs_type_status ON jobs(type, status);

CREATE TABLE final_cuts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning','rendering','ready','failed','cancelled')),
  selection           TEXT    NOT NULL DEFAULT '[]',   -- JSON [{scene_id, code, asset_id, attempt}] theo thứ tự cảnh
  selection_signature TEXT    NOT NULL,                -- sha256 của (scene_id, asset_id) theo thứ tự cảnh
  edl                 TEXT,                            -- JSON {scenes:[{scene_id, asset_id, segments, removed, note}]}
  renderer            TEXT    CHECK (renderer IS NULL OR renderer IN ('shotcut','ffmpeg')),
  video_path          TEXT,                            -- tương đối từ ROOT, vd output/<slug>/final/<slug>_final_v1.mp4
  project_file_path   TEXT,                            -- .mlt (chỉ khi dựng bằng Shotcut)
  contact_sheet_path  TEXT,
  duration_s          REAL,
  job_id              INTEGER REFERENCES jobs(id) ON DELETE SET NULL,   -- job edit_plan
  render_ref          TEXT,                            -- job_id render của Shotcut MCP
  progress            REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  created_by          TEXT    NOT NULL CHECK (created_by IN ('claude','user')),
  note                TEXT,
  summary             TEXT,
  error               TEXT,
  ext_key             TEXT,
  created_at          TEXT    NOT NULL,
  finished_at         TEXT,
  UNIQUE (project_id, version)
);
CREATE INDEX idx_final_cuts_project ON final_cuts(project_id, id);
CREATE INDEX idx_final_cuts_status ON final_cuts(status);
CREATE INDEX idx_final_cuts_job ON final_cuts(job_id);
CREATE UNIQUE INDEX uq_final_cuts_ext_key ON final_cuts(ext_key);
