import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uniqueStreamId } from "./helpers";
import { startWorker, type WorkerHandle } from "./worker_harness";

describe("admin introspection endpoint", () => {
  const ADMIN_TOKEN = "test-admin-token-12345";
  let handle: WorkerHandle;

  beforeAll(async () => {
    handle = await startWorker({
      vars: { ADMIN_TOKEN },
    });
  });

  afterAll(async () => {
    await handle.stop();
  });

  it("returns 401 without auth token", async () => {
    const streamId = uniqueStreamId("admin-noauth");
    const url = `${handle.baseUrl}/v1/stream/${streamId}/admin`;
    const response = await fetch(url);
    expect(response.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const streamId = uniqueStreamId("admin-badauth");
    const url = `${handle.baseUrl}/v1/stream/${streamId}/admin`;
    const response = await fetch(url, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("returns 404 for non-existent stream", async () => {
    const streamId = uniqueStreamId("admin-nostream");
    const url = `${handle.baseUrl}/v1/stream/${streamId}/admin`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("returns introspection data for existing stream", async () => {
    const streamId = uniqueStreamId("admin-inspect");
    const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    // Create stream
    const create = await fetch(streamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(create.status).toBe(201);

    // Append data
    await fetch(streamUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "world",
    });

    // Introspect
    const url = `${handle.baseUrl}/v1/stream/${streamId}/admin`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);

    const data = await response.json();

    // meta
    expect(data.meta).toBeDefined();
    expect(data.meta.stream_id).toBe(streamId);
    expect(data.meta.content_type).toBe("text/plain");
    expect(data.meta.closed).toBe(0);
    expect(data.meta.tail_offset).toBeGreaterThan(0);
    expect(data.meta.created_at).toBeGreaterThan(0);

    // ops
    expect(data.ops).toBeDefined();
    expect(data.ops.messageCount).toBeGreaterThanOrEqual(1);
    expect(data.ops.sizeBytes).toBeGreaterThan(0);

    // segments (may be empty if no rotation happened)
    expect(Array.isArray(data.segments)).toBe(true);

    // producers (may be empty since we didn't use producer headers)
    expect(Array.isArray(data.producers)).toBe(true);

    // realtime counts
    expect(typeof data.sseClientCount).toBe("number");
    expect(typeof data.longPollWaiterCount).toBe("number");
  });

  it("returns introspection with producer data", async () => {
    const streamId = uniqueStreamId("admin-producers");
    const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    // Create stream with producer (seq starts at 0)
    const createResp = await fetch(streamUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "prod-1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "first",
    });
    expect(createResp.status).toBe(201);

    // Append with same producer (seq increments to 1)
    const appendResp = await fetch(streamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "prod-1",
        "Producer-Epoch": "1",
        "Producer-Seq": "1",
      },
      body: "second",
    });
    expect([200, 204]).toContain(appendResp.status);

    // Introspect
    const url = `${handle.baseUrl}/v1/stream/${streamId}/admin`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.producers.length).toBe(1);
    expect(data.producers[0].producer_id).toBe("prod-1");
    expect(data.producers[0].epoch).toBe(1);
    expect(data.producers[0].last_seq).toBe(1);
  });

  it("returns 403 when ADMIN_TOKEN is not configured", async () => {
    // Start a worker without ADMIN_TOKEN
    const noAuthHandle = await startWorker();

    try {
      const streamId = uniqueStreamId("admin-noconfig");
      const url = `${noAuthHandle.baseUrl}/v1/stream/${streamId}/admin`;
      const response = await fetch(url, {
        headers: { Authorization: "Bearer anything" },
      });
      expect(response.status).toBe(403);
    } finally {
      await noAuthHandle.stop();
    }
  });
});
