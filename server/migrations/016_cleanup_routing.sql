-- Preserve 015 and existing jobs; advertise cleanup support independently of heartbeat.
ALTER TABLE worker_sessions ADD COLUMN features TEXT NOT NULL DEFAULT '[]';

-- Keep large clip-discovery payloads out of cleanup lookups and project polling.
CREATE INDEX idx_jobs_clip_cleanup ON jobs (
  project_id, json_extract(payload, '$.clip_id'), json_extract(payload, '$.edit_revision'), id DESC
) WHERE type = 'clip_plan' AND json_extract(payload, '$.mode') = 'cleanup';
CREATE INDEX idx_jobs_clip_discovery ON jobs (project_id, id DESC)
WHERE type = 'clip_plan' AND COALESCE(json_extract(payload, '$.mode'), '') != 'cleanup';
