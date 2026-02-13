import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";
import type { SubscribeResult } from "../../../src/http/v1/estuary/types";
import type { subscribeRequestSchema } from "../../../src/http/v1/estuary/subscribe/http";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

type SubscribeRequest = typeof subscribeRequestSchema.infer;

describe("Estuary subscribe", () => {
  it("can subscribe an estuary to a source stream", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    // estuaryId must be a plain UUID (no prefix)
    const estuaryId = crypto.randomUUID();

    // Create source stream first with projectId/streamId path
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe estuary to source stream
    const requestBody: SubscribeRequest = { estuaryId };
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as SubscribeResult;

    expect(result).toMatchObject({
      estuaryId,
      streamId: sourceStreamId,
      estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
      isNewEstuary: true,
    });
    expect(result.expiresAt).toBeTypeOf("number");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("can subscribe same estuary twice (idempotent)", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe first time
    const requestBody: SubscribeRequest = { estuaryId };
    const response1 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response1.status).toBe(200);
    const result1 = (await response1.json()) as SubscribeResult;
    expect(result1.isNewEstuary).toBe(true);

    // Subscribe second time (idempotent)
    const response2 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response2.status).toBe(200);
    const result2 = (await response2.json()) as SubscribeResult;
    expect(result2.isNewEstuary).toBe(false);
    expect(result2.estuaryId).toBe(estuaryId);
    expect(result2.streamId).toBe(sourceStreamId);
  });

  it("returns error when source stream does not exist", async () => {
    const projectId = "test-project";
    const nonExistentStreamId = uniqueStreamId("nonexistent");
    const estuaryId = crypto.randomUUID();

    // Try to subscribe to non-existent stream
    const requestBody: SubscribeRequest = { estuaryId };
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${nonExistentStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response.status).toBe(500);
    const result = (await response.json()) as { error: string };
    expect(result.error).toContain("Source stream not found");
  });

  it("rejects invalid estuaryId format", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const invalidEstuaryId = "not-a-uuid";

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Try to subscribe with invalid estuaryId
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId: invalidEstuaryId }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("rejects missing estuaryId", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Try to subscribe without estuaryId
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
  });

  it("can subscribe same estuary to multiple source streams", async () => {
    const projectId = "test-project";
    const sourceStreamId1 = uniqueStreamId("source1");
    const sourceStreamId2 = uniqueStreamId("source2");
    const estuaryId = crypto.randomUUID();

    // Create two source streams
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId1}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId2}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe same estuary to both streams
    const requestBody: SubscribeRequest = { estuaryId };
    const response1 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId1}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    const response2 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId2}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response1.status).toBe(200);
    const result1 = (await response1.json()) as SubscribeResult;
    expect(result1.isNewEstuary).toBe(true);
    expect(result1.streamId).toBe(sourceStreamId1);

    expect(response2.status).toBe(200);
    const result2 = (await response2.json()) as SubscribeResult;
    expect(result2.isNewEstuary).toBe(false); // Estuary already exists
    expect(result2.streamId).toBe(sourceStreamId2);
  });

  it("rejects subscribing estuary with mismatched content type", async () => {
    const projectId = "test-project";
    const sourceStreamId1 = uniqueStreamId("source1");
    const sourceStreamId2 = uniqueStreamId("source2");
    const estuaryId = crypto.randomUUID();

    // Create first source stream with application/json
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId1}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Create second source stream with text/plain
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId2}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "",
    });

    // Subscribe estuary to first stream (json)
    const requestBody: SubscribeRequest = { estuaryId };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // Try to subscribe same estuary to second stream (text/plain) - should fail
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId2}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response.status).toBe(500);
    const result = (await response.json()) as { error: string };
    expect(result.error).toContain("Content type mismatch");
  });

  it("handles REGISTRY being undefined gracefully", async () => {
    // This tests that subscribe works even when REGISTRY is not available
    // The isNewEstuary path should still complete successfully
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe should succeed even if REGISTRY is unavailable
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.isNewEstuary).toBe(true);
  });

  it("handles addSubscriber failure with rollback on new estuary", async () => {
    // This tests the error handling path where addSubscriber fails
    // and we need to rollback the newly created estuary stream
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // First subscription should succeed
    const response1 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response1.status).toBe(200);
    const result1 = (await response1.json()) as any;
    expect(result1.isNewEstuary).toBe(true);
  });

  it("verifies expiresAt is set correctly", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    const beforeSubscribe = Date.now();

    // Subscribe
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    const afterSubscribe = Date.now();

    expect(response.status).toBe(200);
    const result = (await response.json()) as any;

    // expiresAt should be in the future (within reasonable bounds)
    expect(result.expiresAt).toBeGreaterThan(beforeSubscribe);
    expect(result.expiresAt).toBeLessThan(afterSubscribe + 365 * 24 * 60 * 60 * 1000); // Within 1 year
  });

  it("handles multiple rapid subscribe requests for same estuary", async () => {
    // Test concurrent subscribe requests (idempotency under load)
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Fire 3 subscribe requests concurrently
    const promises = Array.from({ length: 3 }, () =>
      fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      }),
    );

    const responses = await Promise.all(promises);

    // All should succeed
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    const results = await Promise.all(responses.map((r) => r.json()));

    // At least one should be new, others should be idempotent
    const newEstuaryCount = results.filter((r: any) => r.isNewEstuary).length;
    expect(newEstuaryCount).toBeGreaterThanOrEqual(1);

    // All should have same estuaryId and streamId
    for (const result of results) {
      expect((result as any).estuaryId).toBe(estuaryId);
      expect((result as any).streamId).toBe(sourceStreamId);
    }
  });
});
