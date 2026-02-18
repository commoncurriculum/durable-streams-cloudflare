import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logError, logWarn, logInfo, getLogger } from "../../src/log";

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Mock console methods to capture log output
 */
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Spy on console methods to verify log calls
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  // Restore console methods
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleInfoSpy.mockRestore();
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse JSON log output from console spy
 */
function parseLogCall(spy: ReturnType<typeof vi.spyOn>, callIndex = 0): Record<string, unknown> {
  const call = spy.mock.calls[callIndex];
  if (!call || call.length === 0) {
    throw new Error(`No call at index ${callIndex}`);
  }
  const logString = call[0];
  if (typeof logString !== "string") {
    throw new Error(`Expected string, got ${typeof logString}`);
  }
  return JSON.parse(logString);
}

/**
 * Verify common log fields
 */
function verifyLogFields(
  log: Record<string, unknown>,
  expectedLevel: string,
  expectedMsg: string,
  expectedContext: Record<string, unknown>,
): void {
  expect(log.level).toBe(expectedLevel);
  expect(log.msg).toBe(expectedMsg);
  expect(log.ts).toBeDefined();
  expect(typeof log.ts).toBe("number");

  // Verify context fields are present
  for (const [key, value] of Object.entries(expectedContext)) {
    expect(log[key]).toBe(value);
  }
}

// ============================================================================
// logError — basic functionality
// ============================================================================

describe("logError", () => {
  it("logs error with context and error object", () => {
    const context = { streamId: "test-stream", projectId: "test-project" };
    const message = "Failed to append to stream";
    const error = new Error("Connection timeout");

    logError(context, message, error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    verifyLogFields(log, "error", message, context);
    // LogLayer's withError adds error details using 'err' field
    expect(log.err).toBeDefined();
  });

  it("logs error with context without error object", () => {
    const context = { streamId: "test-stream", operation: "read" };
    const message = "Stream not found";

    logError(context, message);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    verifyLogFields(log, "error", message, context);
    // No error object means no error field
    expect(log.err).toBeUndefined();
  });

  it("logs error with empty context", () => {
    const context = {};
    const message = "System error";

    logError(context, message);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    expect(log.level).toBe("error");
    expect(log.msg).toBe(message);
    expect(log.ts).toBeDefined();
  });

  it("logs error with complex context", () => {
    const context = {
      streamId: "test-stream",
      projectId: "test-project",
      offset: 42,
      contentType: "application/json",
      requestId: "abc123",
    };
    const message = "Invalid offset";

    logError(context, message);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    verifyLogFields(log, "error", message, context);
  });

  it("logs error with Error instance", () => {
    const context = { operation: "append" };
    const message = "Operation failed";
    const error = new Error("Network error");
    error.name = "NetworkError";

    logError(context, message, error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    verifyLogFields(log, "error", message, context);
    expect(log.err).toBeDefined();
  });

  it("logs error with non-Error object", () => {
    const context = { streamId: "test" };
    const message = "Unexpected failure";
    const error = { code: "ECONNRESET", message: "Connection reset" };

    logError(context, message, error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    verifyLogFields(log, "error", message, context);
    expect(log.err).toBeDefined();
  });

  it("logs error with string error", () => {
    const context = { streamId: "test" };
    const message = "String error occurred";
    const error = "This is a string error";

    logError(context, message, error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    verifyLogFields(log, "error", message, context);
    expect(log.err).toBeDefined();
  });
});

// ============================================================================
// logWarn — basic functionality
// ============================================================================

describe("logWarn", () => {
  it("logs warning with context and error object", () => {
    const context = { streamId: "test-stream", projectId: "test-project" };
    const message = "Stream nearing capacity";
    const error = new Error("90% full");

    logWarn(context, message, error);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleWarnSpy);

    verifyLogFields(log, "warn", message, context);
    expect(log.err).toBeDefined();
  });

  it("logs warning with context without error object", () => {
    const context = { streamId: "test-stream", subscribers: 100 };
    const message = "High subscriber count";

    logWarn(context, message);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleWarnSpy);

    verifyLogFields(log, "warn", message, context);
    expect(log.err).toBeUndefined();
  });

  it("logs warning with empty context", () => {
    const context = {};
    const message = "Configuration warning";

    logWarn(context, message);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleWarnSpy);

    expect(log.level).toBe("warn");
    expect(log.msg).toBe(message);
    expect(log.ts).toBeDefined();
  });

  it("logs warning with complex context", () => {
    const context = {
      streamId: "test-stream",
      operation: "cleanup",
      segmentCount: 500,
      threshold: 1000,
    };
    const message = "Approaching segment limit";

    logWarn(context, message);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleWarnSpy);

    verifyLogFields(log, "warn", message, context);
  });

  it("logs warning with Error instance", () => {
    const context = { operation: "read" };
    const message = "Slow query detected";
    const error = new Error("Query took 5000ms");

    logWarn(context, message, error);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleWarnSpy);

    verifyLogFields(log, "warn", message, context);
    expect(log.err).toBeDefined();
  });

  it("logs warning with non-Error object", () => {
    const context = { streamId: "test" };
    const message = "Deprecated API usage";
    const error = { api: "v1/old", deprecationDate: "2025-01-01" };

    logWarn(context, message, error);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleWarnSpy);

    verifyLogFields(log, "warn", message, context);
    expect(log.err).toBeDefined();
  });
});

// ============================================================================
// logInfo — basic functionality
// ============================================================================

describe("logInfo", () => {
  it("logs info with context", () => {
    const context = { streamId: "test-stream", projectId: "test-project" };
    const message = "Stream created successfully";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    verifyLogFields(log, "info", message, context);
  });

  it("logs info with empty context", () => {
    const context = {};
    const message = "Service started";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.level).toBe("info");
    expect(log.msg).toBe(message);
    expect(log.ts).toBeDefined();
  });

  it("logs info with complex context", () => {
    const context = {
      streamId: "test-stream",
      operation: "append",
      byteCount: 1024,
      offset: 42,
      contentType: "text/plain",
    };
    const message = "Data appended";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    verifyLogFields(log, "info", message, context);
  });

  it("logs info with numeric context values", () => {
    const context = {
      count: 100,
      duration: 123.45,
      statusCode: 200,
    };
    const message = "Request completed";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.level).toBe("info");
    expect(log.msg).toBe(message);
    expect(log.count).toBe(100);
    expect(log.duration).toBe(123.45);
    expect(log.statusCode).toBe(200);
  });

  it("logs info with boolean context values", () => {
    const context = {
      success: true,
      cached: false,
      compressed: true,
    };
    const message = "Response generated";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.level).toBe("info");
    expect(log.msg).toBe(message);
    expect(log.success).toBe(true);
    expect(log.cached).toBe(false);
    expect(log.compressed).toBe(true);
  });

  it("logs info with null context values", () => {
    const context = {
      streamId: "test",
      endOffset: null,
    };
    const message = "Stream has no end";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.level).toBe("info");
    expect(log.msg).toBe(message);
    expect(log.streamId).toBe("test");
    expect(log.endOffset).toBeNull();
  });
});

// ============================================================================
// getLogger — basic functionality
// ============================================================================

describe("getLogger", () => {
  it("returns the root logger instance", () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(typeof logger).toBe("object");
  });

  it("returns a logger with withContext method", () => {
    const logger = getLogger();
    expect(typeof logger.withContext).toBe("function");
  });

  it("returns a logger with log level methods", () => {
    const logger = getLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("returns a logger that can be used directly", () => {
    const logger = getLogger();
    const contextLogger = logger.withContext({ test: "direct" });

    contextLogger.info("Direct logger usage");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.level).toBe("info");
    expect(log.msg).toBe("Direct logger usage");
    expect(log.test).toBe("direct");
  });

  it("returns a logger with withError method", () => {
    const logger = getLogger();
    expect(typeof logger.withError).toBe("function");
  });

  it("returns the same logger instance on multiple calls", () => {
    const logger1 = getLogger();
    const logger2 = getLogger();

    // Should return the same instance (reference equality)
    expect(logger1).toBe(logger2);
  });
});

// ============================================================================
// Structured logging format verification
// ============================================================================

describe("structured logging format", () => {
  it("outputs valid JSON with all required fields", () => {
    const context = { streamId: "test", projectId: "proj" };
    const message = "Test message";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logString = consoleInfoSpy.mock.calls[0][0] as string;

    // Should be valid JSON
    expect(() => JSON.parse(logString)).not.toThrow();

    const log = JSON.parse(logString);

    // Should have all required structured fields
    expect(log).toHaveProperty("level");
    expect(log).toHaveProperty("msg");
    expect(log).toHaveProperty("ts");

    // Should have context fields
    expect(log).toHaveProperty("streamId");
    expect(log).toHaveProperty("projectId");
  });

  it("uses consistent field names across log levels", () => {
    const context = { key: "value" };

    logInfo(context, "Info message");
    logWarn(context, "Warn message");
    logError(context, "Error message");

    const infoLog = parseLogCall(consoleInfoSpy);
    const warnLog = parseLogCall(consoleWarnSpy);
    const errorLog = parseLogCall(consoleErrorSpy);

    // All should have same field structure
    expect(Object.keys(infoLog).sort()).toContain("level");
    expect(Object.keys(infoLog).sort()).toContain("msg");
    expect(Object.keys(infoLog).sort()).toContain("ts");

    expect(Object.keys(warnLog).sort()).toContain("level");
    expect(Object.keys(warnLog).sort()).toContain("msg");
    expect(Object.keys(warnLog).sort()).toContain("ts");

    expect(Object.keys(errorLog).sort()).toContain("level");
    expect(Object.keys(errorLog).sort()).toContain("msg");
    expect(Object.keys(errorLog).sort()).toContain("ts");
  });

  it("includes timestamp as Unix milliseconds", () => {
    const now = Date.now();
    logInfo({}, "Test");

    const log = parseLogCall(consoleInfoSpy);

    expect(typeof log.ts).toBe("number");
    // Timestamp should be close to now (within 1 second)
    expect(Math.abs((log.ts as number) - now)).toBeLessThan(1000);
  });

  it("does not include undefined context values", () => {
    const context = {
      defined: "value",
      undefined: undefined,
    };

    logInfo(context, "Test");

    const log = parseLogCall(consoleInfoSpy);

    expect(log.defined).toBe("value");
    // undefined values should not appear in JSON
    expect("undefined" in log).toBe(false);
  });

  it("outputs single line JSON (no newlines in JSON)", () => {
    const context = { streamId: "test" };
    const message = "Test message";

    logInfo(context, message);

    const logString = consoleInfoSpy.mock.calls[0][0] as string;

    // JSON string should be single line (stringify: true in config)
    expect(typeof logString).toBe("string");
    expect(logString.trim()).not.toContain("\n");
  });
});

// ============================================================================
// Edge cases and special scenarios
// ============================================================================

describe("edge cases", () => {
  it("handles empty message", () => {
    const context = { streamId: "test" };
    const message = "";

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.msg).toBe("");
  });

  it("handles message with special characters", () => {
    const context = { streamId: "test" };
    const message = 'Special chars: "quotes" \\backslash\\ \nnewline\t tab';

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    // JSON should escape special characters properly
    expect(log.msg).toBe(message);
  });

  it("handles context with special string values", () => {
    const context = {
      streamId: "test-\n-newline",
      quote: 'has "quotes"',
      backslash: "has\\backslash",
    };

    logInfo(context, "Test");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.streamId).toBe(context.streamId);
    expect(log.quote).toBe(context.quote);
    expect(log.backslash).toBe(context.backslash);
  });

  it("handles very long messages", () => {
    const context = { streamId: "test" };
    const message = "x".repeat(10000);

    logInfo(context, message);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.msg).toBe(message);
  });

  it("handles context with array values", () => {
    const context = {
      streamIds: ["stream1", "stream2", "stream3"],
      counts: [1, 2, 3],
    };

    logInfo(context, "Multiple streams");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.streamIds).toEqual(["stream1", "stream2", "stream3"]);
    expect(log.counts).toEqual([1, 2, 3]);
  });

  it("handles context with nested objects", () => {
    const context = {
      request: {
        method: "GET",
        path: "/stream/test",
        headers: { "content-type": "application/json" },
      },
    };

    logInfo(context, "Request received");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.request).toEqual(context.request);
  });

  it("handles multiple rapid log calls", () => {
    for (let i = 0; i < 100; i++) {
      logInfo({ iteration: i }, `Message ${i}`);
    }

    expect(consoleInfoSpy).toHaveBeenCalledTimes(100);

    // Verify first and last logs
    const firstLog = parseLogCall(consoleInfoSpy, 0);
    const lastLog = parseLogCall(consoleInfoSpy, 99);

    expect(firstLog.iteration).toBe(0);
    expect(firstLog.msg).toBe("Message 0");

    expect(lastLog.iteration).toBe(99);
    expect(lastLog.msg).toBe("Message 99");
  });

  it("handles context with large numbers", () => {
    const context = {
      offset: Number.MAX_SAFE_INTEGER,
      negative: Number.MIN_SAFE_INTEGER,
      float: 123.456789,
    };

    logInfo(context, "Large numbers");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleInfoSpy);

    expect(log.offset).toBe(Number.MAX_SAFE_INTEGER);
    expect(log.negative).toBe(Number.MIN_SAFE_INTEGER);
    expect(log.float).toBe(123.456789);
  });
});

// ============================================================================
// Error object variations
// ============================================================================

describe("error object handling", () => {
  it("handles Error with stack trace", () => {
    const context = { operation: "test" };
    const error = new Error("Test error");

    logError(context, "Error occurred", error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    expect(log.err).toBeDefined();
  });

  it("handles Error with custom properties", () => {
    const context = { operation: "test" };
    const error = new Error("Custom error") as Error & { code: string; statusCode: number };
    error.code = "CUSTOM_ERROR";
    error.statusCode = 500;

    logError(context, "Error with custom props", error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    expect(log.err).toBeDefined();
  });

  it("handles TypeError", () => {
    const context = { operation: "test" };
    const error = new TypeError("Invalid type");

    logError(context, "Type error occurred", error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    expect(log.err).toBeDefined();
  });

  it("handles RangeError", () => {
    const context = { operation: "test" };
    const error = new RangeError("Out of range");

    logError(context, "Range error occurred", error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    expect(log.err).toBeDefined();
  });

  it("handles null as error", () => {
    const context = { operation: "test" };

    logError(context, "Null error", null);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    // null is falsy, so it takes the else branch (no error object)
    expect(log.err).toBeUndefined();
  });

  it("handles undefined as error", () => {
    const context = { operation: "test" };

    logError(context, "Undefined error", undefined);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    // undefined means no error object, should use else branch
    expect(log.err).toBeUndefined();
  });

  it("handles number as error", () => {
    const context = { operation: "test" };

    logError(context, "Number error", 404);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const log = parseLogCall(consoleErrorSpy);

    expect(log.err).toBeDefined();
  });
});
