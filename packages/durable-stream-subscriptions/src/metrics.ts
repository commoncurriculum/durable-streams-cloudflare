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

  // Fanout events
  fanout(
    streamId: string,
    subscribers: number,
    success: number,
    failures: number,
    latencyMs: number,
  ) {
    this.ae?.writeDataPoint({
      blobs: [streamId, "", "fanout", ""],
      doubles: [subscribers, success, failures, latencyMs],
      indexes: ["fanout"],
    });
  }

  fanoutFailure(streamId: string, sessionId: string, errorType: string, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: [streamId, sessionId, "fanout_failure", errorType],
      doubles: [1, latencyMs, 0, 0],
      indexes: ["fanout_error"],
    });
  }

  // Queue events
  queueBatch(size: number, success: number, retries: number, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: ["", "", "queue_batch", ""],
      doubles: [size, success, retries, latencyMs],
      indexes: ["queue"],
    });
  }

  queueRetry(streamId: string, sessionId: string, attempt: number, errorType: string) {
    this.ae?.writeDataPoint({
      blobs: [streamId, sessionId, "queue_retry", errorType],
      doubles: [attempt, 0, 0, 0],
      indexes: ["queue_error"],
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

  // Session lifecycle events
  sessionCreate(sessionId: string, ttlSeconds: number, latencyMs: number) {
    this.ae?.writeDataPoint({
      blobs: ["", sessionId, "session_create", ""],
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

  // Cleanup events
  cleanupBatch(
    marked: number,
    deleted: number,
    deleteSuccess: number,
    deleteFail: number,
    latencyMs: number,
  ) {
    this.ae?.writeDataPoint({
      blobs: ["", "", "cleanup_batch", ""],
      doubles: [marked, deleted, deleteSuccess, deleteFail, latencyMs],
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

  // Reconciliation events
  reconcile(
    total: number,
    valid: number,
    orphaned: number,
    cleaned: number,
    errors: number,
    latencyMs: number,
  ) {
    this.ae?.writeDataPoint({
      blobs: ["", "", "reconcile", ""],
      doubles: [total, valid, orphaned, cleaned, errors, latencyMs],
      indexes: ["reconcile"],
    });
  }
}

// Factory function to create a metrics instance
export function createMetrics(ae: AnalyticsEngineDataset | undefined): Metrics {
  return new Metrics(ae);
}
