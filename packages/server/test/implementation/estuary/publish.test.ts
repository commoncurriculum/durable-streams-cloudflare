import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

/**
 * Poll an estuary stream until it contains data or timeout.
 * Fanout is fire-and-forget (via waitUntil), so we need to poll rather than rely on fixed delays.
 */
async function pollEstuaryUntilData(
  estuaryPath: string,
  maxAttempts = 20,
  delayMs = 100,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`);
    if (response.status === 200) {
      const data = await response.text();
      // Check if we have actual message data (not just metadata)
      if (data.length > 50) {
        return data;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Estuary ${estuaryPath} did not receive data after ${maxAttempts} attempts`);
}

describe("Estuary publish (fanout)", () => {
  it("publishes to stream with single subscriber", async () => {
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

    // Subscribe estuary
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Publish message to source stream
    const message = { type: "test", data: "single subscriber" };
    const publishResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });
    expect([200, 204]).toContain(publishResponse.status);

    // Verify fanout
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);
    expect(estuaryData).toContain("single subscriber");
  });

  it("publishes to stream with multiple subscribers", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId1 = crypto.randomUUID();
    const estuaryId2 = crypto.randomUUID();
    const estuaryId3 = crypto.randomUUID();

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe three estuaries
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: estuaryId1 }),
    });
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: estuaryId2 }),
    });
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: estuaryId3 }),
    });

    // Publish message
    const message = { type: "broadcast", data: "multiple subscribers" };
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });

    // Verify all estuaries received the message
    const estuary1Path = `${projectId}/${estuaryId1}`;
    const estuary2Path = `${projectId}/${estuaryId2}`;
    const estuary3Path = `${projectId}/${estuaryId3}`;

    const data1 = await pollEstuaryUntilData(estuary1Path);
    const data2 = await pollEstuaryUntilData(estuary2Path);
    const data3 = await pollEstuaryUntilData(estuary3Path);

    expect(data1).toContain("multiple subscribers");
    expect(data2).toContain("multiple subscribers");
    expect(data3).toContain("multiple subscribers");
  });

  it("publishes to stream with no subscribers (no error)", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");

    // Create source stream with no subscribers
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Publish message - should succeed even with no subscribers
    const message = { type: "test", data: "no subscribers" };
    const publishResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });

    expect([200, 204]).toContain(publishResponse.status);

    // Verify message was written to source stream
    const readResponse = await fetch(
      `${BASE_URL}/v1/stream/${sourceStreamPath}?offset=${ZERO_OFFSET}`,
    );
    expect(readResponse.status).toBe(200);
    const data = await readResponse.text();
    expect(data).toContain("no subscribers");
  });

  it("publishes multiple messages in sequence", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create and subscribe
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Publish three messages
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ seq: 1, data: "first" }]),
    });

    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ seq: 2, data: "second" }]),
    });

    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ seq: 3, data: "third" }]),
    });

    // Verify all messages reached estuary
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);

    expect(estuaryData).toContain("first");
    expect(estuaryData).toContain("second");
    expect(estuaryData).toContain("third");
  });

  it("publishes with text/plain content type", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream with text/plain
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "",
    });

    // Subscribe estuary
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Publish text message
    const textMessage = "Plain text message for fanout";
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: textMessage,
    });

    // Verify fanout
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);
    expect(estuaryData).toContain(textMessage);
  });

  it("returns 404 for non-existent source stream", async () => {
    const projectId = "test-project";
    const nonExistentStream = uniqueStreamId("nonexistent");

    const response = await fetch(`${BASE_URL}/v1/stream/${projectId}/${nonExistentStream}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ data: "test" }]),
    });

    expect(response.status).toBe(404);
  });

  it("returns 409 for content-type mismatch", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");

    // Create stream with application/json
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Try to publish with mismatched content-type
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "wrong type",
    });

    expect(response.status).toBe(409);
  });

  it("handles subscriber added after initial publish", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId1 = crypto.randomUUID();
    const estuaryId2 = crypto.randomUUID();

    // Create source and first subscriber
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: estuaryId1 }),
    });

    // First publish - only estuary1 subscribed
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ data: "first message" }]),
    });

    // Add second subscriber
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: estuaryId2 }),
    });

    // Second publish - both should receive
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ data: "second message" }]),
    });

    // Verify both messages in estuary1
    const estuary1Path = `${projectId}/${estuaryId1}`;
    const data1 = await pollEstuaryUntilData(estuary1Path);
    expect(data1).toContain("first message");
    expect(data1).toContain("second message");

    // Verify only second message in estuary2 (subscribed late)
    const estuary2Path = `${projectId}/${estuaryId2}`;
    const data2 = await pollEstuaryUntilData(estuary2Path);
    expect(data2).toContain("second message");
    // estuary2 should not have first message (subscribed after it was published)
    // Note: It might have it if it was backfilled, depending on implementation
  });

  it("fanout preserves message order", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create and subscribe
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Publish messages with sequence numbers
    const messages = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ seq: i, data: `message-${i}` });
    }

    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    // Verify order in estuary
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);

    // Check that messages appear in order
    const idx0 = estuaryData.indexOf("message-0");
    const idx1 = estuaryData.indexOf("message-1");
    const idx2 = estuaryData.indexOf("message-2");
    const idx3 = estuaryData.indexOf("message-3");
    const idx4 = estuaryData.indexOf("message-4");

    expect(idx0).toBeLessThan(idx1);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx4);
  });
});
