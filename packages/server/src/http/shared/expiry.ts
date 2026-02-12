import { type } from "arktype";
import { HEADER_STREAM_EXPIRES_AT, HEADER_STREAM_TTL } from "./headers";

export type ExpiryMeta = {
  ttl_seconds: number | null;
  expires_at: number | null;
};

const ttlSeconds = type("string").pipe((s, ctx) => {
  if (!/^(0|[1-9]\d*)$/.test(s)) return ctx.error("invalid Stream-TTL");
  return parseInt(s, 10);
});

const expiresAtIso = type("string").pipe((s, ctx) => {
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return ctx.error("invalid Stream-Expires-At");
  return parsed;
});

export function parseTtlSeconds(value: string | null): { value: number | null; error?: string } {
  if (!value) return { value: null };
  const result = ttlSeconds(value);
  if (result instanceof type.errors) return { value: null, error: result.summary };
  return { value: result };
}

export function parseExpiresAt(value: string | null): { value: number | null; error?: string } {
  if (!value) return { value: null };
  const result = expiresAtIso(value);
  if (result instanceof type.errors) return { value: null, error: result.summary };
  return { value: result };
}

export function ttlMatches(
  meta: ExpiryMeta,
  ttlSeconds: number | null,
  expiresAt: number | null,
): boolean {
  if (meta.ttl_seconds !== null) {
    return ttlSeconds !== null && meta.ttl_seconds === ttlSeconds;
  }
  if (meta.expires_at !== null) {
    return expiresAt !== null && meta.expires_at === expiresAt;
  }
  return ttlSeconds === null && expiresAt === null;
}

export function applyExpiryHeaders(headers: Headers, meta: ExpiryMeta): void {
  if (meta.ttl_seconds !== null) {
    const remaining = remainingTtlSeconds(meta);
    if (remaining !== null) headers.set(HEADER_STREAM_TTL, remaining.toString());
  }
  if (meta.expires_at !== null) {
    headers.set(HEADER_STREAM_EXPIRES_AT, new Date(meta.expires_at).toISOString());
  }
}

export function remainingTtlSeconds(meta: ExpiryMeta): number | null {
  if (meta.expires_at === null) return meta.ttl_seconds;
  const remainingMs = meta.expires_at - Date.now();
  return Math.max(0, Math.floor(remainingMs / 1000));
}

export function cacheControlFor(meta: ExpiryMeta): string {
  const remaining = remainingTtlSeconds(meta);
  if (remaining === null) return "public, max-age=60, stale-while-revalidate=300";
  if (remaining <= 0) return "no-store";
  const maxAge = Math.min(60, remaining);
  return `public, max-age=${maxAge}`;
}

export function isExpired(meta: ExpiryMeta): boolean {
  if (meta.expires_at === null) return false;
  return Date.now() >= meta.expires_at;
}
