const CURSOR_EPOCH_MS = Date.UTC(2024, 9, 9, 0, 0, 0, 0);
const CURSOR_INTERVAL_SECONDS = 20;
const MIN_JITTER_SECONDS = 1;
const MAX_JITTER_SECONDS = 3600;

export function generateCursor(): string {
  const now = Date.now();
  const intervalMs = CURSOR_INTERVAL_SECONDS * 1000;
  const intervalNumber = Math.floor((now - CURSOR_EPOCH_MS) / intervalMs);
  return intervalNumber.toString(10);
}

export function generateResponseCursor(clientCursor: string): string {
  const current = generateCursor();
  const currentInterval = parseInt(current, 10);

  if (!clientCursor) return current;

  const clientInterval = parseInt(clientCursor, 10);
  if (!Number.isFinite(clientInterval) || clientInterval < currentInterval) {
    return current;
  }

  const jitterSeconds = Math.floor((MIN_JITTER_SECONDS + MAX_JITTER_SECONDS) / 2);
  const jitterIntervals = Math.max(1, Math.floor(jitterSeconds / CURSOR_INTERVAL_SECONDS));
  return (clientInterval + jitterIntervals).toString(10);
}
