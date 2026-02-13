import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import type { subscribeRequestSchema } from "../../../src/http/v1/estuary/subscribe/http";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

type SubscribeRequest = typeof subscribeRequestSchema.infer;

/**
 * Poll an estuary stream until it contains data or timeout.
 * Uses higher defaults than publish.test.ts to account for queue processing latency.
 */
async function pollEstuaryUntilData(
  estuaryPath: string,
  maxAttempts = 30,
  delayMs = 200,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`);
    if (response.status === 200) {
      const data = await response.text();
      if (data.length > 50) {
        return data;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Estuary ${estuaryPath} did not receive data after ${maxAttempts} attempts`);
}

describe("Queue-based fanout", () => {
  // These tests assume FANOUT_QUEUE_THRESHOLD=1 in the test environment,
  // so >1 subscriber triggers the queue path instead of inline fanout.
  // They will fail until queue-based fanout is wired up.

  it("delivers messages via queue when subscriber count exceeds threshold", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId1 = crypto.randomUUID();
    const estuaryId2 = crypto.randomUUID();

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    const createResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(createResponse.status).toBe(201);

    // Subscribe 2 estuaries (2 > threshold of 1 → queue path)
    const sub1: SubscribeRequest = { estuaryId: estuaryId1 };
    const sub2: SubscribeRequest = { estuaryId: estuaryId2 };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub1),
    });
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub2),
    });

    // Publish message
    const message = { type: "queue-test", data: "delivered via queue" };
    const publishResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });
    expect([200, 204]).toContain(publishResponse.status);

    // Both estuaries should receive the message through queue pipeline
    const data1 = await pollEstuaryUntilData(`${projectId}/${estuaryId1}`);
    const data2 = await pollEstuaryUntilData(`${projectId}/${estuaryId2}`);
    expect(data1).toContain("delivered via queue");
    expect(data2).toContain("delivered via queue");
  });

  it("delivers messages via queue to 5 subscribers", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryIds = Array.from({ length: 5 }, () => crypto.randomUUID());

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe all 5 estuaries (5 > threshold of 1 → queue path)
    for (const estuaryId of estuaryIds) {
      const requestBody: SubscribeRequest = { estuaryId };
      await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    }

    // Publish message
    const message = { type: "queue-test-5", data: "five subscribers via queue" };
    const publishResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });
    expect([200, 204]).toContain(publishResponse.status);

    // All 5 estuaries should receive the message
    const results = await Promise.all(
      estuaryIds.map((id) => pollEstuaryUntilData(`${projectId}/${id}`)),
    );

    for (const data of results) {
      expect(data).toContain("five subscribers via queue");
    }
  });

  it("preserves payload fidelity through queue (base64 round-trip)", async () => {
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

    // Subscribe 2 estuaries to trigger queue path
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

    // Publish message with unicode and special characters
    const specialMessage = {
      unicode: "Hello 世界 🌍 مرحبا",
      quotes: 'Test "quoted" text',
      newlines: "Line1\nLine2\nLine3",
      tabs: "Col1\tCol2\tCol3",
      html: "<div>&amp; &lt;tag&gt;</div>",
      emoji: "🎉🚀💡🔥",
    };

    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([specialMessage]),
    });

    // Verify payload survived base64 encode/decode through queue
    const data1 = await pollEstuaryUntilData(`${projectId}/${estuaryId1}`);
    const data2 = await pollEstuaryUntilData(`${projectId}/${estuaryId2}`);

    for (const data of [data1, data2]) {
      expect(data).toContain("世界");
      expect(data).toContain("🌍");
      expect(data).toContain("🎉🚀💡🔥");
      expect(data).toContain("<div>");
    }
  });

  it("delivers multiple sequential publishes through queue", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId1 = crypto.randomUUID();
    const estuaryId2 = crypto.randomUUID();

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
      body: JSON.stringify({ estuaryId: estuaryId1 }),
    });
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: estuaryId2 }),
    });

    // Publish 3 messages sequentially — each goes through the queue
    for (let i = 1; i <= 3; i++) {
      await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ seq: i, data: `queue-msg-${i}` }]),
      });
    }

    // Both estuaries should receive all 3 messages
    const data1 = await pollEstuaryUntilData(`${projectId}/${estuaryId1}`);
    const data2 = await pollEstuaryUntilData(`${projectId}/${estuaryId2}`);

    for (const data of [data1, data2]) {
      expect(data).toContain("queue-msg-1");
      expect(data).toContain("queue-msg-2");
      expect(data).toContain("queue-msg-3");
    }
  });

  it("handles stale subscriber in queue path", async () => {
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

    // Subscribe 3 estuaries (3 > threshold of 1 → queue path)
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

    // Delete the first estuary before publishing (creates stale subscriber)
    await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId1}`, {
      method: "DELETE",
    });

    // Publish message — queue consumer should handle the stale subscriber gracefully
    const message = { data: "stale queue subscriber test" };
    const response = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });
    expect([200, 204]).toContain(response.status);

    // Remaining 2 estuaries should still receive the message
    const data2 = await pollEstuaryUntilData(`${projectId}/${estuaryId2}`);
    const data3 = await pollEstuaryUntilData(`${projectId}/${estuaryId3}`);

    expect(data2).toContain("stale queue subscriber test");
    expect(data3).toContain("stale queue subscriber test");
  });
});
