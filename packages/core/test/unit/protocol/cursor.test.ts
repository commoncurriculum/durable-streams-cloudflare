import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateCursor, generateResponseCursor } from "../../../src/protocol/cursor";

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

  it("returns client cursor plus jitter intervals when client equals current", () => {
    const result = generateResponseCursor("50");
    const resultInterval = parseInt(result, 10);

    // Jitter: ceil(rand(1..3600) / 20) => min 1, max ceil(3600/20) = 180
    expect(resultInterval).toBeGreaterThan(50);
    expect(resultInterval).toBeLessThanOrEqual(50 + 180);
  });

  it("always returns a value strictly greater than the client cursor", () => {
    // Run multiple times to guard against edge cases
    for (let i = 0; i < 100; i++) {
      const result = generateResponseCursor("50");
      expect(parseInt(result, 10)).toBeGreaterThan(50);
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

  it("returns client cursor plus jitter intervals when client is ahead of current", () => {
    const result = generateResponseCursor("100");
    const resultInterval = parseInt(result, 10);

    // Jitter added on top of 100, not 50
    expect(resultInterval).toBeGreaterThan(100);
    expect(resultInterval).toBeLessThanOrEqual(100 + 180);
  });

  it("preserves the client interval as the base (not the server interval)", () => {
    const result = generateResponseCursor("200");
    const resultInterval = parseInt(result, 10);

    // Must be at least 201 (200 + min jitter of 1 interval)
    expect(resultInterval).toBeGreaterThanOrEqual(201);
  });
});

// ============================================================================
// generateResponseCursor — jitter bounds
// ============================================================================

describe("generateResponseCursor — jitter bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CURSOR_EPOCH_MS + 50 * CURSOR_INTERVAL_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds minimum jitter of 1 interval when Math.random returns 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const result = generateResponseCursor("50");
    const resultInterval = parseInt(result, 10);

    // jitterSeconds = 1 + floor(0 * 3600) = 1
    // jitterIntervals = max(1, ceil(1 / 20)) = 1
    expect(resultInterval).toBe(51);
    vi.restoreAllMocks();
  });

  it("adds maximum jitter of 180 intervals when Math.random returns just under 1", () => {
    // Math.random() returns values in [0, 1)
    // floor(0.999... * 3600) = 3599
    // jitterSeconds = 1 + 3599 = 3600
    // jitterIntervals = ceil(3600 / 20) = 180
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    const result = generateResponseCursor("50");
    const resultInterval = parseInt(result, 10);

    expect(resultInterval).toBe(50 + 180);
    vi.restoreAllMocks();
  });

  it("jitter produces a mid-range value", () => {
    // random = 0.5 => floor(0.5 * 3600) = 1800
    // jitterSeconds = 1 + 1800 = 1801
    // jitterIntervals = ceil(1801 / 20) = ceil(90.05) = 91
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = generateResponseCursor("50");
    const resultInterval = parseInt(result, 10);

    expect(resultInterval).toBe(50 + 91);
    vi.restoreAllMocks();
  });

  it("jitter minimum is guaranteed by Math.max(1, ...)", () => {
    // Even with random = 0, jitterSeconds = 1, ceil(1/20) = 1, max(1,1) = 1
    // The Math.max(1, ...) ensures at least 1 interval
    vi.spyOn(Math, "random").mockReturnValue(0);
    const result = generateResponseCursor("50");
    const resultInterval = parseInt(result, 10);

    expect(resultInterval).toBeGreaterThanOrEqual(51);
    vi.restoreAllMocks();
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

    // Fresh cursor path (with jitter)
    const fresh = generateResponseCursor("50");
    expect(fresh).toMatch(/^-?\d+$/);

    // Future cursor path (with jitter)
    const future = generateResponseCursor("100");
    expect(future).toMatch(/^-?\d+$/);
  });

  it("returns a string that can be round-tripped through parseInt", () => {
    const result = generateResponseCursor("50");
    const parsed = parseInt(result, 10);
    expect(parsed.toString(10)).toBe(result);
  });
});
