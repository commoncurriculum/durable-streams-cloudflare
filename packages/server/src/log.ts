/**
 * Structured logging — lightweight JSON to console.error / console.log.
 *
 * Every log entry is a single JSON line with consistent fields:
 *   { level, msg, ts, ...context }
 *
 * Context fields (streamId, projectId, etc.) are passed per-call so
 * each site includes only what's relevant.
 */

export function logError(context: Record<string, unknown>, message: string, error?: unknown): void {
  const entry: Record<string, unknown> = {
    level: "error",
    msg: message,
    ts: Date.now(),
    ...context,
  };
  if (error instanceof Error) {
    entry.error = error.message;
    if (error.stack) entry.stack = error.stack;
  } else if (error !== undefined) {
    entry.error = String(error);
  }
  console.error(JSON.stringify(entry));
}

export function logWarn(context: Record<string, unknown>, message: string, error?: unknown): void {
  const entry: Record<string, unknown> = {
    level: "warn",
    msg: message,
    ts: Date.now(),
    ...context,
  };
  if (error instanceof Error) {
    entry.error = error.message;
  } else if (error !== undefined) {
    entry.error = String(error);
  }
  console.error(JSON.stringify(entry));
}

export function logInfo(context: Record<string, unknown>, message: string): void {
  console.log(JSON.stringify({
    level: "info",
    msg: message,
    ts: Date.now(),
    ...context,
  }));
}
