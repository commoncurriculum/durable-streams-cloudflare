import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary unsubscribe", () => {
  it("unsubscribes estuary from a stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream
    await client.createStream(streamId, "", "application/json");

    // Subscribe estuary
    const subscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );
    expect(subscribeResponse.status).toBe(200);

    // Unsubscribe
    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(unsubscribeResponse.status).toBe(200);
    const result = await unsubscribeResponse.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.streamId).toBe(streamId);
  });

  it("unsubscribes estuary from one stream but keeps other subscriptions", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const estuaryId = uniqueStreamId("estuary");

    // Create two source streams
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "application/json");

    // Subscribe to both streams
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Unsubscribe from first stream
    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId1}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(unsubscribeResponse.status).toBe(200);

    // Estuary stream should still exist (has other subscription)
    const estuaryStreamPath = `/v1/stream/test-project/${estuaryId}`;
    const readResponse = await fetch(`${BASE_URL}${estuaryStreamPath}?offset=0`);
    expect(readResponse.status).toBe(200);
  });

  it("handles unsubscribe when not subscribed (idempotent)", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("never-subscribed");

    // Create source stream
    await client.createStream(streamId, "", "application/json");

    // Try to unsubscribe without subscribing first
    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    // Should succeed (idempotent operation)
    expect(unsubscribeResponse.status).toBe(200);
  });

  it("rejects unsubscribe with missing estuaryId", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");

    await client.createStream(streamId, "", "application/json");

    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(unsubscribeResponse.status).toBe(400);
  });

  it("rejects unsubscribe with empty estuaryId", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");

    await client.createStream(streamId, "", "application/json");

    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId: "" }),
      },
    );

    expect(unsubscribeResponse.status).toBe(400);
  });

  it("rejects unsubscribe with invalid estuaryId format", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");

    await client.createStream(streamId, "", "application/json");

    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId: "invalid id!" }),
      },
    );

    expect(unsubscribeResponse.status).toBe(500);
    const text = await unsubscribeResponse.text();
    expect(text).toContain("Invalid estuaryId format");
  });

  it("handles unsubscribe from nonexistent stream", async () => {
    const streamId = uniqueStreamId("nonexistent");
    const estuaryId = uniqueStreamId("estuary");

    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    // Should handle gracefully
    expect(unsubscribeResponse.status).toBe(200);
  });

  it("unsubscribes and allows re-subscription", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream
    await client.createStream(streamId, "", "application/json");

    // Subscribe
    const subscribeResponse1 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );
    expect(subscribeResponse1.status).toBe(200);
    const result1 = await subscribeResponse1.json();
    expect(result1.isNewEstuary).toBe(true);

    // Unsubscribe
    const unsubscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );
    expect(unsubscribeResponse.status).toBe(200);

    // Re-subscribe
    const subscribeResponse2 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );
    expect(subscribeResponse2.status).toBe(200);
    const result2 = await subscribeResponse2.json();
    // Estuary still exists, so isNewEstuary should be false
    expect(result2.isNewEstuary).toBe(false);
  });
});
