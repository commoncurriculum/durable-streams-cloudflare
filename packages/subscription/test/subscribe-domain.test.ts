import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";

describe("subscribe", () => {
  it("creates estuary stream and adds subscriber to DO", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const result = await subscribe(env as never, PROJECT_ID, streamId, estuaryId);

    expect(result.isNewEstuary).toBe(true);
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.streamId).toBe(streamId);
    expect(result.estuaryStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${estuaryId}`);
  });

  it("existing estuary returns isNewEstuary false", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Pre-create the estuary stream
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const result = await subscribe(env as never, PROJECT_ID, streamId, estuaryId);

    expect(result.isNewEstuary).toBe(false);
  });

  it("DO failure triggers rollback for new estuary", async () => {
    const estuaryId = crypto.randomUUID();
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
    await expect(subscribe(failEnv as never, PROJECT_ID, streamId, estuaryId)).rejects.toThrow("DO error");

    // Estuary stream should have been rolled back (deleted)
    const headResult = await env.CORE.headStream(`${PROJECT_ID}/${estuaryId}`);
    expect(headResult.ok).toBe(false);
  });

  it("DO failure does NOT rollback existing estuary", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Pre-create estuary so it already exists
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

    const mockAddSubscriber = vi.fn().mockRejectedValueOnce(new Error("DO error"));
    const failEnv = {
      ...env,
      SUBSCRIPTION_DO: {
        idFromName: env.SUBSCRIPTION_DO.idFromName.bind(env.SUBSCRIPTION_DO),
        get: vi.fn().mockReturnValue({ addSubscriber: mockAddSubscriber }),
      },
    };

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(failEnv as never, PROJECT_ID, streamId, estuaryId)).rejects.toThrow("DO error");

    // Estuary stream should still exist (not rolled back)
    const headResult = await env.CORE.headStream(`${PROJECT_ID}/${estuaryId}`);
    expect(headResult.ok).toBe(true);
  });
});
