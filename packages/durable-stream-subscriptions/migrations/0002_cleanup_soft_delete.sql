-- Add soft-delete column for two-phase cleanup
-- This prevents race conditions where a session gets a new subscription
-- while cleanup is running

ALTER TABLE sessions ADD COLUMN marked_for_deletion_at INTEGER;

-- Index for efficient querying of sessions marked for deletion
CREATE INDEX idx_sessions_deletion ON sessions(marked_for_deletion_at);
