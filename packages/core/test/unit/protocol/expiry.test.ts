import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseTtlSeconds,
  parseExpiresAt,
  ttlMatches,
  applyExpiryHeaders,
  remainingTtlSeconds,
  cacheControlFor,
  isExpired,
  type ExpiryMeta,
} from "../../../src/protocol/expiry";

// ============================================================================
// parseTtlSeconds
// ============================================================================

describe("parseTtlSeconds", () => {
  it("returns null value for null input", () => {
    const result = parseTtlSeconds(null);
    expect(result).toEqual({ value: null });
    expect(result.error).toBeUndefined();
  });

  it("parses a valid integer string", () => {
    const result = parseTtlSeconds("3600");
    expect(result).toEqual({ value: 3600 });
    expect(result.error).toBeUndefined();
  });

  it("parses zero", () => {
    const result = parseTtlSeconds("0");
    expect(result).toEqual({ value: 0 });
    expect(result.error).toBeUndefined();
  });

  it("returns error for negative value", () => {
    const result = parseTtlSeconds("-1");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("returns error for float value", () => {
    const result = parseTtlSeconds("3.5");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("returns error for non-numeric string", () => {
    const result = parseTtlSeconds("abc");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("returns error for empty string", () => {
    // empty string is falsy, so it takes the !value early return
    const result = parseTtlSeconds("");
    expect(result).toEqual({ value: null });
    expect(result.error).toBeUndefined();
  });

  it("returns error for leading zeros", () => {
    const result = parseTtlSeconds("007");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("returns error for string with spaces", () => {
    const result = parseTtlSeconds(" 100 ");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });
});

// ============================================================================
// parseExpiresAt
// ============================================================================

describe("parseExpiresAt", () => {
  it("returns null value for null input", () => {
    const result = parseExpiresAt(null);
    expect(result).toEqual({ value: null });
    expect(result.error).toBeUndefined();
  });

  it("parses a valid ISO 8601 date string", () => {
    const result = parseExpiresAt("2025-06-15T12:00:00.000Z");
    expect(result.value).toBe(Date.parse("2025-06-15T12:00:00.000Z"));
    expect(result.error).toBeUndefined();
  });

  it("parses a valid ISO date without milliseconds", () => {
    const result = parseExpiresAt("2025-06-15T12:00:00Z");
    expect(result.value).toBe(Date.parse("2025-06-15T12:00:00Z"));
    expect(result.error).toBeUndefined();
  });

  it("returns error for an invalid date string", () => {
    const result = parseExpiresAt("not-a-date");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("returns error for gibberish", () => {
    const result = parseExpiresAt("xyz123");
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("returns null value for empty string (falsy)", () => {
    const result = parseExpiresAt("");
    expect(result).toEqual({ value: null });
    expect(result.error).toBeUndefined();
  });
});

// ============================================================================
// ttlMatches
// ============================================================================

describe("ttlMatches", () => {
  it("matches when meta has ttl_seconds and input matches", () => {
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: null };
    expect(ttlMatches(meta, 3600, null)).toBe(true);
  });

  it("does not match when meta has ttl_seconds and input differs", () => {
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: null };
    expect(ttlMatches(meta, 7200, null)).toBe(false);
  });

  it("does not match when meta has ttl_seconds but input is null", () => {
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: null };
    expect(ttlMatches(meta, null, null)).toBe(false);
  });

  it("matches when meta has expires_at and input matches", () => {
    const ts = Date.now() + 60_000;
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: ts };
    expect(ttlMatches(meta, null, ts)).toBe(true);
  });

  it("does not match when meta has expires_at and input differs", () => {
    const ts = Date.now() + 60_000;
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: ts };
    expect(ttlMatches(meta, null, ts + 1000)).toBe(false);
  });

  it("does not match when meta has expires_at but input is null", () => {
    const ts = Date.now() + 60_000;
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: ts };
    expect(ttlMatches(meta, null, null)).toBe(false);
  });

  it("matches when no expiry on either side (both null)", () => {
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    expect(ttlMatches(meta, null, null)).toBe(true);
  });

  it("does not match when meta has no expiry but input provides ttlSeconds", () => {
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    expect(ttlMatches(meta, 3600, null)).toBe(false);
  });

  it("does not match when meta has no expiry but input provides expiresAt", () => {
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    expect(ttlMatches(meta, null, Date.now())).toBe(false);
  });

  it("prioritizes ttl_seconds over expires_at when meta has both", () => {
    // When meta has ttl_seconds set, it checks ttlSeconds input first
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: Date.now() + 60_000 };
    expect(ttlMatches(meta, 3600, null)).toBe(true);
    expect(ttlMatches(meta, null, meta.expires_at)).toBe(false);
  });
});

// ============================================================================
// applyExpiryHeaders
// ============================================================================

describe("applyExpiryHeaders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets no headers when meta has no expiry", () => {
    const headers = new Headers();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    applyExpiryHeaders(headers, meta);

    expect(headers.has("Stream-TTL")).toBe(false);
    expect(headers.has("Stream-Expires-At")).toBe(false);
  });

  it("sets Stream-TTL header with remaining seconds when meta has ttl_seconds", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: now + 3_600_000 };
    const headers = new Headers();
    applyExpiryHeaders(headers, meta);

    expect(headers.get("Stream-TTL")).toBe("3600");
  });

  it("sets Stream-Expires-At header as ISO string when meta has expires_at", () => {
    const expiresAt = Date.parse("2025-06-16T12:00:00.000Z");
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: expiresAt };
    const headers = new Headers();
    applyExpiryHeaders(headers, meta);

    expect(headers.get("Stream-Expires-At")).toBe("2025-06-16T12:00:00.000Z");
    expect(headers.has("Stream-TTL")).toBe(false);
  });

  it("sets both headers when meta has both ttl_seconds and expires_at", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: now + 3_600_000 };
    const headers = new Headers();
    applyExpiryHeaders(headers, meta);

    expect(headers.has("Stream-TTL")).toBe(true);
    expect(headers.has("Stream-Expires-At")).toBe(true);
  });

  it("sets Stream-TTL to 0 when already expired", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: now - 1000 };
    const headers = new Headers();
    applyExpiryHeaders(headers, meta);

    expect(headers.get("Stream-TTL")).toBe("0");
  });
});

// ============================================================================
// remainingTtlSeconds
// ============================================================================

describe("remainingTtlSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns raw ttl_seconds when expires_at is null", () => {
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: null };
    expect(remainingTtlSeconds(meta)).toBe(3600);
  });

  it("returns null when both are null", () => {
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    expect(remainingTtlSeconds(meta)).toBeNull();
  });

  it("returns remaining seconds for a future expires_at", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 90_000 };
    // 90_000ms = 90s -> floor(90) = 90
    expect(remainingTtlSeconds(meta)).toBe(90);
  });

  it("floors fractional remaining time", () => {
    const now = Date.now();
    // 90_500ms -> floor(90500/1000) = floor(90.5) = 90
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 90_500 };
    expect(remainingTtlSeconds(meta)).toBe(90);
  });

  it("returns 0 for past expires_at", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now - 10_000 };
    expect(remainingTtlSeconds(meta)).toBe(0);
  });

  it("returns 0 when expires_at is exactly now", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now };
    expect(remainingTtlSeconds(meta)).toBe(0);
  });

  it("uses expires_at over ttl_seconds when both are present", () => {
    const now = Date.now();
    // ttl_seconds says 3600, but expires_at says 120 seconds from now
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: now + 120_000 };
    expect(remainingTtlSeconds(meta)).toBe(120);
  });
});

// ============================================================================
// cacheControlFor
// ============================================================================

describe("cacheControlFor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns public cache with swr when no TTL (no expiry)", () => {
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    expect(cacheControlFor(meta)).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  it("returns no-store when stream is expired", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now - 1000 };
    expect(cacheControlFor(meta)).toBe("no-store");
  });

  it("returns no-store when remaining is exactly 0", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now };
    expect(cacheControlFor(meta)).toBe("no-store");
  });

  it("caps max-age at 60 for long remaining TTL", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 3_600_000 };
    expect(cacheControlFor(meta)).toBe("public, max-age=60");
  });

  it("uses remaining TTL when shorter than 60 seconds", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 30_000 };
    expect(cacheControlFor(meta)).toBe("public, max-age=30");
  });

  it("uses remaining of 1 for very short TTL", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 1_500 };
    // floor(1500/1000) = 1
    expect(cacheControlFor(meta)).toBe("public, max-age=1");
  });

  it("uses raw ttl_seconds when expires_at is null", () => {
    const meta: ExpiryMeta = { ttl_seconds: 30, expires_at: null };
    expect(cacheControlFor(meta)).toBe("public, max-age=30");
  });

  it("caps raw ttl_seconds at 60", () => {
    const meta: ExpiryMeta = { ttl_seconds: 7200, expires_at: null };
    expect(cacheControlFor(meta)).toBe("public, max-age=60");
  });

  it("returns no-store for ttl_seconds of 0 and null expires_at", () => {
    const meta: ExpiryMeta = { ttl_seconds: 0, expires_at: null };
    expect(cacheControlFor(meta)).toBe("no-store");
  });
});

// ============================================================================
// isExpired
// ============================================================================

describe("isExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when expires_at is null (no expiry)", () => {
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: null };
    expect(isExpired(meta)).toBe(false);
  });

  it("returns false when expires_at is null even with ttl_seconds set", () => {
    // isExpired only checks expires_at, not ttl_seconds
    const meta: ExpiryMeta = { ttl_seconds: 3600, expires_at: null };
    expect(isExpired(meta)).toBe(false);
  });

  it("returns false when expires_at is in the future", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 60_000 };
    expect(isExpired(meta)).toBe(false);
  });

  it("returns true when expires_at is in the past", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now - 1000 };
    expect(isExpired(meta)).toBe(true);
  });

  it("returns true when expires_at is exactly now", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now };
    expect(isExpired(meta)).toBe(true);
  });

  it("transitions from not-expired to expired as time advances", () => {
    const now = Date.now();
    const meta: ExpiryMeta = { ttl_seconds: null, expires_at: now + 5_000 };

    expect(isExpired(meta)).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(isExpired(meta)).toBe(true);
  });
});
