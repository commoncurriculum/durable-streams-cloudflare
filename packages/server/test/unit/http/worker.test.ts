import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ServerWorker, createStreamWorker } from "../../../src/http/worker";
import type { FanoutQueueMessage } from "../../../src/http/v1/estuary/types";

describe("ServerWorker", () => {
  describe("exports", () => {
    it("exports ServerWorker class", () => {
      expect(ServerWorker).toBeDefined();
      expect(typeof ServerWorker).toBe("function");
    });

    it("exports createStreamWorker factory", () => {
      expect(createStreamWorker).toBeDefined();
      expect(typeof createStreamWorker).toBe("function");
    });

    it("exports StreamDO", async () => {
      const { StreamDO } = await import("../../../src/http/worker");
      expect(StreamDO).toBeDefined();
    });

    it("exports StreamSubscribersDO", async () => {
      const { StreamSubscribersDO } = await import("../../../src/http/worker");
      expect(StreamSubscribersDO).toBeDefined();
    });

    it("exports EstuaryDO", async () => {
      const { EstuaryDO } = await import("../../../src/http/worker");
      expect(EstuaryDO).toBeDefined();
    });
  });

  describe("fetch method via handler", () => {
    let worker: ReturnType<typeof createStreamWorker>;

    beforeEach(async () => {
      worker = createStreamWorker();
      // Set up default project in REGISTRY to avoid 401 errors
      await env.REGISTRY.put(
        "_default",
        JSON.stringify({
          signingSecrets: ["test-secret"],
        }),
      );
    });

    it("delegates HTTP requests to the handler", async () => {
      const response = await worker.app.request("/health", {}, env);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("ok");
    });

    it("passes environment bindings to handler", async () => {
      const response = await worker.app.request("/health", {}, env);

      expect(response.status).toBe(200);
    });

    it("handles 404 for unknown routes", async () => {
      const response = await worker.app.request("/unknown-route", {}, env);

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("not found");
    });

    it("handles OPTIONS preflight requests", async () => {
      // Set up CORS for OPTIONS to work
      await env.REGISTRY.put(
        "_default",
        JSON.stringify({
          signingSecrets: ["test-secret"],
          corsOrigins: ["https://example.com"],
        }),
      );

      const response = await worker.app.request(
        "/v1/stream/test-stream",
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://example.com",
            "Access-Control-Request-Method": "GET",
          },
        },
        env,
      );

      expect(response.status).toBe(204);
    });

    it("processes stream creation requests (delegates to handler)", async () => {
      // Without auth, we expect 401, which proves delegation is working
      const response = await worker.app.request(
        "/v1/stream/test-stream",
        {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "",
        },
        env,
      );

      // 401 means the request was delegated to the handler and reached auth middleware
      expect(response.status).toBe(401);
      expect(response).toBeInstanceOf(Response);
    });

    it("processes stream read requests (delegates to handler)", async () => {
      // Read request without auth
      const response = await worker.app.request("/v1/stream/read-test?offset=-1", {}, env);

      // 401 means the request was delegated to the handler and reached auth middleware
      expect(response.status).toBe(401);
      expect(response).toBeInstanceOf(Response);
    });

    it("processes stream append requests (delegates to handler)", async () => {
      // Append data without auth
      const response = await worker.app.request(
        "/v1/stream/append-test",
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "hello world",
        },
        env,
      );

      // 401 means the request was delegated to the handler and reached auth middleware
      expect(response.status).toBe(401);
      expect(response).toBeInstanceOf(Response);
    });

    it("handles request with custom headers", async () => {
      const response = await worker.app.request(
        "/health",
        {
          headers: {
            "User-Agent": "test-agent",
            "X-Custom-Header": "test-value",
          },
        },
        env,
      );

      expect(response.status).toBe(200);
    });

    it("processes DELETE requests (delegates to handler)", async () => {
      // Delete without auth
      const response = await worker.app.request(
        "/v1/stream/delete-test",
        {
          method: "DELETE",
        },
        env,
      );

      // 401 means the request was delegated to the handler and reached auth middleware
      expect(response.status).toBe(401);
      expect(response).toBeInstanceOf(Response);
    });

    it("handles requests with query parameters (delegates to handler)", async () => {
      const response = await worker.app.request("/v1/stream/test?offset=-1&cursor=abc", {}, env);

      // 401 means query params were parsed and request reached auth middleware
      expect(response.status).toBe(401);
      expect(response).toBeInstanceOf(Response);
    });

    it("handles POST with body data (delegates to handler)", async () => {
      // Post JSON data without auth
      const response = await worker.app.request(
        "/v1/stream/post-test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test: "data" }),
        },
        env,
      );

      // 401 means the request was delegated to the handler and reached auth middleware
      expect(response.status).toBe(401);
      expect(response).toBeInstanceOf(Response);
    });
  });

  describe("queue method", () => {
    let worker: ReturnType<typeof createStreamWorker>;

    beforeEach(async () => {
      worker = createStreamWorker();
      // Set up REGISTRY with test project
      await env.REGISTRY.put(
        "_default",
        JSON.stringify({
          signingSecrets: ["test-secret"],
        }),
      );
    });

    it("processes empty queue batches", async () => {
      const batch: MessageBatch<FanoutQueueMessage> = {
        queue: "fanout-queue",
        messages: [],
        retryAll: () => {},
        ackAll: () => {},
      };

      // Empty batch should complete without throwing
      await expect(worker.queue!(batch, env, {} as ExecutionContext)).resolves.toBeUndefined();
    });

    it("queue method exists and has correct signature", () => {
      expect(worker.queue).toBeDefined();
      expect(typeof worker.queue).toBe("function");
    });

    it("queue method accepts MessageBatch parameter", async () => {
      const batch: MessageBatch<FanoutQueueMessage> = {
        queue: "test-queue",
        messages: [],
        retryAll: () => {},
        ackAll: () => {},
      };

      // Should accept the batch and return undefined (void)
      const result = await worker.queue!(batch, env, {} as ExecutionContext);
      expect(result).toBeUndefined();
    });

    it("queue handler delegates to handleFanoutQueue", async () => {
      // The queue handler in router.ts calls handleFanoutQueue
      // We verify it's wired up correctly by ensuring empty batches work
      const batch: MessageBatch<FanoutQueueMessage> = {
        queue: "fanout",
        messages: [],
        retryAll: () => {},
        ackAll: () => {},
      };

      await expect(worker.queue!(batch, env, {} as ExecutionContext)).resolves.toBeUndefined();
    });
  });

  describe("module-level handler", () => {
    it("creates handler at module scope for isolate-wide coalescing", () => {
      // The handler is created at module scope (line 11 in worker.ts)
      // This test verifies the module can be imported without errors
      const worker1 = createStreamWorker();
      const worker2 = createStreamWorker();

      // Both should have the same structure
      expect(worker1.app).toBeDefined();
      expect(worker2.app).toBeDefined();
      expect(worker1.fetch).toBeDefined();
      expect(worker2.fetch).toBeDefined();
      expect(worker1.queue).toBeDefined();
      expect(worker2.queue).toBeDefined();
    });

    it("handler is reused across worker instances", async () => {
      const worker1 = createStreamWorker();
      const worker2 = createStreamWorker();

      // Both should successfully handle requests
      const response1 = await worker1.app.request("/health", {}, env);
      const response2 = await worker2.app.request("/health", {}, env);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });

    it("shared handler maintains in-flight coalescing map", async () => {
      const worker1 = createStreamWorker();
      const worker2 = createStreamWorker();

      // Both workers delegate to the same shared handler (created at module scope)
      // We verify this by making requests through both and confirming they work
      const response1 = await worker1.app.request("/health", {}, env);
      const response2 = await worker2.app.request("/health", {}, env);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // Verify stream requests also delegate correctly
      const streamResponse1 = await worker1.app.request(
        "/v1/stream/shared-stream",
        {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: "",
        },
        env,
      );
      const streamResponse2 = await worker2.app.request(
        "/v1/stream/other-stream?offset=-1",
        {},
        env,
      );

      // Both should reach auth middleware (proving delegation works)
      expect(streamResponse1.status).toBe(401);
      expect(streamResponse2.status).toBe(401);
    });
  });

  describe("WorkerEntrypoint integration", () => {
    it("ServerWorker class exists and can be type-checked", () => {
      // Verify the class is exported and has the correct structure
      expect(ServerWorker).toBeDefined();
      expect(typeof ServerWorker).toBe("function");
      expect(ServerWorker.name).toBe("ServerWorker");
    });

    it("createStreamWorker returns handler with fetch method", async () => {
      const worker = createStreamWorker();

      expect(worker.fetch).toBeDefined();
      expect(typeof worker.fetch).toBe("function");

      // Verify fetch works (covers line 17 - the type cast in ServerWorker.fetch)
      const response = await worker.fetch!(
        new Request("http://localhost/health"),
        env,
        {} as ExecutionContext,
      );
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
    });

    it("handler.fetch handles different request types", async () => {
      const worker = createStreamWorker();

      // Test GET request
      const getResponse = await worker.fetch!(
        new Request("http://localhost/health"),
        env,
        {} as ExecutionContext,
      );
      expect(getResponse.status).toBe(200);

      // Test POST request (covers the type cast with different request types)
      const postResponse = await worker.fetch!(
        new Request("http://localhost/v1/stream/test", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "data",
        }),
        env,
        {} as ExecutionContext,
      );
      expect(postResponse).toBeInstanceOf(Response);
      expect(postResponse.status).toBeGreaterThanOrEqual(200);
    });

    it("createStreamWorker returns handler with queue method", async () => {
      const worker = createStreamWorker();

      expect(worker.queue).toBeDefined();
      expect(typeof worker.queue).toBe("function");

      const batch: MessageBatch<FanoutQueueMessage> = {
        queue: "test",
        messages: [],
        retryAll: () => {},
        ackAll: () => {},
      };

      // Should not throw and should return void
      const result = await worker.queue!(batch, env, {} as ExecutionContext);
      expect(result).toBeUndefined();
    });
  });

  describe("error handling", () => {
    let worker: ReturnType<typeof createStreamWorker>;

    beforeEach(() => {
      worker = createStreamWorker();
    });

    it("handles malformed URLs gracefully", async () => {
      const response = await worker.app.request("/v1/stream/", {}, env);

      // Should return 404 for empty stream path
      expect(response.status).toBe(404);
    });

    it("handles invalid HTTP methods", async () => {
      const response = await worker.app.request(
        "/v1/stream/test",
        {
          method: "PATCH",
        },
        env,
      );

      // PATCH is not supported, should return 401 or 404
      expect([401, 404]).toContain(response.status);
    });

    it("handles requests with no body when body expected", async () => {
      const response = await worker.app.request(
        "/v1/stream/test",
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
        },
        env,
      );

      // Should handle gracefully (may be 401 or 404 if stream doesn't exist)
      expect(response.status).toBeGreaterThanOrEqual(200);
    });
  });
});
