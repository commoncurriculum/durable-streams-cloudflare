// #region synced-to-docs:metrics-overview
/**
 * Metrics helper for Analytics Engine observability.
 *
 * All metrics use this structure:
 * - blobs: [streamId, sessionId, eventType, errorType?] (up to 20 blobs)
 * - doubles: [count, latencyMs, ...] (up to 20 doubles)
 * - indexes: [eventCategory] (1 index for querying)
 */
export class Metrics {
  constructor(private ae: AnalyticsEngineDataset | undefined) {}
  // #endregion synced-to-docs:metrics-overview

  // #region synced-to-docs:metrics-fanout-subscription
  // Fanout events
  fanout(p: { streamId: string; subscribers: number; success: number; failures: number; latencyMs: number }) {
    this.ae?.writeDataPoint({
      blobs: [p.streamId, "", "fanout", ""],
      doubles: [p.subscribers, p.success, p.failures, p.latencyMs],
      indexes: ["fanout"],
    });
  }

  fanoutQueued(streamId: string, subscribers: number, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [streamId, "", "fanout_queued", ""],
      doubles: [subscribers, latencyMs, 0, 0],
      indexes: ["fanout"],
    });
  }

  // Subscription events
  subscribe(streamId: string, sessionId: string, isNewSession: boolean, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [streamId, sessionId, "subscribe", ""],
      doubles: [1, latencyMs, isNewSession ? 1 : 0, 0],
      indexes: ["subscription"],
    });
  }

  unsubscribe(streamId: string, sessionId: string, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [streamId, sessionId, "unsubscribe", ""],
      doubles: [1, latencyMs, 0, 0],
      indexes: ["subscription"],
    });
  }
  // #endregion synced-to-docs:metrics-fanout-subscription

  // #region synced-to-docs:metrics-session-cleanup
  // Session lifecycle events
  sessionCreate(sessionId: string, project: string, ttlSeconds: number, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [project, sessionId, "session_create", ""],
      doubles: [1, latencyMs, ttlSeconds, 0],
      indexes: ["session"],
    });
  }

  sessionTouch(sessionId: string, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: ["", sessionId, "session_touch", ""],
      doubles: [1, latencyMs, 0, 0],
      indexes: ["session"],
    });
  }

  sessionDelete(sessionId: string, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: ["", sessionId, "session_delete", ""],
      doubles: [1, latencyMs, 0, 0],
      indexes: ["session"],
    });
  }

  sessionExpire(sessionId: string, subscriptionCount: number, ageMs: number) {
    this.ae?.writeDataPoint({
      blobs: ["", sessionId, "session_expire", ""],
      doubles: [1, 0, subscriptionCount, ageMs],
      indexes: ["session"],
    });
  }
  // #endregion synced-to-docs:metrics-session-cleanup

  // Cleanup events
  cleanupBatch(p: { expiredSessions: number; streamsDeleted: number; subscriptionsRemoved: number; subscriptionsFailed: number; latencyMs: number }) {
    this.ae?.writeDataPoint({
      blobs: ["", "", "cleanup_batch", ""],
      doubles: [p.expiredSessions, p.streamsDeleted, p.subscriptionsRemoved, p.subscriptionsFailed, p.latencyMs],
      indexes: ["cleanup"],
    });
  }

  // HTTP request events
  http(endpoint: string, method: string, status: number, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [endpoint, method, status.toString(), ""],
      doubles: [1, latencyMs, 0, 0],
      indexes: ["http"],
    });
  }

  // Publish events
  publish(streamId: string, fanoutCount: number, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [streamId, "", "publish", ""],
      doubles: [1, fanoutCount, latencyMs, 0],
      indexes: ["publish"],
    });
  }

  publishError(streamId: string, errorType: string, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [streamId, "", "publish_error", errorType],
      doubles: [1, latencyMs, 0, 0],
      indexes: ["publish_error"],
    });
  }

}

// Factory function to create a metrics instance
export function createMetrics(ae: AnalyticsEngineDataset | undefined): Metrics {
  return new Metrics(ae);
}
