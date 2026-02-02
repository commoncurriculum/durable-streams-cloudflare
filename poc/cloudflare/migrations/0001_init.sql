CREATE TABLE streams (
  stream_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  tail_offset INTEGER NOT NULL DEFAULT 0,
  last_stream_seq TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE producers (
  stream_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  last_offset INTEGER NOT NULL,
  PRIMARY KEY (stream_id, producer_id)
);

CREATE TABLE ops (
  stream_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  stream_seq TEXT,
  producer_id TEXT,
  producer_epoch INTEGER,
  producer_seq INTEGER,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, start_offset)
);

CREATE INDEX ops_stream_offset ON ops(stream_id, start_offset);
