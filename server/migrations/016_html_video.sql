-- migrate:foreign-keys-off
-- 016_html_video: tab "Video HTML" (xem PLAN-html-video.md mục 5 và server/API.md mục 15).
-- Nội dung:
--   1. Dựng lại bảng projects để thêm kind 'html' vào CHECK(kind) (SQLite không ALTER được CHECK). ĐÂY LÀ LẦN DỰNG LẠI projects ĐẦU TIÊN:
--      DDL hiệu lực = 001 + cột thêm ở 009 (source, created_by_name), 011 (deleted_at, deleted_by, trash_path, lan_client_hash), 014 (kind, stt_terms);
--      thứ tự cột giữ nguyên. Quy trình 003/014: bảng mới → chép theo TÊN cột → giữ bộ đếm AUTOINCREMENT → DROP → RENAME → tạo lại index
--      (idx_projects_source, idx_projects_deleted). Mọi bảng con (project_refs, scenes, jobs, events, credit_ledger, final_cuts, ai_project_policy,
--      color_refs, source_videos, clips, clip_cuts, ...) tham chiếu projects(id) theo TÊN bảng nên tự nối lại; runner chạy foreign_key_check trước khi commit.
--   2. Dựng lại bảng jobs để thêm loại 'html_compose' vào CHECK(type) (mẫu 014).
--   3. Bảng mới: html_project_meta (cấu hình dự án), html_versions (phiên bản bất biến), html_assets (asset người dùng tải lên),
--      html_version_assets (asset được gắn/chụp vào từng phiên bản), html_renders (lần dựng MP4).
-- Số phiên bản: UNIQUE(project_id, version) + dịch vụ cấp MAX(version)+1 trong cùng transaction. Phiên bản không bao giờ bị xoá riêng lẻ
-- (chỉ biến mất cùng dự án qua CASCADE) nên MAX+1 không tái sử dụng số đã cấp, kể cả với bản failed/cancelled.

-- ---------------------------------------------------------------- 1. projects
CREATE TABLE projects_new (
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
  updated_at             TEXT    NOT NULL,
  source                 TEXT    NOT NULL DEFAULT 'app' CHECK (source IN ('app','lan')),
  created_by_name        TEXT,
  deleted_at             TEXT,
  deleted_by             TEXT    CHECK (deleted_by IS NULL OR deleted_by IN ('app','lan')),
  trash_path             TEXT,
  lan_client_hash        TEXT,
  kind                   TEXT    NOT NULL DEFAULT 'scenes' CHECK (kind IN ('scenes','clips','html')),
  stt_terms              TEXT
);

INSERT INTO projects_new (id, slug, name, brief, style_lock, credit_budget, max_attempts_per_scene, credit_per_video, status, created_at, updated_at,
                          source, created_by_name, deleted_at, deleted_by, trash_path, lan_client_hash, kind, stt_terms)
SELECT id, slug, name, brief, style_lock, credit_budget, max_attempts_per_scene, credit_per_video, status, created_at, updated_at,
       source, created_by_name, deleted_at, deleted_by, trash_path, lan_client_hash, kind, stt_terms
FROM projects;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'projects_new', seq FROM sqlite_sequence
  WHERE name = 'projects' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'projects_new');
UPDATE sqlite_sequence
  SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'projects'), 0))
  WHERE name = 'projects_new';

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX idx_projects_source ON projects(source, id);
CREATE INDEX idx_projects_deleted ON projects(deleted_at) WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------- 2. jobs
CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id         INTEGER REFERENCES scenes(id) ON DELETE CASCADE,   -- NULL với analyze_brief / edit_plan / clip_plan / html_compose
  type             TEXT    NOT NULL CHECK (type IN ('analyze_brief','storyboard','video','revise_prompt','edit_plan','clip_plan','html_compose')),
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
  last_requeued_at TEXT,
  lease_id         TEXT,
  lease_epoch      INTEGER NOT NULL DEFAULT 0,
  worker_mode      TEXT NOT NULL DEFAULT 'legacy',
  wait_reason      TEXT,
  next_attempt_at  TEXT,
  checkpoint       TEXT,
  completion_key   TEXT,
  completion_hash  TEXT
);

INSERT INTO jobs_new (id, project_id, scene_id, type, status, payload, result, error, error_code, claimed_by, claimed_at,
                      heartbeat_at, created_at, finished_at, credits_cost, requires_approval, approved_at, requeue_count, last_requeued_at,
                      lease_id, lease_epoch, worker_mode, wait_reason, next_attempt_at, checkpoint, completion_key, completion_hash)
SELECT id, project_id, scene_id, type, status, payload, result, error, error_code, claimed_by, claimed_at,
       heartbeat_at, created_at, finished_at, credits_cost, requires_approval, approved_at, requeue_count, last_requeued_at,
       lease_id, lease_epoch, worker_mode, wait_reason, next_attempt_at, checkpoint, completion_key, completion_hash
FROM jobs;

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

-- ---------------------------------------------------------------- 3. bảng Video HTML
-- Cấu hình dự án Video HTML (1 dòng/dự án kind='html').
CREATE TABLE html_project_meta (
  project_id    INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  aspect        TEXT    NOT NULL CHECK (aspect IN ('9:16','1:1','16:9')),
  duration_s    INTEGER NOT NULL CHECK (duration_s >= 1 AND duration_s <= 60),
  quality       TEXT    NOT NULL CHECK (quality IN ('720p','1080p')),
  template_id   TEXT,
  model_json    TEXT    NOT NULL DEFAULT '{}',     -- {compose?: string|'auto', vision?: string|'auto'}
  created_at    TEXT    NOT NULL
);

-- Asset người dùng tải lên: output/<slug>/html/assets/<sha256-prefix>-<id>.<ext>. original_name chỉ là nhãn.
CREATE TABLE html_assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT    NOT NULL,
  stored_path   TEXT    NOT NULL,                  -- tương đối từ ROOT
  content_hash  TEXT    NOT NULL,                  -- sha256 hex đầy đủ
  kind          TEXT    NOT NULL CHECK (kind IN ('image','video','audio')),
  media_type    TEXT    NOT NULL,                  -- vd image/png
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  width         INTEGER,
  height        INTEGER,
  duration_s    REAL,
  has_audio     INTEGER CHECK (has_audio IS NULL OR has_audio IN (0,1)),
  created_at    TEXT    NOT NULL
);
CREATE INDEX idx_html_assets_project ON html_assets(project_id, id);

-- Phiên bản. files_dir (tương đối từ ROOT) chỉ có giá trị khi đã công bố (ready); thư mục đó bất biến.
CREATE TABLE html_versions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL CHECK (version >= 1),
  parent_id           INTEGER REFERENCES html_versions(id) ON DELETE SET NULL,
  compose_job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status              TEXT    NOT NULL DEFAULT 'composing'
                      CHECK (status IN ('composing','validating','ready','failed','cancelled')),
  prompt              TEXT    NOT NULL DEFAULT '',
  feedback            TEXT,
  summary             TEXT,
  variables_json      TEXT    NOT NULL DEFAULT '[]',
  manifest_json       TEXT    NOT NULL DEFAULT '[]',     -- [{path, bytes, sha256}]
  files_dir           TEXT,
  content_hash        TEXT,
  lint_report_json    TEXT,
  compose_policy_json TEXT    NOT NULL DEFAULT '{}',
  error               TEXT,
  error_code          TEXT,
  created_by          TEXT    NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai','user')),
  idempotency_key     TEXT,
  created_at          TEXT    NOT NULL,
  published_at        TEXT,
  UNIQUE (project_id, version)
);
CREATE UNIQUE INDEX idx_html_versions_idem ON html_versions(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_html_versions_job ON html_versions(compose_job_id);
CREATE INDEX idx_html_versions_parent ON html_versions(parent_id);
CREATE INDEX idx_html_versions_status ON html_versions(status);

-- Asset gắn với một phiên bản: stored_path/content_hash lấy lúc tạo phiên bản; snapshot_path (tương đối từ ROOT) điền lúc công bố
-- (hard link, dự phòng copy, vào <files_dir>/assets/u/<asset_ref>.<ext>). asset_ref = id của html_assets lúc gắn, KHÔNG là khoá ngoại (cố ý, và đặt tên khác *_id vì test project-trash đòi mọi cột asset_id có FK): asset gốc có thể bị xoá, bản chụp vẫn dùng được.
CREATE TABLE html_version_assets (
  version_id    INTEGER NOT NULL REFERENCES html_versions(id) ON DELETE CASCADE,
  asset_ref     INTEGER NOT NULL,
  stored_path   TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  snapshot_path TEXT,
  PRIMARY KEY (version_id, asset_ref)
);
CREATE INDEX idx_html_version_assets_asset ON html_version_assets(asset_ref);

-- Mỗi lần dựng MP4 một dòng riêng. Một render active (queued|rendering) cho mỗi (version, chất lượng); idempotency_key duy nhất theo version.
CREATE TABLE html_renders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id       INTEGER NOT NULL REFERENCES html_versions(id) ON DELETE CASCADE,
  idempotency_key  TEXT    NOT NULL,
  quality          TEXT    NOT NULL CHECK (quality IN ('720p','1080p')),
  status           TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','ready','failed','cancelled')),
  settings_json    TEXT    NOT NULL DEFAULT '{}',
  source_hash      TEXT,
  video_path       TEXT,
  poster_path      TEXT,
  progress         REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  error            TEXT,
  error_code       TEXT,
  created_at       TEXT    NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  UNIQUE (version_id, idempotency_key)
);
CREATE UNIQUE INDEX idx_html_renders_active ON html_renders(version_id, quality) WHERE status IN ('queued','rendering');
CREATE INDEX idx_html_renders_version ON html_renders(version_id, id);
CREATE INDEX idx_html_renders_status ON html_renders(status);
