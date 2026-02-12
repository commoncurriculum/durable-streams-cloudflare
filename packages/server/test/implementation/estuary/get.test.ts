import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary get", () => {
  it("gets estuary info with subscriptions", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const estuaryId = uniqueStreamId("estuary");

    // Create source streams
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

    // Get estuary info
    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.estuaryStreamPath).toBe(`/v1/stream/test-project/${estuaryId}`);
    expect(result.contentType).toBe("application/json");
    expect(result.subscriptions).toBeInstanceOf(Array);
    expect(result.subscriptions.length).toBe(2);

    const subscribedStreamIds = result.subscriptions.map((s: { streamId: string }) => s.streamId);
    expect(subscribedStreamIds).toContain(streamId1);
    expect(subscribedStreamIds).toContain(streamId2);
  });

  it("gets estuary info with no subscriptions", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream and subscribe
    await client.createStream(streamId, "", "text/plain");
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Unsubscribe
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Get estuary info
    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.subscriptions).toBeInstanceOf(Array);
    expect(result.subscriptions.length).toBe(0);
  });

  it("returns 404 for nonexistent estuary", async () => {
    const estuaryId = uniqueStreamId("nonexistent");

    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("Estuary not found");
  });

  it("returns correct content type for text/plain estuary", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("text-source");
    const estuaryId = uniqueStreamId("estuary");

    // Create text/plain source stream
    await client.createStream(streamId, "", "text/plain");

    // Subscribe
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Get estuary info
    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.contentType).toBe("text/plain");
  });

  it("gets estuary after subscription changes", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const streamId3 = uniqueStreamId("source3");
    const estuaryId = uniqueStreamId("estuary");

    // Create three source streams
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "application/json");
    await client.createStream(streamId3, "", "application/json");

    // Subscribe to first two
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

    // Get info
    const response1 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(response1.status).toBe(200);
    const result1 = await response1.json();
    expect(result1.subscriptions.length).toBe(2);

    // Subscribe to third
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId3}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Get info again
    const response2 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(response2.status).toBe(200);
    const result2 = await response2.json();
    expect(result2.subscriptions.length).toBe(3);

    // Unsubscribe from one
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId1}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Get info final time
    const response3 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(response3.status).toBe(200);
    const result3 = await response3.json();
    expect(result3.subscriptions.length).toBe(2);
  });

  it("rejects get with invalid estuaryId format", async () => {
    const invalidEstuaryId = "invalid id with spaces!";

    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${invalidEstuaryId}`, {
      method: "GET",
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("Invalid estuaryId format");
  });

  it("gets estuary with single subscription", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream
    await client.createStream(streamId, "", "application/json");

    // Subscribe
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Get estuary info
    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.subscriptions.length).toBe(1);
    expect(result.subscriptions[0].streamId).toBe(streamId);
  });
});
