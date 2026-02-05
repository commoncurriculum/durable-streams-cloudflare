import { describe, it, expect, vi } from "vitest";
import { withRetry, type RetryOptions } from "../../src/utils/retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("success");

    const result = await withRetry(fn);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure up to maxAttempts", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after maxAttempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff", async () => {
    const delays: number[] = [];
    let lastCall = Date.now();

    const fn = vi.fn().mockImplementation(async () => {
      const now = Date.now();
      if (fn.mock.calls.length > 1) {
        delays.push(now - lastCall);
      }
      lastCall = now;
      if (fn.mock.calls.length < 3) {
        throw new Error("fail");
      }
      return "success";
    });

    const options: RetryOptions = { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2 };
    const result = await withRetry(fn, options);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
    // First delay ~10ms, second delay ~20ms (with some tolerance for timing)
    expect(delays[0]).toBeGreaterThanOrEqual(8);
    expect(delays[1]).toBeGreaterThanOrEqual(15);
  });

  it("respects shouldRetry predicate", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));

    await expect(withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 1,
      shouldRetry: () => false, // Never retry
    })).rejects.toThrow("permanent");

    expect(fn).toHaveBeenCalledTimes(1); // Only tried once
  });

  it("retries when shouldRetry returns true", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("retryable"))
      .mockResolvedValue("success");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 1,
      shouldRetry: (error) => error.message === "retryable",
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when shouldRetry returns false for specific error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("retryable"))
      .mockRejectedValueOnce(new Error("permanent"))
      .mockResolvedValue("success");

    await expect(withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 1,
      shouldRetry: (error) => error.message !== "permanent",
    })).rejects.toThrow("permanent");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxDelayMs cap", async () => {
    const delays: number[] = [];
    let lastCall = Date.now();

    const fn = vi.fn().mockImplementation(async () => {
      const now = Date.now();
      if (fn.mock.calls.length > 1) {
        delays.push(now - lastCall);
      }
      lastCall = now;
      if (fn.mock.calls.length < 4) {
        throw new Error("fail");
      }
      return "success";
    });

    const options: RetryOptions = {
      maxAttempts: 4,
      initialDelayMs: 10,
      backoffMultiplier: 10,
      maxDelayMs: 50, // Cap at 50ms
    };
    await withRetry(fn, options);

    expect(fn).toHaveBeenCalledTimes(4);
    // Without cap: 10, 100, 1000ms. With cap: 10, 50, 50ms
    // Allow extra tolerance for timing variability in CI/test environments
    expect(delays[0]).toBeGreaterThanOrEqual(8);
    expect(delays[1]).toBeLessThanOrEqual(100); // Should be capped at ~50ms
    expect(delays[2]).toBeLessThanOrEqual(100); // Should be capped at ~50ms
  });

  it("passes attempt number to shouldRetry", async () => {
    const shouldRetry = vi.fn().mockReturnValue(true);
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 1,
      shouldRetry,
    });

    expect(shouldRetry).toHaveBeenCalledTimes(2);
    expect(shouldRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1);
    expect(shouldRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2);
  });

  it("defaults to 3 attempts if maxAttempts not specified", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(withRetry(fn, { initialDelayMs: 1 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("works with async functions that return different types", async () => {
    const fn = vi.fn().mockResolvedValue({ data: [1, 2, 3] });

    const result = await withRetry(fn);

    expect(result).toEqual({ data: [1, 2, 3] });
  });
});
