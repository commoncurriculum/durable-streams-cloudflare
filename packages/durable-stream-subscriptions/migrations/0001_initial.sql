-- Sessions table
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  ttl_seconds INTEGER DEFAULT 1800
);

CREATE INDEX idx_sessions_expiry ON sessions(last_active_at);

-- Subscriptions mapping table (session <-> stream)
CREATE TABLE subscriptions (
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  subscribed_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, stream_id)
);

-- Index for fanout: find all sessions subscribed to a stream
CREATE INDEX idx_subscriptions_by_stream ON subscriptions(stream_id);

-- Index for cleanup: find all subscriptions for a session
CREATE INDEX idx_subscriptions_by_session ON subscriptions(session_id);
