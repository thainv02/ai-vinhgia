-- Observed provider quota is display-only; it must not be inferred from retry cooldowns.
ALTER TABLE ai_accounts ADD COLUMN quota_snapshot TEXT;
ALTER TABLE ai_accounts ADD COLUMN quota_checked_at TEXT;
ALTER TABLE ai_accounts ADD COLUMN quota_error TEXT;
