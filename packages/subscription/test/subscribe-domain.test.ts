import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";

describe("subscribe", () => {
  it("creates session stream and adds subscriber to DO", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const result = await subscribe(env as never, PROJECT_ID, streamId, sessionId);

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toBe(sessionId);
    expect(result.streamId).toBe(streamId);
    expect(result.sessionStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${sessionId}`);
  });

  it("existing session returns isNewSession false", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Pre-create the session stream
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const result = await subscribe(env as never, PROJECT_ID, streamId, sessionId);

    expect(result.isNewSession).toBe(false);
  });

  it("DO failure triggers rollback for new session", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Create a DO stub that throws on addSubscriber
    const mockAddSubscriber = vi.fn().mockRejectedValueOnce(new Error("DO error"));
    const failEnv = {
      ...env,
      SUBSCRIPTION_DO: {
        idFromName: env.SUBSCRIPTION_DO.idFromName.bind(env.SUBSCRIPTION_DO),
        get: vi.fn().mockReturnValue({ addSubscriber: mockAddSubscriber }),
      },
    };

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(failEnv as never, PROJECT_ID, streamId, sessionId)).rejects.toThrow("DO error");

    // Session stream should have been rolled back (deleted)
    const headResult = await env.CORE.headStream(`${PROJECT_ID}/${sessionId}`);
    expect(headResult.ok).toBe(false);
  });

  it("DO failure does NOT rollback existing session", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Pre-create session so it already exists
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const mockAddSubscriber = vi.fn().mockRejectedValueOnce(new Error("DO error"));
    const failEnv = {
      ...env,
      SUBSCRIPTION_DO: {
        idFromName: env.SUBSCRIPTION_DO.idFromName.bind(env.SUBSCRIPTION_DO),
        get: vi.fn().mockReturnValue({ addSubscriber: mockAddSubscriber }),
      },
    };

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(failEnv as never, PROJECT_ID, streamId, sessionId)).rejects.toThrow("DO error");

    // Session stream should still exist (not rolled back)
    const headResult = await env.CORE.headStream(`${PROJECT_ID}/${sessionId}`);
    expect(headResult.ok).toBe(true);
  });
});
