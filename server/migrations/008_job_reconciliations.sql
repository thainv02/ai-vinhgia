-- Nhật ký đối soát thủ công của người dùng cho job có thao tác tạo bên ngoài (Flow/ChatGPT) chưa rõ kết quả.
-- Dùng để API đối soát idempotent (bấm lặp không ghi sổ credit/lượt hai lần) và để truy vết ai quyết định gì.
-- Trạng thái action `abandoned` không cần ràng buộc: external_actions.state không có CHECK.
CREATE TABLE job_reconciliations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action_id  TEXT    NOT NULL,
  outcome    TEXT    NOT NULL CHECK (outcome IN ('retry_download','nothing_created','charge_and_fail')),
  prev_state TEXT    NOT NULL,
  note       TEXT,
  credits    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_job_reconciliations_job ON job_reconciliations(job_id, id);
