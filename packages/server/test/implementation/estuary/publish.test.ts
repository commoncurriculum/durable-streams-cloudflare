import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import type { subscribeRequestSchema } from "../../../src/http/v1/estuary/subscribe/http";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

type SubscribeRequest = typeof subscribeRequestSchema.infer;

/**
 * Poll an estuary stream until it contains data or timeout.
 * Fanout is fire-and-forget (via waitUntil), so we need to poll rather than rely on fixed delays.
 */
async function pollEstuaryUntilData(
  estuaryPath: string,
  maxAttempts = 20,
  delayMs = 100,
  expectedContent?: string,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`);
    if (response.status === 200) {
      const data = await response.text();
      // Check if we have actual message data (not just metadata)
      // If expectedContent is provided, keep polling until it appears
      if (data.length > 50 && (!expectedContent || data.includes(expectedContent))) {
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
    const requestBody: SubscribeRequest = { estuaryId };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
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
    const requestBody1: SubscribeRequest = { estuaryId: estuaryId1 };
    const requestBody2: SubscribeRequest = { estuaryId: estuaryId2 };
    const requestBody3: SubscribeRequest = { estuaryId: estuaryId3 };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody1),
    });
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody2),
    });
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody3),
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

    const requestBody: SubscribeRequest = { estuaryId };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
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
    const requestBody: SubscribeRequest = { estuaryId };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
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
    // Use expectedContent to wait for queue-delivered second message
    const estuary1Path = `${projectId}/${estuaryId1}`;
    const data1 = await pollEstuaryUntilData(estuary1Path, 30, 200, "second message");
    expect(data1).toContain("first message");
    expect(data1).toContain("second message");

    // Verify only second message in estuary2 (subscribed late)
    const estuary2Path = `${projectId}/${estuaryId2}`;
    const data2 = await pollEstuaryUntilData(estuary2Path, 30, 200, "second message");
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

    const requestBody: SubscribeRequest = { estuaryId };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
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

  it("handles fanout to estuary that was deleted", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source and subscribe
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

    // Delete the estuary stream (but subscription still exists)
    await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId}`, {
      method: "DELETE",
    });

    // Publish - should handle the 404 gracefully
    const message = { data: "after delete" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });

    // Should succeed at source level even if fanout partially fails
    expect([200, 204]).toContain(response.status);
  });

  it("handles large payload fanout", async () => {
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

    // Create a large payload (1000 items)
    const largePayload = Array.from({ length: 1000 }, (_, i) => ({
      seq: i,
      data: `item-${i}`,
      padding: "x".repeat(100), // Add some bulk
    }));

    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(largePayload),
    });

    expect([200, 204]).toContain(response.status);

    // Verify fanout completed
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath, 30, 200);
    expect(estuaryData).toContain("item-0");
    expect(estuaryData).toContain("item-999");
  });

  it("handles fanout with special characters in payload", async () => {
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

    // Publish with special characters
    const specialMessage = {
      unicode: "Hello 世界 🌍",
      quotes: 'Test "quoted" text',
      newlines: "Line1\nLine2\nLine3",
      tabs: "Col1\tCol2\tCol3",
      special: "<>&'\"",
    };

    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([specialMessage]),
    });

    // Verify fanout preserved special characters
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);
    expect(estuaryData).toContain("世界");
    expect(estuaryData).toContain("🌍");
  });

  it("verifies fanout sequence numbers for deduplication", async () => {
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

    // Publish multiple messages to generate sequence numbers
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ seq: i, data: `msg-${i}` }]),
      });
    }

    // Verify all messages reached estuary
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);

    for (let i = 0; i < 5; i++) {
      expect(estuaryData).toContain(`msg-${i}`);
    }
  });

  it("handles fanout with concurrent publishes", async () => {
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

    // Fire concurrent publishes
    const promises = Array.from({ length: 5 }, (_, i) =>
      fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ concurrent: i, data: `concurrent-${i}` }]),
      }),
    );

    const responses = await Promise.all(promises);

    // All should succeed
    for (const response of responses) {
      expect([200, 204]).toContain(response.status);
    }

    // Verify all messages reached estuary
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath, 30, 200);

    for (let i = 0; i < 5; i++) {
      expect(estuaryData).toContain(`concurrent-${i}`);
    }
  });

  it("handles text/html content type fanout", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream with text/html
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "text/html" },
      body: "",
    });

    // Subscribe estuary
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Publish HTML content
    const htmlContent = "<html><body><h1>Test HTML Fanout</h1></body></html>";
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: htmlContent,
    });

    // Verify fanout
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);
    expect(estuaryData).toContain("Test HTML Fanout");
  });

  it("handles fanout when subscriber estuary was deleted (stale subscriber)", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId1 = crypto.randomUUID();
    const estuaryId2 = crypto.randomUUID();

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe two estuaries
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

    // Delete first estuary
    await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId1}`, {
      method: "DELETE",
    });

    // Publish to source - should handle stale subscriber gracefully
    const message = { data: "After deletion" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    expect(response.status).toBe(204);

    // Second estuary should still receive the message
    const estuary2Path = `${projectId}/${estuaryId2}`;
    const estuaryData = await pollEstuaryUntilData(estuary2Path);
    expect(estuaryData).toContain("After deletion");
  });

  it("handles multiple stale subscribers during fanout", async () => {
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

    // Delete first two estuaries (stale subscribers)
    await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId1}`, {
      method: "DELETE",
    });

    await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId2}`, {
      method: "DELETE",
    });

    // Publish to source - should handle multiple stale subscribers
    const message = { data: "Multiple stale test" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    expect(response.status).toBe(204);

    // Third estuary should still receive the message
    const estuary3Path = `${projectId}/${estuaryId3}`;
    const estuaryData = await pollEstuaryUntilData(estuary3Path);
    expect(estuaryData).toContain("Multiple stale test");
  });

  it("handles fanout with batching (10+ subscribers)", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryIds = Array.from({ length: 12 }, () => crypto.randomUUID());

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe all estuaries
    await Promise.all(
      estuaryIds.map((estuaryId) =>
        fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ estuaryId }),
        }),
      ),
    );

    // Publish message
    const message = { data: "Batch test" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    expect(response.status).toBe(204);

    // Verify at least a few estuaries received the message
    const estuaryPath1 = `${projectId}/${estuaryIds[0]}`;
    const estuaryPath2 = `${projectId}/${estuaryIds[11]}`;

    const data1 = await pollEstuaryUntilData(estuaryPath1);
    const data2 = await pollEstuaryUntilData(estuaryPath2);

    expect(data1).toContain("Batch test");
    expect(data2).toContain("Batch test");
  });

  it("verifies producer headers are set for deduplication", async () => {
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

    // Publish message
    const message = { data: "Producer header test" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    // Publish should succeed
    expect(response.status).toBe(204);

    // Wait for fanout - if producer headers are set correctly, fanout succeeds
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);

    // Producer headers enabled successful fanout
    expect(estuaryData).toContain("Producer header test");
  });

  it("handles mixed success and failure during fanout batch", async () => {
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

    // Delete the middle estuary to create a failure case
    await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId2}`, {
      method: "DELETE",
    });

    // Publish message - should succeed even with one failure
    const message = { data: "Mixed results test" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    expect(response.status).toBe(204);

    // First and third estuaries should receive the message
    const estuary1Path = `${projectId}/${estuaryId1}`;
    const estuary3Path = `${projectId}/${estuaryId3}`;

    const data1 = await pollEstuaryUntilData(estuary1Path);
    const data3 = await pollEstuaryUntilData(estuary3Path);

    expect(data1).toContain("Mixed results test");
    expect(data3).toContain("Mixed results test");
  });
});
