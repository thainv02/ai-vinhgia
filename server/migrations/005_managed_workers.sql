-- migrate:foreign-keys-off

-- Preserve legacy authors; managed workers use agent and explicit provider provenance.

CREATE TABLE scene_prompt_versions_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  prompt     TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  created_by TEXT    NOT NULL CHECK (created_by IN ('claude','user','agent')),
  created_at TEXT    NOT NULL,
  ext_key    TEXT,
  UNIQUE (scene_id, version)
);

INSERT INTO scene_prompt_versions_new SELECT * FROM scene_prompt_versions;

INSERT INTO sqlite_sequence(name,seq) SELECT 'scene_prompt_versions_new',seq FROM sqlite_sequence WHERE name='scene_prompt_versions' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='scene_prompt_versions_new');

UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='scene_prompt_versions'),0)) WHERE name='scene_prompt_versions_new';

DROP TABLE scene_prompt_versions;

ALTER TABLE scene_prompt_versions_new RENAME TO scene_prompt_versions;

CREATE UNIQUE INDEX uq_prompt_versions_ext_key ON scene_prompt_versions(ext_key);

ALTER TABLE scene_prompt_versions ADD COLUMN provider TEXT;

ALTER TABLE scene_prompt_versions ADD COLUMN model TEXT;

ALTER TABLE scene_prompt_versions ADD COLUMN account_id INTEGER;

CREATE TABLE comments_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  asset_id   INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  author     TEXT    NOT NULL CHECK (author IN ('user','claude','agent')),
  body       TEXT    NOT NULL,
  timecode   REAL,                          -- giây trong video, nullable
  action     TEXT    NOT NULL DEFAULT 'note'
             CHECK (action IN ('note','revise_and_regenerate','regenerate_same','regenerate_storyboard')),
  resolved   INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  created_at TEXT    NOT NULL,
  ext_key    TEXT
);

INSERT INTO comments_new SELECT * FROM comments;

INSERT INTO sqlite_sequence(name,seq) SELECT 'comments_new',seq FROM sqlite_sequence WHERE name='comments' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='comments_new');

UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='comments'),0)) WHERE name='comments_new';

DROP TABLE comments;

ALTER TABLE comments_new RENAME TO comments;

CREATE INDEX idx_comments_scene ON comments(scene_id, id);

CREATE UNIQUE INDEX uq_comments_ext_key ON comments(ext_key);

ALTER TABLE comments ADD COLUMN provider TEXT;

ALTER TABLE comments ADD COLUMN model TEXT;

ALTER TABLE comments ADD COLUMN account_id INTEGER;

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
  video_path          TEXT,                            -- tương đối từ ROOT, vd output/<slug>/final/<slug>_final_v1.mp4
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
  finished_at         TEXT, stage TEXT CHECK (stage IS NULL OR stage IN ('render','clean')), raw_video_path TEXT, failed_stage TEXT CHECK (failed_stage IS NULL OR failed_stage IN ('render','clean')), watermark_removed INTEGER NOT NULL DEFAULT 0 CHECK (watermark_removed IN (0,1)), watermark_meta TEXT,
  UNIQUE (project_id, version)
);

INSERT INTO final_cuts_new SELECT * FROM final_cuts;

INSERT INTO sqlite_sequence(name,seq) SELECT 'final_cuts_new',seq FROM sqlite_sequence WHERE name='final_cuts' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='final_cuts_new');

UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='final_cuts'),0)) WHERE name='final_cuts_new';

DROP TABLE final_cuts;

ALTER TABLE final_cuts_new RENAME TO final_cuts;

CREATE INDEX idx_final_cuts_project ON final_cuts(project_id, id);

CREATE INDEX idx_final_cuts_status ON final_cuts(status);

CREATE INDEX idx_final_cuts_job ON final_cuts(job_id);

CREATE UNIQUE INDEX uq_final_cuts_ext_key ON final_cuts(ext_key);

ALTER TABLE final_cuts ADD COLUMN provider TEXT;

ALTER TABLE final_cuts ADD COLUMN model TEXT;

ALTER TABLE final_cuts ADD COLUMN account_id INTEGER;


ALTER TABLE jobs ADD COLUMN lease_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN worker_mode TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE jobs ADD COLUMN wait_reason TEXT;
ALTER TABLE jobs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE jobs ADD COLUMN checkpoint TEXT;
ALTER TABLE jobs ADD COLUMN completion_key TEXT;
ALTER TABLE jobs ADD COLUMN completion_hash TEXT;

CREATE TABLE ai_accounts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 alias TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('codex','antigravity','claude','openai')),
 adapter TEXT NOT NULL DEFAULT 'openai-compatible',
 base_url TEXT NOT NULL UNIQUE,
 model TEXT NOT NULL,
 key_env TEXT,
 enabled INTEGER NOT NULL DEFAULT 1,
 priority INTEGER NOT NULL DEFAULT 100,
 capabilities TEXT NOT NULL DEFAULT '["text","vision","tools"]',
 quota_scope_key TEXT,
 state TEXT NOT NULL DEFAULT 'unknown',
 retry_after TEXT,
 reserved_until TEXT,
 reservation_id TEXT,
 last_error TEXT,
 last_used_at TEXT,
 last_checked_at TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE ai_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id INTEGER REFERENCES ai_accounts(id) ON DELETE SET NULL,
 job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
 model TEXT NOT NULL,
 outcome TEXT NOT NULL,
 latency_ms INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE ai_project_policy (
 project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 policy TEXT NOT NULL
);
CREATE TABLE worker_sessions (
 worker_id TEXT PRIMARY KEY,
 mode TEXT NOT NULL,
 last_seen_at TEXT NOT NULL
);
CREATE TABLE external_actions (
 id TEXT PRIMARY KEY,
 job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 lease_epoch INTEGER NOT NULL,
 profile TEXT NOT NULL,
 kind TEXT NOT NULL,
 state TEXT NOT NULL,
 evidence TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_external_job ON external_actions(job_id);
CREATE INDEX idx_ai_attempt_job ON ai_attempts(job_id,id);
CREATE TABLE browser_leases (
 profile TEXT PRIMARY KEY,
 job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 lease_id TEXT NOT NULL,
 expires_at TEXT NOT NULL
);

