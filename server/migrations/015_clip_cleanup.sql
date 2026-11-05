-- Non-destructive edit proposals, approval state and immutable render snapshots.
ALTER TABLE clips ADD COLUMN cleanup TEXT;
ALTER TABLE clips ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clip_cuts ADD COLUMN edit_snapshot TEXT;
