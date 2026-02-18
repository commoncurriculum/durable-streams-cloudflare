import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import type { SubscribeResult } from "../../../src/http/v1/estuary/types";
import type { subscribeRequestSchema } from "../../../src/http/v1/estuary/subscribe/http";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

type SubscribeRequest = typeof subscribeRequestSchema.infer;

/**
 * Poll an estuary stream until it contains data or timeout.
 * Fanout is fire-and-forget (via waitUntil), so we need to poll rather than rely on fixed delays.
 */
async function pollEstuaryUntilData(
  estuaryPath: string,
  maxAttempts = 10,
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

describe("Estuary fanout", () => {
  it("fans out message from source to subscribed estuary", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // 1. Create source stream (public for test simplicity)
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    const createResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(createResponse.status).toBe(201);

    // 2. Subscribe estuary to source stream
    const requestBody: SubscribeRequest = { estuaryId };
    const subResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );
    expect(subResponse.status).toBe(200);
    const subResult = (await subResponse.json()) as SubscribeResult;
    expect(subResult.isNewEstuary).toBe(true);

    // 3. Publish message to source stream
    // This triggers StreamDO.appendStream() → triggerFanout() → StreamSubscribersDO.fanoutOnly()
    const message = { type: "notification", content: "Hello from fanout!" };
    const publishResponse = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([message]),
    });
    expect([200, 204]).toContain(publishResponse.status);

    // 4. Poll estuary stream until fanout completes
    // Fanout is fire-and-forget (uses waitUntil), so we poll rather than use fixed delay
    const estuaryPath = `${projectId}/${estuaryId}`;
    const estuaryData = await pollEstuaryUntilData(estuaryPath);

    // 5. Verify message was fanned out correctly
    expect(estuaryData).toContain("Hello from fanout!");
  });
});
