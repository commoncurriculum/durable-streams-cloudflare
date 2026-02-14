import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  tryCoalesceInFlight,
  resolveInFlightWaiters,
  COALESCE_LINGER_MS,
  MAX_IN_FLIGHT,
  type InFlightResult,
} from "../../../../src/http/middleware/coalesce";
import { Timing } from "../../../../src/http/shared/timing";
import * as log from "../../../../src/log";

// ============================================================================
// Constants
// ============================================================================

describe("coalesce constants", () => {
  it("exports COALESCE_LINGER_MS constant", () => {
    expect(COALESCE_LINGER_MS).toBe(200);
  });

  it("exports MAX_IN_FLIGHT constant", () => {
    expect(MAX_IN_FLIGHT).toBe(100_000);
  });
});

// ============================================================================
// tryCoalesceInFlight - Happy Path
// ============================================================================

describe("tryCoalesceInFlight - no pending request", () => {
  it("returns null when no pending request exists", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const corsOrigin = "*";
    const timing = new Timing();

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, corsOrigin, timing);

    expect(result).toBeNull();
  });

  it("returns null when inFlight map is empty", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result).toBeNull();
  });

  it("returns null when cacheUrl does not match any pending requests", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const otherPromise = Promise.resolve({
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [],
    });
    inFlight.set("https://example.com/other", otherPromise);

    const result = await tryCoalesceInFlight(
      inFlight,
      "https://example.com/stream/test",
      null,
      null,
    );

    expect(result).toBeNull();
  });
});

describe("tryCoalesceInFlight - with pending request", () => {
  it("waits for pending request and returns a Response", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const body = new TextEncoder().encode("test data");

    const pendingResult: InFlightResult = {
      body: body.buffer as ArrayBuffer,
      status: 200,
      statusText: "OK",
      headers: [
        ["Content-Type", "text/plain"],
        ["Content-Length", "9"],
      ],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, "*", null);

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(200);
    expect(result!.statusText).toBe("OK");
    expect(result!.headers.get("Content-Type")).toBe("text/plain");
    expect(result!.headers.get("X-Cache")).toBe("HIT");
    expect(result!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await result!.text();
    expect(text).toBe("test data");
  });

  it("sets X-Cache header to HIT", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 204,
      statusText: "No Content",
      headers: [],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result!.headers.get("X-Cache")).toBe("HIT");
  });

  it("applies CORS headers with specific origin", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const corsOrigin = "https://myapp.com";

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, corsOrigin, null);

    expect(result!.headers.get("Access-Control-Allow-Origin")).toBe("https://myapp.com");
    expect(result!.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(result!.headers.get("Access-Control-Expose-Headers")).toContain("Stream-Next-Offset");
  });

  it("does not apply CORS headers when corsOrigin is null", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result!.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(result!.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("preserves original response headers", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [
        ["Stream-Next-Offset", "42"],
        ["Stream-Cursor", "abc123"],
        ["Content-Type", "application/json"],
      ],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result!.headers.get("Stream-Next-Offset")).toBe("42");
    expect(result!.headers.get("Stream-Cursor")).toBe("abc123");
    expect(result!.headers.get("Content-Type")).toBe("application/json");
  });

  it("attaches timing when timing object is provided", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const timing = new Timing();
    timing.record("test", 10);

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, timing);

    expect(result!.headers.get("Server-Timing")).toBeTruthy();
    expect(result!.headers.get("Server-Timing")).toContain("test");
  });

  it("does not attach timing when timing is null", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result!.headers.get("Server-Timing")).toBeNull();
  });

  it("handles non-200 status codes", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    const pendingResult: InFlightResult = {
      body: new ArrayBuffer(0),
      status: 404,
      statusText: "Not Found",
      headers: [],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result!.status).toBe(404);
    expect(result!.statusText).toBe("Not Found");
    expect(result!.headers.get("X-Cache")).toBe("HIT");
  });

  it("handles binary response bodies", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header

    const pendingResult: InFlightResult = {
      body: binaryData.buffer,
      status: 200,
      statusText: "OK",
      headers: [["Content-Type", "image/png"]],
    };

    inFlight.set(cacheUrl, Promise.resolve(pendingResult));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    const arrayBuffer = await result!.arrayBuffer();
    const resultData = new Uint8Array(arrayBuffer);
    expect(resultData).toEqual(binaryData);
  });
});

describe("tryCoalesceInFlight - error handling", () => {
  let logWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logWarnSpy = vi.spyOn(log, "logWarn").mockImplementation(() => {});
  });

  afterEach(() => {
    logWarnSpy.mockRestore();
  });

  it("returns null when pending request rejects", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const error = new Error("Request failed");

    inFlight.set(cacheUrl, Promise.reject(error));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, "*", null);

    expect(result).toBeNull();
  });

  it("logs warning when pending request fails", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const error = new Error("Network timeout");

    inFlight.set(cacheUrl, Promise.reject(error));

    await tryCoalesceInFlight(inFlight, cacheUrl, "*", null);

    expect(logWarnSpy).toHaveBeenCalledWith(
      { cacheUrl, component: "coalesce" },
      "coalesced request failed, falling through to DO",
      error,
    );
  });

  it("logs warning with correct context", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/my-stream?offset=10";
    const error = new Error("Server error");

    inFlight.set(cacheUrl, Promise.reject(error));

    await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    const callArgs = logWarnSpy.mock.calls[0];
    expect(callArgs[0]).toEqual({ cacheUrl, component: "coalesce" });
    expect(callArgs[1]).toBe("coalesced request failed, falling through to DO");
    expect(callArgs[2]).toBe(error);
  });

  it("handles promise rejection with non-Error object", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    inFlight.set(cacheUrl, Promise.reject("string error"));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result).toBeNull();
    expect(logWarnSpy).toHaveBeenCalledWith(
      { cacheUrl, component: "coalesce" },
      "coalesced request failed, falling through to DO",
      "string error",
    );
  });

  it("handles promise rejection with null", async () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";

    inFlight.set(cacheUrl, Promise.reject(null));

    const result = await tryCoalesceInFlight(inFlight, cacheUrl, null, null);

    expect(result).toBeNull();
    expect(logWarnSpy).toHaveBeenCalled();
  });
});

// ============================================================================
// resolveInFlightWaiters
// ============================================================================

describe("resolveInFlightWaiters - stored in cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the promise with InFlightResult", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const body = new TextEncoder().encode("test");
    const response = new Response(body, {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Next-Offset": "10",
      },
    });

    let resolvedValue: InFlightResult | undefined;
    const promise = new Promise<InFlightResult>((resolve) => {
      const captureResolve = (r: InFlightResult) => {
        resolvedValue = r;
        resolve(r);
      };
      resolveInFlightWaiters(
        inFlight,
        cacheUrl,
        response,
        body.buffer as ArrayBuffer,
        captureResolve,
        true,
      );
    });

    inFlight.set(cacheUrl, promise);

    expect(resolvedValue).toBeDefined();
    expect(resolvedValue!.status).toBe(200);
    expect(resolvedValue!.statusText).toBe("OK");
    expect(resolvedValue!.headers).toEqual([
      ["content-type", "text/plain"],
      ["stream-next-offset", "10"],
    ]);
  });

  it("captures all response headers as array", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, {
      status: 204,
      statusText: "No Content",
      headers: {
        "X-Custom-1": "value1",
        "X-Custom-2": "value2",
        "Content-Type": "application/json",
      },
    });

    let capturedHeaders: [string, string][] = [];
    const resolve = (r: InFlightResult) => {
      capturedHeaders = r.headers;
    };

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolve, true);

    expect(capturedHeaders).toHaveLength(3);
    expect(capturedHeaders).toContainEqual(["content-type", "application/json"]);
    expect(capturedHeaders).toContainEqual(["x-custom-1", "value1"]);
    expect(capturedHeaders).toContainEqual(["x-custom-2", "value2"]);
  });

  it("lingers in map when stored in cache", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 200 });

    let resolveFunc: (r: InFlightResult) => void = () => {};
    const promise = new Promise<InFlightResult>((res) => {
      resolveFunc = res;
    });
    inFlight.set(cacheUrl, promise);

    // Call resolveInFlightWaiters - it should NOT delete immediately because storedInCache=true
    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolveFunc, true);

    // Should still be in the map (lingering)
    expect(inFlight.has(cacheUrl)).toBe(true);

    // Advance time by less than COALESCE_LINGER_MS
    vi.advanceTimersByTime(COALESCE_LINGER_MS - 10);
    expect(inFlight.has(cacheUrl)).toBe(true);

    // Advance past COALESCE_LINGER_MS - now it should be deleted
    vi.advanceTimersByTime(20);
    expect(inFlight.has(cacheUrl)).toBe(false);
  });

  it("only deletes the lingering promise if it is still the same promise", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 200 });

    let resolveFunc1: (r: InFlightResult) => void = () => {};
    const promise1 = new Promise<InFlightResult>((res) => {
      resolveFunc1 = res;
    });
    inFlight.set(cacheUrl, promise1);

    // Call resolveInFlightWaiters with storedInCache=true
    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolveFunc1, true);

    // Replace with a different promise before the timeout
    vi.advanceTimersByTime(COALESCE_LINGER_MS / 2);
    const promise2 = Promise.resolve({
      body: new ArrayBuffer(0),
      status: 200,
      statusText: "OK",
      headers: [],
    });
    inFlight.set(cacheUrl, promise2);

    // Advance past the original timeout
    vi.advanceTimersByTime(COALESCE_LINGER_MS);

    // The map should still have the entry because it was replaced
    expect(inFlight.has(cacheUrl)).toBe(true);
    expect(inFlight.get(cacheUrl)).toBe(promise2);
  });
});

describe("resolveInFlightWaiters - NOT stored in cache", () => {
  it("deletes immediately when not stored in cache", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 200 });

    let resolveFunc: (r: InFlightResult) => void = () => {};
    const promise = new Promise<InFlightResult>((res) => {
      resolveFunc = res;
    });
    inFlight.set(cacheUrl, promise);

    // Call resolveInFlightWaiters with storedInCache=false - should delete immediately
    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolveFunc, false);

    expect(inFlight.has(cacheUrl)).toBe(false);
  });

  it("does not linger when storedInCache is false", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 204 });

    let resolveFunc: (r: InFlightResult) => void = () => {};
    const promise = new Promise<InFlightResult>((res) => {
      resolveFunc = res;
    });
    inFlight.set(cacheUrl, promise);

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolveFunc, false);

    // Immediately deleted
    expect(inFlight.has(cacheUrl)).toBe(false);
  });

  it("deletes at-tail GET immediately to avoid stale data", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test?offset=-1";
    const response = new Response(null, {
      status: 200,
      headers: { "Stream-Up-To-Date": "true" },
    });

    let resolveFunc: (r: InFlightResult) => void = () => {};
    const promise = new Promise<InFlightResult>((res) => {
      resolveFunc = res;
    });
    inFlight.set(cacheUrl, promise);

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolveFunc, false);

    expect(inFlight.has(cacheUrl)).toBe(false);
  });

  it("deletes 404 responses immediately", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/nonexistent";
    const response = new Response(null, { status: 404, statusText: "Not Found" });

    let resolveFunc: (r: InFlightResult) => void = () => {};
    const promise = new Promise<InFlightResult>((res) => {
      resolveFunc = res;
    });
    inFlight.set(cacheUrl, promise);

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolveFunc, false);

    expect(inFlight.has(cacheUrl)).toBe(false);
  });
});

describe("resolveInFlightWaiters - edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles response with no headers", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 204 });

    let capturedResult: InFlightResult | undefined;
    const resolve = (r: InFlightResult) => {
      capturedResult = r;
    };

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolve, true);

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.headers).toEqual([]);
  });

  it("handles response with empty body", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 204, statusText: "No Content" });

    let capturedResult: InFlightResult | undefined;
    const resolve = (r: InFlightResult) => {
      capturedResult = r;
    };

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolve, false);

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.body.byteLength).toBe(0);
  });

  it("preserves binary data in bodyBuffer", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
    const response = new Response(binaryData, { status: 200 });

    let capturedResult: InFlightResult | undefined;
    const resolve = (r: InFlightResult) => {
      capturedResult = r;
    };

    resolveInFlightWaiters(inFlight, cacheUrl, response, binaryData.buffer, resolve, false);

    expect(capturedResult).toBeDefined();
    expect(new Uint8Array(capturedResult!.body)).toEqual(binaryData);
  });

  it("resolves with correct statusText", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const response = new Response(null, { status: 201, statusText: "Created" });

    let capturedResult: InFlightResult | undefined;
    const resolve = (r: InFlightResult) => {
      capturedResult = r;
    };

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolve, false);

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.statusText).toBe("Created");
  });

  it("handles multiple headers with same name", () => {
    const inFlight = new Map<string, Promise<InFlightResult>>();
    const cacheUrl = "https://example.com/stream/test";
    const headers = new Headers();
    headers.append("Set-Cookie", "session=abc123");
    headers.append("Set-Cookie", "user=john");
    const response = new Response(null, { status: 200, headers });

    let capturedHeaders: [string, string][] = [];
    const resolve = (r: InFlightResult) => {
      capturedHeaders = r.headers;
    };

    resolveInFlightWaiters(inFlight, cacheUrl, response, new ArrayBuffer(0), resolve, false);

    // Headers iterator will return both values separately
    const setCookieHeaders = capturedHeaders.filter(([k]) => k === "set-cookie");
    expect(setCookieHeaders.length).toBeGreaterThan(0);
  });
});
