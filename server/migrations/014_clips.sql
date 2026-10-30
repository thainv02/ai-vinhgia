-- migrate:foreign-keys-off
-- 014_clips: tính năng "Cắt clip từ video dài" (xem PLAN-long-video-to-shorts.md và server/API.md mục "Cắt clip").
-- Nội dung:
--   1. projects.kind ('scenes' mặc định | 'clips') và projects.stt_terms (tên riêng/thuật ngữ gợi ý cho nhận dạng lời nói).
--   2. Dựng lại bảng jobs để thêm loại 'clip_plan' vào CHECK(type) (SQLite không ALTER được CHECK), đúng quy trình 003:
--      tạo bảng mới → chép theo TÊN cột → giữ bộ đếm AUTOINCREMENT → DROP → RENAME → tạo lại index.
--      Runner tắt foreign_keys trước khi mở transaction và chạy PRAGMA foreign_key_check trước khi commit (xem db/index.ts).
--      Các bảng có khóa ngoại tới jobs(id) và giữ nguyên (tham chiếu theo TÊN bảng nên tự nối lại với bảng jobs mới):
--      assets, credit_ledger (001), final_cuts (003/005/012), ai_attempts, external_actions, browser_leases (005), job_reconciliations (008),
--      và clips (bảng mới dưới đây).
--   3. source_videos, clips, clip_cuts (bảng mới).
-- Thêm so với đặc tả (chỉ bổ sung cột, không đổi hợp đồng API): source_videos.deleted_at (video nguồn LAN đã bị xoá sau hạn lưu),
--   clips.start_word/end_word (chỉ số từ toàn cục của hai đầu clip), clips.caption_source ('ai' = đã khôi phục dấu câu, 'user' = sửa tay).

ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'scenes' CHECK (kind IN ('scenes','clips'));
ALTER TABLE projects ADD COLUMN stt_terms TEXT;

CREATE TABLE jobs_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id         INTEGER REFERENCES scenes(id) ON DELETE CASCADE,   -- NULL với analyze_brief / edit_plan / clip_plan
  type             TEXT    NOT NULL CHECK (type IN ('analyze_brief','storyboard','video','revise_prompt','edit_plan','clip_plan')),
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

-- Video nguồn (đợt 1: mỗi dự án cắt clip có 1 video nguồn, bảng giữ tổng quát).
CREATE TABLE source_videos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path            TEXT,                                   -- tương đối từ ROOT: output/<slug>/clips/source/<hash16>.<ext>; NULL khi video đã bị xoá
  original_name   TEXT    NOT NULL,
  bytes           INTEGER NOT NULL,
  duration_s      REAL,
  width           INTEGER,
  height          INTEGER,
  fps             REAL,
  has_audio       INTEGER NOT NULL DEFAULT 1 CHECK (has_audio IN (0,1)),
  status          TEXT    NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded','transcribing','transcribed','failed','cancelled')),
  progress        REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  error           TEXT,
  error_code      TEXT,
  stt_job_id      TEXT,                                   -- X-Job-Id của dịch vụ nhận dạng (để lấy lại kết quả khi đứt kết nối)
  transcript_path TEXT,                                   -- output/<slug>/clips/transcript.json
  stt_meta        TEXT,                                   -- JSON {model, elapsed_ms, word_count, speech_ratio, terms}
  content_hash    TEXT    NOT NULL,                       -- sha256 hex của file
  created_at      TEXT    NOT NULL,
  transcribed_at  TEXT,
  deleted_at      TEXT                                    -- video nguồn LAN bị xoá sau hạn lưu (giữ transcript, bản xem thử và clip)
);
CREATE INDEX idx_source_videos_project ON source_videos(project_id, id);
CREATE INDEX idx_source_videos_status ON source_videos(status);
CREATE INDEX idx_source_videos_hash ON source_videos(content_hash);

-- Đoạn clip đề xuất / do người dùng tạo.
CREATE TABLE clips (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  code            TEXT    NOT NULL,                       -- K1, K2... duy nhất trong dự án
  status          TEXT    NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  start_sentence  INTEGER NOT NULL,
  end_sentence    INTEGER NOT NULL,
  start_word      INTEGER NOT NULL,
  end_word        INTEGER NOT NULL,
  start_s         REAL    NOT NULL,                       -- đã bám khoảng lặng
  end_s           REAL    NOT NULL,
  title           TEXT,
  hook            TEXT,
  score           INTEGER,
  reason          TEXT,
  content_type    TEXT,
  verify          TEXT,                                   -- JSON {status, keep, standalone_score, diagnosis, ...}
  created_by      TEXT    NOT NULL CHECK (created_by IN ('agent','user')),
  job_id          INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  caption_words   TEXT,                                   -- JSON [{i,w}] chữ phụ đề đã khôi phục dấu câu hoặc sửa tay; NULL = dùng chữ ASR
  caption_source  TEXT    CHECK (caption_source IS NULL OR caption_source IN ('ai','user')),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (project_id, code)
);
CREATE INDEX idx_clips_project ON clips(project_id, id);
CREATE INDEX idx_clips_source ON clips(source_id);
CREATE INDEX idx_clips_job ON clips(job_id);

-- Phiên bản dựng của từng clip.
CREATE TABLE clip_cuts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id      INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'rendering' CHECK (status IN ('rendering','ready','failed','cancelled')),
  stage        TEXT,                                      -- prepare | render | thumb (chỉ khi status='rendering')
  progress     REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  error        TEXT,
  aspect       TEXT    NOT NULL DEFAULT '9:16' CHECK (aspect IN ('9:16','1:1','16:9','source')),
  reframe      TEXT    NOT NULL DEFAULT '{"mode":"fit"}', -- JSON {mode:'center'|'fit'|'native'}
  captions     TEXT    NOT NULL DEFAULT '{"preset":"highlight"}', -- JSON {preset:'highlight'|'karaoke'|'minimal'|'none'}
  start_s      REAL    NOT NULL,                          -- điểm cắt tại thời điểm dựng (không đổi khi sửa clip sau đó)
  end_s        REAL    NOT NULL,
  video_path   TEXT,
  srt_path     TEXT,
  ass_path     TEXT,
  duration_s   REAL,
  parent_id    INTEGER REFERENCES clip_cuts(id) ON DELETE SET NULL,   -- chừa cho góp ý AI (P5)
  feedback     TEXT,
  grade        TEXT,
  created_at   TEXT    NOT NULL,
  finished_at  TEXT,
  UNIQUE (clip_id, version)
);
CREATE INDEX idx_clip_cuts_clip ON clip_cuts(clip_id, id);
CREATE INDEX idx_clip_cuts_project ON clip_cuts(project_id, id);
CREATE INDEX idx_clip_cuts_status ON clip_cuts(status);
