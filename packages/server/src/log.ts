/**
 * Structured logging using LogLayer.
 *
 * Every log entry is a single JSON line with consistent fields:
 *   { level, msg, ts, ...context }
 *
 * Context fields (streamId, projectId, etc.) are passed per-call so
 * each site includes only what's relevant.
 */

import { LogLayer, ConsoleTransport } from "loglayer";

// Create a global logger instance configured for Cloudflare Workers
// Using ConsoleTransport with structured JSON output
const log = new LogLayer({
  transport: new ConsoleTransport({
    logger: console,
    messageField: "msg",
    dateField: "ts",
    levelField: "level",
    dateFn: () => Date.now(), // Unix timestamp in milliseconds
    stringify: true, // Output as single JSON string per line
  }),
});

/**
 * Log an error with context and optional error object
 */
export function logError(context: Record<string, unknown>, message: string, error?: unknown): void {
  const logger = log.withContext(context);
  if (error) {
    logger.withError(error).error(message);
  } else {
    logger.error(message);
  }
}

/**
 * Log a warning with context and optional error object
 */
export function logWarn(context: Record<string, unknown>, message: string, error?: unknown): void {
  const logger = log.withContext(context);
  if (error) {
    logger.withError(error).warn(message);
  } else {
    logger.warn(message);
  }
}

/**
 * Log an info message with context
 */
export function logInfo(context: Record<string, unknown>, message: string): void {
  log.withContext(context).info(message);
}

/**
 * Get the root logger instance for advanced usage
 */
export function getLogger() {
  return log;
}
