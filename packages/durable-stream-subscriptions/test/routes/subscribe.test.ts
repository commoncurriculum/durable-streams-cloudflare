import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock core-client
vi.mock("../../src/core-client", () => ({
  fetchFromCore: vi.fn(),
}));

// Mock metrics
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sessionCreate: vi.fn(),
    sessionDelete: vi.fn(),
  })),
}));

function createTestApp() {
  return import("../../src/routes/subscribe").then(({ subscribeRoutes }) => {
    const app = new Hono();
    app.route("/v1", subscribeRoutes);
    return app;
  });
}

function createMockDoFetch(options: { ok?: boolean; status?: number; body?: object } = {}) {
  const { ok = true, status = 200, body = {} } = options;
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function createMockDoNamespace(mockDoFetch: ReturnType<typeof vi.fn>) {
  return {
    idFromName: vi.fn().mockReturnValue("do-id"),
    get: vi.fn().mockReturnValue({ fetch: mockDoFetch }),
  };
}

function createMockEnv(mockDoNamespace: ReturnType<typeof createMockDoNamespace>) {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: mockDoNamespace as unknown as DurableObjectNamespace,
    METRICS: {} as AnalyticsEngineDataset,
    SESSION_TTL_SECONDS: "1800",
  };
}

describe("POST /subscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validation", () => {
    it("returns 400 when sessionId is missing", async () => {
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId is missing", async () => {
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(400);
    });
  });

  describe("session stream creation", () => {
    it("creates session stream in core with PUT request", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 201,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "new-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        "/v1/stream/session:new-session",
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Stream-Expires-At": expect.any(String),
          }),
        }),
      );
    });

    it("handles 409 conflict from core (session already exists)", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 409,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "existing-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      // 409 means session already exists, which is fine - continue with subscription
      expect(res.status).toBe(200);
    });

    it("returns 500 when core fails with non-409 error", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal error"),
      } as unknown as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Failed to create session stream");
    });
  });

  describe("subscription via SubscriptionDO", () => {
    it("routes subscription to SubscriptionDO with correct streamId", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 201,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-123", streamId: "stream-abc" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      // Verify DO was addressed by streamId
      expect(mockDoNamespace.idFromName).toHaveBeenCalledWith("stream-abc");
      expect(mockDoNamespace.get).toHaveBeenCalled();

      // Verify DO was called with correct subscribe request
      expect(mockDoFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "http://do/subscribe",
        }),
      );
    });

    it("passes sessionId in DO request body", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 201,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "my-session", streamId: "my-stream" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      // Verify the DO received the correct body
      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      const doBody = await doRequest.json();
      expect(doBody).toEqual({ sessionId: "my-session" });
    });

    it("returns 500 when DO subscription fails", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch({ ok: false, status: 500 });
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 201,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Failed to add subscription");
    });
  });

  describe("metrics", () => {
    it("records subscribe metric with isNewSession=true for new sessions", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { createMetrics } = await import("../../src/metrics");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const mockMetrics = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        sessionCreate: vi.fn(),
        sessionDelete: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

      // ok: true means new session created
      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 201,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "new-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(mockMetrics.subscribe).toHaveBeenCalledWith(
        "stream-1",
        "new-session",
        true, // isNewSession
        expect.any(Number),
      );
      expect(mockMetrics.sessionCreate).toHaveBeenCalledWith(
        "new-session",
        1800,
        expect.any(Number),
      );
    });

    it("records subscribe metric with isNewSession=false for existing sessions", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { createMetrics } = await import("../../src/metrics");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const mockMetrics = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        sessionCreate: vi.fn(),
        sessionDelete: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

      // 409 means session already exists
      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 409,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "existing-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(mockMetrics.subscribe).toHaveBeenCalledWith(
        "stream-1",
        "existing-session",
        false, // isNewSession
        expect.any(Number),
      );
      expect(mockMetrics.sessionCreate).not.toHaveBeenCalled();
    });
  });

  describe("response", () => {
    it("returns sessionId, streamId, and sessionStreamPath", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const mockDoFetch = createMockDoFetch();
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 201,
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "my-session-id", streamId: "my-stream" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionId: string;
        streamId: string;
        sessionStreamPath: string;
        expiresAt: number;
        isNewSession: boolean;
      };
      expect(body.sessionId).toBe("my-session-id");
      expect(body.streamId).toBe("my-stream");
      expect(body.sessionStreamPath).toBe("/v1/stream/session:my-session-id");
      expect(body.isNewSession).toBe(true);
      expect(typeof body.expiresAt).toBe("number");
    });
  });
});

describe("DELETE /unsubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes unsubscription to SubscriptionDO", async () => {
    const mockDoFetch = createMockDoFetch({ body: { unsubscribed: true } });
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    const app = await createTestApp();
    await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-abc" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv(mockDoNamespace));

    // Verify DO was addressed by streamId
    expect(mockDoNamespace.idFromName).toHaveBeenCalledWith("stream-abc");

    // Verify DO was called with correct unsubscribe request
    expect(mockDoFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: "http://do/unsubscribe",
      }),
    );
  });

  it("records unsubscribe metric", async () => {
    const { createMetrics } = await import("../../src/metrics");
    const mockDoFetch = createMockDoFetch();
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    const mockMetrics = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      sessionCreate: vi.fn(),
      sessionDelete: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

    const app = await createTestApp();
    await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv(mockDoNamespace));

    expect(mockMetrics.unsubscribe).toHaveBeenCalledWith(
      "stream-1",
      "session-1",
      expect.any(Number),
    );
  });

  it("returns confirmation response", async () => {
    const mockDoFetch = createMockDoFetch();
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    const app = await createTestApp();
    const res = await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv(mockDoNamespace));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; streamId: string; unsubscribed: boolean };
    expect(body.sessionId).toBe("session-1");
    expect(body.streamId).toBe("stream-1");
    expect(body.unsubscribed).toBe(true);
  });

  it("returns 500 when DO unsubscribe fails", async () => {
    const mockDoFetch = createMockDoFetch({ ok: false, status: 500 });
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    const app = await createTestApp();
    const res = await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv(mockDoNamespace));

    expect(res.status).toBe(500);
  });
});

describe("DELETE /session/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes session stream from core", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const mockDoFetch = createMockDoFetch();
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    await app.request("/v1/session/session-123", {
      method: "DELETE",
    }, createMockEnv(mockDoNamespace));

    expect(fetchFromCore).toHaveBeenCalledWith(
      expect.anything(),
      "/v1/stream/session:session-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("continues even if core delete fails", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const mockDoFetch = createMockDoFetch();
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    vi.mocked(fetchFromCore).mockRejectedValue(new Error("Core error"));

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {
      method: "DELETE",
    }, createMockEnv(mockDoNamespace));

    // Should still succeed (lazy cleanup of subscriptions)
    expect(res.status).toBe(200);
  });

  it("records sessionDelete metric", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { createMetrics } = await import("../../src/metrics");
    const mockDoFetch = createMockDoFetch();
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    const mockMetrics = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      sessionCreate: vi.fn(),
      sessionDelete: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    await app.request("/v1/session/session-123", {
      method: "DELETE",
    }, createMockEnv(mockDoNamespace));

    expect(mockMetrics.sessionDelete).toHaveBeenCalledWith(
      "session-123",
      expect.any(Number),
    );
  });

  it("returns confirmation response", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const mockDoFetch = createMockDoFetch();
    const mockDoNamespace = createMockDoNamespace(mockDoFetch);

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    const res = await app.request("/v1/session/my-session", {
      method: "DELETE",
    }, createMockEnv(mockDoNamespace));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; deleted: boolean };
    expect(body.sessionId).toBe("my-session");
    expect(body.deleted).toBe(true);
  });
});
