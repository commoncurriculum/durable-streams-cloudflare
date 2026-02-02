ALTER TABLE streams ADD COLUMN ttl_seconds INTEGER;
ALTER TABLE streams ADD COLUMN expires_at INTEGER;

CREATE TABLE snapshots (
  stream_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, r2_key)
);
