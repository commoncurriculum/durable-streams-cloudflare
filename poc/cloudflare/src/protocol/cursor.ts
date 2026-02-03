const CURSOR_EPOCH_MS = Date.UTC(2024, 9, 9, 0, 0, 0, 0);
const CURSOR_INTERVAL_SECONDS = 20;
const MIN_JITTER_SECONDS = 1;
const MAX_JITTER_SECONDS = 3600;

function generateJitterIntervals(intervalSeconds: number): number {
  const jitterSeconds =
    MIN_JITTER_SECONDS + Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1));
  return Math.max(1, Math.ceil(jitterSeconds / intervalSeconds));
}

export function generateCursor(): string {
  const now = Date.now();
  const intervalMs = CURSOR_INTERVAL_SECONDS * 1000;
  const intervalNumber = Math.floor((now - CURSOR_EPOCH_MS) / intervalMs);
  return intervalNumber.toString(10);
}

export function generateResponseCursor(clientCursor: string | null | undefined): string {
  const current = generateCursor();
  const currentInterval = parseInt(current, 10);

  if (!clientCursor) return current;

  const clientInterval = parseInt(clientCursor, 10);
  if (!Number.isFinite(clientInterval) || clientInterval < currentInterval) {
    return current;
  }

  const jitterIntervals = generateJitterIntervals(CURSOR_INTERVAL_SECONDS);
  return (clientInterval + jitterIntervals).toString(10);
}
