import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary subscribe", () => {
  it("subscribes a new estuary to a stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream
    await client.createStream(streamId, "", "application/json");

    // Subscribe estuary
    const response = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.streamId).toBe(streamId);
    expect(result.estuaryStreamPath).toBe(`/v1/stream/test-project/${estuaryId}`);
    expect(result.expiresAt).toBeTypeOf("number");
    expect(result.isNewEstuary).toBe(true);
  });

  it("subscribes existing estuary to another stream", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const estuaryId = uniqueStreamId("estuary");

    // Create two source streams with same content type
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "application/json");

    // Subscribe estuary to first stream
    const response1 = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });
    expect(response1.status).toBe(200);
    const result1 = await response1.json();
    expect(result1.isNewEstuary).toBe(true);

    // Subscribe same estuary to second stream
    const response2 = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });
    expect(response2.status).toBe(200);
    const result2 = await response2.json();
    expect(result2.isNewEstuary).toBe(false);
  });

  it("rejects subscription when source stream does not exist", async () => {
    const streamId = uniqueStreamId("nonexistent");
    const estuaryId = uniqueStreamId("estuary");

    const response = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("Source stream not found");
  });

  it("rejects subscription with invalid estuaryId format", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const invalidEstuaryId = "invalid id with spaces!";

    await client.createStream(streamId, "", "application/json");

    const response = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: invalidEstuaryId }),
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("Invalid estuaryId format");
  });

  it("rejects subscription when content types mismatch", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("json-stream");
    const streamId2 = uniqueStreamId("text-stream");
    const estuaryId = uniqueStreamId("estuary");

    // Create streams with different content types
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "text/plain");

    // Subscribe to JSON stream (creates estuary with application/json)
    const response1 = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });
    expect(response1.status).toBe(200);

    // Try to subscribe same estuary to text/plain stream (should fail)
    const response2 = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    expect(response2.status).toBe(500);
    const text = await response2.text();
    expect(text).toContain("Content type mismatch");
  });

  it("extends TTL when subscribing to existing estuary", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const estuaryId = uniqueStreamId("estuary");

    // Create source streams
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "application/json");

    // First subscription
    const response1 = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });
    expect(response1.status).toBe(200);
    const result1 = await response1.json();
    const firstExpiry = result1.expiresAt;

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second subscription should extend TTL
    const response2 = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });
    expect(response2.status).toBe(200);
    const result2 = await response2.json();

    // Second expiry should be later than first
    expect(result2.expiresAt).toBeGreaterThan(firstExpiry);
  });

  it("rejects subscription with missing estuaryId", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");

    await client.createStream(streamId, "", "application/json");

    const response = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it("rejects subscription with empty estuaryId", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");

    await client.createStream(streamId, "", "application/json");

    const response = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: "" }),
    });

    expect(response.status).toBe(400);
  });

  it("creates estuary with correct content type from source", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("text-source");
    const estuaryId = uniqueStreamId("estuary");

    // Create text/plain source stream
    await client.createStream(streamId, "test content", "text/plain");

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

    // Verify estuary stream has correct content type
    const estuaryStreamPath = `/v1/stream/test-project/${estuaryId}`;
    const readResponse = await fetch(`${BASE_URL}${estuaryStreamPath}?offset=0`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.headers.get("Content-Type")).toBe("text/plain");
  });
});
