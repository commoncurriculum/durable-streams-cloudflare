/**
 * Minimal in-memory fake for Cloudflare's SqlStorage interface.
 *
 * Handles only the SQL patterns used by SubscriptionDO:
 *   CREATE TABLE, INSERT ... ON CONFLICT DO NOTHING, DELETE WHERE, SELECT
 *
 * The exec() method returns an iterable cursor with named row properties,
 * matching the SqlStorageCursor contract used in production code.
 */

interface Row {
  [key: string]: string | number;
}

export function createTestSqlStorage() {
  const rows: Map<string, Row> = new Map(); // keyed by session_id

  return {
    exec(query: string, ...bindings: unknown[]): Iterable<Row> {
      const trimmed = query.replace(/\s+/g, " ").trim();

      // CREATE TABLE — no-op
      if (/^CREATE TABLE/i.test(trimmed)) {
        return [];
      }

      // INSERT ... ON CONFLICT DO NOTHING
      if (/^INSERT INTO subscribers/i.test(trimmed)) {
        const sessionId = bindings[0] as string;
        const subscribedAt = bindings[1] as number;
        if (!rows.has(sessionId)) {
          rows.set(sessionId, { session_id: sessionId, subscribed_at: subscribedAt });
        }
        return [];
      }

      // DELETE FROM subscribers WHERE session_id = ?
      if (/^DELETE FROM subscribers/i.test(trimmed)) {
        const sessionId = bindings[0] as string;
        rows.delete(sessionId);
        return [];
      }

      // SELECT session_id, subscribed_at FROM subscribers
      if (/^SELECT session_id, subscribed_at/i.test(trimmed)) {
        return [...rows.values()];
      }

      // SELECT session_id FROM subscribers
      if (/^SELECT session_id/i.test(trimmed)) {
        return [...rows.values()].map((r) => ({ session_id: r.session_id }));
      }

      throw new Error(`Unhandled SQL in test fake: ${trimmed}`);
    },
  };
}
