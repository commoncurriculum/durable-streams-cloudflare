CREATE TABLE IF NOT EXISTS streams (
  stream_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS streams_created_at
  ON streams(created_at);
