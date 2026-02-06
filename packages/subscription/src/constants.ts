/**
 * Shared constants for durable-stream-subscriptions
 */

// #region synced-to-docs:id-patterns
/**
 * Pattern for valid session IDs.
 * Allows alphanumeric characters, hyphens, underscores, colons, and periods.
 * Does not allow quotes, semicolons, spaces, or other special characters
 * that could be used in SQL injection attacks.
 */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;

/**
 * Pattern for valid stream IDs.
 * Same rules as session IDs.
 */
export const STREAM_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;
// #endregion synced-to-docs:id-patterns

/**
 * Default session TTL in seconds (30 minutes).
 */
export const DEFAULT_SESSION_TTL_SECONDS = 1800;

/**
 * Maximum number of concurrent fanout writes per batch.
 */
export const FANOUT_BATCH_SIZE = 50;

/**
 * Default Analytics Engine dataset name.
 */
export const DEFAULT_ANALYTICS_DATASET = "subscriptions_metrics";

/**
 * Validates a session ID against the allowed pattern.
 * @param sessionId - The session ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Validates a stream ID against the allowed pattern.
 * @param streamId - The stream ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidStreamId(streamId: string): boolean {
  return STREAM_ID_PATTERN.test(streamId);
}
