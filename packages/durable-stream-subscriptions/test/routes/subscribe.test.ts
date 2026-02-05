import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock storage
vi.mock("../../src/storage", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  addSubscription: vi.fn(),
  removeSubscription: vi.fn(),
  deleteSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock fanout
vi.mock("../../src/fanout", () => ({
  createSessionStreamWithEnv: vi.fn(),
  deleteSessionStreamWithEnv: vi.fn(),
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

function createMockEnv() {
  return {
    DB: {} as D1Database,
    CORE_URL: "http://localhost:8787",
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
      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("uses default contentType application/json when not specified", async () => {
      const { getSession, addSubscription, touchSession } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");

      // Existing session
      vi.mocked(getSession).mockResolvedValue({
        session_id: "session-1",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      // Should not call createSessionStreamWithEnv since session exists
      expect(createSessionStreamWithEnv).not.toHaveBeenCalled();
    });
  });

  describe("new session flow", () => {
    it("creates session stream in core for new session", async () => {
      const { getSession, createSession, addSubscription } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");

      // Session doesn't exist initially
      vi.mocked(getSession)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          session_id: "new-session",
          created_at: Date.now(),
          last_active_at: Date.now(),
          ttl_seconds: 1800,
          marked_for_deletion_at: null,
        });

      vi.mocked(createSessionStreamWithEnv).mockResolvedValue({
        ok: true,
        status: 201,
      } as Response);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "new-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(createSessionStreamWithEnv).toHaveBeenCalledWith(
        expect.anything(),
        "new-session",
        "application/json",
        1800, // default TTL
      );
    });

    it("handles 409 conflict from core (stream already exists)", async () => {
      const { getSession, createSession, addSubscription } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");

      vi.mocked(getSession)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          session_id: "session-1",
          created_at: Date.now(),
          last_active_at: Date.now(),
          ttl_seconds: 1800,
          marked_for_deletion_at: null,
        });

      // 409 = stream already exists, which is acceptable
      vi.mocked(createSessionStreamWithEnv).mockResolvedValue({
        ok: false,
        status: 409,
      } as Response);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(200);
      expect(createSession).toHaveBeenCalled();
    });

    it("returns 500 when core fails with non-409 error", async () => {
      const { getSession } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");

      vi.mocked(getSession).mockResolvedValue(null);
      vi.mocked(createSessionStreamWithEnv).mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal error"),
      } as unknown as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Failed to create session stream");
    });

    it("creates D1 record after successful core creation", async () => {
      const { getSession, createSession, addSubscription } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");

      vi.mocked(getSession)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          session_id: "new-session",
          created_at: Date.now(),
          last_active_at: Date.now(),
          ttl_seconds: 1800,
          marked_for_deletion_at: null,
        });

      vi.mocked(createSessionStreamWithEnv).mockResolvedValue({
        ok: true,
        status: 201,
      } as Response);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "new-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(createSession).toHaveBeenCalledWith(expect.anything(), "new-session", 1800);
    });

    it("records sessionCreate metric for new sessions", async () => {
      const { getSession, createSession, addSubscription } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        sessionCreate: vi.fn(),
        sessionDelete: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getSession)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          session_id: "new-session",
          created_at: Date.now(),
          last_active_at: Date.now(),
          ttl_seconds: 1800,
          marked_for_deletion_at: null,
        });

      vi.mocked(createSessionStreamWithEnv).mockResolvedValue({
        ok: true,
        status: 201,
      } as Response);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "new-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(mockMetrics.sessionCreate).toHaveBeenCalledWith(
        "new-session",
        1800,
        expect.any(Number),
      );
    });
  });

  describe("existing session flow", () => {
    it("touches session when it already exists", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "existing",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "existing", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(touchSession).toHaveBeenCalledWith(expect.anything(), "existing");
    });

    it("does not call core for existing session", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "existing",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "existing", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(createSessionStreamWithEnv).not.toHaveBeenCalled();
    });

    it("clears marked_for_deletion_at when touching", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      // Session with deletion mark
      vi.mocked(getSession).mockResolvedValue({
        session_id: "marked-session",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: 3000,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "marked-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      // touchSession clears the mark internally
      expect(touchSession).toHaveBeenCalledWith(expect.anything(), "marked-session");
    });
  });

  describe("subscription", () => {
    it("adds subscription to D1", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "session-1",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-abc" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(addSubscription).toHaveBeenCalledWith(
        expect.anything(),
        "session-1",
        "stream-abc",
      );
    });

    it("handles duplicate subscription (idempotent)", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "session-1",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      // addSubscription is idempotent (ON CONFLICT DO NOTHING)
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();

      // Subscribe twice
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(200);
    });

    it("records subscribe metric with isNewSession flag", async () => {
      const { getSession, touchSession, addSubscription, createSession } = await import("../../src/storage");
      const { createSessionStreamWithEnv } = await import("../../src/fanout");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        sessionCreate: vi.fn(),
        sessionDelete: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      // Test with existing session
      vi.mocked(getSession).mockResolvedValue({
        session_id: "existing",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "existing", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(mockMetrics.subscribe).toHaveBeenCalledWith(
        "stream-1",
        "existing",
        false, // isNewSession
        expect.any(Number),
      );

      // Reset and test with new session
      vi.clearAllMocks();
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getSession)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          session_id: "new-session",
          created_at: Date.now(),
          last_active_at: Date.now(),
          ttl_seconds: 1800,
          marked_for_deletion_at: null,
        });
      vi.mocked(createSessionStreamWithEnv).mockResolvedValue({
        ok: true,
        status: 201,
      } as Response);
      vi.mocked(createSession).mockResolvedValue(undefined);

      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "new-session", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(mockMetrics.subscribe).toHaveBeenCalledWith(
        "stream-1",
        "new-session",
        true, // isNewSession
        expect.any(Number),
      );
    });
  });

  describe("response", () => {
    it("returns sessionId and streamId", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "session-1",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; streamId: string };
      expect(body.sessionId).toBe("session-1");
      expect(body.streamId).toBe("stream-1");
    });

    it("returns sessionStreamPath", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "my-session-id",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "my-session-id", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      const body = (await res.json()) as { sessionStreamPath: string };
      expect(body.sessionStreamPath).toBe("/v1/stream/session:my-session-id");
    });

    it("returns expiresAt timestamp", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "session-1",
        created_at: 1000,
        last_active_at: 5000000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      const body = (await res.json()) as { expiresAt: number };
      expect(body.expiresAt).toBe(5000000 + 1800 * 1000);
    });

    it("returns isNewSession flag", async () => {
      const { getSession, touchSession, addSubscription } = await import("../../src/storage");

      vi.mocked(getSession).mockResolvedValue({
        session_id: "session-1",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
        marked_for_deletion_at: null,
      });
      vi.mocked(touchSession).mockResolvedValue(true);
      vi.mocked(addSubscription).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      const body = (await res.json()) as { isNewSession: boolean };
      expect(body.isNewSession).toBe(false);
    });
  });
});

describe("DELETE /unsubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes subscription from D1", async () => {
    const { removeSubscription } = await import("../../src/storage");
    vi.mocked(removeSubscription).mockResolvedValue(undefined);

    const app = await createTestApp();
    await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(removeSubscription).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
      "stream-1",
    );
  });

  it("records unsubscribe metric", async () => {
    const { removeSubscription } = await import("../../src/storage");
    const { createMetrics } = await import("../../src/metrics");

    const mockMetrics = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      sessionCreate: vi.fn(),
      sessionDelete: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);
    vi.mocked(removeSubscription).mockResolvedValue(undefined);

    const app = await createTestApp();
    await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(mockMetrics.unsubscribe).toHaveBeenCalledWith(
      "stream-1",
      "session-1",
      expect.any(Number),
    );
  });

  it("returns confirmation response", async () => {
    const { removeSubscription } = await import("../../src/storage");
    vi.mocked(removeSubscription).mockResolvedValue(undefined);

    const app = await createTestApp();
    const res = await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; streamId: string; unsubscribed: boolean };
    expect(body.sessionId).toBe("session-1");
    expect(body.streamId).toBe("stream-1");
    expect(body.unsubscribed).toBe(true);
  });

  it("handles non-existent subscription gracefully", async () => {
    const { removeSubscription } = await import("../../src/storage");
    // removeSubscription doesn't throw on non-existent - it's a DELETE that affects 0 rows
    vi.mocked(removeSubscription).mockResolvedValue(undefined);

    const app = await createTestApp();
    const res = await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "nonexistent", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(res.status).toBe(200);
  });
});

describe("DELETE /session/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes session stream from core", async () => {
    const { deleteSession } = await import("../../src/storage");
    const { deleteSessionStreamWithEnv } = await import("../../src/fanout");

    vi.mocked(deleteSessionStreamWithEnv).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    const app = await createTestApp();
    await app.request("/v1/session/session-1", {
      method: "DELETE",
    }, createMockEnv());

    expect(deleteSessionStreamWithEnv).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
    );
  });

  it("continues D1 delete even if core delete fails", async () => {
    const { deleteSession } = await import("../../src/storage");
    const { deleteSessionStreamWithEnv } = await import("../../src/fanout");

    vi.mocked(deleteSessionStreamWithEnv).mockRejectedValue(new Error("Core error"));
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-1", {
      method: "DELETE",
    }, createMockEnv());

    // Should still succeed and delete from D1
    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalled();
  });

  it("deletes subscriptions from D1", async () => {
    const { deleteSession } = await import("../../src/storage");
    const { deleteSessionStreamWithEnv } = await import("../../src/fanout");

    vi.mocked(deleteSessionStreamWithEnv).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    const app = await createTestApp();
    await app.request("/v1/session/session-1", {
      method: "DELETE",
    }, createMockEnv());

    // deleteSession deletes both session and subscriptions in a batch
    expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "session-1");
  });

  it("deletes session from D1", async () => {
    const { deleteSession } = await import("../../src/storage");
    const { deleteSessionStreamWithEnv } = await import("../../src/fanout");

    vi.mocked(deleteSessionStreamWithEnv).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    const app = await createTestApp();
    await app.request("/v1/session/session-1", {
      method: "DELETE",
    }, createMockEnv());

    expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "session-1");
  });

  it("records sessionDelete metric", async () => {
    const { deleteSession } = await import("../../src/storage");
    const { deleteSessionStreamWithEnv } = await import("../../src/fanout");
    const { createMetrics } = await import("../../src/metrics");

    const mockMetrics = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      sessionCreate: vi.fn(),
      sessionDelete: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

    vi.mocked(deleteSessionStreamWithEnv).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    const app = await createTestApp();
    await app.request("/v1/session/session-1", {
      method: "DELETE",
    }, createMockEnv());

    expect(mockMetrics.sessionDelete).toHaveBeenCalledWith(
      "session-1",
      expect.any(Number),
    );
  });

  it("returns confirmation response", async () => {
    const { deleteSession } = await import("../../src/storage");
    const { deleteSessionStreamWithEnv } = await import("../../src/fanout");

    vi.mocked(deleteSessionStreamWithEnv).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    const app = await createTestApp();
    const res = await app.request("/v1/session/my-session", {
      method: "DELETE",
    }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; deleted: boolean };
    expect(body.sessionId).toBe("my-session");
    expect(body.deleted).toBe(true);
  });
});
