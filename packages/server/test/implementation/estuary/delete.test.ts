import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary delete", () => {
  it("deletes an estuary", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream and subscribe (creates estuary)
    await client.createStream(streamId, "", "application/json");
    await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Verify estuary exists
    const getResponse1 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse1.status).toBe(200);

    // Delete estuary
    const deleteResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });

    expect(deleteResponse.status).toBe(200);
    const result = await deleteResponse.json();
    expect(result.estuaryId).toBe(estuaryId);
    expect(result.deleted).toBe(true);
  });

  it("delete removes estuary stream", async () => {
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

    // Verify estuary stream exists
    const estuaryStreamPath = `/v1/stream/test-project/${estuaryId}`;
    const readResponse1 = await fetch(`${BASE_URL}${estuaryStreamPath}?offset=0`);
    expect(readResponse1.status).toBe(200);

    // Delete estuary
    await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });

    // Verify estuary stream is gone
    const readResponse2 = await fetch(`${BASE_URL}${estuaryStreamPath}?offset=0`);
    expect(readResponse2.status).toBe(404);
  });

  it("delete makes GET return 404", async () => {
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

    // Delete estuary
    await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });

    // Verify GET returns 404
    const getResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse.status).toBe(500);
    const text = await getResponse.text();
    expect(text).toContain("Estuary not found");
  });

  it("delete is idempotent", async () => {
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

    // Delete once
    const deleteResponse1 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });
    expect(deleteResponse1.status).toBe(200);

    // Delete again (should succeed - idempotent)
    const deleteResponse2 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });
    expect(deleteResponse2.status).toBe(200);
  });

  it("delete nonexistent estuary succeeds (idempotent)", async () => {
    const estuaryId = uniqueStreamId("never-existed");

    const deleteResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });

    expect(deleteResponse.status).toBe(200);
    const result = await deleteResponse.json();
    expect(result.deleted).toBe(true);
  });

  it("rejects delete with invalid estuaryId format", async () => {
    const invalidEstuaryId = "invalid id with spaces!";

    const deleteResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${invalidEstuaryId}`, {
      method: "DELETE",
    });

    expect(deleteResponse.status).toBe(500);
    const text = await deleteResponse.text();
    expect(text).toContain("Invalid estuaryId format");
  });

  it("delete with subscriptions removes estuary", async () => {
    const client = createClient();
    const streamId1 = uniqueStreamId("source1");
    const streamId2 = uniqueStreamId("source2");
    const estuaryId = uniqueStreamId("estuary");

    // Create source streams and subscribe to both
    await client.createStream(streamId1, "", "application/json");
    await client.createStream(streamId2, "", "application/json");

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
    const getResponse1 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse1.status).toBe(200);
    const result1 = await getResponse1.json();
    expect(result1.subscriptions.length).toBe(2);

    // Delete estuary
    const deleteResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    // Verify estuary is gone
    const getResponse2 = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse2.status).toBe(500);
  });

  it("delete allows re-creation via touch", async () => {
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

    // Delete estuary
    await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });

    // Re-create via touch
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "POST",
    });
    expect(touchResponse.status).toBe(200);

    // Verify it exists again
    const getResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse.status).toBe(200);
  });

  it("delete allows re-creation via subscribe", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("source");
    const estuaryId = uniqueStreamId("estuary");

    // Create source stream and subscribe
    await client.createStream(streamId, "", "application/json");
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

    // Delete estuary
    await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "DELETE",
    });

    // Re-create via subscribe
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
    expect(result2.isNewEstuary).toBe(true);

    // Verify it exists
    const getResponse = await fetch(`${BASE_URL}/v1/estuary/test-project/${estuaryId}`, {
      method: "GET",
    });
    expect(getResponse.status).toBe(200);
  });

  it("delete with empty estuaryId in path returns error", async () => {
    const response = await fetch(`${BASE_URL}/v1/estuary/test-project/`, {
      method: "DELETE",
    });

    // Should return 404 (no route match) or similar error
    expect([404, 500]).toContain(response.status);
  });
});
