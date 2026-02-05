import {
  markExpiredSessions,
  getSessionsToDelete,
  deleteExpiredSessions,
  getSubscriptionCount,
} from "./storage";
import { deleteSessionStreamWithEnv, type FanoutEnv } from "./fanout";
import { createMetrics } from "./metrics";

export interface CleanupEnv extends FanoutEnv {
  SESSION_TTL_SECONDS?: string;
}

// Grace period: sessions must be marked for deletion for this long
// before actually being deleted. This prevents race conditions where
// a session gets a new subscription while cleanup is running.
const GRACE_PERIOD_MS = 60_000; // 1 minute

export interface CleanupResult {
  marked: number;
  deleted: number;
  streamDeleteSuccesses: number;
  streamDeleteFailures: number;
}

export async function cleanupExpiredSessions(env: CleanupEnv): Promise<CleanupResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);

  // Phase 1: Mark newly expired sessions
  const { marked } = await markExpiredSessions(env.DB);

  // Phase 2: Delete sessions that have been marked for > grace period
  // AND are still expired (not touched since being marked)
  const sessionsToDelete = await getSessionsToDelete(env.DB, GRACE_PERIOD_MS);

  if (sessionsToDelete.length === 0) {
    const latencyMs = Date.now() - start;
    metrics.cleanupBatch(marked, 0, 0, 0, latencyMs);
    return { marked, deleted: 0, streamDeleteSuccesses: 0, streamDeleteFailures: 0 };
  }

  // Record per-session expiry metrics before deletion (parallelized for performance)
  const subCountPromises = sessionsToDelete.map((session) =>
    getSubscriptionCount(env.DB, session.session_id),
  );
  const subCounts = await Promise.all(subCountPromises);

  sessionsToDelete.forEach((session, index) => {
    const ageMs = Date.now() - session.created_at;
    metrics.sessionExpire(session.session_id, subCounts[index], ageMs);
  });

  // Delete session streams from core using Promise.allSettled
  // Uses service binding if available for better performance
  const deleteResults = await Promise.allSettled(
    sessionsToDelete.map((session) =>
      deleteSessionStreamWithEnv(env, session.session_id),
    ),
  );

  const streamDeleteSuccesses = deleteResults.filter(
    (r) => r.status === "fulfilled" && (r.value.ok || r.value.status === 404),
  ).length;
  const streamDeleteFailures = deleteResults.length - streamDeleteSuccesses;

  if (streamDeleteFailures > 0) {
    console.error(
      `Failed to delete ${streamDeleteFailures}/${sessionsToDelete.length} session streams from core`,
    );
  }

  // Delete session records and subscriptions from D1
  // Even if some core deletions failed, we still clean up D1
  // The reconciliation endpoint can be used to handle edge cases
  const sessionIds = sessionsToDelete.map((s) => s.session_id);
  await deleteExpiredSessions(env.DB, sessionIds);

  // Record aggregate cleanup metrics
  const latencyMs = Date.now() - start;
  metrics.cleanupBatch(marked, sessionsToDelete.length, streamDeleteSuccesses, streamDeleteFailures, latencyMs);

  return {
    marked,
    deleted: sessionsToDelete.length,
    streamDeleteSuccesses,
    streamDeleteFailures,
  };
}
