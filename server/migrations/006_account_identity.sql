-- Credential values remain outside SQLite. Identity fingerprints only prevent counting one login twice.
ALTER TABLE ai_accounts ADD COLUMN identity_hash TEXT;
CREATE INDEX idx_ai_account_identity ON ai_accounts(provider,identity_hash);
