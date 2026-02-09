/**
 * Shared constants for durable-streams-subscriptions
 */

import { regex } from "arkregex";

// #region synced-to-docs:id-patterns
/**
 * Pattern for valid session IDs.
 * Must be a UUID (8-4-4-4-12 hex format).
 */
export const SESSION_ID_PATTERN = regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i");

/**
 * Pattern for valid stream IDs.
 * Allows alphanumeric characters, hyphens, underscores, colons, and periods.
 * Does not allow quotes, semicolons, spaces, or other special characters
 * that could be used in SQL injection attacks.
 */
export const STREAM_ID_PATTERN = regex("^[a-zA-Z0-9_\\-:.]+$");

/**
 * Pattern for valid project IDs.
 * Allows alphanumeric characters, hyphens, and underscores.
 */
export const PROJECT_ID_PATTERN = regex("^[a-zA-Z0-9_-]+$");
// #endregion synced-to-docs:id-patterns

/**
 * Default session TTL in seconds (24 hours).
 */
export const DEFAULT_SESSION_TTL_SECONDS = 86400;

/**
 * Maximum number of concurrent fanout writes per batch.
 */
export const FANOUT_BATCH_SIZE = 50;

/**
 * Subscriber count threshold above which fanout is offloaded to a queue.
 * Below this threshold, fanout happens inline (synchronous with publish).
 */
export const FANOUT_QUEUE_THRESHOLD = 200;

/**
 * Number of session IDs per queue message when using queued fanout.
 */
export const FANOUT_QUEUE_BATCH_SIZE = 50;

/**
 * Maximum number of subscribers for inline fanout (without a queue).
 * Above this, fanout is skipped to protect the publish path.
 */
export const MAX_INLINE_FANOUT = 1000;

/**
 * Per-RPC timeout in milliseconds for fanout writes.
 * Workers RPC has no native timeout, so we use Promise.race with setTimeout.
 */
export const FANOUT_RPC_TIMEOUT_MS = 10_000;

/**
 * Circuit breaker: number of consecutive inline fanout failures before opening.
 */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

/**
 * Circuit breaker: time in ms before retrying after opening (half-open).
 */
export const CIRCUIT_BREAKER_RECOVERY_MS = 60_000;

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

/**
 * Validates a project ID against the allowed pattern.
 * @param projectId - The project ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_PATTERN.test(projectId);
}
