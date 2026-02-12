import { HEADER_STREAM_READER_KEY, HEADER_STREAM_UP_TO_DATE } from "../shared/headers";
import { Timing, attachTiming } from "../shared/timing";
import { applyCorsHeaders } from "./cors";
import { putStreamMetadata } from "../../storage/registry";
import type { StreamEntry } from "../../storage/registry";

/**
 * Simplified stream metadata for edge caching decisions.
 * This is a subset of StreamEntry - just the fields needed for cache control.
 */
export type StreamMeta = Pick<StreamEntry, "public" | "readerKey">;

/**
 * Look up a cached response from the edge cache, handling ETag revalidation.
 * Returns a Response on cache hit (or 304), or null on cache miss.
 */
export async function lookupEdgeCache(
  request: Request,
  cacheUrl: string,
  corsOrigin: string | null,
  timing: Timing | null,
): Promise<Response | null> {
  const cache = caches.default;
  const doneCache = timing?.start("edge.cache");
  const cached = await cache.match(cacheUrl);
  doneCache?.();

  if (!cached) {
    timing?.record("edge.cache.result", 0, "miss");
    return null;
  }

  // ETag revalidation at the edge
  const ifNoneMatch = request.headers.get("If-None-Match");
  const cachedEtag = cached.headers.get("ETag");
  if (ifNoneMatch && cachedEtag && ifNoneMatch === cachedEtag) {
    const headers304 = new Headers(cached.headers);
    headers304.set("X-Cache", "HIT");
    applyCorsHeaders(headers304, corsOrigin);
    timing?.record("edge.cache.result", 0, "revalidate-304");
    return attachTiming(new Response(null, { status: 304, headers: headers304 }), timing);
  }

  // Cache hit — return cached response
  const responseHeaders = new Headers(cached.headers);
  responseHeaders.set("X-Cache", "HIT");
  applyCorsHeaders(responseHeaders, corsOrigin);
  timing?.record("edge.cache.result", 0, "hit");
  return attachTiming(
    new Response(cached.body, { status: cached.status, headers: responseHeaders }),
    timing,
  );
}

/**
 * Store a cacheable 200 response in the edge cache. Returns true if stored.
 *
 * Caches mid-stream reads (immutable data) and long-poll reads (cursor rotation
 * prevents stale loops, enables request collapsing). Plain GET at-tail responses
 * are NOT cached — data can change as appends arrive, and caching them breaks
 * read-after-write consistency.
 */
export function storeInEdgeCache(
  waitUntil: (p: Promise<unknown>) => void,
  cacheUrl: string,
  isLongPoll: boolean,
  streamMeta: StreamMeta | null,
  url: URL,
  wrapped: Response,
): boolean {
  const cc = wrapped.headers.get("Cache-Control") ?? "";
  const atTail = wrapped.headers.get(HEADER_STREAM_UP_TO_DATE) === "true";
  // Don't cache responses at bare URLs for streams with a reader key.
  // Without this guard, an authenticated client without ?rk would populate
  // a cache entry at a guessable URL that anyone could then hit.
  const hasReaderKey = streamMeta?.readerKey;
  const urlHasRk = url.searchParams.has("rk");
  if (!cc.includes("no-store") && (!atTail || isLongPoll) && !(hasReaderKey && !urlHasRk)) {
    waitUntil(caches.default.put(cacheUrl, wrapped.clone()));
    return true;
  }
  return false;
}

/**
 * On successful stream creation (PUT → 201), write metadata to KV for edge
 * lookups. Generates a reader key for auth-required, non-public streams so
 * unauthorized clients can't match cached entries.
 */
export function writeStreamCreationMetadata(
  url: URL,
  doKey: string,
  _unused: undefined,
  kv: KVNamespace,
  waitUntil: (p: Promise<unknown>) => void,
  wrapped: Response,
): void {
  const isPublic = url.searchParams.get("public") === "true";
  // Generate a reader key for non-public streams. The reader key adds an
  // unguessable component to the CDN cache key so unauthorized clients
  // can't match cached entries.
  const readerKey = !isPublic ? `rk_${crypto.randomUUID().replace(/-/g, "")}` : undefined;
  if (readerKey) {
    wrapped.headers.set(HEADER_STREAM_READER_KEY, readerKey);
  }
  waitUntil(
    putStreamMetadata(kv, doKey, {
      public: isPublic,
      content_type: wrapped.headers.get("Content-Type") || "application/octet-stream",
      readerKey,
    }),
  );
}
