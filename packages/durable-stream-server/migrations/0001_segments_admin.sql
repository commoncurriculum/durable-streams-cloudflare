CREATE TABLE IF NOT EXISTS segments_admin (
  stream_id TEXT NOT NULL,
  read_seq INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  size_bytes INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  PRIMARY KEY (stream_id, read_seq)
);

CREATE INDEX IF NOT EXISTS segments_admin_stream_end
  ON segments_admin(stream_id, end_offset);
