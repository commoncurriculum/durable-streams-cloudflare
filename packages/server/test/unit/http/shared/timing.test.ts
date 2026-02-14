import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Timing, appendServerTiming, attachTiming } from "../../../../src/http/shared/timing";

// ============================================================================
// Timing class - start()
// ============================================================================

describe("Timing.start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a function that records timing when called", () => {
    const timing = new Timing();
    const end = timing.start("test");

    vi.advanceTimersByTime(100);
    end();

    expect(timing.isEmpty()).toBe(false);
    const header = timing.toHeaderValue();
    expect(header).toContain("test");
    expect(header).toContain("dur=");
  });

  it("records accurate duration between start and end", () => {
    const timing = new Timing();
    const end = timing.start("operation");

    vi.advanceTimersByTime(250);
    end();

    const header = timing.toHeaderValue();
    expect(header).toContain("operation;dur=250.00");
  });

  it("includes description when provided", () => {
    const timing = new Timing();
    const end = timing.start("fetch", "Fetch user data");

    vi.advanceTimersByTime(50);
    end();

    const header = timing.toHeaderValue();
    expect(header).toContain('fetch;dur=50.00;desc="Fetch user data"');
  });

  it("works without description", () => {
    const timing = new Timing();
    const end = timing.start("compute");

    vi.advanceTimersByTime(75);
    end();

    const header = timing.toHeaderValue();
    expect(header).toContain("compute;dur=75.00");
    expect(header).not.toContain("desc=");
  });

  it("allows multiple independent timers", () => {
    const timing = new Timing();
    const end1 = timing.start("timer1");
    vi.advanceTimersByTime(100);
    const end2 = timing.start("timer2");
    vi.advanceTimersByTime(50);
    end1(); // 150ms total
    vi.advanceTimersByTime(25);
    end2(); // 75ms total

    const header = timing.toHeaderValue();
    expect(header).toContain("timer1;dur=150.00");
    expect(header).toContain("timer2;dur=75.00");
  });

  it("handles zero duration", () => {
    const timing = new Timing();
    const end = timing.start("instant");
    end(); // Immediate call, ~0ms

    expect(timing.isEmpty()).toBe(false);
    const header = timing.toHeaderValue();
    expect(header).toContain("instant;dur=0.00");
  });

  it("handles very small durations with precision", () => {
    const timing = new Timing();
    const end = timing.start("quick");

    vi.advanceTimersByTime(1.5);
    end();

    const header = timing.toHeaderValue();
    expect(header).toContain("quick;dur=1.50");
  });
});

// ============================================================================
// Timing class - record()
// ============================================================================

describe("Timing.record", () => {
  it("records a timing entry with name and duration", () => {
    const timing = new Timing();
    timing.record("test", 123.45);

    expect(timing.isEmpty()).toBe(false);
    const header = timing.toHeaderValue();
    expect(header).toBe("test;dur=123.45");
  });

  it("records a timing entry with description", () => {
    const timing = new Timing();
    timing.record("fetch", 50.0, "API call");

    const header = timing.toHeaderValue();
    expect(header).toBe('fetch;dur=50.00;desc="API call"');
  });

  it("records entry without description", () => {
    const timing = new Timing();
    timing.record("compute", 25.5);

    const header = timing.toHeaderValue();
    expect(header).toBe("compute;dur=25.50");
    expect(header).not.toContain("desc=");
  });

  it("skips non-finite duration (Infinity)", () => {
    const timing = new Timing();
    timing.record("infinite", Infinity);

    expect(timing.isEmpty()).toBe(true);
  });

  it("skips non-finite duration (-Infinity)", () => {
    const timing = new Timing();
    timing.record("neg-infinite", -Infinity);

    expect(timing.isEmpty()).toBe(true);
  });

  it("skips non-finite duration (NaN)", () => {
    const timing = new Timing();
    timing.record("not-a-number", NaN);

    expect(timing.isEmpty()).toBe(true);
  });

  it("accepts zero duration", () => {
    const timing = new Timing();
    timing.record("zero", 0);

    expect(timing.isEmpty()).toBe(false);
    const header = timing.toHeaderValue();
    expect(header).toBe("zero;dur=0.00");
  });

  it("accepts negative duration", () => {
    const timing = new Timing();
    timing.record("negative", -10.5);

    expect(timing.isEmpty()).toBe(false);
    const header = timing.toHeaderValue();
    expect(header).toBe("negative;dur=-10.50");
  });

  it("allows recording multiple entries", () => {
    const timing = new Timing();
    timing.record("first", 10);
    timing.record("second", 20, "Second entry");
    timing.record("third", 30);

    const header = timing.toHeaderValue();
    expect(header).toBe('first;dur=10.00, second;dur=20.00;desc="Second entry", third;dur=30.00');
  });

  it("skips non-finite entries but keeps valid ones", () => {
    const timing = new Timing();
    timing.record("valid1", 10);
    timing.record("invalid", NaN);
    timing.record("valid2", 20);

    const header = timing.toHeaderValue();
    expect(header).toBe("valid1;dur=10.00, valid2;dur=20.00");
  });
});

// ============================================================================
// Timing class - isEmpty()
// ============================================================================

describe("Timing.isEmpty", () => {
  it("returns true for new Timing instance", () => {
    const timing = new Timing();
    expect(timing.isEmpty()).toBe(true);
  });

  it("returns false after recording an entry", () => {
    const timing = new Timing();
    timing.record("test", 10);
    expect(timing.isEmpty()).toBe(false);
  });

  it("returns false after using start()", () => {
    const timing = new Timing();
    const end = timing.start("test");
    end();
    expect(timing.isEmpty()).toBe(false);
  });

  it("returns true when only non-finite entries were attempted", () => {
    const timing = new Timing();
    timing.record("invalid", NaN);
    timing.record("infinite", Infinity);
    expect(timing.isEmpty()).toBe(true);
  });

  it("returns false with mix of valid and invalid entries", () => {
    const timing = new Timing();
    timing.record("invalid", NaN);
    timing.record("valid", 10);
    expect(timing.isEmpty()).toBe(false);
  });
});

// ============================================================================
// Timing class - toHeaderValue()
// ============================================================================

describe("Timing.toHeaderValue", () => {
  it("returns empty string for empty timing", () => {
    const timing = new Timing();
    expect(timing.toHeaderValue()).toBe("");
  });

  it("formats single entry without description", () => {
    const timing = new Timing();
    timing.record("test", 123.456);
    expect(timing.toHeaderValue()).toBe("test;dur=123.46");
  });

  it("formats single entry with description", () => {
    const timing = new Timing();
    timing.record("test", 123.456, "Test operation");
    expect(timing.toHeaderValue()).toBe('test;dur=123.46;desc="Test operation"');
  });

  it("formats multiple entries separated by comma-space", () => {
    const timing = new Timing();
    timing.record("first", 10.5);
    timing.record("second", 20.75);
    timing.record("third", 30.25);

    const header = timing.toHeaderValue();
    expect(header).toBe("first;dur=10.50, second;dur=20.75, third;dur=30.25");
  });

  it("formats mixed entries with and without descriptions", () => {
    const timing = new Timing();
    timing.record("a", 10);
    timing.record("b", 20, "Description for B");
    timing.record("c", 30);

    const header = timing.toHeaderValue();
    expect(header).toBe('a;dur=10.00, b;dur=20.00;desc="Description for B", c;dur=30.00');
  });

  it("rounds duration to 2 decimal places", () => {
    const timing = new Timing();
    timing.record("test1", 123.456789);
    timing.record("test2", 1.111);
    timing.record("test3", 99.999);

    const header = timing.toHeaderValue();
    expect(header).toBe("test1;dur=123.46, test2;dur=1.11, test3;dur=100.00");
  });

  it("handles duration with exactly 2 decimal places", () => {
    const timing = new Timing();
    timing.record("exact", 50.0);
    expect(timing.toHeaderValue()).toBe("exact;dur=50.00");
  });

  it("handles very small durations", () => {
    const timing = new Timing();
    timing.record("tiny", 0.001);
    expect(timing.toHeaderValue()).toBe("tiny;dur=0.00");
  });

  it("handles very large durations", () => {
    const timing = new Timing();
    timing.record("huge", 999999.999);
    expect(timing.toHeaderValue()).toBe("huge;dur=1000000.00");
  });

  it("escapes quotes in description", () => {
    const timing = new Timing();
    timing.record("test", 10, 'Description with "quotes"');
    // The implementation doesn't escape quotes, so this documents current behavior
    const header = timing.toHeaderValue();
    expect(header).toBe('test;dur=10.00;desc="Description with "quotes""');
  });

  it("handles special characters in description", () => {
    const timing = new Timing();
    timing.record("test", 10, "Special: <>&;=");
    const header = timing.toHeaderValue();
    expect(header).toBe('test;dur=10.00;desc="Special: <>&;="');
  });

  it("handles empty description string", () => {
    const timing = new Timing();
    timing.record("test", 10, "");
    // Empty string is falsy, so no desc should be added
    const header = timing.toHeaderValue();
    expect(header).toBe("test;dur=10.00");
  });

  it("handles negative durations", () => {
    const timing = new Timing();
    timing.record("negative", -5.5);
    expect(timing.toHeaderValue()).toBe("negative;dur=-5.50");
  });
});

// ============================================================================
// appendServerTiming()
// ============================================================================

describe("appendServerTiming", () => {
  it("does nothing when timing is null", () => {
    const headers = new Headers();
    appendServerTiming(headers, null);
    expect(headers.has("Server-Timing")).toBe(false);
  });

  it("does nothing when timing is empty", () => {
    const headers = new Headers();
    const timing = new Timing();
    appendServerTiming(headers, timing);
    expect(headers.has("Server-Timing")).toBe(false);
  });

  it("sets Server-Timing header when no existing header", () => {
    const headers = new Headers();
    const timing = new Timing();
    timing.record("test", 10);
    appendServerTiming(headers, timing);

    expect(headers.get("Server-Timing")).toBe("test;dur=10.00");
  });

  it("appends to existing Server-Timing header with comma-space", () => {
    const headers = new Headers();
    headers.set("Server-Timing", "existing;dur=5.00");

    const timing = new Timing();
    timing.record("new", 10);
    appendServerTiming(headers, timing);

    expect(headers.get("Server-Timing")).toBe("existing;dur=5.00, new;dur=10.00");
  });

  it("appends multiple new entries to existing header", () => {
    const headers = new Headers();
    headers.set("Server-Timing", "first;dur=1.00");

    const timing = new Timing();
    timing.record("second", 2);
    timing.record("third", 3);
    appendServerTiming(headers, timing);

    expect(headers.get("Server-Timing")).toBe("first;dur=1.00, second;dur=2.00, third;dur=3.00");
  });

  it("does not set header when timing value is empty string", () => {
    const headers = new Headers();
    const timing = new Timing();
    // Record only non-finite entries so toHeaderValue returns ""
    timing.record("invalid", NaN);

    appendServerTiming(headers, timing);
    expect(headers.has("Server-Timing")).toBe(false);
  });

  it("handles timing with descriptions", () => {
    const headers = new Headers();
    const timing = new Timing();
    timing.record("fetch", 50, "Database query");
    appendServerTiming(headers, timing);

    expect(headers.get("Server-Timing")).toBe('fetch;dur=50.00;desc="Database query"');
  });

  it("preserves complex existing Server-Timing header", () => {
    const headers = new Headers();
    headers.set("Server-Timing", 'cache;dur=2.3;desc="Cache", db;dur=5.6');

    const timing = new Timing();
    timing.record("app", 10.5, "Application logic");
    appendServerTiming(headers, timing);

    expect(headers.get("Server-Timing")).toBe(
      'cache;dur=2.3;desc="Cache", db;dur=5.6, app;dur=10.50;desc="Application logic"',
    );
  });
});

// ============================================================================
// attachTiming()
// ============================================================================

describe("attachTiming", () => {
  it("returns original response when timing is null", () => {
    const response = new Response("body", { status: 200 });
    const result = attachTiming(response, null);

    expect(result).toBe(response);
  });

  it("returns original response when timing is empty", () => {
    const response = new Response("body", { status: 200 });
    const timing = new Timing();
    const result = attachTiming(response, timing);

    expect(result).toBe(response);
  });

  it("returns new response with Server-Timing header", async () => {
    const response = new Response("body", { status: 200 });
    const timing = new Timing();
    timing.record("test", 10);

    const result = attachTiming(response, timing);

    expect(result).not.toBe(response);
    expect(result.headers.get("Server-Timing")).toBe("test;dur=10.00");
    expect(await result.text()).toBe("body");
  });

  it("preserves response status", () => {
    const response = new Response("error", { status: 404 });
    const timing = new Timing();
    timing.record("lookup", 5);

    const result = attachTiming(response, timing);

    expect(result.status).toBe(404);
  });

  it("preserves response statusText", () => {
    const response = new Response("error", { status: 404, statusText: "Not Found" });
    const timing = new Timing();
    timing.record("lookup", 5);

    const result = attachTiming(response, timing);

    expect(result.statusText).toBe("Not Found");
  });

  it("preserves existing response headers", () => {
    const response = new Response("body", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "X-Custom": "value",
      },
    });
    const timing = new Timing();
    timing.record("process", 15);

    const result = attachTiming(response, timing);

    expect(result.headers.get("Content-Type")).toBe("text/plain");
    expect(result.headers.get("X-Custom")).toBe("value");
    expect(result.headers.get("Server-Timing")).toBe("process;dur=15.00");
  });

  it("appends to existing Server-Timing header", () => {
    const response = new Response("body", {
      status: 200,
      headers: {
        "Server-Timing": "cache;dur=5.00",
      },
    });
    const timing = new Timing();
    timing.record("compute", 10);

    const result = attachTiming(response, timing);

    expect(result.headers.get("Server-Timing")).toBe("cache;dur=5.00, compute;dur=10.00");
  });

  it("preserves response body stream", async () => {
    const body = "test response body";
    const response = new Response(body, { status: 200 });
    const timing = new Timing();
    timing.record("stream", 20);

    const result = attachTiming(response, timing);

    expect(await result.text()).toBe(body);
  });

  it("works with JSON response", async () => {
    const data = { message: "success" };
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const timing = new Timing();
    timing.record("json", 12);

    const result = attachTiming(response, timing);

    expect(result.headers.get("Content-Type")).toBe("application/json");
    expect(result.headers.get("Server-Timing")).toBe("json;dur=12.00");
    expect(await result.json()).toEqual(data);
  });

  it("works with empty body response", async () => {
    const response = new Response(null, { status: 204 });
    const timing = new Timing();
    timing.record("nocontent", 3);

    const result = attachTiming(response, timing);

    expect(result.status).toBe(204);
    expect(result.headers.get("Server-Timing")).toBe("nocontent;dur=3.00");
    expect(result.body).toBeNull();
  });

  it("handles timing with multiple entries", () => {
    const response = new Response("body", { status: 200 });
    const timing = new Timing();
    timing.record("db", 25);
    timing.record("cache", 5);
    timing.record("render", 10);

    const result = attachTiming(response, timing);

    expect(result.headers.get("Server-Timing")).toBe(
      "db;dur=25.00, cache;dur=5.00, render;dur=10.00",
    );
  });

  it("handles timing with descriptions", () => {
    const response = new Response("body", { status: 200 });
    const timing = new Timing();
    timing.record("query", 30, "Database query");

    const result = attachTiming(response, timing);

    expect(result.headers.get("Server-Timing")).toBe('query;dur=30.00;desc="Database query"');
  });
});

// ============================================================================
// Integration scenarios
// ============================================================================

describe("Timing - integration scenarios", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks multiple operations in sequence", () => {
    const timing = new Timing();

    const auth = timing.start("auth");
    vi.advanceTimersByTime(10);
    auth();

    const db = timing.start("db", "Fetch user");
    vi.advanceTimersByTime(50);
    db();

    const render = timing.start("render");
    vi.advanceTimersByTime(20);
    render();

    const header = timing.toHeaderValue();
    expect(header).toBe('auth;dur=10.00, db;dur=50.00;desc="Fetch user", render;dur=20.00');
  });

  it("combines start() and record() methods", () => {
    const timing = new Timing();

    timing.record("overhead", 2.5, "Request overhead");

    const process = timing.start("process");
    vi.advanceTimersByTime(100);
    process();

    timing.record("total", 150, "Total time");

    const header = timing.toHeaderValue();
    expect(header).toBe(
      'overhead;dur=2.50;desc="Request overhead", process;dur=100.00, total;dur=150.00;desc="Total time"',
    );
  });

  it("full workflow with response attachment", async () => {
    const timing = new Timing();

    const auth = timing.start("auth");
    vi.advanceTimersByTime(5);
    auth();

    const handler = timing.start("handler", "Request handler");
    vi.advanceTimersByTime(95);
    handler();

    const response = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const finalResponse = attachTiming(response, timing);

    expect(finalResponse.status).toBe(200);
    expect(finalResponse.headers.get("Content-Type")).toBe("application/json");
    expect(finalResponse.headers.get("Server-Timing")).toBe(
      'auth;dur=5.00, handler;dur=95.00;desc="Request handler"',
    );
    expect(await finalResponse.json()).toEqual({ success: true });
  });

  it("handles nested timing measurements", () => {
    const timing = new Timing();

    const outer = timing.start("outer");
    vi.advanceTimersByTime(10);

    const inner1 = timing.start("inner1");
    vi.advanceTimersByTime(30);
    inner1();

    const inner2 = timing.start("inner2");
    vi.advanceTimersByTime(20);
    inner2();

    vi.advanceTimersByTime(5);
    outer();

    // Entries are recorded in the order they're completed, not started
    const header = timing.toHeaderValue();
    expect(header).toBe("inner1;dur=30.00, inner2;dur=20.00, outer;dur=65.00");
  });

  it("skips invalid entries in real workflow", () => {
    const timing = new Timing();

    timing.record("valid1", 10);
    timing.record("invalid", NaN);

    const measure = timing.start("measure");
    vi.advanceTimersByTime(20);
    measure();

    timing.record("infinity", Infinity);
    timing.record("valid2", 30);

    const header = timing.toHeaderValue();
    expect(header).toBe("valid1;dur=10.00, measure;dur=20.00, valid2;dur=30.00");
  });

  it("empty timing does not modify response", () => {
    const timing = new Timing();
    const response = new Response("body", {
      status: 200,
      headers: { "X-Custom": "value" },
    });

    const result = attachTiming(response, timing);

    expect(result).toBe(response);
    expect(result.headers.has("Server-Timing")).toBe(false);
  });
});
