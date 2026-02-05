import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchFromCore, getAuthHeaders, type CoreClientEnv } from "../src/core-client";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("core-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetchFromCore", () => {
    it("uses service binding when CORE is available", async () => {
      const mockServiceBinding = {
        fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      };

      const env: CoreClientEnv = {
        CORE: mockServiceBinding as unknown as Fetcher,
        CORE_URL: "http://localhost:8787",
        AUTH_TOKEN: "secret",
      };

      const response = await fetchFromCore(env, "/v1/stream/test");

      expect(mockServiceBinding.fetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();

      // Verify the request URL uses internal routing
      const calledRequest = mockServiceBinding.fetch.mock.calls[0][0] as Request;
      expect(calledRequest.url).toBe("https://internal/v1/stream/test");
    });

    it("falls back to HTTP fetch when CORE is not available", async () => {
      mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      const env: CoreClientEnv = {
        CORE_URL: "http://localhost:8787",
        AUTH_TOKEN: "secret",
      };

      await fetchFromCore(env, "/v1/stream/test");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8787/v1/stream/test",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer secret",
          }),
        }),
      );
    });

    it("does not include auth header when AUTH_TOKEN is not set", async () => {
      mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      const env: CoreClientEnv = {
        CORE_URL: "http://localhost:8787",
      };

      await fetchFromCore(env, "/v1/stream/test");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8787/v1/stream/test",
        expect.objectContaining({
          headers: {},
        }),
      );
    });

    it("merges provided headers with auth header", async () => {
      mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      const env: CoreClientEnv = {
        CORE_URL: "http://localhost:8787",
        AUTH_TOKEN: "secret",
      };

      await fetchFromCore(env, "/v1/stream/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8787/v1/stream/test",
        expect.objectContaining({
          method: "POST",
          body: "{}",
          headers: expect.objectContaining({
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("passes options to service binding fetch", async () => {
      const mockServiceBinding = {
        fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      };

      const env: CoreClientEnv = {
        CORE: mockServiceBinding as unknown as Fetcher,
        CORE_URL: "http://localhost:8787",
      };

      await fetchFromCore(env, "/v1/stream/test", {
        method: "DELETE",
      });

      const calledRequest = mockServiceBinding.fetch.mock.calls[0][0] as Request;
      expect(calledRequest.method).toBe("DELETE");
    });
  });

  describe("getAuthHeaders", () => {
    it("returns auth header when AUTH_TOKEN is set", () => {
      const env: CoreClientEnv = {
        CORE_URL: "http://localhost:8787",
        AUTH_TOKEN: "my-token",
      };

      const headers = getAuthHeaders(env);

      expect(headers).toEqual({ Authorization: "Bearer my-token" });
    });

    it("returns empty object when AUTH_TOKEN is not set", () => {
      const env: CoreClientEnv = {
        CORE_URL: "http://localhost:8787",
      };

      const headers = getAuthHeaders(env);

      expect(headers).toEqual({});
    });
  });
});
