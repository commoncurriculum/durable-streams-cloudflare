import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateCursor,
  generateResponseCursor,
} from "../../../../../../src/http/v1/streams/realtime/cursor";

// Known constants from the source (used to compute expected values)
const CURSOR_EPOCH_MS = Date.UTC(2024, 9, 9, 0, 0, 0, 0); // Oct 9, 2024 UTC
const CURSOR_INTERVAL_SECONDS = 20;
const CURSOR_INTERVAL_MS = CURSOR_INTERVAL_SECONDS * 1000;

// ============================================================================
// generateCursor
// ============================================================================

describe("generateCursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '0' at the cursor epoch", () => {
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS));
    expect(generateCursor()).toBe("0");
  });

  it("returns '1' one interval after the epoch", () => {
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + CURSOR_INTERVAL_MS));
    expect(generateCursor()).toBe("1");
  });

  it("returns '0' for a time within the first interval (floors to interval boundary)", () => {
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + CURSOR_INTERVAL_MS - 1));
    expect(generateCursor()).toBe("0");
  });

  it("returns correct interval for a time well past the epoch", () => {
    // 100 intervals = 100 * 20s = 2000s after epoch
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 100 * CURSOR_INTERVAL_MS));
    expect(generateCursor()).toBe("100");
  });

  it("returns a negative interval number for a time before the epoch", () => {
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS - CURSOR_INTERVAL_MS));
    expect(generateCursor()).toBe("-1");
  });

  it("returns a base-10 string, not other bases", () => {
    // 15 intervals, which would be "f" in hex
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 15 * CURSOR_INTERVAL_MS));
    expect(generateCursor()).toBe("15");
  });

  it("returns the same value within the same 20-second interval", () => {
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 5 * CURSOR_INTERVAL_MS));
    const a = generateCursor();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 5 * CURSOR_INTERVAL_MS + 10_000));
    const b = generateCursor();
    expect(a).toBe(b);
  });

  it("increments when crossing an interval boundary", () => {
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 5 * CURSOR_INTERVAL_MS + 19_999));
    const before = generateCursor();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 6 * CURSOR_INTERVAL_MS));
    const after = generateCursor();
    expect(parseInt(after, 10)).toBe(parseInt(before, 10) + 1);
  });
});

// ============================================================================
// generateResponseCursor — no client cursor
// ============================================================================

describe("generateResponseCursor — no client cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the current cursor when clientCursor is null", () => {
    expect(generateResponseCursor(null)).toBe("50");
  });

  it("returns the current cursor when clientCursor is undefined", () => {
    expect(generateResponseCursor(undefined)).toBe("50");
  });

  it("returns the current cursor when clientCursor is empty string", () => {
    expect(generateResponseCursor("")).toBe("50");
  });
});

// ============================================================================
// generateResponseCursor — stale client cursor (behind current)
// ============================================================================

describe("generateResponseCursor — stale client cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the current cursor when clientCursor is behind current interval", () => {
    // Current is "50", client sends "30" which is less
    expect(generateResponseCursor("30")).toBe("50");
  });

  it("returns the current cursor when clientCursor is exactly one behind", () => {
    expect(generateResponseCursor("49")).toBe("50");
  });

  it("returns the current cursor when clientCursor is '0'", () => {
    expect(generateResponseCursor("0")).toBe("50");
  });

  it("returns the current cursor for a negative client cursor", () => {
    expect(generateResponseCursor("-5")).toBe("50");
  });
});

// ============================================================================
// generateResponseCursor — invalid client cursor
// ============================================================================

describe("generateResponseCursor — invalid client cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the current cursor for NaN-producing input", () => {
    expect(generateResponseCursor("abc")).toBe("50");
  });

  it("returns the current cursor for Infinity-producing input", () => {
    expect(generateResponseCursor("Infinity")).toBe("50");
  });

  it("returns the current cursor for -Infinity-producing input", () => {
    expect(generateResponseCursor("-Infinity")).toBe("50");
  });
});

// ============================================================================
// generateResponseCursor — current client cursor (equal to server)
// ============================================================================

describe("generateResponseCursor — current client cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns currentInterval + 1 when client equals current", () => {
    expect(generateResponseCursor("50")).toBe("51");
  });

  it("always returns exactly one ahead of current interval", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateResponseCursor("50")).toBe("51");
    }
  });
});

// ============================================================================
// generateResponseCursor — future client cursor (ahead of server)
// ============================================================================

describe("generateResponseCursor — future client cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns currentInterval + 1 when client is ahead of current", () => {
    // Client at 100, current at 50 — returns 51 (deterministic, based on server time)
    expect(generateResponseCursor("100")).toBe("51");
  });

  it("returns currentInterval + 1 regardless of how far ahead client is", () => {
    expect(generateResponseCursor("200")).toBe("51");
    expect(generateResponseCursor("999")).toBe("51");
  });
});

// ============================================================================
// generateResponseCursor — deterministic (proves no jitter/divergence)
// ============================================================================

describe("generateResponseCursor — deterministic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces identical cursors for identical inputs (no jitter)", () => {
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(generateResponseCursor("50"));
    }
    expect(results.size).toBe(1);
    expect(results.has("51")).toBe(true);
  });

  it("all clients with different future cursors converge to the same value", () => {
    const cursors = ["50", "75", "100"].map((c) => generateResponseCursor(c));
    expect(new Set(cursors).size).toBe(1);
    expect(cursors[0]).toBe("51");
  });
});

// ============================================================================
// generateResponseCursor — output format
// ============================================================================

describe("generateResponseCursor — output format", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a base-10 string for all code paths", () => {
    // No cursor path
    const noCursor = generateResponseCursor(null);
    expect(noCursor).toMatch(/^-?\d+$/);

    // Stale cursor path
    const stale = generateResponseCursor("10");
    expect(stale).toMatch(/^-?\d+$/);

    // Current cursor path (deterministic)
    const fresh = generateResponseCursor("50");
    expect(fresh).toMatch(/^-?\d+$/);

    // Future cursor path (deterministic)
    const future = generateResponseCursor("100");
    expect(future).toMatch(/^-?\d+$/);
  });

  it("returns a string that can be round-tripped through parseInt", () => {
    const result = generateResponseCursor("50");
    const parsed = parseInt(result, 10);
    expect(parsed.toString(10)).toBe(result);
  });
});
