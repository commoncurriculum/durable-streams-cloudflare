-- Add deleted_at column to streams table for soft deletes
ALTER TABLE streams ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS streams_deleted_at
  ON streams(deleted_at);
