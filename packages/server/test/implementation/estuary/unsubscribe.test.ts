import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";
import type { UnsubscribeResult } from "../../../src/http/v1/estuary/types";
import type { subscribeRequestSchema } from "../../../src/http/v1/estuary/subscribe/http";
import type { unsubscribeRequestSchema } from "../../../src/http/v1/estuary/unsubscribe/http";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

type SubscribeRequest = typeof subscribeRequestSchema.infer;
type UnsubscribeRequest = typeof unsubscribeRequestSchema.infer;

describe("Estuary unsubscribe", () => {
  it("can unsubscribe an estuary from a stream", async () => {
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

    // Subscribe first
    const subscribeBody: SubscribeRequest = { estuaryId };
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscribeBody),
    });

    // Unsubscribe
    const unsubscribeBody: UnsubscribeRequest = { estuaryId };
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unsubscribeBody),
      },
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as UnsubscribeResult;

    expect(result).toMatchObject({
      success: true,
    });
  });

  it("returns error when unsubscribing from non-existent stream", async () => {
    const projectId = "test-project";
    const nonExistentStreamId = uniqueStreamId("nonexistent");
    const estuaryId = crypto.randomUUID();

    // Try to unsubscribe from non-existent stream
    const requestBody: UnsubscribeRequest = { estuaryId };
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${nonExistentStreamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    // Should succeed even if subscription didn't exist (idempotent)
    expect(response.status).toBe(200);
    const result = (await response.json()) as UnsubscribeResult;
    expect(result.success).toBe(true);
  });

  it("validates estuaryId format", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const invalidEstuaryId = "estuary;DROP TABLE"; // SQL injection attempt

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Try to unsubscribe with invalid estuaryId
    const requestBody = { estuaryId: invalidEstuaryId };
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as { success: false; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
