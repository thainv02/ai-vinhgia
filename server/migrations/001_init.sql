-- 001_init: toàn bộ bảng của plan mục 5 + cột bổ sung theo decisions (slug, project_id/requeue/error_code của jobs,
-- ext_key cho import idempotent, worker_state). Thời gian lưu ISO 8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ).

CREATE TABLE projects (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                   TEXT    NOT NULL UNIQUE,
  name                   TEXT    NOT NULL,
  brief                  TEXT    NOT NULL DEFAULT '',
  style_lock             TEXT    NOT NULL DEFAULT '',
  credit_budget          INTEGER NOT NULL DEFAULT 0   CHECK (credit_budget >= 0),
  max_attempts_per_scene INTEGER NOT NULL DEFAULT 2   CHECK (max_attempts_per_scene >= 1),
  credit_per_video       INTEGER NOT NULL DEFAULT 15  CHECK (credit_per_video >= 0),
  status                 TEXT    NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','analyzing','active','archived')),
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

CREATE TABLE project_refs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,
  file_path     TEXT    NOT NULL,           -- tương đối từ ROOT, vd refs/1/box.png
  original_name TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);
CREATE INDEX idx_project_refs_project ON project_refs(project_id, order_index);

CREATE TABLE scenes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code                TEXT    NOT NULL,     -- C1, C2...
  order_index         INTEGER NOT NULL DEFAULT 0,
  title               TEXT    NOT NULL DEFAULT '',
  prompt              TEXT    NOT NULL DEFAULT '',
  first_frame_desc    TEXT    NOT NULL DEFAULT '',
  upload_refs         TEXT    NOT NULL DEFAULT '[]',   -- JSON mảng id project_refs theo thứ tự upload
  use_prev_storyboard INTEGER NOT NULL DEFAULT 0 CHECK (use_prev_storyboard IN (0,1)),
  status              TEXT    NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','prompt_ready','awaiting_approval','storyboard_queued','storyboard_running',
                                        'storyboard_review','video_queued','video_running','video_review','done',
                                        'needs_revision','failed','blocked_budget','cancelled')),
  selected_video_id   INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE (project_id, code)
);
CREATE INDEX idx_scenes_project ON scenes(project_id, order_index);
CREATE INDEX idx_scenes_status ON scenes(project_id, status);

CREATE TABLE scene_prompt_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  prompt     TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  created_by TEXT    NOT NULL CHECK (created_by IN ('claude','user')),
  created_at TEXT    NOT NULL,
  ext_key    TEXT,
  UNIQUE (scene_id, version)
);
CREATE UNIQUE INDEX uq_prompt_versions_ext_key ON scene_prompt_versions(ext_key);

CREATE TABLE jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id         INTEGER REFERENCES scenes(id) ON DELETE CASCADE,   -- NULL với analyze_brief
  type             TEXT    NOT NULL CHECK (type IN ('analyze_brief','storyboard','video','revise_prompt')),
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
CREATE INDEX idx_jobs_status ON jobs(status, id);
CREATE INDEX idx_jobs_project ON jobs(project_id, id);
CREATE INDEX idx_jobs_scene ON jobs(scene_id, status);
CREATE INDEX idx_jobs_type_status ON jobs(type, status);

CREATE TABLE assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id     INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('storyboard','video','grid')),
  file_path    TEXT    NOT NULL,           -- tương đối từ ROOT, vd output/cacao-smoothie/video/C1_v2.mp4
  attempt      INTEGER NOT NULL DEFAULT 1,
  meta         TEXT    NOT NULL DEFAULT '{}',
  verdict      TEXT    CHECK (verdict IS NULL OR verdict IN ('pass','fix_in_edit','redo')),
  verdict_note TEXT,
  created_at   TEXT    NOT NULL,
  ext_key      TEXT
);
CREATE INDEX idx_assets_scene ON assets(scene_id, kind, id);
CREATE UNIQUE INDEX uq_assets_ext_key ON assets(ext_key);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  asset_id   INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  author     TEXT    NOT NULL CHECK (author IN ('user','claude')),
  body       TEXT    NOT NULL,
  timecode   REAL,                          -- giây trong video, nullable
  action     TEXT    NOT NULL DEFAULT 'note'
             CHECK (action IN ('note','revise_and_regenerate','regenerate_same','regenerate_storyboard')),
  resolved   INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  created_at TEXT    NOT NULL,
  ext_key    TEXT
);
CREATE INDEX idx_comments_scene ON comments(scene_id, id);
CREATE UNIQUE INDEX uq_comments_ext_key ON comments(ext_key);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id   INTEGER REFERENCES scenes(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  ext_key    TEXT
);
CREATE INDEX idx_events_project ON events(project_id, id);
CREATE INDEX idx_events_scene ON events(scene_id, id);
CREATE UNIQUE INDEX uq_events_ext_key ON events(ext_key);

CREATE TABLE credit_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id   INTEGER REFERENCES scenes(id) ON DELETE SET NULL,
  job_id     INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  delta      INTEGER NOT NULL,              -- âm khi tốn credit
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL,
  ext_key    TEXT
);
CREATE INDEX idx_ledger_project ON credit_ledger(project_id, id);
CREATE UNIQUE INDEX uq_ledger_ext_key ON credit_ledger(ext_key);

-- Một dòng duy nhất (id = 1)
CREATE TABLE worker_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen_at  TEXT,
  worker_id     TEXT,
  queue_paused  INTEGER NOT NULL DEFAULT 0 CHECK (queue_paused IN (0,1)),
  pause_reason  TEXT,
  pause_code    TEXT,
  paused_at     TEXT
);
INSERT INTO worker_state (id) VALUES (1);
