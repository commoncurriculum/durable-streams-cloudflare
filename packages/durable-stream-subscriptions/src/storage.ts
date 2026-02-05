export interface Session {
  session_id: string;
  created_at: number;
  last_active_at: number;
  ttl_seconds: number;
  marked_for_deletion_at: number | null;
}

export interface Subscription {
  session_id: string;
  stream_id: string;
  subscribed_at: number;
}

export async function createSession(
  db: D1Database,
  sessionId: string,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (session_id, created_at, last_active_at, ttl_seconds)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_active_at = ?`,
    )
    .bind(sessionId, now, now, ttlSeconds, now)
    .run();
}

export async function getSession(db: D1Database, sessionId: string): Promise<Session | null> {
  const result = await db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<Session>();
  return result ?? null;
}

export async function touchSession(db: D1Database, sessionId: string): Promise<boolean> {
  // Also clear deletion mark if session was touched (prevents race condition in cleanup)
  const result = await db
    .prepare(
      "UPDATE sessions SET last_active_at = ?, marked_for_deletion_at = NULL WHERE session_id = ?",
    )
    .bind(Date.now(), sessionId)
    .run();
  return result.meta.changes > 0;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM subscriptions WHERE session_id = ?").bind(sessionId),
    db.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId),
  ]);
}

export async function addSubscription(
  db: D1Database,
  sessionId: string,
  streamId: string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare("UPDATE sessions SET last_active_at = ? WHERE session_id = ?")
      .bind(now, sessionId),
    db
      .prepare(
        `INSERT INTO subscriptions (session_id, stream_id, subscribed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id, stream_id) DO NOTHING`,
      )
      .bind(sessionId, streamId, now),
  ]);
}

export async function removeSubscription(
  db: D1Database,
  sessionId: string,
  streamId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM subscriptions WHERE session_id = ? AND stream_id = ?")
    .bind(sessionId, streamId)
    .run();
}

export async function getSessionSubscriptions(
  db: D1Database,
  sessionId: string,
): Promise<Subscription[]> {
  const result = await db
    .prepare("SELECT * FROM subscriptions WHERE session_id = ?")
    .bind(sessionId)
    .all<Subscription>();
  return result.results;
}

export async function getStreamSubscribers(
  db: D1Database,
  streamId: string,
): Promise<string[]> {
  const result = await db
    .prepare("SELECT session_id FROM subscriptions WHERE stream_id = ?")
    .bind(streamId)
    .all<{ session_id: string }>();
  return result.results.map((r) => r.session_id);
}

export async function getExpiredSessions(
  db: D1Database,
  now: number,
): Promise<Session[]> {
  const result = await db
    .prepare(
      `SELECT * FROM sessions
       WHERE (last_active_at + (ttl_seconds * 1000)) < ?
       AND marked_for_deletion_at IS NULL`,
    )
    .bind(now)
    .all<Session>();
  return result.results;
}

export async function getAllSessions(db: D1Database): Promise<Session[]> {
  const result = await db.prepare("SELECT * FROM sessions").all<Session>();
  return result.results;
}

export async function deleteExpiredSessions(
  db: D1Database,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;

  const placeholders = sessionIds.map(() => "?").join(",");
  await db.batch([
    db
      .prepare(`DELETE FROM subscriptions WHERE session_id IN (${placeholders})`)
      .bind(...sessionIds),
    db
      .prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`)
      .bind(...sessionIds),
  ]);
}

// Two-phase cleanup to prevent race conditions

// Phase 1: Mark expired sessions for deletion
export async function markExpiredSessions(db: D1Database): Promise<{ marked: number }> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE sessions
       SET marked_for_deletion_at = ?
       WHERE marked_for_deletion_at IS NULL
         AND (last_active_at + (ttl_seconds * 1000)) < ?`,
    )
    .bind(now, now)
    .run();

  return { marked: result.meta.changes };
}

// Phase 2: Get sessions that were marked for deletion longer than grace period ago
// AND are still expired (not touched since being marked)
export async function getSessionsToDelete(
  db: D1Database,
  gracePeriodMs: number,
): Promise<Session[]> {
  const cutoff = Date.now() - gracePeriodMs;
  const now = Date.now();

  const result = await db
    .prepare(
      `SELECT * FROM sessions
       WHERE marked_for_deletion_at IS NOT NULL
         AND marked_for_deletion_at < ?
         AND (last_active_at + (ttl_seconds * 1000)) < ?`,
    )
    .bind(cutoff, now)
    .all<Session>();

  return result.results;
}

// Get count of subscriptions for a session (for metrics)
export async function getSubscriptionCount(
  db: D1Database,
  sessionId: string,
): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM subscriptions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}
