export const MAX_CHUNK_BYTES = 256 * 1024;
export const MAX_APPEND_BYTES = 8 * 1024 * 1024;
export const OFFSET_WIDTH = 16;
export const SSE_RECONNECT_MS = 55_000;
export const LONG_POLL_TIMEOUT_MS = 4_000;
export const LONG_POLL_CACHE_SECONDS = 20;
/**
 * When a write wakes long-poll waiters, spread their resolution over a
 * random [0, STAGGER_MS] window instead of resolving all at once.  This
 * staggers the reconnection burst so the first client's cached response
 * has time to propagate before the rest arrive at the edge.
 *
 * Set to 0 to disable (resolve all waiters immediately).
 */
export const LONGPOLL_STAGGER_MS = 300;
export const SEGMENT_MAX_BYTES_DEFAULT = 4 * 1024 * 1024;
export const SEGMENT_MAX_MESSAGES_DEFAULT = 1000;
