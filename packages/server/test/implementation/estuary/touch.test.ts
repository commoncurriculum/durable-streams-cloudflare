import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary touch", () => {
  it("creates a new estuary via touch", async () => {
    const estuaryId = uniqueStreamId("estuary");

    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.expiresAt).toBeTypeOf("number");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("extends TTL for existing estuary", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream and subscribe (creates estuary)
    await client.createStream(streamId, "", "application/json");
    const subscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );
    expect(subscribeResponse.status).toBe(200);
    const subscribeResult = await subscribeResponse.json();
    const firstExpiry = subscribeResult.expiresAt;

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Touch estuary
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });

    expect(touchResponse.status).toBe(200);
    const touchResult = await touchResponse.json();
    expect(touchResult.expiresAt).toBeGreaterThan(firstExpiry);
  });

  it("touch creates estuary stream that is readable", async () => {
    const estuaryId = uniqueStreamId("estuary");

    // Touch to create estuary
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });
    expect(touchResponse.status).toBe(200);

    // Verify estuary stream exists and is readable
    const estuaryStreamPath = `/v1/stream/test-project/${estuaryId}`;
    const readResponse = await fetch(`${BASE_URL}${estuaryStreamPath}?offset=0`);
    expect(readResponse.status).toBe(200);
  });

  it("touch sets default content type to application/json", async () => {
    const estuaryId = uniqueStreamId("estuary");

    // Touch to create estuary
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });
    expect(touchResponse.status).toBe(200);

    // Verify content type via GET
    const getResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse.status).toBe(200);
    const result = await getResponse.json();
    expect(result.contentType).toBe("application/json");
  });

  it("touch multiple times continues extending TTL", async () => {
    const estuaryId = uniqueStreamId("estuary");

    // First touch
    const response1 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });
    expect(response1.status).toBe(200);
    const result1 = await response1.json();
    const firstExpiry = result1.expiresAt;

    // Wait
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second touch
    const response2 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });
    expect(response2.status).toBe(200);
    const result2 = await response2.json();
    const secondExpiry = result2.expiresAt;

    // Wait
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Third touch
    const response3 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });
    expect(response3.status).toBe(200);
    const result3 = await response3.json();

    // Each expiry should be later than the previous
    expect(secondExpiry).toBeGreaterThan(firstExpiry);
    expect(result3.expiresAt).toBeGreaterThan(secondExpiry);
  });

  it("rejects touch with invalid estuaryId format", async () => {
    const invalidEstuaryId = "invalid id with spaces!";

    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/${invalidEstuaryId}`, {
      method: "POST",
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("Invalid estuaryId format");
  });

  it("touch works after unsubscribing from all streams", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream and subscribe
    await client.createStream(streamId, "", "application/json");
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Unsubscribe from all streams
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Touch should still work
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });

    expect(touchResponse.status).toBe(200);
    const result = await touchResponse.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("touch extends TTL for estuary with subscriptions", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const estuaryId = uniqueStreamId("estuary");

    // Create source streams
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "application/json");

    // Subscribe to both
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

    // Verify subscriptions exist
    const getResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse.status).toBe(200);
    const getResult = await getResponse.json();
    expect(getResult.subscriptions.length).toBe(2);
    const initialExpiry = getResult.subscriptions[0].expiresAt;

    // Wait
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Touch estuary
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });

    expect(touchResponse.status).toBe(200);
    const touchResult = await touchResponse.json();
    expect(touchResult.expiresAt).toBeGreaterThan(Date.now());

    // Verify subscriptions still exist
    const getResponse2 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse2.status).toBe(200);
    const getResult2 = await getResponse2.json();
    expect(getResult2.subscriptions.length).toBe(2);
  });

  it("touch with empty estuaryId in path returns error", async () => {
    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/`, {
      method: "POST",
    });

    // Should return 404 (no route match) or similar error
    expect([404, 500]).toContain(response.status);
  });
});
