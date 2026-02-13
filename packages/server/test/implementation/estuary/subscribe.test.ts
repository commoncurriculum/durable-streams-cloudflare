import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary subscribe", () => {
  it("can subscribe an estuary to a source stream", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    // estuaryId must be a plain UUID (no prefix)
    const estuaryId = crypto.randomUUID();

    // Create source stream first with projectId/streamId path
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe estuary to source stream
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as any;

    expect(result).toMatchObject({
      estuaryId,
      streamId: sourceStreamId,
      estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
      isNewEstuary: true,
    });
    expect(result.expiresAt).toBeTypeOf("number");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("can subscribe same estuary twice (idempotent)", async () => {
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

    // Subscribe first time
    const response1 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response1.status).toBe(200);
    const result1 = (await response1.json()) as any;
    expect(result1.isNewEstuary).toBe(true);

    // Subscribe second time (idempotent)
    const response2 = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response2.status).toBe(200);
    const result2 = (await response2.json()) as any;
    expect(result2.isNewEstuary).toBe(false);
    expect(result2.estuaryId).toBe(estuaryId);
    expect(result2.streamId).toBe(sourceStreamId);
  });

  it("returns error when source stream does not exist", async () => {
    const projectId = "test-project";
    const nonExistentStreamId = uniqueStreamId("nonexistent");
    const estuaryId = crypto.randomUUID();

    // Try to subscribe to non-existent stream
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${nonExistentStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response.status).toBe(500);
    const result = (await response.json()) as any;
    expect(result.error).toContain("Source stream not found");
  });
});
